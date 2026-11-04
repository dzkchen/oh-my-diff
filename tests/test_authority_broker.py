import hashlib
import json
from pathlib import Path
import plistlib
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


def signed(key, path, body, namespace=authority_broker.SIGNING_NAMESPACE):
    path.parent.mkdir(exist_ok=True)
    path.write_bytes(body)
    path.with_name(path.name + ".sig").unlink(missing_ok=True)
    subprocess.run(["ssh-keygen", "-Y", "sign", "-q", "-f", key, "-n", namespace, path], check=True)
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
            body = json.dumps({"schema": 1, "version": "1.0.0", "artifacts": artifacts}).encode()
            manifest = signed(key, base / "omd-release.json", body)
            forged = signed(other_key, base / "forged/omd-release.json", body)
            missing = base / "missing/omd-release.json"
            missing.parent.mkdir()
            missing.write_bytes(body)
            with mock.patch.object(authority_broker, "RELEASE_KEY", public), \
                    mock.patch.object(authority_broker, "cdhash", side_effect=AssertionError("cdhash before the signature check")), \
                    mock.patch.object(authority_broker, "create_account", side_effect=AssertionError("deployed unsigned")):
                with self.assertRaisesRegex(ValueError, "stray is not listed"):
                    authority_broker.install(stray, helper, [codex], [manifest])
                with self.assertRaisesRegex(ValueError, "codex is not listed as omd-broker"):
                    authority_broker.install(codex, helper, [codex], [manifest])
                with self.assertRaisesRegex(ValueError, "omd-broker is not listed as authority_broker.py"):
                    authority_broker.install(helper, helper, [codex], [manifest])
                for unsigned, error in ((forged, "not signed by the Oh My Diff release key"),
                                        (missing, "has no signed omd-release.json")):
                    with self.assertRaisesRegex(ValueError, error):
                        authority_broker.install(helper, helper, [codex], [unsigned])
            hashed = []
            tooling, copy = base / "tooling.py", base / "tools/authority_broker.py"
            tooling.write_bytes(b"new tooling")
            copy.parent.mkdir()
            copy.write_bytes(b"old tooling")
            (base / "pins.json").write_text(json.dumps({"cdhashes": ["old"], "version": "1.0.0"}))
            newer = dict(artifacts, **{"authority_broker.py": hashlib.sha256(b"new tooling").hexdigest()})
            update = signed(key, base / "update/omd-release.json",
                            json.dumps({"schema": 1, "version": "1.0.1", "artifacts": newer}).encode())
            older = signed(key, base / "older/omd-release.json",
                           json.dumps({"schema": 1, "version": "1.0.0-rc.1", "artifacts": newer}).encode())
            with mock.patch.object(authority_broker, "RELEASE_KEY", public), \
                    mock.patch.multiple(authority_broker, ROOT=base, COPY=copy), mock.patch("os.fchown"), mock.patch("os.chown"), \
                    mock.patch.object(authority_broker, "cdhash", side_effect=lambda path: hashed.append(path) or path.read_text()):
                with self.assertRaisesRegex(ValueError, "stray is not listed"):
                    authority_broker.write_pins([codex, stray], [manifest], tooling)
                self.assertEqual(authority_broker.write_pins([codex, helper], [manifest], tooling), ["codex", "omd-broker"])
                self.assertEqual(copy.read_bytes(), b"old tooling")
                self.assertEqual(authority_broker.write_pins([codex], [manifest, update], tooling, add=True),
                                 ["codex", "omd-broker"])
                self.assertEqual(copy.read_bytes(), b"new tooling")
                self.assertEqual(json.loads((base / "pins.json").read_text())["version"], "1.0.1")
                with self.assertRaisesRegex(ValueError, "pins 1.0.1; refusing the older 1.0.0-rc.1"):
                    authority_broker.write_pins([codex], [older], tooling)
                with self.assertRaisesRegex(ValueError, "refusing the older 1.0.0"):
                    authority_broker.write_pins([codex], [manifest], tooling)
                nightly = signed(key, base / "nightly/omd-release.json", json.dumps(
                    {"schema": 1, "version": "1.0.1-nightly.20261018000000.1.1", "artifacts": newer}).encode())
                authority_broker.write_pins([codex], [nightly], tooling)
                self.assertEqual(json.loads((base / "pins.json").read_text())["version"], "1.0.1-nightly.20261018000000.1.1")
            self.assertNotIn(codex, hashed)
            self.assertNotIn(helper, hashed)

    def test_installer_and_broker_pin_the_same_release_key(self):
        code = (Path(__file__).resolve().parents[1] / "install.sh").read_text()
        self.assertIn(f'RELEASE_KEY = "{authority_broker.RELEASE_KEY}"\n', code)
        self.assertIn(f'SIGNING_NAMESPACE = "{authority_broker.SIGNING_NAMESPACE}"\n', code)


