import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("nightly", Path(__file__).resolve().parents[1] / "scripts/nightly.py")
nightly = importlib.util.module_from_spec(spec)
spec.loader.exec_module(nightly)


class SummarizeTests(unittest.TestCase):
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
