import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "plugins/bundled/oh-my-diff/plugins/omd-review-policy"
HOOK = PLUGIN / "hooks/omd_review_lifecycle.py"


class ReviewPluginTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.repository = self.root / "repository"
        self.repository.mkdir()
        self.manifest = self.root / "manifest.json"
        self.manifest_value = {
            "repository": str(self.repository),
            "capabilities": {"unified_review": True},
            "review": {"every_turn_advice": True},
        }
        self.write_manifest()

    def tearDown(self):
        self.temporary.cleanup()

    def write_manifest(self):
        self.manifest.write_text(json.dumps(self.manifest_value) + "\n")

    def run_hook(self, event, enabled=True, owner="manual"):
        environment = os.environ.copy()
        environment["OMD_REVIEW_CADENCE_OWNER"] = owner
        if enabled:
            environment.update(
                {
                    "OMD_MODE": "omd",
                    "OMD_REVIEW_CONFIG": str(self.manifest),
                    "PLUGIN_DATA": str(self.root / "plugin-data"),
                    "PLUGIN_ROOT": str(PLUGIN),
                }
            )
        else:
            environment.pop("OMD_MODE", None)
            environment.pop("OMD_REVIEW_CONFIG", None)
        return subprocess.run(
            [sys.executable, str(HOOK)],
            input=json.dumps(event),
            text=True,
            capture_output=True,
            env=environment,
            check=False,
        )

    @staticmethod
    def event(name, turn="turn-1", **values):
        return {
            "hook_event_name": name,
            "session_id": "session-1",
            "turn_id": turn,
            **values,
        }

    def marker(self, turn="turn-1"):
        session = hashlib.sha256(b"session-1").hexdigest()
        turn_hash = hashlib.sha256(turn.encode()).hexdigest()
        return self.root / "plugin-data" / f"{session}-{turn_hash}.json"

    def test_review_skills_cover_all_cadences_and_retain_native_authority(self):
        cadence = (PLUGIN / "skills/omd-review-cadence/SKILL.md").read_text()
        final = (PLUGIN / "skills/omd-final-review/SKILL.md").read_text()
        for name in ("stable_milestone", "risk_triggered", "every_turn"):
            self.assertIn(name, cadence)
        self.assertIn("final_review", final)
        for retained in ("ledger", "limits", "drift"):
            self.assertIn(retained, (cadence + final).lower())

    def test_every_turn_stop_blocks_until_mod_review_receipt_succeeds(self):
        stopped = self.run_hook(self.event("Stop"))
        self.assertEqual(stopped.returncode, 0, stopped.stderr)
        self.assertEqual(json.loads(stopped.stdout)["decision"], "block")
        reviewed = self.run_hook(
            self.event(
                "PostToolUse",
                tool_name="mod_omd_workflow_advance",
                tool_use_id="call-1",
                tool_response={"status": "recorded", "receipt": {"kind": "milestone_review", "outcome": "pass", "producer": {"kind": "agent"}}},
            )
        )
        self.assertEqual(reviewed.returncode, 0, reviewed.stderr)
        marker = json.loads(self.marker().read_text())
        self.assertEqual(marker["cadence"], "milestone_review")
        allowed = self.run_hook(self.event("Stop"))
        self.assertEqual(allowed.returncode, 0, allowed.stderr)
        self.assertEqual(allowed.stdout, "")

    def test_other_tools_and_unselected_policy_do_not_satisfy_or_enforce_cadence(self):
        result = self.run_hook(
            self.event(
                "PostToolUse",
                tool_name="apply_patch",
                tool_use_id="call-1",
                tool_input={},
            )
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.marker().exists())
        self.manifest_value["review"]["every_turn_advice"] = False
        self.write_manifest()
        stopped = self.run_hook(self.event("Stop"))
        self.assertEqual(stopped.returncode, 0, stopped.stderr)
        self.assertEqual(stopped.stdout, "")

    def test_started_failed_or_lead_review_cannot_satisfy_cadence(self):
        for result in ({"status": "running"},
                       {"status": "recorded", "receipt": {"kind": "milestone_review", "outcome": "fail", "producer": {"kind": "agent"}}},
                       {"status": "recorded", "receipt": {"kind": "milestone_review", "outcome": "pass", "producer": {"kind": "lead"}}},
                       {"status": "recorded", "receipt": {"kind": "milestone_review", "outcome": "pass", "producer": "agent"}}):
            response = self.run_hook(self.event("PostToolUse", tool_name="mod_omd_workflow_advance",
                                               tool_use_id="incomplete", tool_response=result))
            self.assertEqual(response.returncode, 0, response.stderr)
            self.assertFalse(self.marker().exists())

    def test_truthy_manifest_values_do_not_activate_the_guard(self):
        self.manifest_value["capabilities"]["unified_review"] = 1
        self.manifest_value["review"]["every_turn_advice"] = "yes"
        self.write_manifest()
        result = self.run_hook(self.event("Stop"))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "")

    def test_advisor_owns_completed_turn_cadence_without_manual_stop_guard(self):
        for event in (self.event("Stop"), self.event("SessionEnd")):
            result = self.run_hook(event, owner="advisor")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, "")
        self.assertFalse((self.root / "plugin-data").exists())
        self.assertEqual(json.loads(self.run_hook(self.event("Stop")).stdout)["decision"], "block")

    def test_tampered_marker_does_not_satisfy_stop(self):
        self.marker().parent.mkdir()
        self.marker().write_text('{"schema":1,"cadence":"every_turn"}\n')
        stopped = self.run_hook(self.event("Stop"))
        self.assertEqual(stopped.returncode, 0, stopped.stderr)
        self.assertEqual(json.loads(stopped.stdout)["decision"], "block")

    def test_session_end_clears_only_its_review_markers(self):
        reviewed = self.run_hook(
            self.event(
                "PostToolUse",
                tool_name="mod_omd_workflow_advance",
                tool_use_id="call-1",
                tool_response={"status": "recorded", "receipt": {"kind": "milestone_review", "outcome": "pass", "producer": {"kind": "agent"}}},
            )
        )
        self.assertEqual(reviewed.returncode, 0, reviewed.stderr)
        other = self.root / "plugin-data/other.json"
        other.write_text("{}\n")
        ended = self.run_hook(self.event("SessionEnd"))
        self.assertEqual(ended.returncode, 0, ended.stderr)
        self.assertFalse(self.marker().exists())
        self.assertTrue(other.exists())


if __name__ == "__main__":
    unittest.main()
