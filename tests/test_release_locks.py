import hashlib
import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from scripts import install_support
from scripts import plugin_lock


class PluginLockTests(unittest.TestCase):
    def test_release_inventory_ignores_ambient_files_and_requires_declared_sources(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name in ("plugins", "runtime"):
                shutil.copytree(install_support.ROOT / name, root / name)
            with mock.patch.object(install_support, "ROOT", root), mock.patch.multiple(
                    plugin_lock, ROOT=root, LOCK=root / "runtime/plugins.lock.json"):
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
