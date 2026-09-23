import argparse
import copy
from pathlib import Path

from .compare import artifact, identity, read, require, write


def integration_candidate(root, result, review, checks, current):
    require(result["schema"] == 1, "unsupported worker result")
    require(result["status"] == "completed", "worker did not complete")
    require(result["model"] == "muse-spark-1.3-contributor", "wrong Contributor model")
    before = read(artifact(root, result["base"]))
    candidate = read(artifact(root, result["candidate"]))
    for tree in (before, candidate, current):
        require(tree["format"] == "tree-v1", "invalid tree format")
    require(result["evidence"], "worker evidence missing")
    for reference in result["evidence"]:
        artifact(root, reference)
    candidate_hash = identity(candidate)
    require(review["candidate_sha256"] == candidate_hash, "review is stale")
    require(checks["candidate_sha256"] == candidate_hash, "checks are stale")
    require(review["model"] != result["model"], "reviewer must be a separate model")
    require(review["model"] == "gpt-6-astra", "reviewer differs from fixed assignment")
    require(review["status"] == "approved", "review did not approve")
    require(checks["status"] == "passed", "executable checks did not pass")
    artifact(root, review["evidence"])
    artifact(root, checks["evidence"])
    require(result["attempts"], "usage attribution missing")
    request_ids = set()
    for reference in result["attempts"]:
        attempt = read(artifact(root, reference))
        request_id = attempt["request_id"]
        require(isinstance(request_id, str) and request_id, "request identity missing")
        require(request_id not in request_ids, "duplicate request attribution")
        request_ids.add(request_id)
        require(attempt["worker_id"] == result["worker_id"], "attempt belongs to another worker")
        require(attempt["model"] == result["model"], "attempt model differs")
        require(attempt["status"] in ("completed", "failed", "cancelled", "unknown"), "invalid attempt state")
        require("raw_usage" in attempt, "raw usage or explicit unknown required")
        require(attempt["raw_usage"] is None or isinstance(attempt["raw_usage"], dict), "invalid raw usage")
    changed = sorted(name for name in before["files"].keys() | candidate["files"].keys()
                     if before["files"].get(name) != candidate["files"].get(name))
    require(result["changed_paths"] == changed, "worker changed-path declaration differs")
    conflicts = [name for name in changed if current["files"].get(name) != before["files"].get(name)]
    require(not conflicts, "intervening edits conflict: " + ", ".join(conflicts))
    merged = copy.deepcopy(current)
    for name in changed:
        if name in candidate["files"]:
            merged["files"][name] = copy.deepcopy(candidate["files"][name])
        else:
            merged["files"].pop(name, None)
    for name in merged["files"]:
        require(not any(str(parent) in merged["files"] for parent in Path(name).parents),
                "intervening file/directory conflict")
    return {"schema": 1, "status": "candidate-only", "base_sha256": identity(before),
            "reviewed_candidate_sha256": candidate_hash, "current_sha256": identity(current),
            "merged": merged, "changed_paths": changed,
            "integration_gate": "Validate tree paths and permissions, then check/review this merged version before host-owned integration. This oracle does not write a workspace or attest model/check provenance."}


def prepare(repo, authorization=None):
    pin = read(repo / "upstream.lock.json")
    catalog = read(repo / "benchmarks/corpus/catalog.json")
    freeze = read(repo / "benchmarks/corpus/freeze.json")
    if authorization is None:
        path = repo / ".docs/audits/evidence/controlled-contributor-20260913/data-authorization.json"
        authorization = read(path) if path.is_file() else {}
    tasks = []
    for task_id in ("serde-rs/serde#2798", "psf/requests#6028"):
        task = next(t for t in catalog["tasks"] if t["id"] == task_id)
        require(task["split"] == "development", "only development tasks may be selected")
        tasks.append({key: task[key] for key in ("id", "suite", "split", "source_revision")})
    original_path = repo / ".docs/audits/evidence/controlled-contributor-20260913/proposal.json"
    original = read(original_path) if original_path.is_file() else {}
    data_authorized = (authorization.get("schema") == 1
                       and authorization.get("data_authorized") is True
                       and authorization.get("revocable") is True
                       and authorization.get("split") == "development"
                       and set(authorization.get("repositories", [])) == {"serde-rs/serde", "psf/requests"}
                       and authorization.get("proposal_sha256") == identity(original)
                       and original.get("tasks") == tasks
                       and original.get("roles", {}).get("worker") == "muse-spark-1.3-contributor"
                       and original.get("context") == "focused brief plus selected evidence; experimental fixed condition")
    return {"schema": 1, "status": "not-executable", "purpose": "development",
            "upstream_commit": pin["commit"], "catalog_sha256": identity(catalog),
            "freeze_sha256": identity(freeze), "tasks": tasks,
            "roles": {"lead": "gpt-5.6-sol", "reviewer": "gpt-6-astra",
                      "worker": "muse-spark-1.3-contributor"},
            "reasoning": {"lead": "high", "reviewer": "high", "worker": "low"},
            "context": "focused brief plus selected evidence; experimental fixed condition",
            "comparators": ["default-upstream", "configured-upstream", "omd"],
            "configured_alternative": "Qualify native same-provider delegation as an eligible configured alternative; retain direct work when delegation adds no value.",
            "repeats": 3, "state": "cold", "core_runs": 18,
            "assessors": ["gpt-5.6-sol", "gpt-6-astra"], "independent_assessments": 36,
            "proposed_limits": {"active_seconds": 28800, "paid_usd": "15",
                                "task_seconds": 900, "worker_seconds": 300,
                                "shared_requests_per_task": 60, "worker_requests": 20,
                                "worker_depth": 1, "concurrent_workers": 1,
                                "whole_task_retries": 0, "provider_retries": 0,
                                "shared_native_rss_bytes": 6442450944, "shared_native_processes": 64},
            "allowance_approved": False, "contributor_data_authorized": data_authorized,
            "data_authorization": authorization if data_authorized else None,
            "accounting": "Count access, briefing, lead, workers, review, repair, failures, unknown/in-flight usage and checks. Separate evaluator/assessor overhead. Included subscription use is not zero-priced API usage; API projections cannot certify metered savings.",
            "decision_rule": "Keep only for further validation if executable and independent review quality do not decline in either development suite and total measured task cost improves against the competitive configured alternative. Unknown pricing/usage, missing assessments or an incomplete schedule are inconclusive. No held-out gate claim.",
            "blockers": ["Native mixed-provider/isolation/limit/result/review/integration implementation and validation",
                         "Current Contributor pricing units and cache semantics",
                         *([] if data_authorized else ["Contributor benchmark eligibility and revocable repository-specific data authorization"]),
                         "Agreed allowance and verified account/quota access",
                         "Exact candidate/configuration freeze and complete-schedule affordability"]}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    write(args.output, prepare(Path(__file__).resolve().parents[1]))


if __name__ == "__main__":
    main()
