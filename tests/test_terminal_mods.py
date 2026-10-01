import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
MODS = ("omd_git", "omd_logo", "omd_model_picker")


def manage(manager, *arguments):
    result = subprocess.run([manager, *map(str, arguments)], capture_output=True, text=True, check=True)
    return json.loads(result.stdout) if result.stdout.strip().startswith(("{", "[")) else result.stdout


@unittest.skipUnless(os.environ.get("OMD_TEST_MANAGER") and os.environ.get("OMD_TEST_NODE"),
                     "set OMD_TEST_MANAGER and OMD_TEST_NODE to run offline mod scenarios")
class TerminalModScenarioTests(unittest.TestCase):
    def test_each_terminal_mod_passes_its_offline_scenario(self):
        manager, node = os.environ["OMD_TEST_MANAGER"], os.environ["OMD_TEST_NODE"]
        for mod in MODS:
            with self.subTest(mod=mod), tempfile.TemporaryDirectory() as directory:
                store = Path(directory) / "store"
                package = ROOT / "mods/first-party" / mod
                manage(manager, "init", store, node)
                inspected = manage(manager, "inspect", package)
                manage(manager, "trust", store, package, inspected["sha256"],
                       ",".join(inspected["manifest"]["capabilities"]), "user")
                manage(manager, "enable", store, package)
                result = manage(manager, "test", store, package / "mod.test.json")
                self.assertEqual(result["unused_mock_replies"], [])
                self.assertEqual(result["paid_requests"], 0)
                self.assertTrue(all("error" not in step for step in result["steps"]))


class TerminalModSourceTests(unittest.TestCase):
    def test_terminal_mods_declare_only_their_required_features_and_capabilities(self):
        expected = {
            "omd_git": ({"commands", "exec", "fs.read", "fs.write", "store", "lifecycle", "terminal"},
                        {"exec_v1", "guarded_exec_v1", "workspace_access_v1", "workspace_fs_v1", "terminal_lists_v1", "store_v1"}),
            "omd_logo": ({"terminal"}, {"terminal_render_sites_v1", "terminal_welcome_v1"}),
            "omd_model_picker": ({"terminal", "events", "store"}, {"terminal_lists_v1", "events_v1"}),
        }
        for mod, (capabilities, features) in expected.items():
            manifest = json.loads((ROOT / "mods/first-party" / mod / "mod.json").read_text())
            with self.subTest(mod=mod):
                self.assertEqual(set(manifest["capabilities"]), capabilities)
                self.assertLessEqual(features, set(manifest["compatibility"]["required_features"]))


if __name__ == "__main__":
    unittest.main()
