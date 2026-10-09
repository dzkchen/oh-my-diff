import importlib.util
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

spec = importlib.util.spec_from_file_location("batch_tree", Path(__file__).resolve().parents[1] / "scripts/batch_tree.py")
batch_tree = importlib.util.module_from_spec(spec)
spec.loader.exec_module(batch_tree)


class CleanTests(unittest.TestCase):
    def test_keep_warm_replaces_only_the_profiles_the_batch_built(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            warm = root / "warm"
            for path in (warm / "debug/deps/libold.rlib", warm / "release/codex",
                         root / "omd-bx/target/debug/deps/libserde.rlib", root / "omd-bx/target/debug/deps/libcodex_omd.rlib"):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.touch()
            with mock.patch.multiple(batch_tree, TMP=root, WARM=warm):
                batch_tree.clean(SimpleNamespace(batch="x", keep_warm=True, tree=False))
            self.assertEqual(sorted(path.name for path in (warm / "debug/deps").iterdir()), ["libserde.rlib"])
            self.assertTrue((warm / "release/codex").is_file())
            self.assertFalse((root / "omd-bx/target").exists())


class ArtifactTests(unittest.TestCase):
    def test_artifacts_build_sign_and_copy_the_release_profile(self):
        from scripts import lean_release_lock

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            batch = root / "omd-bx"
            for profile in batch_tree.PROFILES:
                built = batch / "target" / profile
                built.mkdir(parents=True)
                for name in batch_tree.BINARIES:
                    (built / name).write_text(profile)
            with mock.patch.object(batch_tree, "TMP", root), \
                    mock.patch.object(batch_tree, "cargo_run", return_value=0) as cargo, \
                    mock.patch.object(batch_tree, "pack_sdk") as pack, \
                    mock.patch.object(lean_release_lock, "sign") as sign:
                batch_tree.artifacts(SimpleNamespace(batch="x", release=True))
            cargo.assert_called_once_with(batch, "build-artifacts", [*batch_tree.BUILD, "--release"])
            pack.assert_called_once_with(batch / "artifacts")
            self.assertCountEqual(sign.call_args_list,
                                  [mock.call(batch / "artifacts" / name) for name in lean_release_lock.HARDENED])
            for name in batch_tree.BINARIES:
                self.assertEqual((batch / "artifacts" / name).read_text(), "release")

    def test_artifacts_refuse_a_debug_only_target(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            built = root / "omd-bx/target/debug"
            built.mkdir(parents=True)
            for name in batch_tree.BINARIES:
                (built / name).touch()
            with mock.patch.object(batch_tree, "TMP", root), self.assertRaisesRegex(SystemExit, "--release"):
                batch_tree.artifacts(SimpleNamespace(batch="x", release=False))


if __name__ == "__main__":
    unittest.main()
