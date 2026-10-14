import argparse
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from scripts import lean_package


PROVENANCE = {'schema': 1, 'inputs': {'runtime_patch_sha256': 'fixture'}, 'signed': {}}


def extracted(root):
    artifacts = root / 'artifacts'
    artifacts.mkdir()
    for name in lean_package.release.BINARIES + (lean_package.release.AUTHOR_ARCHIVE,):
        (artifacts / name).write_text(name)
    (artifacts / lean_package.release.build_provenance.RECORD).write_text(json.dumps(PROVENANCE))
    record = {'version': 'fixture', 'target': 'fixture', 'upstream_tag': 'fixture',
              'mod_api': 'fixture', 'node': 'fixture', 'build_provenance': PROVENANCE}
    lock = root / 'lock.json'
    lock.write_text(json.dumps(record))
    with patch.object(lean_package.release, 'build', return_value=record), \
            patch.object(lean_package.release, 'OUTPUT', lock), patch.object(lean_package, 'copy_sources'):
        packed = lean_package.archive_payload(artifacts, root / 'package.tar.xz')
    destination = root / 'unpacked'
    destination.mkdir()
    return lean_package.checked_extract(root / 'package.tar.xz', packed['sha256'], destination)


class SourceBuildTests(unittest.TestCase):
    def test_archive_preserves_the_artifact_bound_build_record(self):
        with tempfile.TemporaryDirectory() as directory:
            payload = extracted(Path(directory))
            self.assertEqual(json.loads((payload / 'artifacts' / lean_package.release.build_provenance.RECORD).read_text()), PROVENANCE)

    def test_an_extracted_payload_installs_only_after_verification_and_without_extracting_again(self):
        with tempfile.TemporaryDirectory() as directory:
            payload = extracted(Path(directory))
            args = argparse.Namespace(payload=payload, upstream='/usr/bin/true', profile='platform', prefix='prefix',
                                      bin_dir='bin', store='store', node='node', attach_store=False)
            calls = []
            with patch.object(lean_package.support, 'run', side_effect=lambda arguments, **kwargs: calls.append(arguments)), \
                    patch.object(lean_package.support, 'binary_identity', return_value={'path': '/usr/bin/true', 'version': 'fixture'}), \
                    patch.object(lean_package.support, 'compatible_upstream', return_value=True), \
                    patch.object(lean_package.tarfile, 'open', side_effect=AssertionError('extracted again')):
                lean_package.install_archive(args)
                self.assertEqual([call[2] for call in calls], ['scripts.lean_release_lock', 'scripts.lean_profiles'])
                self.assertIn(payload.resolve() / 'artifacts/codex', calls[1])
                (payload / 'artifacts/codex').write_text('changed')
                with self.assertRaisesRegex(ValueError, 'prebuilt package file changed: artifacts/codex'):
                    lean_package.install_archive(args)
                (payload / 'artifacts/codex').write_text('codex')
                (payload / 'artifacts/extra').write_text('extra')
                with self.assertRaisesRegex(ValueError, 'inventory mismatch'):
                    lean_package.install_archive(args)
            self.assertEqual(len(calls), 2)

    def test_noncanonical_member_names_are_unsafe(self):
        for name in ('payload/./x', 'payload//x', 'payload/x/'):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                archive = Path(directory) / 'package.tar.xz'
                with lean_package.tarfile.open(archive, 'w:xz') as tar:
                    tar.addfile(lean_package.tarfile.TarInfo(name))
                with self.assertRaisesRegex(ValueError, 'unsafe package member'):
                    lean_package.checked_extract(archive, lean_package.support.digest(archive), Path(directory) / 'out')

    def test_fresh_source_build_selects_every_copied_binary(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            author = root / 'mod-api.tgz'
            author.write_bytes(b'author')
            args = argparse.Namespace(output_archive=None, repository='fixture', target_dir=str(root / 'target'), author_archive=author)
            identity = lean_package.release.build_provenance.identity()
            inputs = {**identity, 'configuration': {'cargo_arguments': ['build', '--locked', '--release'],
                'compiler': f"release: {identity['rust_toolchain']}\nhost: {identity['target']}",
                'environment': {}, 'cargo_configs': {}}}

            def run(arguments, **kwargs):
                if arguments[0] != 'cargo':
                    return
                binaries = [arguments[i + 1] for i, value in enumerate(arguments) if value == '--bin']
                self.assertEqual(set(binaries), set(lean_package.release.BINARIES))
                output = root / 'target/release'
                output.mkdir(parents=True)
                for name in binaries:
                    (output / name).write_bytes(name.encode())

            def archive(artifacts, *arguments, **kwargs):
                record = lean_package.release.build_provenance.verify(artifacts)
                self.assertEqual(record['inputs'], inputs)
                return {'sha256': 'fixture'}

            with patch.object(lean_package.support, 'run', side_effect=run), patch.object(lean_package.release, 'sign'), patch.object(lean_package.release.build_provenance, 'inputs', return_value=inputs), patch.object(lean_package, 'archive_payload', side_effect=archive), patch.object(lean_package, 'install_archive'):
                lean_package.source_build(args)
