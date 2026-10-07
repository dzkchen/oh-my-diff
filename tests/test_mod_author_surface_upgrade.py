import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from scripts import mod_author_surface_upgrade


ROOT = Path(__file__).resolve().parents[1]


class ModAuthorSurfaceUpgradeTests(unittest.TestCase):
    def test_compatible_upgrade_bumps_current_fixture_patch_without_changing_api_or_state(self):
        original = json.loads((ROOT / "mods/examples/counter/mod.json").read_text())
        upgraded = mod_author_surface_upgrade.compatible_upgrade(original)
        self.assertEqual(original["version"], "2.0.0")
        self.assertEqual(upgraded["version"], "2.0.1")
        self.assertEqual(upgraded["api"], original["api"])
        self.assertEqual(upgraded["state_version"], original["state_version"])

    def test_compatible_upgrade_rejects_stale_api_and_ambiguous_version(self):
        original = json.loads((ROOT / "mods/examples/counter/mod.json").read_text())
        with self.assertRaisesRegex(RuntimeError, "differs from current SDK"):
            mod_author_surface_upgrade.compatible_upgrade({**original, "api": "0.1.0-experimental.8"})
        with self.assertRaisesRegex(RuntimeError, "stable semver"):
            mod_author_surface_upgrade.compatible_upgrade({**original, "version": "2.0.0-preview.1"})

    def test_install_trusts_manifest_capabilities(self):
        manifest = json.loads((ROOT / "mods/examples/counter/mod.json").read_text())
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)
            (source / "mod.json").write_text(json.dumps(manifest))
            with patch.object(mod_author_surface_upgrade, "call", side_effect=[{"confirmation": "confirmed"}, {}, {"packages": [{}]}]) as call:
                result = mod_author_surface_upgrade.install(source / "store", source)
        request = json.loads(call.call_args_list[0].args[2])
        self.assertEqual(request["trust"]["packages"][manifest["id"]]["capabilities"], manifest["capabilities"])
        self.assertEqual(call.call_args_list[1].args[-1], "confirmed")
        self.assertEqual(call.call_args_list[2].args, ("package-enable", source / "store", manifest["id"]))
        self.assertEqual(len(result["lock"]["packages"]), 1)


if __name__ == "__main__":
    unittest.main()
