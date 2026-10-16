import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
import build
from scripts import build_provenance, release_lock


class BuildTests(unittest.TestCase):
    def test_cargo_environment_keeps_the_node_resolved_before_home_isolation(self):
        with mock.patch.dict(os.environ, {"HOME": "/isolated-home", "OMD_TEST_NODE": "/real/node"}), \
                mock.patch.object(build, "run", return_value=b"host: fixture-target\n") as child:
            env = build.cargo_env(Path("/batch"))
        self.assertEqual(env["OMD_TEST_NODE"], "/real/node")
        self.assertEqual(env["HOME"], "/isolated-home")
        self.assertFalse(any(call.args[0] == "mise" for call in child.call_args_list))

    def test_release_artifacts_build_and_copy_release_binaries_with_platform_signing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            binaries = root / "omd-bx/target/release"
            binaries.mkdir(parents=True)
            for name in build.BINARIES:
                (binaries / name).write_bytes(name.encode())
            with mock.patch.object(build, "TMP", root), \
                    mock.patch.object(build, "cargo_run", return_value=0) as cargo, \
                    mock.patch.object(build, "pack_sdk"), mock.patch.object(release_lock, "sign") as sign:
                with mock.patch.object(build.sys, "platform", "linux"):
                    build.artifacts(SimpleNamespace(batch="x", release=True))
                    sign.assert_not_called()
                self.assertIn("--release", cargo.call_args.args[-1])
                self.assertEqual((root / "omd-bx/artifacts/codex").read_bytes(), b"codex")
                with mock.patch.object(build.sys, "platform", "darwin"):
                    build.artifacts(SimpleNamespace(batch="x", release=False))
                self.assertEqual(sign.call_count, len(release_lock.HARDENED))



class ArtifactTests(unittest.TestCase):
    def test_artifacts_build_sign_and_copy_the_release_profile(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            batch = root / "omd-bx"
            for profile in ("debug", "release"):
                built = batch / "target" / profile
                built.mkdir(parents=True)
                for name in build.BINARIES:
                    (built / name).write_text(profile)
            with mock.patch.object(build, "TMP", root), \
                    mock.patch.object(build, "cargo_run", return_value=0) as cargo, \
                    mock.patch.object(build, "pack_sdk") as pack, \
                    mock.patch.object(release_lock, "sign") as sign, \
                    mock.patch.object(build, "cargo_env", return_value={}), \
                    mock.patch.object(build_provenance, "inputs", return_value="inputs") as inputs, \
                    mock.patch.object(build_provenance, "record_build") as record_build, \
                    mock.patch.object(build_provenance, "verify", return_value={"unsigned": "hashes"}), \
                    mock.patch.object(build_provenance, "hashes", return_value="hashes"), \
                    mock.patch.object(build_provenance, "record_signing") as record_signing, \
                    mock.patch.object(build.sys, "platform", "darwin"):
                build.artifacts(SimpleNamespace(batch="x", release=True))
            cargo.assert_called_once_with(batch, "build-artifacts", [*build.BUILD, "--release"])
            self.assertEqual(inputs.call_args_list, [mock.call(batch / "codex", [*build.BUILD, "--release"], {})] * 2)
            record_build.assert_called_once_with(batch / "target/release", "inputs", "inputs")
            record_signing.assert_called_once_with(batch / "artifacts", {"unsigned": "hashes"})
            pack.assert_called_once_with(batch / "artifacts")
            self.assertCountEqual(sign.call_args_list,
                                  [mock.call(batch / "artifacts" / name) for name in release_lock.HARDENED])
            for name in build.BINARIES:
                self.assertEqual((batch / "artifacts" / name).read_text(), "release")

    def test_artifacts_refuse_a_debug_only_target(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            built = root / "omd-bx/target/debug"
            built.mkdir(parents=True)
            for name in build.BINARIES:
                (built / name).touch()
            with mock.patch.object(build, "TMP", root), self.assertRaisesRegex(SystemExit, "--release"):
                build.artifacts(SimpleNamespace(batch="x", release=False))


if __name__ == "__main__":
    unittest.main()
