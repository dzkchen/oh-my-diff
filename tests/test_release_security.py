import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from scripts import authority_broker, install_support

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / '.github/scripts'))
import ci


class ReleaseReviewFixes(unittest.TestCase):
    def test_root_write_refuses_a_preplanted_temporary_symlink(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            victim = root / 'victim'
            victim.write_bytes(b'keep')
            path = root / 'pins.json'
            (root / f'.pins.json.{os.getpid()}').symlink_to(victim)
            (root / '.pins.json.fixed').symlink_to(victim)
            with mock.patch('secrets.token_hex', return_value='fixed'), mock.patch.object(os, 'chown'), mock.patch.object(os, 'fchown'):
                try:
                    authority_broker.write_root(path, b'replaced', 0o644)
                except FileExistsError:
                    pass
            self.assertEqual(victim.read_bytes(), b'keep')

    def test_reset_does_not_follow_a_store_directory_symlink(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            root, outside = base / 'broker', base / 'outside'
            (root / 'stores').mkdir(parents=True)
            outside.mkdir()
            grants = outside / 'grants.json'
            grants.write_text('keep')
            (root / 'stores' / 'attacker').symlink_to(outside, target_is_directory=True)
            with mock.patch.object(authority_broker, 'ROOT', root):
                authority_broker.reset()
            self.assertEqual(grants.read_text(), 'keep')

    def test_upstream_checksum_mismatch_is_rejected_before_extraction(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / 'upstream'
            def output(argv):
                if argv[0] == 'curl':
                    (directory / 'codex.tar.gz').write_bytes(b'tampered')
                else:
                    self.fail('extracted an unverified archive')
            with mock.patch.object(ci.support, 'output', side_effect=output):
                with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
                    ci.upstream_codex('rust-v0.166.0', directory)

    def test_dry_run_with_a_key_stays_unsigned(self):
        from tests.test_pr_ci import HostedJobs
        original = ci.publish
        def publish(*args, **kwargs):
            with mock.patch.dict(os.environ, {'OMD_RELEASE_SIGNING_KEY': 'present'}), mock.patch.object(ci, 'sign', side_effect=AssertionError('dry run signed')):
                return original(*args, **kwargs)
        with mock.patch.object(ci, 'publish', side_effect=publish):
            HostedJobs().test_a_release_dry_run_without_the_signing_key_prints_the_commands_unsigned()

    def test_package_digest_frames_binary_asset_boundaries(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'mod.json').write_text(json.dumps({'entrypoint': 'index.ts', 'assets': ['a', 'b']}))
            (root / 'index.ts').write_text('export default () => {}')
            (root / 'a').write_bytes(b'x\0b\0y')
            (root / 'b').write_bytes(b'z')
            first = install_support.package_digest(root)
            (root / 'a').write_bytes(b'x')
            (root / 'b').write_bytes(b'y\0b\0z')
            self.assertNotEqual(first, install_support.package_digest(root))

    def test_truncated_curl_installer_fails_before_running_python(self):
        source = (Path(__file__).resolve().parents[1] / 'install.sh').read_text()
        for end in (source.index('import argparse'), source.rindex('install_main "$@"')):
            with self.subTest(end=end):
                result = subprocess.run(['sh'], input=source[:end], text=True, capture_output=True)
                self.assertNotEqual(result.returncode, 0)
