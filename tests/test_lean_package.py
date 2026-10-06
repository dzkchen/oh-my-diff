import argparse
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from scripts import lean_package


class SourceBuildTests(unittest.TestCase):
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
