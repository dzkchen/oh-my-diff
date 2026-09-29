import hashlib
import json
import unittest

from scripts import install_support
from scripts import preview_lock


class PreviewLockTests(unittest.TestCase):
    def test_pinned_preview_lock_matches_the_first_party_sources(self):
        self.assertEqual(preview_lock.build(), install_support.preview_lock())

    def test_every_pinned_package_declares_its_exact_supported_api_version(self):
        lock = install_support.preview_lock()
        api = json.loads((install_support.ROOT / "mods/package.json").read_text())["version"]
        self.assertEqual(lock["mod_api"], api)
        self.assertTrue(lock["packages"])
        for identifier, package in lock["packages"].items():
            manifest = json.loads((install_support.ROOT / package["source"] / "mod.json").read_text())
            self.assertEqual(manifest["api"], package["api"], identifier)
            preview_lock.validate_manifest(manifest, identifier)
            self.assertEqual(manifest["capabilities"], package["capabilities"], identifier)
            self.assertEqual(package["extension_type"], "mod", identifier)


class PluginLockTests(unittest.TestCase):
    def test_pinned_bundle_matches_plugin_sources(self):
        lock = install_support.plugin_sources()
        self.assertEqual(lock["marketplace"], "oh-my-diff")
        self.assertEqual(set(lock["plugins"]),
                         {"omd-guidance-hooks", "omd-review-policy", "omd-application-bridges",
                          "omd-artifact-reading", "omd-code-execution"})
        self.assertEqual(
            lock["plugins"]["omd-guidance-hooks"]["extension_types"],
            ["plugin", "skill", "hook"],
        )
        self.assertFalse(lock["plugins"]["omd-guidance-hooks"]["mod_required"])
        self.assertEqual(
            lock["plugins"]["omd-review-policy"]["extension_types"],
            ["plugin", "skill", "hook"],
        )
        self.assertFalse(lock["plugins"]["omd-review-policy"]["mod_required"])
        self.assertEqual(
            lock["plugins"]["omd-application-bridges"]["extension_types"],
            ["plugin", "mcp", "hook"],
        )
        self.assertFalse(lock["plugins"]["omd-application-bridges"]["mod_required"])
        self.assertEqual(
            lock["plugins"]["omd-artifact-reading"]["extension_types"],
            ["plugin", "skill"],
        )
        self.assertFalse(lock["plugins"]["omd-artifact-reading"]["mod_required"])
        self.assertEqual(lock["plugins"]["omd-code-execution"]["extension_types"],
                         ["plugin", "skill"])
        self.assertFalse(lock["plugins"]["omd-code-execution"]["mod_required"])


class ShippedPatchTests(unittest.TestCase):
    def test_shipped_patch_matches_the_runtime_sources_it_installs(self):
        manifest = json.loads((install_support.ROOT / "runtime/patches/manifest.json").read_text())
        patch = install_support.ROOT / manifest["patch"]["path"]
        self.assertEqual(hashlib.sha256(patch.read_bytes()).hexdigest(), manifest["patch"]["sha256"])
        checked = 0
        for name, hashes in manifest["files"].items():
            for prefix, source in (("codex-rs/omd/", "runtime/omd/"), ("codex-rs/ext/omd/", "runtime/native/")):
                if name.startswith(prefix):
                    path = install_support.ROOT / source / name[len(prefix):]
                    self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), hashes["after"],
                                     f"{path} changed without regenerating the shipped patch")
                    checked += 1
        self.assertGreater(checked, 20)


if __name__ == "__main__":
    unittest.main()
