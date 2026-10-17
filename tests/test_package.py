import argparse
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from scripts import package


PROVENANCE = {'schema': 1, 'inputs': {'runtime_patch_sha256': 'fixture'}, 'signed': {}}


def extracted(root):
    artifacts = root / 'artifacts'
    artifacts.mkdir()
    for name in package.release.BINARIES + (package.release.AUTHOR_ARCHIVE,):
        (artifacts / name).write_text(name)
    (artifacts / package.release.build_provenance.RECORD).write_text(json.dumps(PROVENANCE))
    record = {'version': 'fixture', 'target': 'fixture', 'upstream_tag': 'fixture',
              'mod_api': 'fixture', 'node': 'fixture', 'build_provenance': PROVENANCE,
              'artifacts': {'codex': {'sha256': 'c' * 64, 'bytes': 5}}}
    lock = root / 'lock.json'
    lock.write_text(json.dumps(record))
    with patch.object(package.release, 'build', return_value=record), \
            patch.object(package.release, 'OUTPUT', lock), \
            patch.object(package, 'copy_sources', side_effect=lambda payload: (payload / 'runtime').mkdir() or
                         (payload / 'runtime/release.lock.json').write_text(json.dumps(record))):
        packed = package.archive_payload(artifacts, root / 'package.tar.xz')
    destination = root / 'unpacked'
    destination.mkdir()
    return package.checked_extract(root / 'package.tar.xz', packed['sha256'], destination)


class SourceBuildTests(unittest.TestCase):
    def test_an_extracted_payload_installs_only_after_verification_and_without_extracting_again(self):
        with tempfile.TemporaryDirectory() as directory:
            payload = extracted(Path(directory))
            args = argparse.Namespace(payload=payload, upstream='/usr/bin/true', profile='platform', prefix='prefix',
                                      bin_dir='bin', store='store', node='node', attach_store=False)
            calls = []
            with patch.object(package.support, 'run', side_effect=lambda arguments, **kwargs: calls.append(arguments)), \
                    patch.object(package.support, 'binary_identity', return_value={'path': '/usr/bin/true', 'version': 'fixture'}), \
                    patch.object(package.support, 'compatible_upstream', return_value=True), \
                    patch.object(package.tarfile, 'open', side_effect=AssertionError('extracted again')):
                package.install_archive(args)
                self.assertEqual([call[2] for call in calls], ['scripts.release_lock', 'scripts.profiles'])
                self.assertEqual(calls[0][calls[0].index('--version') + 1], 'fixture')
                self.assertIn(payload.resolve() / 'artifacts/codex', calls[1])
                (payload / 'artifacts/codex').write_text('changed')
                with self.assertRaisesRegex(ValueError, 'prebuilt package file changed: artifacts/codex'):
                    package.install_archive(args)
                (payload / 'artifacts/codex').write_text('codex')
                (payload / 'artifacts/extra').write_text('extra')
                with self.assertRaisesRegex(ValueError, 'inventory mismatch'):
                    package.install_archive(args)
            self.assertEqual(len(calls), 2)

    def test_noncanonical_member_names_are_unsafe(self):
        for name in ('payload/./x', 'payload//x', 'payload/x/'):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                archive = Path(directory) / 'package.tar.xz'
                with package.tarfile.open(archive, 'w:xz') as tar:
                    tar.addfile(package.tarfile.TarInfo(name))
                with self.assertRaisesRegex(ValueError, 'unsafe package member'):
                    package.checked_extract(archive, package.support.digest(archive), Path(directory) / 'out')

