import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "plugins/bundled/oh-my-diff/plugins/omd-guidance-hooks"
HOOK = PLUGIN / "hooks/omd_lifecycle.py"


class GuidanceHooksTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.repository = self.root / "repository"
        self.evidence = self.root / "evidence"
        self.repository.mkdir()
        self.evidence.mkdir()
        self.rules = self.root / "reactive.json"
        self.rule_set = {
            "schema": 1,
            "version": "hook-fixture-v1",
            "rules": [
                {
                    "id": "inspect-patch-result",
                    "scope": "lead",
                    "trigger": {
                        "event": "tool_finished",
                        "tool": "apply_patch",
                        "outcome": "completed_host_success",
                    },
                    "instruction": "Inspect the exact patch result before continuing.",
                    "max_activations": 1,
                    "max_context_reactivations": 1,
                },
                {
                    "id": "inspect-worker-result",
                    "scope": "worker",
                    "trigger": {
                        "event": "tool_finished",
                        "tool": "apply_patch",
                        "outcome": "completed_host_success",
                    },
                    "instruction": "Inspect the worker patch result before continuing.",
                    "max_activations": 2,
                    "max_context_reactivations": 0,
                },
            ],
        }
        self.write_rules()
        self.manifest = self.root / "manifest.json"
        self.manifest_value = {
            "repository": str(self.repository),
            "evidence": str(self.evidence),
            "capabilities": {"reactive_rules": True},
            "communication": {
                "concise_user_updates": False,
                "structured_worker_reports": True,
            },
            "reactive_rules": {
                "path": str(self.rules),
                "sha256": self.digest(self.rules),
            },
        }
        self.write_manifest()

    def tearDown(self):
        self.temporary.cleanup()

    @staticmethod
    def digest(path):
        return hashlib.sha256(path.read_bytes()).hexdigest()

    def write_rules(self):
        self.rules.write_text(json.dumps(self.rule_set, sort_keys=True) + "\n")

    def write_manifest(self):
        self.manifest.write_text(json.dumps(self.manifest_value, sort_keys=True) + "\n")

    def run_hook(self, event, enabled=True):
        environment = os.environ.copy()
        if enabled:
            environment.update({
                "OMD_MODE": "enabled",
                "OMD_CONTROLLED_MANIFEST": str(self.manifest),
                "PLUGIN_ROOT": str(PLUGIN),
                "PLUGIN_DATA": str(self.root / "plugin-data"),
            })
        else:
            environment.pop("OMD_MODE", None)
            environment.pop("OMD_CONTROLLED_MANIFEST", None)
        return subprocess.run(
            [sys.executable, str(HOOK)],
            input=json.dumps(event),
            text=True,
            capture_output=True,
            env=environment,
            check=False,
        )

    def post_event(self, agent_id=None, tool="apply_patch"):
        event = {
            "hook_event_name": "PostToolUse",
            "session_id": "session-1",
            "turn_id": "turn-1",
            "tool_name": tool,
            "tool_use_id": "call-1",
            "tool_input": {"patch": "bounded"},
            "tool_response": "Success",
        }
        if agent_id is not None:
            event["agent_id"] = agent_id
            event["agent_type"] = "worker"
        return event

    def marker(self, event):
        identity = f"{event['turn_id']}\0{event['tool_use_id']}".encode()
        name = hashlib.sha256(identity).hexdigest() + ".json"
        return self.evidence / ".omd-hook-events" / name

    def report_event(self, report):
        return {
            "hook_event_name": "SubagentStop",
            "session_id": "session-1",
            "turn_id": "turn-1",
            "agent_id": "agent-1",
            "agent_type": "worker",
            "last_assistant_message": report,
        }

    def valid_report(self):
        return json.dumps({
            "schema": 1,
            "status": "completed",
            "summary": "Bounded work completed.",
            "scope": ["one file"],
            "uncertainty": [],
            "evidence": ["focused check passed"],
            "required_clarification": [],
        })

    def test_inactive_plugin_has_no_effect(self):
        event = self.post_event()
        result = self.run_hook(event, enabled=False)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertFalse(self.marker(event).exists())

    def test_lead_success_writes_exact_hook_marker(self):
        event = self.post_event()
        result = self.run_hook(event)
        self.assertEqual(result.returncode, 0, result.stderr)
        marker = json.loads(self.marker(event).read_text())
        self.assertEqual(marker["rule_id"], "inspect-patch-result")
        self.assertEqual(marker["scope"], "lead")
        self.assertEqual(marker["outcome"], "completed_host_success")
        self.assertEqual(marker["source_sha256"], self.digest(self.rules))

    def test_worker_event_selects_only_worker_rule(self):
        event = self.post_event(agent_id="agent-1")
        result = self.run_hook(event)
        self.assertEqual(result.returncode, 0, result.stderr)
        marker = json.loads(self.marker(event).read_text())
        self.assertEqual(marker["rule_id"], "inspect-worker-result")
        self.assertEqual(marker["scope"], "worker")

    def test_unmatched_canonical_tool_writes_no_marker(self):
        event = self.post_event(tool="Bash")
        result = self.run_hook(event)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.marker(event).exists())

    def test_changed_rule_source_fails_without_marker(self):
        event = self.post_event()
        self.rules.write_text("{}\n")
        result = self.run_hook(event)
        self.assertEqual(result.returncode, 1)
        self.assertIn("source changed", result.stderr)
        self.assertFalse(self.marker(event).exists())

    def test_ambiguous_rule_set_is_rejected(self):
        self.rule_set["rules"].append({**self.rule_set["rules"][0], "id": "duplicate"})
        self.write_rules()
        self.manifest_value["reactive_rules"]["sha256"] = self.digest(self.rules)
        self.write_manifest()
        result = self.run_hook(self.post_event())
        self.assertEqual(result.returncode, 1)
        self.assertIn("ambiguous", result.stderr)

    def test_valid_structured_report_passes(self):
        result = self.run_hook(self.report_event(self.valid_report()))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "")

    def test_incomplete_structured_report_blocks_completion(self):
        result = self.run_hook(self.report_event('{"status":"completed"}'))
        self.assertEqual(result.returncode, 0, result.stderr)
        output = json.loads(result.stdout)
        self.assertEqual(output["decision"], "block")
        self.assertIn("cannot be integrated", output["reason"])

    def test_plain_worker_mode_does_not_validate_report(self):
        self.manifest_value["communication"]["structured_worker_reports"] = False
        self.write_manifest()
        result = self.run_hook(self.report_event("plain worker result"))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "")

    def test_duplicate_report_fields_are_rejected(self):
        report = '{"schema":1,"schema":1,"status":"completed","summary":"x","scope":["x"],"uncertainty":[],"evidence":[],"required_clarification":[]}'
        result = self.run_hook(self.report_event(report))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["decision"], "block")

    def test_boolean_schema_is_rejected(self):
        report = json.loads(self.valid_report())
        report["schema"] = True
        result = self.run_hook(self.report_event(json.dumps(report)))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["decision"], "block")

    def test_non_string_report_status_is_rejected(self):
        report = json.loads(self.valid_report())
        report["status"] = []
        result = self.run_hook(self.report_event(json.dumps(report)))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["decision"], "block")

    def test_truthy_manifest_flags_do_not_activate_hooks(self):
        self.manifest_value["capabilities"]["reactive_rules"] = 1
        self.manifest_value["communication"]["structured_worker_reports"] = "yes"
        self.write_manifest()
        event = self.post_event()
        post = self.run_hook(event)
        report = self.run_hook(self.report_event("plain worker result"))
        self.assertEqual(post.returncode, 0, post.stderr)
        self.assertEqual(report.returncode, 0, report.stderr)
        self.assertEqual(report.stdout, "")
        self.assertFalse(self.marker(event).exists())


if __name__ == "__main__":
    unittest.main()
