import argparse
import io
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
              'mod_api': 'fixture', 'node': 'fixture', 'build_provenance': PROVENANCE}
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
    def test_archive_preserves_the_artifact_bound_build_record(self):
        with tempfile.TemporaryDirectory() as directory:
            payload = extracted(Path(directory))
            self.assertEqual(json.loads((payload / 'artifacts' / package.release.build_provenance.RECORD).read_text()), PROVENANCE)

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

    def test_product_version_is_recorded_without_becoming_the_codex_version(self):
        release = package.release
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'runtime/patches').mkdir(parents=True)
            (root / 'mods').mkdir()
            (root / 'extensions').mkdir()
            pin = json.loads((release.ROOT / 'upstream.lock.json').read_text())
            codex = pin['tag'].removeprefix('rust-v')
            (root / 'upstream.lock.json').write_text(json.dumps(pin))
            (root / 'patch').write_text('fixture patch')
            (root / 'runtime/patches/manifest.json').write_text(json.dumps({'patch': {'path': 'patch', 'sha256': release.support.digest(root / 'patch')}}))
            (root / 'mods/package.json').write_text('{}')
            (root / 'extensions/index.json').write_text(json.dumps({'release_pin': {'codex': codex, 'mod_api': 'api', 'node': '24'}}))
            with release.tarfile.open(root / release.AUTHOR_ARCHIVE, 'w:gz') as packed:
                member = release.tarfile.TarInfo('package/package.json')
                member.size = 2
                packed.addfile(member, io.BytesIO(b'{}'))
            mods = {'mod_api': 'api', 'node': '24', 'packages': {}}
            lock = root / 'lock.json'
            with patch.multiple(release, ROOT=root, OUTPUT=lock, BINARIES=(), SOURCES=()), \
                    patch.object(release.build_provenance, 'verify', return_value=PROVENANCE), \
                    patch.object(release.support, 'mods_lock', return_value=mods), \
                    patch.object(release.mods_lock, 'build', return_value=mods), \
                    patch.object(release.support, 'plugin_sources', return_value={'plugins': {}}), \
                    patch.object(release, 'sdk_sources', return_value=()), \
                    patch.object(release.support, 'binary_identity', return_value={'version': f'codex-cli {codex}', 'path': '/usr/bin/true'}):
                nightly = '0.1.0-nightly.20261008070000.99.1'
                self.assertEqual(release.build(root, version=nightly)['version'], nightly)
                self.assertEqual(release.build(root)['version'], release.VERSION)
                with self.assertRaisesRegex(ValueError, 'invalid release version'):
                    release.build(root, version='1.0')
                lock.write_text(json.dumps(release.build(root, version=nightly), indent=2, sort_keys=True) + '\n')
                with patch('sys.argv', ['release_lock', '--artifact-dir', str(root), '--version', nightly]):
                    release.main()
                with patch('sys.argv', ['release_lock', '--artifact-dir', str(root)]), \
                        self.assertRaisesRegex(SystemExit, 'release lock differs'):
                    release.main()

    def test_noncanonical_member_names_are_unsafe(self):
        for name in ('payload/./x', 'payload//x', 'payload/x/'):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                archive = Path(directory) / 'package.tar.xz'
                with package.tarfile.open(archive, 'w:xz') as tar:
                    tar.addfile(package.tarfile.TarInfo(name))
                with self.assertRaisesRegex(ValueError, 'unsafe package member'):
                    package.checked_extract(archive, package.support.digest(archive), Path(directory) / 'out')

    def test_fresh_source_build_selects_every_copied_binary(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            author = root / 'mod-api.tgz'
            author.write_bytes(b'author')
            args = argparse.Namespace(output_archive=None, repository='fixture', target_dir=str(root / 'target'), author_archive=author)
            identity = package.release.build_provenance.identity()
            inputs = {**identity, 'configuration': {'cargo_arguments': ['build', '--locked', '--release'],
                'compiler': f"release: {identity['rust_toolchain']}\nhost: {identity['target']}",
                'environment': {}, 'cargo_configs': {}}}

            def run(arguments, **kwargs):
                if arguments[0] != 'cargo':
                    return
                binaries = [arguments[i + 1] for i, value in enumerate(arguments) if value == '--bin']
                self.assertEqual(set(binaries), set(package.release.BINARIES))
                output = root / 'target/release'
                output.mkdir(parents=True)
                for name in binaries:
                    (output / name).write_bytes(name.encode())

            def archive(artifacts, *arguments, **kwargs):
                record = package.release.build_provenance.verify(artifacts)
                self.assertEqual(record['inputs'], inputs)
                return {'sha256': 'fixture'}

            with patch.object(package.support, 'run', side_effect=run), patch.object(package.release, 'sign'), patch.object(package.release.build_provenance, 'inputs', return_value=inputs), patch.object(package, 'archive_payload', side_effect=archive), patch.object(package, 'install_archive'):
                package.source_build(args)
