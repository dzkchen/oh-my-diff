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


if __name__ == "__main__":
    unittest.main()
