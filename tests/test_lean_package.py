import argparse
import io
import json
from pathlib import Path
import tempfile
import tarfile
import unittest
from unittest.mock import patch

from scripts import lean_package


class SourceBuildTests(unittest.TestCase):
    def test_product_version_survives_package_verification_and_does_not_become_the_codex_version(self):
        release = lean_package.release
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "runtime/patches").mkdir(parents=True)
            (root / "mods").mkdir()
            pin = json.loads((release.ROOT / "upstream.lock.json").read_text())
            (root / "upstream.lock.json").write_text(json.dumps(pin))
            (root / "runtime/patches/manifest.json").write_text(json.dumps({"patch": {"path": "patch", "sha256": "hash"}}))
            (root / "mods/package.json").write_text("{}")
            (root / "extensions").mkdir()
            (root / "extensions/index.json").write_text(json.dumps({"release_pin": {"codex": "0.161.0", "mod_api": "api", "node": "24"}}))
            with tarfile.open(root / "mod-api.tgz", "w:gz") as packed:
                member = tarfile.TarInfo("package/package.json")
                member.size = 2
                packed.addfile(member, io.BytesIO(b"{}"))
            lock = root / "lock.json"
            product_version = "0.1.0-nightly.20261008070000.99.1"
            lock.write_text(json.dumps({"version": product_version}))
            with patch.multiple(release, ROOT=root, OUTPUT=lock, BINARIES=(), SOURCES=()), \
                    patch.object(release.support, "digest", return_value="hash"), \
                    patch.object(release.support, "preview_lock"), \
                    patch.object(release.support, "preview_sources", return_value={"mod_api": "api", "node": "24", "packages": {}}), \
                    patch.object(release.full_mods_lock, "load", return_value={"packages": {}}), \
                    patch.object(release.full_mods_lock, "build", return_value={"packages": {}}), \
                    patch.object(release, "selected_plugins", return_value=(None, [])), \
                    patch.object(release, "sdk_sources", return_value=()), \
                    patch.object(release.support, "binary_identity", return_value={"version": "codex-cli 0.161.0"}):
                self.assertEqual(release.build(root)["version"], product_version)
                self.assertEqual(release.build(root, version="0.1.0")["version"], "0.1.0")

    def test_fresh_source_build_selects_every_copied_binary(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            author = root / 'mod-api.tgz'
            author.write_bytes(b'author')
            args = argparse.Namespace(output_archive=None, repository='fixture', target_dir=str(root / 'target'), author_archive=author)

            def run(*arguments, **kwargs):
                if arguments[0] != 'cargo':
                    return
                binaries = [arguments[i + 1] for i, value in enumerate(arguments) if value == '--bin']
                self.assertEqual(set(binaries), set(lean_package.release.BINARIES))
                output = root / 'target/release'
                output.mkdir(parents=True)
                for name in binaries:
                    (output / name).write_bytes(name.encode())

            with patch.object(lean_package, 'run', side_effect=run), patch.object(lean_package.release, 'sign'), patch.object(lean_package, 'archive_payload', return_value={'sha256': 'fixture'}), patch.object(lean_package, 'install_archive'):
                lean_package.source_build(args)