class PowerHelperDaemonTest(unittest.TestCase):
    def test_install_runs_the_power_helper_as_root_for_the_broker_only_and_uninstall_restores_sleep(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            root = base / "OhMyDiff/broker"
            paths = {"ROOT": root, "TOOLS": root.parent / "tools", "COPY": root.parent / "tools/authority_broker.py",
                     "HELPER": base / "helper", "DAEMON": base / "broker.plist",
                     "POWER_DAEMON": base / "power.plist", "POWER_RECORD": root.parent / "power.json",
                     "POLICY": root.parent / "policy.json", "SOCKET": str(base / "broker.sock"),
                     "POWER_SOCKET": str(base / "power.sock")}
            commands = []
            with mock.patch.multiple(authority_broker, **paths), \
                    mock.patch.multiple(authority_broker, signed_releases=lambda _: [{"version": "1.0.0"}],
                                        signed_hashes=lambda _: {}, signed_bytes=lambda *_: b"signed",
                                        signed_cdhashes=lambda *_: ["pin"], create_account=lambda: None,
                                        run=lambda *arguments, **_: commands.append(arguments) or mock.Mock(returncode=0)), \
                    mock.patch("grp.getgrnam", return_value=mock.Mock(gr_gid=301)), \
                    mock.patch("shutil.chown"), mock.patch("os.fchown"), mock.patch("os.chown"):
                authority_broker.install(base / "omd-broker", base / "tooling.py", [], [])
                power = plistlib.loads(paths["POWER_DAEMON"].read_bytes())
                self.assertEqual(power["ProgramArguments"], [str(paths["HELPER"]), "power"])
                self.assertNotIn("UserName", power)
                self.assertEqual(power["Sockets"]["Listener"], {"SockPathName": authority_broker.POWER_SOCKET,
                                                                "SockPathMode": 0o660, "SockPathOwner": 0,
                                                                "SockPathGroup": 301})
                self.assertIn(("/bin/launchctl", "bootstrap", "system", paths["POWER_DAEMON"]), commands)
                paths["POWER_RECORD"].write_text(json.dumps({"previous": True}))
                authority_broker.uninstall()
                self.assertIn(("/usr/bin/pmset", "-a", "disablesleep", "1"), commands)
                self.assertFalse(paths["POWER_DAEMON"].exists() or paths["POWER_RECORD"].exists())


class AdministratorPolicyFileTest(unittest.TestCase):
    def test_broker_uninstall_refuses_to_report_success_when_system_records_remain(self):
        for failed, message in (("bootout", "service is still running"), ("remove", "authorization right remains"),
                                ("-delete", "account record remains")):
            with self.subTest(failed=failed), tempfile.TemporaryDirectory() as temporary:
                base = Path(temporary)
                root = base / "OhMyDiff/broker"
                paths = {"ROOT": root, "POLICY": root.parent / "policy.json", "TOOLS": root.parent / "tools",
                         "HELPER": base / "helper", "DAEMON": base / "broker.plist", "POWER_DAEMON": base / "power.plist",
                         "POWER_RECORD": base / "power.json", "SOCKET": str(base / "broker.sock"),
                         "POWER_SOCKET": str(base / "power.sock")}
                paths["DAEMON"].write_text("managed")

                def run(*arguments, **kwargs):
                    return mock.Mock(returncode=int(failed in arguments))

                with mock.patch.multiple(authority_broker, **paths), mock.patch.object(authority_broker, "run", side_effect=run), \
                        self.assertRaisesRegex(ValueError, message):
                    authority_broker.uninstall(purge=True)
                self.assertTrue(paths["DAEMON"].is_file())

    def test_broker_uninstall_parses_purge_without_changing_the_system(self):
        with mock.patch("os.geteuid", return_value=0), mock.patch.object(authority_broker, "uninstall", return_value={}) as remove:
            authority_broker.main(["uninstall", "--purge"])
        remove.assert_called_once_with(True)

    def test_broker_uninstall_reports_an_incomplete_directory_removal(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            root = base / "OhMyDiff/broker"
            root.mkdir(parents=True)
            paths = {"ROOT": root, "POLICY": root.parent / "policy.json", "TOOLS": root.parent / "tools",
                     "HELPER": base / "helper", "DAEMON": base / "broker.plist", "POWER_DAEMON": base / "power.plist",
                     "POWER_RECORD": base / "power.json", "SOCKET": str(base / "broker.sock"),
                     "POWER_SOCKET": str(base / "power.sock")}
            with mock.patch.multiple(authority_broker, **paths), mock.patch.object(authority_broker, "run"), \
                    mock.patch.object(authority_broker.shutil, "rmtree", side_effect=PermissionError("broker is locked")), \
                    self.assertRaisesRegex(PermissionError, "broker is locked"):
                authority_broker.uninstall(purge=True)
            self.assertTrue(root.exists())

    def test_broker_uninstall_purge_removes_both_policy_files_and_keeps_user_files(self):
        for purge in (False, True):
            with self.subTest(purge=purge), tempfile.TemporaryDirectory() as temporary:
                base = Path(temporary)
                root = base / "OhMyDiff/broker"
                root.mkdir(parents=True)
                (root / "credentials.json").write_text("protected")
                policy = root.parent / "policy.json"
                previous = policy.with_name("policy.json.previous")
                for path in (policy, previous):
                    path.write_text("{}")
                personal = root.parent / "personal.txt"
                personal.write_text("keep")
                paths = {"ROOT": root, "POLICY": policy, "TOOLS": root.parent / "tools", "HELPER": base / "helper",
                         "DAEMON": base / "broker.plist", "POWER_DAEMON": base / "power.plist",
                         "POWER_RECORD": base / "power.json", "SOCKET": str(base / "broker.sock"),
                         "POWER_SOCKET": str(base / "power.sock")}
                with mock.patch.multiple(authority_broker, **paths), mock.patch.object(authority_broker, "run"):
                    result = authority_broker.uninstall(purge=purge)
                self.assertEqual(policy.exists(), not purge)
                self.assertEqual(previous.exists(), not purge)
                self.assertFalse(root.exists())
                self.assertEqual(personal.read_text(), "keep")
                self.assertEqual(result["purged_administrator_policy" if purge else "preserved_administrator_policy"],
                                 [str(policy), str(previous)])

    def test_install_rollback_and_remove_keep_one_previous_policy(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            policy = base / "OhMyDiff/policy.json"
            previous = policy.with_name("policy.json.previous")
            first, second = base / "first.json", base / "second.json"
            first.write_text(json.dumps({"schema": 1}))
            second.write_text(json.dumps({"schema": 1, "managed_only": True}))
            with mock.patch.object(authority_broker, "POLICY", policy), mock.patch("os.fchown"), mock.patch("os.chown"):
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
