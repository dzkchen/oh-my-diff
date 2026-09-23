import copy
import json
from pathlib import Path
import tempfile
import unittest

from benchmarks import compare as c
from benchmarks import fixture as f


class ComparisonTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.m = f.create_manifest(self.root)

    def test_balanced_reproducible_order(self):
        plan = c.schedule(self.m)
        self.assertEqual(plan, c.schedule(copy.deepcopy(self.m)))
        self.assertEqual(len({r["id"] for r in plan}), 18)
        orders = [tuple(r["arm"] for r in plan[i:i + 3]) for i in range(0, 18, 3)]
        self.assertEqual(len(set(orders)), 6)

    def test_genuine_upstream_and_fixed_models(self):
        self.m["arms"]["default-upstream"]["runtime_patches"] = ["omd-disabled"]
        with self.assertRaisesRegex(ValueError, "unmodified"):
            c.validate_manifest(self.m, self.root)
        self.m["arms"]["default-upstream"]["runtime_patches"] = []
        self.m["arms"]["omd"]["requested_model"] = "different"
        with self.assertRaisesRegex(ValueError, "assignments differ"):
            c.validate_manifest(self.m, self.root)

    def test_no_unimplemented_omd_claim(self):
        self.m["purpose"] = "development"
        with self.assertRaisesRegex(ValueError, "no Oh My Diff patch"):
            c.validate_manifest(self.m, self.root)

    def test_legacy_arm_remains_replayable(self):
        self.m["arms"][c.LEGACY_OMD_ARM] = self.m["arms"].pop("omd")
        c.validate_manifest(self.m, self.root)
        plan = c.schedule(self.m)
        self.assertEqual({run["arm"] for run in plan}, {*c.ARMS[:2], c.LEGACY_OMD_ARM})

    def test_upstream_pilot_schedule_and_holdout_denial(self):
        self.m["comparison"] = "upstream-pilot"
        del self.m["arms"]["omd"]
        c.validate_manifest(self.m, self.root)
        plan = c.schedule(self.m)
        self.assertEqual(len(plan), 12)
        self.assertEqual({r["arm"] for r in plan}, set(c.ARMS[:2]))
        orders = [tuple(r["arm"] for r in plan[i:i + 2]) for i in range(0, 12, 2)]
        self.assertEqual(orders.count(c.ARMS[:2]), 3)
        self.assertEqual(orders.count(tuple(reversed(c.ARMS[:2]))), 3)
        result = c.report(self.m, *self.pipeline())
        self.assertTrue(result["schedule_complete"])
        self.assertTrue(result["assessment_complete"])
        self.assertEqual(set(result["arm_provenance"]), set(c.ARMS[:2]))
        self.m["purpose"] = "held-out"
        with self.assertRaisesRegex(ValueError, "development-only"):
            c.validate_manifest(self.m, self.root)
        self.m["purpose"] = "fixture"
        del self.m["comparison"]
        with self.assertRaisesRegex(ValueError, "comparator arms"):
            c.validate_manifest(self.m, self.root)

    def test_content_tampering_and_path_escape(self):
        ref = self.m["tasks"][0]["prompt"]
        (self.root / ref["path"]).write_text("changed")
        with self.assertRaisesRegex(ValueError, "changed"):
            c.validate_manifest(self.m, self.root)
        with self.assertRaisesRegex(ValueError, "escapes"):
            c.artifact(self.root, {"path": "../outside", "sha256": "x"})

    def test_cache_and_reasoning_not_double_charged(self):
        usage = {"input": 100, "cache_read": 20, "cache_write": 10, "output": 30, "reasoning": 7}
        rates = {"semantics": "input-includes-disjoint-cache;output-includes-reasoning",
                 "input": "1", "cache_read": "0.1", "cache_write": "2", "output": "3"}
        self.assertEqual(c.estimate_tokens(usage, rates), "0.000182")
        usage["reasoning"] = 31
        with self.assertRaisesRegex(ValueError, "subsets"):
            c.estimate_tokens(usage, rates)

    def test_unknown_subscription_duplicate_and_invalid_money(self):
        event = f.charge(self.root, "cancel", basis="unknown", status="cancelled")
        totals = c.money([event])
        self.assertEqual(totals["task_api"]["unknown"], 1)
        with self.assertRaisesRegex(ValueError, "duplicate"):
            c.money([event, event])
        event["usd"] = "0"
        with self.assertRaisesRegex(ValueError, "cannot"):
            c.money([event])
        event["basis"] = "actual"
        event["usd"] = "NaN"
        with self.assertRaisesRegex(ValueError, "nonfinite"):
            c.money([event])
        event["basis"], event["usd"] = "subscription", None
        self.assertEqual(c.money([event])["task_api"]["subscription"], 1)

    def pipeline(self):
        f.execute(self.root, self.m)
        runs, missing = c.load_runs(self.m, self.root, self.root / "runs")
        c.blind(self.m, self.root, runs, self.root / "blinded")
        f.assess_fixture(self.root, self.m)
        reviews, overhead = c.assessments(self.m, runs, self.root / "blinded/private/key.json", self.root / "assessments")
        return runs, missing, reviews, overhead

    def test_end_to_end_failure_costs_quality_and_evaluation_separation(self):
        result = c.report(self.m, *self.pipeline())
        self.assertTrue(result["schedule_complete"])
        self.assertTrue(result["assessment_complete"])
        self.assertEqual(result["assessor_overhead"]["evaluation"]["actual_usd"], "0.36")
        for group in result["groups"]:
            self.assertEqual(group["accepted_by_checks"], 2)
            self.assertEqual(group["actual_api_usd_per_accepted"], "0.02")
            self.assertEqual(group["cost"]["task_api"]["actual_usd"], "0.04")
            self.assertEqual(group["quality"]["correctness"]["median"], 0.9)
        for path in (self.root / "blinded/packets").glob("*.json"):
            packet = c.read(path)
            self.assertEqual(set(packet), {"candidate_id", "task", "patch", "source", "rubric"})
            self.assertNotIn("upstream", json.dumps(packet))

    def test_missing_failed_and_unknown_runs_do_not_become_savings(self):
        runs, missing, reviews, overhead = self.pipeline()
        first = runs[0]
        first["ledger"].append(f.charge(Path(first["_root"]), "unknown", basis="unknown", status="in-flight"))
        result = c.report(self.m, runs, ["absent-run"], reviews, overhead)
        self.assertFalse(result["schedule_complete"])
        group = next(g for g in result["groups"] if g["arm"] == first["arm"] and g["state"] == first["state"])
        self.assertIsNone(group["actual_api_usd_per_accepted"])
        for run in runs:
            for check in run["checks"]:
                check["passed"] = False
        self.assertTrue(all(g["actual_api_usd_per_accepted"] is None for g in c.report(self.m, runs, missing, reviews, overhead)["groups"]))

    def test_stale_checks_and_seed_rejected(self):
        f.execute(self.root, self.m)
        path = next((self.root / "runs").glob("*/run.json"))
        run = c.read(path)
        run["checks"][0]["candidate_sha256"] = "stale"
        path.write_text(json.dumps(run))
        with self.assertRaisesRegex(ValueError, "stale"):
            c.load_runs(self.m, self.root, self.root / "runs")

    def test_assessor_identity_and_packet_binding(self):
        runs, _, _, _ = self.pipeline()
        path = next((self.root / "assessments").glob("*.json"))
        review = c.read(path)
        review["packet_sha256"] = "wrong"
        path.write_text(json.dumps(review))
        with self.assertRaisesRegex(ValueError, "wrong packet"):
            c.assessments(self.m, runs, self.root / "blinded/private/key.json", self.root / "assessments")

    def test_billing_unit_alias_does_not_double_count(self):
        event = f.charge(self.root, "request")
        alias = dict(event, id="different-id")
        with self.assertRaisesRegex(ValueError, "billing unit"):
            c.money([event, alias])

    def test_incomplete_capture_suppresses_cost_per_success(self):
        runs, missing, reviews, overhead = self.pipeline()
        for run in runs:
            run["coverage"]["task_api"] = False
        result = c.report(self.m, runs, missing, reviews, overhead)
        self.assertTrue(all(g["actual_api_usd_per_accepted"] is None for g in result["groups"]))

    def test_cancelled_before_checks_remains_in_denominator(self):
        f.execute(self.root, self.m)
        path = next((self.root / "runs").glob("*/run.json"))
        run = c.read(path)
        run["checks"], run["status"] = [], "cancelled"
        path.write_text(json.dumps(run))
        runs, missing = c.load_runs(self.m, self.root, self.root / "runs")
        result = c.report(self.m, runs, missing, {}, [])
        self.assertEqual(sum(g["runs"] for g in result["groups"]), 18)
        self.assertFalse(result["assessment_complete"])

    def test_same_returned_assessor_model_is_rejected(self):
        runs, missing, reviews, overhead = self.pipeline()
        for by_model in reviews.values():
            for review in by_model.values():
                review["returned_model"] = "one-model-under-two-aliases"
        with self.assertRaisesRegex(ValueError, "one model"):
            c.report(self.m, runs, missing, reviews, overhead)

    def test_missing_assessments_are_incomplete(self):
        runs, missing, reviews, overhead = self.pipeline()
        reviews.pop(runs[0]["id"])
        result = c.report(self.m, runs, missing, reviews, overhead)
        self.assertFalse(result["assessment_complete"])
        self.assertEqual(sum(g["assessed_runs"] for g in result["groups"]), 17)

    def test_runtime_control_and_seed_mismatch(self):
        f.execute(self.root, self.m)
        path = next((self.root / "runs").glob("*/run.json"))
        original = c.read(path)
        for field in ("binary_sha256", "controls_sha256", "source_sha256", "initial_state_sha256"):
            run = dict(original, **{field: "changed"})
            path.write_text(json.dumps(run))
            with self.assertRaises(ValueError):
                c.load_runs(self.m, self.root, self.root / "runs")


if __name__ == "__main__":
    unittest.main()
