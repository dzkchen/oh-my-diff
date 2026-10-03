import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts import lean_profiles


ROOT = Path(__file__).resolve().parents[1]


class LeanProfileModeTests(unittest.TestCase):
    def test_cli_advertises_only_current_activation_choices(self):
        result = subprocess.run(
            [sys.executable, "-m", "scripts.lean_profiles", "--prefix", "/tmp/omd-unused-prefix",
             "--bin-dir", "/tmp/omd-unused-bin", "activate", "--help"],
            cwd=ROOT, capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("{platform,full,direct}", result.stdout)

    def test_launcher_defines_set_up_providers_only_in_omd_mode(self):
        provider = {"id": "omd_claude_cli", "name": "OMD Claude CLI", "base_url": "http://127.0.0.1:5/v1",
                    "env_key": "OMD_CLAUDE_LOCAL_TOKEN", "token": "/opt/omd/claude/local token"}
        record = {"binary": {"installed_path": "/opt/omd/codex"}, "store": "/opt/omd/store", "profile": "full",
                  "activation": {"selection": "full"}, "providers": {"omd_claude_cli": provider}, "author": {"node": "/opt/omd/node"}}
        text = lean_profiles.selected_text(record)
        self.assertIn("export OMD_NODE=/opt/omd/node", text)
        self.assertIn("-c features.daemon_auto_start=false", text)
        self.assertIn("OMD_CLAUDE_LOCAL_TOKEN=\"$(cat '/opt/omd/claude/local token' 2>/dev/null)\"", text)
        self.assertIn("-c 'model_providers.omd_claude_cli.base_url=\"http://127.0.0.1:5/v1\"'", text)
        record["activation"]["selection"] = "direct"
        self.assertNotIn("omd_claude_cli", lean_profiles.selected_text(record))

    def test_missing_service_rolls_back_selection_and_settings(self):
        identifier = "omd_task_tools"
        store = Path("/tmp/omd-unused-store")
        source = store / "sources" / identifier
        record = {"store": str(store), "packages": {identifier: {}}}
        selected = False
        workflow_enabled = False
        commands = []

        def invoke(_manager, command, _store, *arguments):
            nonlocal selected
            commands.append(command)
            if command == "selection-status":
                return {"selections": [{"id": identifier, "path": str(source),
                                        "selected": selected, "settings_sha256": "original-settings"}]}
            if command == "enable":
                selected = True
            elif command == "disable":
                selected = False
            return {}

        def profile_status(_prefix, _bin_dir):
            return {"packages": [{"id": identifier, "enabled_in_store": selected,
                                  "error": "service_provider_missing: omd_task_tools requires omd.workflow"
                                  if selected and not workflow_enabled else None}]}

        with patch.object(lean_profiles, "load", return_value=record), \
                patch.object(lean_profiles, "check", return_value=(None, Path("/tmp/omd-unused-manager"))), \
                patch.object(lean_profiles, "invoke", side_effect=invoke), \
                patch.object(lean_profiles, "status", side_effect=profile_status):
            with self.assertRaisesRegex(ValueError, "was restored:.*service_provider_missing"):
                lean_profiles.select_mod(Path("/tmp/omd-unused-prefix"), Path("/tmp/omd-unused-bin"),
                                         identifier, True)
            self.assertFalse(selected)
            self.assertEqual(commands, ["selection-status", "enable", "reload", "disable", "reload", "selection-status"])
            workflow_enabled = True
            result = lean_profiles.select_mod(Path("/tmp/omd-unused-prefix"), Path("/tmp/omd-unused-bin"),
                                              identifier, True)
            self.assertTrue(selected)
            self.assertIsNone(result["packages"][0]["error"])

    @unittest.skipUnless(os.environ.get("OMD_TEST_MOD_BIN"), "set OMD_TEST_MOD_BIN for native offline coverage")
    def test_task_tools_enable_requires_workflow_in_isolated_store(self):
        manager = Path(os.environ["OMD_TEST_MOD_BIN"]).resolve()
        node = shutil.which("node")
        self.assertIsNotNone(node)
        with tempfile.TemporaryDirectory(prefix="omd-profile-selection-", dir="/private/tmp") as temporary:
            base = Path(temporary)
            store = base / "store"
            lean_profiles.invoke(manager, "init", store, node)
            sources = store / "sources"
            sources.mkdir()
            for identifier in ("omd_task_tools", "omd_workflow"):
                source = sources / identifier
                source.mkdir()
                for name in ("mod.json", "index.ts"):
                    shutil.copy2(ROOT / "mods/first-party" / identifier / name, source / name)
                inspected = lean_profiles.invoke(manager, "inspect", source)
                lean_profiles.invoke(manager, "trust", store, source, inspected["sha256"],
                                     ",".join(inspected["manifest"]["capabilities"]))
            task_tools = sources / "omd_task_tools"
            lean_profiles.invoke(manager, "settings", store, task_tools,
                                 json.dumps({"python_command": ["python3", "-V"]}))
            record = {"store": str(store), "packages": {"omd_task_tools": {}}}

            def profile_status(_prefix, _bin_dir):
                host = lean_profiles.invoke(manager, "status", store)
                selected = {item["id"]: item for item in host["mods"]}
                active = selected.get("omd_task_tools")
                return {"packages": [{"id": "omd_task_tools", "enabled_in_store": active is not None,
                                      "error": active["error"] if active else None}]}

            before = lean_profiles.invoke(manager, "selection-status", store)["selections"]
            task_before = next(item for item in before if item["id"] == "omd_task_tools")
            with patch.object(lean_profiles, "load", return_value=record), \
                    patch.object(lean_profiles, "check", return_value=(None, manager)), \
                    patch.object(lean_profiles, "status", side_effect=profile_status):
                with self.assertRaisesRegex(ValueError, "service_provider_missing.*omd.workflow"):
                    lean_profiles.select_mod(base / "prefix", base / "bin", "omd_task_tools", True)
                after = lean_profiles.invoke(manager, "selection-status", store)["selections"]
                task_after = next(item for item in after if item["id"] == "omd_task_tools")
                self.assertFalse(task_after["selected"])
                self.assertEqual(task_after["settings_sha256"], task_before["settings_sha256"])
                lean_profiles.invoke(manager, "enable", store, sources / "omd_workflow")
                lean_profiles.invoke(manager, "reload", store)
                result = lean_profiles.select_mod(base / "prefix", base / "bin", "omd_task_tools", True)
                self.assertTrue(result["packages"][0]["enabled_in_store"])
                self.assertIsNone(result["packages"][0]["error"])

    def test_mini_relaunches_only_on_a_request_from_the_run_that_exited(self):
        record = {"store": "/opt/omd/store", "activation": {"selection": "full"},
                  "tools": {"omd": {"installed_path": "/opt/omd/bin/omd"}}}
        enabled = [{"id": "omd_mini", "effective": True, "error": None}]
        runs, requests = [], [{"run": 0, "target": "full", "thread": "019a-1"}, {"run": 0, "target": "mini", "thread": "019a-1"}]

        def run(argv, **options):
            if argv[0] == "/opt/omd/bin/omd":
                request = requests.pop(0) if requests else None
                entries = {f"switch_{runs[-1][1]['OH_MY_DIFF_LAUNCH'].split('.')[0]}": {"value": request}} if request else {}
                return subprocess.CompletedProcess(argv, 0, json.dumps({"entries": entries}), "")
            runs.append(([str(item) for item in argv], options["env"]))
            return subprocess.CompletedProcess(argv, 3)

        handlers = {name: lean_profiles.signal.getsignal(name) for name in (lean_profiles.signal.SIGINT, lean_profiles.signal.SIGQUIT)}
        try:
            with patch.object(lean_profiles, "load", return_value=record), \
                    patch.object(lean_profiles, "check", return_value=(None, "/opt/omd/manager")), \
                    patch.object(lean_profiles, "invoke", return_value={"selections": enabled}), \
                    patch.object(lean_profiles.sys.stdin, "isatty", return_value=True), \
                    patch.object(lean_profiles.sys.stdout, "isatty", return_value=True), \
                    patch.object(lean_profiles.subprocess, "run", side_effect=run):
                self.assertEqual(lean_profiles.mini(Path("/opt/omd"), Path("/opt/bin"), ["-m", "gpt"]), 3)
                self.assertEqual([argv for argv, _ in runs], [["/opt/bin/codex", "--no-alt-screen", "-m", "gpt"], ["/opt/bin/codex", "resume", "019a-1"]])
                self.assertEqual([(env["OH_MY_DIFF_PRESENTATION"], env["OH_MY_DIFF_LAUNCH"][-2:]) for _, env in runs], [("mini", ".0"), ("full", ".1")])
                enabled[0]["effective"] = False
                with self.assertRaisesRegex(ValueError, "omd-package mod enable omd_mini"):
                    lean_profiles.mini(Path("/opt/omd"), Path("/opt/bin"), [])
        finally:
            for name, handler in handlers.items():
                lean_profiles.signal.signal(name, handler)


if __name__ == "__main__":
    unittest.main()
