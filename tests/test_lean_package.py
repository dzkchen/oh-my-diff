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
            (root / "patch").write_text("fixture patch")
            (root / "runtime/patches/manifest.json").write_text(json.dumps({"patch": {"path": "patch", "sha256": release.support.digest(root / "patch")}}))
            (root / "mods/package.json").write_text("{}")
            (root / "extensions").mkdir()
            (root / "extensions/index.json").write_text(json.dumps({"release_pin": {"codex": pin["tag"].removeprefix("rust-v"), "mod_api": "api", "node": "24"}}))
            with tarfile.open(root / "mod-api.tgz", "w:gz") as packed:
                member = tarfile.TarInfo("package/package.json")
                member.size = 2
                packed.addfile(member, io.BytesIO(b"{}"))
            lock = root / "lock.json"
            product_version = "0.1.0-nightly.20261008070000.99.1"
            lock.write_text(json.dumps({"version": product_version}))
            with patch.multiple(release, ROOT=root, OUTPUT=lock, BINARIES=(), SOURCES=()), \
                    patch.object(release.support, "preview_lock"), \
                    patch.object(release.support, "preview_sources", return_value={"mod_api": "api", "node": "24", "packages": {}}), \
                    patch.object(release.full_mods_lock, "load", return_value={"packages": {}}), \
                    patch.object(release.full_mods_lock, "build", return_value={"packages": {}}), \
                    patch.object(release.support, "plugin_sources", return_value={"plugins": {}}), \
                    patch.object(release, "sdk_sources", return_value=()), \
                    patch.object(release.support, "binary_identity", return_value={"version": "codex-cli " + pin["tag"].removeprefix("rust-v"), "path": "/usr/bin/true"}):
                self.assertEqual(release.build(root, version=product_version)["version"], product_version)
                self.assertEqual(release.build(root, version="0.1.0")["version"], "0.1.0")
                frozen = release.build(root, version=product_version)
                lock.write_text(json.dumps(frozen))
                def copy_sources(payload):
                    (payload / "runtime").mkdir()
                    (payload / "runtime/lean-release.lock.json").write_bytes(lock.read_bytes())
                with patch.object(lean_package, "copy_sources", side_effect=copy_sources):
                    packed = lean_package.archive_payload(root, root / "package.tar.xz")
                self.assertEqual(json.loads(Path(packed["manifest"]).read_text())["version"], product_version)
                args = argparse.Namespace(archive=packed["archive"], sha256=packed["sha256"], upstream="/usr/bin/true",
                                          prefix=root / "prefix", bin_dir=root / "bin", profile="platform", node="node",
                                          store=root / "store", attach_store=False)
                with patch.object(lean_package, "run") as run:
                    lean_package.install_archive(args)
                verification = run.call_args_list[0].args
                self.assertEqual(verification[verification.index("--version") + 1], product_version)
                with patch.object(release, "VERSION", "0.2.0-alpha.1"):
                    expected = release.build(root)
                    self.assertEqual(expected["version"], "0.2.0-alpha.1")
                    lock.write_text(json.dumps(expected, indent=2, sort_keys=True) + "\n")
                    with patch("sys.argv", ["lean_release_lock", "--artifact-dir", str(root)]), \
                            patch.object(release, "VERSION", "0.2.0-alpha.2"):
                        with self.assertRaisesRegex(SystemExit, "lean release lock differs"):
                            release.main()

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
