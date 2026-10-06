import importlib.util
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

spec = importlib.util.spec_from_file_location("nightly", Path(__file__).resolve().parents[1] / "scripts/nightly.py")
nightly = importlib.util.module_from_spec(spec)
spec.loader.exec_module(nightly)


class SummarizeTests(unittest.TestCase):
    def test_report_names_the_selected_ref(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with mock.patch.multiple(nightly, ROOT=root, WORK=root / "work", REPO=root / "repo"), \
                 mock.patch("sys.argv", ["nightly", "--ref", "fixes/findings"]), \
                 mock.patch.object(nightly.subprocess, "run", return_value=SimpleNamespace(stdout="23b63db\n")), \
                 mock.patch.object(nightly, "run", side_effect=lambda name, _: {
                     "name": name, "status": 0, "seconds": 0, "log": name, "tail": [],
                 }), mock.patch("builtins.print"):
                self.assertEqual(nightly.main(), 0)
            report = (root / "work/report.md").read_text()
            self.assertIn("fixes/findings at `23b63db`", report)
            self.assertNotIn("main", report)

    def test_a_failed_setup_keeps_unrun_failures_and_reports_them_as_skipped(self):
        summary = nightly.summarize([{"name": "setup", "status": 1}], ["mods tests"])
        self.assertEqual(summary["fixed"], [])
        self.assertEqual(summary["new"], ["setup"])
        self.assertEqual(summary["unresolved"], ["setup", "mods tests"])
        self.assertEqual(summary["skipped"], [name for name, _ in nightly.STEPS[1:]])

    def test_only_rerun_steps_count_as_fixed(self):
        results = [{"name": name, "status": 0} for name, _ in nightly.STEPS]
        summary = nightly.summarize(results, ["mods tests"])
        self.assertEqual((summary["fixed"], summary["unresolved"], summary["skipped"]), (["mods tests"], [], []))


if __name__ == "__main__":
    unittest.main()
