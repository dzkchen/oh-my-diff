import argparse
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from scripts import lean_package


class SourceBuildTests(unittest.TestCase):
    def test_archive_preserves_the_artifact_bound_build_record(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifacts = root / 'artifacts'
            artifacts.mkdir()
            provenance = {'schema': 1, 'inputs': {'runtime_patch_sha256': 'fixture'}, 'signed': {}}
            for name in lean_package.release.BINARIES + (lean_package.release.AUTHOR_ARCHIVE,):
                (artifacts / name).write_text(name)
            (artifacts / lean_package.release.build_provenance.RECORD).write_text(json.dumps(provenance))
            record = {'version': 'fixture', 'target': 'fixture', 'upstream_tag': 'fixture',
                      'mod_api': 'fixture', 'node': 'fixture', 'build_provenance': provenance}
            lock = root / 'lock.json'
            lock.write_text(json.dumps(record))
            with patch.object(lean_package.release, 'build', return_value=record), \
                    patch.object(lean_package.release, 'OUTPUT', lock), patch.object(lean_package, 'copy_sources'):
                packed = lean_package.archive_payload(artifacts, root / 'package.tar.xz')
            destination = root / 'unpacked'
            destination.mkdir()
            payload = lean_package.checked_extract(root / 'package.tar.xz', packed['sha256'], destination)
            self.assertEqual(json.loads((payload / 'artifacts' / lean_package.release.build_provenance.RECORD).read_text()), provenance)

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

            def run(*arguments, **kwargs):
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

            with patch.object(lean_package, 'run', side_effect=run), patch.object(lean_package.release, 'sign'), patch.object(lean_package.release.build_provenance, 'inputs', return_value=inputs), patch.object(lean_package, 'archive_payload', side_effect=archive), patch.object(lean_package, 'install_archive'):
                lean_package.source_build(args)
