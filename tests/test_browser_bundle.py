import io
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest import mock

from scripts import browser_bundle


class BrowserBundleTests(unittest.TestCase):
    def executable(self, path, version):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"#!/bin/sh\nprintf '%s\\n' '{version}'\n")
        path.chmod(0o755)

    def managed(self, destination):
        self.executable(destination / "runtime/bin/node", "v24.21.0")
        self.executable(destination / "bin/omd-browser-mcp", "Version 0.0.81")
        (destination / "artifacts").mkdir()
        manifest = {
            "schema": browser_bundle.SCHEMA,
            "product": browser_bundle.PRODUCT,
            "destination": str(destination.resolve()),
            "provisioning": "source",
            "node": {"version": "24.21.0"},
            "mcp": {"version": "0.0.81"},
            "browser": {"revision": "1244"},
            "launcher": "bin/omd-browser-mcp",
        }
        manifest["tree"] = browser_bundle.tree_identity(destination)
        browser_bundle.write_json(destination / "bundle.json", manifest)
        return manifest

    def test_prebuilt_archive_installs_the_same_verified_tree(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            self.managed(source)
            archive = root / "browser.tar.xz"
            packaged = browser_bundle.create_archive(source, archive)
            installed = browser_bundle.install_archive(
                archive, packaged["sha256"], root / "installed")
            self.assertTrue(installed["verified"])
            self.assertEqual(installed["provisioning"], "prebuilt-archive")
            self.assertEqual(installed["tree"], browser_bundle.tree_identity(root / "installed"))

    def test_archive_rejects_parent_traversal(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / "hostile.tar"
            with tarfile.open(archive, "w") as target:
                entry = tarfile.TarInfo("../escape")
                entry.size = 1
                target.addfile(entry, io.BytesIO(b"x"))
            with self.assertRaisesRegex(ValueError, "escapes"):
                browser_bundle.safe_extract(archive, root / "extract")
            self.assertFalse((root / "escape").exists())

    def test_archive_rejects_unsupported_entry_types(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / "hostile.tar"
            with tarfile.open(archive, "w") as target:
                entry = tarfile.TarInfo("device")
                entry.type = tarfile.CHRTYPE
                target.addfile(entry)
            with self.assertRaisesRegex(ValueError, "unsupported entry type"):
                browser_bundle.safe_extract(archive, root / "extract")

    def test_verify_detects_changes_but_ignores_bounded_artifacts(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "browser"
            self.managed(root)
            (root / "artifacts/evidence.png").write_bytes(b"image")
            self.assertTrue(browser_bundle.verify(root)["verified"])
            (root / "bin/omd-browser-mcp").write_text("changed\n")
            with self.assertRaisesRegex(ValueError, "tree hash mismatch"):
                browser_bundle.verify(root)

    def test_launcher_selects_the_bundled_browser_and_keeps_its_sandbox(self):
        lock = {"browser": {"revision": "1244"}}
        launcher = browser_bundle.launcher_text(lock)
        self.assertIn("chromium_headless_shell-1244", launcher)
        self.assertIn("--executable-path=", launcher)
        self.assertIn("--sandbox", launcher)
        self.assertNotIn("--no-sandbox", launcher)
        self.assertIn('cd "$artifacts_dir"', launcher)

    def test_failed_post_swap_update_restores_the_verified_bundle(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            destination = root / "installed"
            original = self.managed(destination)
            source = root / "source"
            self.managed(source)
            archive = root / "browser.tar.xz"
            packaged = browser_bundle.create_archive(source, archive)
            verified = browser_bundle.verify(destination)
            with mock.patch.object(browser_bundle, "verify",
                                   side_effect=[verified, verified, RuntimeError("post-swap")]):
                with self.assertRaisesRegex(RuntimeError, "post-swap"):
                    browser_bundle.update(destination, archive=archive,
                                          expected_sha256=packaged["sha256"])
            self.assertEqual(browser_bundle.load_manifest(destination)["tree"], original["tree"])
            self.assertFalse((root / ".installed.replacement").exists())
            self.assertFalse((root / ".installed.rollback").exists())


if __name__ == "__main__":
    unittest.main()
