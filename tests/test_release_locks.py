import hashlib
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from scripts import install_support
from scripts import mods_lock
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



class PublishedCatalogTests(unittest.TestCase):
    def test_published_entries_must_match_their_revision(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            shutil.copytree(install_support.ROOT / "mods/examples/counter", root / "mods/counter")
            git = ["git", "-C", root, "-c", "user.name=t", "-c", "user.email=t@example.invalid"]
            for command in (["init", "-q"], ["add", "."], ["commit", "-qm", "counter"]):
                subprocess.run([*git, *command], check=True)
            revision = subprocess.run([*git, "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
            version = json.loads((root / "mods/counter/mod.json").read_text())["version"]
            published = {"repository": "https://example.invalid/r", "revision": revision,
                         "sha256": install_support.package_digest(root / "mods/counter")}
            (root / "extensions").mkdir()

            def drift(**changes):
                entry = {"id": "counter", "version": version, "source": "mods/counter", "published": published | changes}
                (root / "extensions/index.json").write_text(json.dumps({"packages": [entry]}))
                with mock.patch.object(mods_lock, "ROOT", root):
                    return mods_lock.published_drift()
            self.assertEqual(drift(), [])
            self.assertRegex(drift(sha256="0" * 64)[0], "^counter: published.sha256 is 0{64}")
            (root / "mods/counter/index.ts").write_text("// changed after publishing\n")
            self.assertEqual(drift(), [])


if __name__ == "__main__":
    unittest.main()
