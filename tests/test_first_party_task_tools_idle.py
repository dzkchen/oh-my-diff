import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from scripts.first_party_task_tools_idle import launch_environment, selected_store


class TaskToolsIdleSelectionTests(unittest.TestCase):
    def test_launcher_uses_omd_store_and_clears_legacy_manifest(self):
        with mock.patch.dict("os.environ", {"OMD_CONTROLLED_MANIFEST": "/legacy.json", "OMD_MODE": "enabled"}):
            env = launch_environment(Path("/fixture/home"), Path("/fixture/store"))
        self.assertEqual(env["OMD_MODE"], "omd")
        self.assertEqual(env["OMD_MOD_STORE"], "/fixture/store")
        self.assertNotIn("OMD_CONTROLLED_MANIFEST", env)

    def test_arms_use_new_host_selection_without_other_mods(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source.json"
            source.write_text(json.dumps({"schema": 1, "revision": 3, "node": "/node", "mods": [
                {"path": "/packages/omd_task_tools", "enabled": True},
                {"path": "/packages/other", "enabled": True},
            ]}))
            baseline = selected_store(source, root / "baseline", False)
            task_tools = selected_store(source, root / "task-tools", True)
            self.assertEqual(json.loads((baseline / "mods.json").read_text())["mods"], [])
            selected = json.loads((task_tools / "mods.json").read_text())
            self.assertEqual([Path(item["path"]).name for item in selected["mods"]], ["omd_task_tools"])
            self.assertEqual(selected["revision"], 3)

    def test_missing_task_tools_fails_before_launch(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source.json"
            source.write_text(json.dumps({"schema": 1, "mods": [{"path": "/packages/other"}]}))
            with self.assertRaisesRegex(ValueError, "exactly one omd_task_tools"):
                selected_store(source, root / "task-tools", True)
            self.assertFalse((root / "task-tools").exists())

    def test_disabled_task_tools_cannot_be_measured_as_active(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source.json"
            source.write_text(json.dumps({"schema": 1, "mods": [
                {"path": "/packages/omd_task_tools", "enabled": False},
            ]}))
            with self.assertRaisesRegex(ValueError, "must be enabled"):
                selected_store(source, root / "task-tools", True)
            self.assertFalse((root / "task-tools").exists())


if __name__ == "__main__":
    unittest.main()
