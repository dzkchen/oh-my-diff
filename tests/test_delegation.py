import copy
import json
import shutil
from pathlib import Path
import tempfile
import unittest

from benchmarks.compare import identity, put
from benchmarks.delegation import integration_candidate, prepare


class DelegationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.before = {"format": "tree-v1", "files": {"a": {"base64": "YQ==", "mode": 420}}}
        self.candidate = copy.deepcopy(self.before)
        self.candidate["files"]["a"]["base64"] = "Yg=="
        self.evidence = put(self.root, "evidence.txt", "synthetic evidence")
        self.attempt = {"request_id": "request-1", "worker_id": "worker-1",
                        "model": "muse-spark-1.3-contributor", "status": "unknown", "raw_usage": None}
        self.result = {"schema": 1, "worker_id": "worker-1", "model": self.attempt["model"],
                       "status": "completed", "base": put(self.root, "base.json", json.dumps(self.before)),
                       "candidate": put(self.root, "candidate.json", json.dumps(self.candidate)),
                       "changed_paths": ["a"], "evidence": [self.evidence],
                       "attempts": [put(self.root, "attempt.json", json.dumps(self.attempt))]}
        self.review = {"model": "gpt-6-astra", "status": "approved",
                       "candidate_sha256": identity(self.candidate), "evidence": self.evidence}
        self.checks = {"status": "passed", "candidate_sha256": identity(self.candidate), "evidence": self.evidence}

    def merge(self, current=None):
        return integration_candidate(self.root, self.result, self.review, self.checks,
                                     self.before if current is None else current)

    def test_unrelated_current_changes_survive_and_inputs_are_not_mutated(self):
        current = copy.deepcopy(self.before)
        current["files"]["unrelated"] = {"base64": "Yw==", "mode": 420}
        saved = copy.deepcopy(current)
        result = self.merge(current)
        expected = copy.deepcopy(self.candidate)
        expected["files"]["unrelated"] = current["files"]["unrelated"]
        self.assertEqual(result["merged"], expected)
        self.assertEqual(current, saved)
        self.assertEqual(result["status"], "candidate-only")
        self.assertIsNone(json.loads((self.root / "attempt.json").read_text())["raw_usage"])

    def test_intervening_edit_and_deletion_conflict(self):
        for current in (self.candidate, {"format": "tree-v1", "files": {}}):
            with self.subTest(current=current), self.assertRaisesRegex(ValueError, "intervening edits"):
                self.merge(current)

    def test_stale_review_and_checks_block_candidate(self):
        for record in (self.review, self.checks):
            original = record["candidate_sha256"]
            record["candidate_sha256"] = identity(self.before)
            with self.assertRaisesRegex(ValueError, "stale"):
                self.merge()
            record["candidate_sha256"] = original

    def test_self_review_and_failed_checks_block_candidate(self):
        self.review["model"] = self.result["model"]
        with self.assertRaisesRegex(ValueError, "separate model"):
            self.merge()
        self.review["model"] = ""
        with self.assertRaisesRegex(ValueError, "fixed assignment"):
            self.merge()
        self.review["model"] = "gpt-6-astra"
        self.checks["status"] = "failed"
        with self.assertRaisesRegex(ValueError, "checks did not pass"):
            self.merge()

    def test_incomplete_worker_and_undeclared_edits_block_candidate(self):
        self.result["status"] = "stopped"
        with self.assertRaisesRegex(ValueError, "did not complete"):
            self.merge()
        self.result["status"] = "completed"
        self.result["changed_paths"] = []
        with self.assertRaisesRegex(ValueError, "declaration differs"):
            self.merge()

    def test_missing_tampered_and_duplicate_attribution_block_candidate(self):
        self.result["attempts"] *= 2
        with self.assertRaisesRegex(ValueError, "duplicate request"):
            self.merge()
        self.result["attempts"] = []
        with self.assertRaisesRegex(ValueError, "usage attribution missing"):
            self.merge()
        self.result["attempts"] = [put(self.root, "other-attempt.json", json.dumps(self.attempt))]
        (self.root / "evidence.txt").write_text("tampered")
        with self.assertRaisesRegex(ValueError, "artifact changed"):
            self.merge()

    def test_plan_is_development_only_and_grants_no_authorization(self):
        plan = prepare(Path(__file__).resolve().parents[1], authorization={})
        self.assertEqual({task["split"] for task in plan["tasks"]}, {"development"})
        self.assertEqual(plan["status"], "not-executable")
        self.assertFalse(plan["allowance_approved"])
        self.assertFalse(plan["contributor_data_authorized"])

    def test_ancestor_conflicts_are_rejected(self):
        base = {"format": "tree-v1", "files": {}}
        for worker_name, current_name in (("a", "a/b"), ("a/b", "a")):
            with self.subTest(worker_name=worker_name):
                candidate = {"format": "tree-v1", "files": {worker_name: {"base64": "YQ==", "mode": 420}}}
                current = {"format": "tree-v1", "files": {current_name: {"base64": "YQ==", "mode": 420}}}
                self.result["base"] = put(self.root, worker_name.replace("/", "-") + "-base.json", json.dumps(base))
                self.result["candidate"] = put(self.root, worker_name.replace("/", "-") + "-candidate.json", json.dumps(candidate))
                self.result["changed_paths"] = [worker_name]
                self.review["candidate_sha256"] = self.checks["candidate_sha256"] = identity(candidate)
                with self.assertRaisesRegex(ValueError, "file/directory conflict"):
                    self.merge(current)

    def test_scoped_data_authorization_is_bound_to_original_data_and_revocable(self):
        repo = self.root / "repo"
        actual = Path(__file__).resolve().parents[1]
        for name in ("upstream.lock.json", "benchmarks/corpus/catalog.json", "benchmarks/corpus/freeze.json"):
            path = repo / name
            path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(actual / name, path)
        original = prepare(repo, authorization={})
        proposal_path = repo / ".docs/audits/evidence/controlled-contributor-20260913/proposal.json"
        proposal_path.parent.mkdir(parents=True)
        proposal_path.write_text(json.dumps(original))
        authorization = {"schema": 1, "data_authorized": True, "revocable": True,
                         "split": "development", "repositories": ["serde-rs/serde", "psf/requests"],
                         "proposal_sha256": identity(original)}
        self.assertTrue(prepare(repo, authorization)["contributor_data_authorized"])
        first = prepare(repo, authorization)
        second = prepare(repo, authorization)
        self.assertEqual(first, second)
        self.assertEqual(identity(json.loads(proposal_path.read_text())), authorization["proposal_sha256"])
        for key, invalid in (("revocable", False), ("proposal_sha256", "stale"), ("schema", 9)):
            changed = {**authorization, key: invalid}
            self.assertFalse(prepare(repo, changed)["contributor_data_authorized"])
        catalog_path = repo / "benchmarks/corpus/catalog.json"
        catalog = json.loads(catalog_path.read_text())
        next(task for task in catalog["tasks"] if task["id"] == "psf/requests#6028")["source_revision"] = "0" * 40
        catalog_path.write_text(json.dumps(catalog))
        self.assertFalse(prepare(repo, authorization)["contributor_data_authorized"])


if __name__ == "__main__":
    unittest.main()
