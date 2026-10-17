import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

from scripts import authority_broker


def signing_key(directory):
    Path(directory).mkdir(exist_ok=True)
    key = Path(directory) / "release-key"
    subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "", "-f", key], check=True)
    return key, key.with_suffix(".pub").read_text().strip()


def signed(key, path, body):
    path.parent.mkdir(exist_ok=True)
    path.write_bytes(body)
    path.with_name(path.name + ".sig").unlink(missing_ok=True)
    subprocess.run(["ssh-keygen", "-Y", "sign", "-q", "-f", key, "-n", authority_broker.SIGNING_NAMESPACE, path], check=True)
    return path


class SignedReleaseAnchorTest(unittest.TestCase):
    def test_install_and_pin_accept_only_binaries_in_a_signed_manifest(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            key, public = signing_key(base)
            other_key, _ = signing_key(base / "other")
            helper, codex, stray = base / "omd-broker", base / "codex", base / "stray"
            for path in (helper, codex, stray):
                path.write_bytes(path.name.encode())
            artifacts = {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in (helper, codex)}
            body = json.dumps({"schema": 1, "artifacts": artifacts}).encode()
            manifest = signed(key, base / "omd-release.json", body)
            forged = signed(other_key, base / "forged/omd-release.json", body)
            missing = base / "missing/omd-release.json"
            missing.parent.mkdir()
            missing.write_bytes(body)
            with mock.patch.object(authority_broker, "RELEASE_KEY", public), \
                    mock.patch.object(authority_broker, "cdhash", side_effect=AssertionError("cdhash before the signature check")), \
                    mock.patch.object(authority_broker, "create_account", side_effect=AssertionError("deployed unsigned")):
                authority_broker.require_signed([helper, codex], [manifest])
                with self.assertRaisesRegex(ValueError, "stray is not listed"):
                    authority_broker.write_pins([codex, stray], [manifest])
                with self.assertRaisesRegex(ValueError, "stray is not listed"):
                    authority_broker.install(stray, [codex], [manifest])
                for unsigned in (forged, missing):
                    with self.assertRaisesRegex(ValueError, "not signed by the Oh My Diff release key"):
                        authority_broker.install(helper, [codex], [unsigned])

    def test_installer_and_broker_pin_the_same_release_key(self):
        code = (Path(__file__).resolve().parents[1] / "install.sh").read_text()
        self.assertIn(f'RELEASE_KEY = "{authority_broker.RELEASE_KEY}"\n', code)
        self.assertIn(f'SIGNING_NAMESPACE = "{authority_broker.SIGNING_NAMESPACE}"\n', code)


class AdministratorPolicyFileTest(unittest.TestCase):
    def test_install_rollback_and_remove_keep_one_previous_policy(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            policy = base / "OhMyDiff/policy.json"
            previous = policy.with_name("policy.json.previous")
            first, second = base / "first.json", base / "second.json"
            first.write_text(json.dumps({"schema": 1}))
            second.write_text(json.dumps({"schema": 1, "managed_only": True}))
            with mock.patch.object(authority_broker, "POLICY", policy), mock.patch("os.chown"):
                authority_broker.policy("policy-install", first)
                self.assertFalse(previous.exists())
                self.assertEqual(policy.stat().st_mode & 0o777, 0o644)
                authority_broker.policy("policy-install", second)
                self.assertEqual(json.loads(previous.read_text()), {"schema": 1})
                authority_broker.policy("policy-rollback")
                self.assertEqual(json.loads(policy.read_text()), {"schema": 1})
                self.assertTrue(json.loads(previous.read_text())["managed_only"])
                self.assertEqual(authority_broker.policy("policy-remove")["installed"], False)
                self.assertFalse(policy.exists())
                authority_broker.policy("policy-rollback")
                self.assertEqual(json.loads(policy.read_text()), {"schema": 1})
                self.assertFalse(previous.exists())
                with self.assertRaises(ValueError):
                    authority_broker.policy("policy-rollback")
                bad = base / "bad.json"
                bad.write_text("{")
                with self.assertRaises(ValueError):
                    authority_broker.policy("policy-install", bad)
                self.assertEqual(json.loads(policy.read_text()), {"schema": 1})


if __name__ == "__main__":
    unittest.main()
