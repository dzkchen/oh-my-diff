import importlib.util
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock
from scripts import lean_release_lock

spec = importlib.util.spec_from_file_location("batch_tree", Path(__file__).resolve().parents[1] / "scripts/batch_tree.py")
batch_tree = importlib.util.module_from_spec(spec)
spec.loader.exec_module(batch_tree)


class CleanTests(unittest.TestCase):
    def test_release_artifacts_build_and_copy_release_binaries_with_platform_signing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            binaries = root / "omd-bx/target/release"
            binaries.mkdir(parents=True)
            for name in batch_tree.BINARIES:
                (binaries / name).write_bytes(name.encode())
            with mock.patch.object(batch_tree, "TMP", root), \
                    mock.patch.object(batch_tree, "cargo_run", return_value=0) as cargo, \
                    mock.patch.object(batch_tree, "pack_sdk"), mock.patch.object(lean_release_lock, "sign") as sign:
                with mock.patch.object(batch_tree.sys, "platform", "linux"):
                    batch_tree.artifacts(SimpleNamespace(batch="x", build=True, profile="release"))
                    sign.assert_not_called()
                self.assertIn("--release", cargo.call_args.args[-1])
                self.assertEqual((root / "omd-bx/artifacts/codex").read_bytes(), b"codex")
                with mock.patch.object(batch_tree.sys, "platform", "darwin"):
                    batch_tree.artifacts(SimpleNamespace(batch="x", build=False, profile="release"))
                self.assertEqual(sign.call_count, len(lean_release_lock.HARDENED))

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


if __name__ == "__main__":
    unittest.main()
