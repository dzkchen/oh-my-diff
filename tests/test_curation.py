import copy
import json
from pathlib import Path
import tempfile
import unittest

from benchmarks.compare import read
from benchmarks.curate import export_task, safe_task, validate
from benchmarks.scenarios import score_scenario, validate_scenarios


ROOT = Path(__file__).resolve().parents[1] / "benchmarks/corpus"


class CurationTests(unittest.TestCase):
    def setUp(self):
        self.catalog = read(ROOT / "catalog.json")
        self.scenarios = read(ROOT / "scenarios.json")

    def test_two_suites_three_splits_and_full_focused_coverage(self):
        self.assertEqual(validate(self.catalog)["tasks"], 88)
        self.assertEqual(validate_scenarios(self.scenarios)["coverage_cells"], 18)
        external = [t for t in self.catalog["tasks"] if t["suite"] == "external-multi-swe"]
        for split in ("development", "validation", "held-out"):
            self.assertEqual({t["language"] for t in external if t["split"] == split}, {"c", "cpp", "go", "java", "js", "ts", "rust"})

    def test_exposed_repository_cannot_enter_holdout(self):
        for task in self.catalog["tasks"]:
            if task["repository"] == "serde-rs/serde":
                task["split"] = "held-out"
        with self.assertRaisesRegex(ValueError, "quarantine"):
            validate(self.catalog)

    def test_duplicate_solution_or_repository_cross_split_rejected(self):
        first = self.catalog["tasks"][0]
        other = next(t for t in self.catalog["tasks"] if t["split"] != first["split"])
        other["gold_sha256"] = first["gold_sha256"]
        with self.assertRaisesRegex(ValueError, "duplicate solutions"):
            validate(self.catalog)

    def test_heldout_export_is_locked_before_data_is_read(self):
        task = next(t for t in self.catalog["tasks"] if t["split"] == "held-out")
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(ValueError, "approved freeze"):
                export_task(ROOT / "catalog.json", task["id"], Path(tmp), Path(tmp) / "output.json")

    def test_new_to_pass_compilation_repair_retains_zero_regression_count(self):
        row = {"org": "example", "repo": "repo", "number": 1, "base": {"sha": "a" * 40},
               "fix_patch": "fixture", "test_patch": "fixture", "n2p_tests": {"new-test": {}}, "p2p_tests": {}}
        task = safe_task(row, "rust", {})
        self.assertEqual(task["new_to_pass_count"], 1)
        self.assertEqual(task["pass_to_pass_count"], 0)
        self.assertIn("require base/gold/wrong-patch", task["regression_coverage"])

    def test_scenario_checks_require_every_observation(self):
        for scenario in self.scenarios["scenarios"]:
            observations = {}
            for assertion in scenario["assertions"]:
                parts = assertion["path"].split(".")
                node = observations
                for part in parts[:-1]:
                    node = node.setdefault(part, {})
                node[parts[-1]] = assertion["equals"]
            self.assertTrue(score_scenario(scenario, observations)["accepted"])
            self.assertFalse(score_scenario(scenario, {})["accepted"])
            for assertion in scenario["assertions"]:
                changed = copy.deepcopy(observations)
                node = changed
                parts = assertion["path"].split(".")
                for part in parts[:-1]:
                    node = node[part]
                del node[parts[-1]]
                self.assertFalse(score_scenario(scenario, changed)["accepted"])


if __name__ == "__main__":
    unittest.main()
