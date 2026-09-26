import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
MODS = ("omd_git", "omd_logo", "omd_model_picker", "omd_selection_copy")


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
            "omd_git": ({"commands", "git", "lifecycle", "state", "terminal"}, {"git_operations_v1"}),
            "omd_logo": ({"terminal"}, {"terminal_identity_v1", "terminal_rich_line_v1"}),
            "omd_model_picker": ({"terminal"}, {"terminal_picker_theme_v1"}),
            "omd_selection_copy": ({"commands", "state", "terminal"}, {"terminal_selection_v1"}),
        }
        for mod, (capabilities, features) in expected.items():
            manifest = json.loads((ROOT / "mods/first-party" / mod / "mod.json").read_text())
            with self.subTest(mod=mod):
                self.assertEqual(set(manifest["capabilities"]), capabilities)
                self.assertLessEqual(features, set(manifest["compatibility"]["required_features"]))

    def test_git_sidebar_writes_only_through_fingerprinted_host_operations(self):
        source = (ROOT / "mods/first-party/omd_git/index.ts").read_text()
        for operation in ("git.stage", "git.unstage", "git.discard", "git.commit", "git.switch"):
            calls = source.count(f"'{operation}'")
            fingerprinted = source.count(f"'{operation}', {{")
            with self.subTest(operation=operation):
                self.assertGreaterEqual(calls, 1)
                self.assertEqual(calls, fingerprinted)
        self.assertNotIn("'git.discard', { paths: [entry", source)
        self.assertIn("preview.fingerprint", source)


if __name__ == "__main__":
    unittest.main()
