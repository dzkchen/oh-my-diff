import hashlib
import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from scripts import install_support
from scripts import preview_lock
from scripts import plugin_lock


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
    def test_release_inventory_ignores_ambient_files_and_requires_declared_sources(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name in ("plugins", "runtime"):
                shutil.copytree(install_support.ROOT / name, root / name)
            with mock.patch.object(install_support, "ROOT", root), mock.patch.multiple(
                    plugin_lock, ROOT=root, LOCK=root / "runtime/plugin-v1.lock.json"):
                before = plugin_lock.build()
                source = root / before["source"]
                for name in ("scratch.txt", "node_modules/pkg/index.js", "target/debug/output",
                             "plugins/omd-artifact-reading/scripts/scratch.py", "dist/bundle.js"):
                    path = source / name
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text("ambient")
                self.assertEqual(plugin_lock.build(), before)
                install_support.plugin_sources(before)
                declared = source / ".agents/plugins/marketplace.json"
                declared.unlink()
                with self.assertRaises((ValueError, FileNotFoundError)):
                    plugin_lock.build()

    def test_pinned_bundle_matches_plugin_sources(self):
        lock = install_support.plugin_sources()
        self.assertEqual(lock["marketplace"], "oh-my-diff")
        self.assertEqual({name: (plugin["extension_types"], plugin["mod_required"]) for name, plugin in lock["plugins"].items()},
                         {name: (["plugin", "skill"], False)
                          for name in ("omd-anchored-edit", "omd-artifact-reading", "omd-code-execution")})


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
