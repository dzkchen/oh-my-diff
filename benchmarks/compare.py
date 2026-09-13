import argparse
from collections import defaultdict
from decimal import Decimal
import hashlib
import itertools
import json
from pathlib import Path
import random
import statistics
from datetime import datetime

ARMS = ("default-upstream", "configured-upstream", "cai")
SCOPES = ("task_api", "task_environment", "evaluation", "guideline_development")
DIMENSIONS = ("correctness", "scope", "maintainability")


def require(ok, message):
    if not ok:
        raise ValueError(message)


def read(path):
    return json.loads(Path(path).read_text())


def write(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x") as stream:
        stream.write(json.dumps(data, indent=2, sort_keys=True) + "\n")


def put(root, name, data):
    path = Path(root) / name
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(data, str):
        data = data.encode()
    with path.open("xb") as stream:
        stream.write(data)
    return {"path": name, "sha256": digest(data)}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def identity(data):
    return digest(json.dumps(data, sort_keys=True, separators=(",", ":")).encode())


def number(value):
    require(isinstance(value, (int, float, str)) and not isinstance(value, bool), "invalid number")
    result = Decimal(str(value))
    require(result.is_finite() and result >= 0, "negative or nonfinite number")
    return result


def artifact(root, ref):
    require(not Path(ref["path"]).is_absolute() and ".." not in Path(ref["path"]).parts, "artifact escapes bundle")
    path = (Path(root) / ref["path"]).resolve()
    require(path.is_relative_to(Path(root).resolve()), "artifact escapes bundle")
    require(path.is_file(), f"missing artifact: {ref['path']}")
    require(digest(path.read_bytes()) == ref["sha256"], f"artifact changed: {ref['path']}")
    return path


def validate_manifest(m, root):
    require(m["schema"] == 1, "unsupported schema")
    require(m["purpose"] in ("fixture", "development", "validation", "held-out"), "invalid purpose")
    require(m["experiment"] in ("fixed-model", "routing"), "invalid experiment")
    pilot = m.get("comparison") == "upstream-pilot"
    require(m.get("comparison", "three-arm") in ("three-arm", "upstream-pilot"), "unknown comparison")
    if pilot:
        require(m["purpose"] in ("fixture", "development"), "upstream pilot is development-only")
        require(m["experiment"] == "fixed-model", "upstream pilot requires fixed models")
    require(set(m["arms"]) == set(ARMS[:2] if pilot else ARMS), "genuine comparator arms required")
    require(type(m["trials"]) is int and m["trials"] > 0, "positive trials required")
    require(type(m["seed"]) is int, "integer seed required")
    require(m["states"] and set(m["states"]) <= {"cold", "reuse"}, "invalid states")
    require(len(m["states"]) == len(set(m["states"])), "duplicate state")
    require(m["controls"]["permissions"] and m["controls"]["resource_limits"], "controls missing")
    require(m["controls"]["environment"] and m["controls"]["reasoning"], "environment/reasoning missing")
    require(m["tools"] and all(t["version"] for t in m["tools"]), "tool versions required")
    for t in m["tools"]:
        artifact(root, t["artifact"])
    pin = m["upstream_commit"]
    require(len(pin) == 40 and all(c in "0123456789abcdef" for c in pin), "exact upstream commit required")
    for name, arm in m["arms"].items():
        require(arm["upstream_commit"] == pin, "upstream revisions differ")
        require(arm["version"] and arm["requested_model"] and arm["provider"], "runtime identity missing")
        for field in ("binary", "configuration", "instructions"):
            artifact(root, arm[field])
        require(arm["configuration_note"], "explain comparator configuration")
        if name != "cai":
            require(arm["runtime_patches"] == [], "upstream arm must be unmodified")
        elif m["purpose"] != "fixture":
            require(arm["runtime_patches"], "no CAI patch yet; do not label upstream as CAI")
    a, b = (m["arms"][name] for name in ARMS[:2])
    require(a["binary"]["sha256"] == b["binary"]["sha256"], "upstream arms must use same binary")
    if m["experiment"] == "fixed-model":
        require(len({(a["provider"], a["requested_model"]) for a in m["arms"].values()}) == 1,
                "fixed-model assignments differ")
    require(m["configuration_review"], "configured-upstream competitiveness rationale required")
    require(m["tasks"], "no tasks")
    ids = set()
    for task in m["tasks"]:
        require(task["id"] not in ids, "duplicate task")
        ids.add(task["id"])
        require(task["suite"] and task["family"] and task["source_revision"], "task provenance missing")
        require(task["split"] == m["purpose"], "split differs from experiment purpose")
        for field in ("prompt", "source", "checks"):
            artifact(root, task[field])
    for state in m["states"]:
        seed = m["initial_state"][state]
        require(seed["provider_cache"] in ("uncontrolled", "cold", "reuse"), "provider cache state missing")
        require(seed["provenance"] and seed["isolation"], "seed provenance/isolation required")
        artifact(root, seed["snapshot"])
    assessment = m["assessment"]
    require(len(set(assessment["models"])) >= 2, "two distinct assessor models required")
    require(len(assessment["models"]) == len(set(assessment["models"])), "duplicate assessor")
    artifact(root, assessment["rubric"])
    require(assessment["aggregation"] == "mean-per-dimension", "unsupported aggregation")
    require(assessment["disagreement"] == "report-range-and-pairwise-distance", "unsupported disagreement rule")
    if m["purpose"] == "held-out":
        require(m.get("approved_freeze"), "held-out requires approved frozen protocol")
        artifact(root, m["approved_freeze"])
    return m


def schedule(m):
    rng = random.Random(m["seed"])
    orders = list(itertools.permutations(ARMS[:2] if m.get("comparison") == "upstream-pilot" else ARMS))
    rng.shuffle(orders)
    blocks = list(itertools.product(m["tasks"], m["states"], range(m["trials"])))
    rng.shuffle(blocks)
    result = []
    for index, (task, state, trial) in enumerate(blocks):
        for arm in orders[index % len(orders)]:
            run = {"task": task["id"], "suite": task["suite"], "state": state,
                   "trial": trial, "arm": arm}
            run["id"] = identity({"manifest": identity(m), **run})[:24]
            result.append(run)
    return result


def money(events):
    totals = {s: {"actual_usd": Decimal(0), "estimated_usd": Decimal(0),
                  "unknown": 0, "subscription": 0} for s in SCOPES}
    seen = set()
    billing_units = set()
    for event in events:
        require(event["id"] not in seen, "duplicate cost event (possible double counting)")
        seen.add(event["id"])
        unit = event["billing_unit"]
        require(unit and unit not in billing_units, "duplicate/missing billing unit")
        billing_units.add(unit)
        scope = event["scope"]
        require(scope in SCOPES, "invalid cost scope")
        require(event["category"] and event["actor"] and event["attempt"], "cost attribution missing")
        require(type(event["attempt"]) is int and event["attempt"] >= 1, "invalid attempt number")
        require(event["status"] in ("completed", "failed", "cancelled", "in-flight"), "invalid status")
        require(event["evidence"], "cost source evidence required")
        require(event["category"] in ("briefing", "implementation", "delegation", "review", "repair",
                                     "retry", "fallback", "indexing", "refresh", "retrieval", "synthesis",
                                     "verification", "tool", "environment", "assessment", "guideline", "unattributed"),
                "unknown cost category")
        basis = event["basis"]
        require(basis in ("actual", "estimate", "unknown", "subscription"), "invalid billing basis")
        if scope == "task_api":
            for field in ("provider", "account_alias", "requested_model", "returned_model", "request_id", "raw_usage"):
                require(field in event, f"missing request field: {field}")
            require(event["requested_model"] and event["provider"] and event["account_alias"], "request identity missing")
        if basis in ("actual", "estimate"):
            require(event.get("currency") == "USD", "USD only; convert with recorded evidence outside ledger")
            amount = number(event["usd"])
            if basis == "estimate":
                require(event.get("rate_card") and event.get("calculation"), "estimate provenance missing")
            totals[scope]["actual_usd" if basis == "actual" else "estimated_usd"] += amount
        else:
            require(event.get("usd") is None, "unknown/subscription cannot be assigned zero dollars")
            totals[scope][basis] += 1
    return {s: {k: str(v) if isinstance(v, Decimal) else v for k, v in t.items()}
            for s, t in totals.items()}


def estimate_tokens(usage, rates):
    require(rates["semantics"] == "input-includes-disjoint-cache;output-includes-reasoning",
            "unknown provider token overlap semantics")
    values = {k: number(usage[k]) for k in ("input", "cache_read", "cache_write", "output", "reasoning")}
    require(all(v == int(v) for v in values.values()), "fractional token count")
    uncached = values["input"] - values["cache_read"] - values["cache_write"]
    require(uncached >= 0 and values["reasoning"] <= values["output"], "invalid token subsets")
    return str(sum(n * number(rates[k]) for k, n in (
        ("input", uncached), ("cache_read", values["cache_read"]),
        ("cache_write", values["cache_write"]), ("output", values["output"]))) / Decimal(1000000))


def load_runs(m, root, runs_dir):
    expected = {r["id"]: r for r in schedule(m)}
    runs = []
    seen = set()
    for path in sorted(Path(runs_dir).glob("*/run.json")):
        run = read(path)
        require(run["id"] in expected and run["id"] not in seen, "unexpected/duplicate run")
        seen.add(run["id"])
        require(run["manifest_sha256"] == identity(m), "manifest changed since execution")
        for key, value in expected[run["id"]].items():
            require(run[key] == value, f"run control mismatch: {key}")
        require(run["status"] in ("completed", "failed", "cancelled", "in-flight"), "invalid run status")
        require(run["started_at"] and run["finished_at"], "timestamps required")
        start, end = (datetime.fromisoformat(run[k]) for k in ("started_at", "finished_at"))
        require(start.tzinfo and end.tzinfo and start <= end, "invalid timestamp interval")
        number(run["task_wall_seconds"])
        number(run["evaluation_wall_seconds"])
        require(run["observed_versions"] and run["resolved_configuration"], "resolved runtime evidence missing")
        require(run["binary_sha256"] == m["arms"][run["arm"]]["binary"]["sha256"], "runtime binary mismatch")
        require(run["controls_sha256"] == identity(m["controls"]), "execution controls mismatch")
        task = next(t for t in m["tasks"] if t["id"] == run["task"])
        require(run["source_sha256"] == task["source"]["sha256"], "task source mismatch")
        require(run["check_definition_sha256"] == task["checks"]["sha256"], "check definition mismatch")
        artifact(path.parent, run["resolved_configuration"])
        require(run["initial_state_sha256"] == m["initial_state"][run["state"]]["snapshot"]["sha256"], "initial state mismatch")
        require(run["state_observations"] and run["isolation_evidence"], "state/isolation observations missing")
        require(run["requested_model"] == m["arms"][run["arm"]]["requested_model"], "requested model changed")
        require("returned_models" in run and "in_task_review_models" in run, "model observations missing")
        require(not set(run["in_task_review_models"]) & set(m["assessment"]["models"]), "assessors must differ from task reviewers")
        require(set(run["coverage"]) == set(SCOPES), "all accounting scopes need coverage")
        require(all(type(v) is bool for v in run["coverage"].values()), "coverage must be boolean")
        require(set(run["coverage_evidence"]) == set(SCOPES), "coverage evidence missing")
        for evidence in run["coverage_evidence"].values():
            artifact(path.parent, evidence)
        checks = run["checks"]
        require(isinstance(checks, list) and all(type(c["passed"]) is bool for c in checks), "invalid executable checks")
        require(checks or run["status"] != "completed", "completed runs need executable checks")
        for check in checks:
            require(check["command"] and check["candidate_sha256"] == run["candidate"]["sha256"], "stale/missing check")
            artifact(path.parent, check["evidence"])
        for field in ("candidate", "trace"):
            artifact(path.parent, run[field])
        for event in run["ledger"]:
            artifact(path.parent, event["evidence"])
            if "billing_evidence" in event:
                artifact(path.parent, event["billing_evidence"])
        money(run["ledger"])
        run["_root"] = str(path.parent)
        runs.append(run)
    return runs, sorted(set(expected) - seen)


def blind(m, root, runs, output):
    out = Path(output)
    require(not out.exists(), "blind output already exists")
    rng = random.SystemRandom()
    shuffled = list(runs)
    rng.shuffle(shuffled)
    mapping = {}
    for run in shuffled:
        token = rng.getrandbits(128).to_bytes(16, "big").hex()
        task = next(t for t in m["tasks"] if t["id"] == run["task"])
        patch = artifact(run["_root"], run["candidate"]).read_text()

        source = artifact(root, task["source"])
        source_name = f"{token}.source"
        (out / "packets").mkdir(parents=True, exist_ok=True)
        (out / "packets" / source_name).write_bytes(source.read_bytes())
        packet = {"candidate_id": token, "task": artifact(root, task["prompt"]).read_text(),
                  "patch": patch, "source": {"path": source_name, "sha256": task["source"]["sha256"]},
                  "rubric": artifact(root, m["assessment"]["rubric"]).read_text()}
        write(out / "packets" / f"{token}.json", packet)
        mapping[token] = {"run_id": run["id"], "packet_sha256": identity(packet),
                          "candidate_sha256": run["candidate"]["sha256"]}
    write(out / "private" / "key.json", {"manifest_sha256": identity(m), "candidates": mapping})
    (out / "private").chmod(0o700)
    (out / "private" / "key.json").chmod(0o600)


def assessments(m, runs, key_path, results_dir):
    key = read(key_path)
    require(key["manifest_sha256"] == identity(m), "blinding key belongs to another protocol")
    by_id = {r["id"]: r for r in runs}
    require({v["run_id"] for v in key["candidates"].values()} == set(by_id), "blinding key run set differs")
    require(len(key["candidates"]) == len(by_id), "duplicate blinding mapping")
    reviews = defaultdict(dict)
    overhead = []
    sessions = set()
    attempts = set()
    for path in sorted(Path(results_dir).glob("*.json")):
        review = read(path)
        entry = key["candidates"][review["candidate_id"]]
        run = by_id[entry["run_id"]]
        require(entry["candidate_sha256"] == run["candidate"]["sha256"], "candidate changed after blinding")
        require(review["packet_sha256"] == entry["packet_sha256"], "assessor reviewed wrong packet")
        model = review["model"]
        require(model in m["assessment"]["models"], "unexpected assessor model")
        attempt = (run["id"], model)
        require(attempt not in attempts, "duplicate assessor result")
        attempts.add(attempt)
        require(model not in reviews[run["id"]], "duplicate assessor result")
        artifact(path.parent, review["evidence"])
        require(all(e["scope"] == "evaluation" for e in review["ledger"]), "assessor cost must be evaluator-only")
        for event in review["ledger"]:
            artifact(path.parent, event["evidence"])
        money(review["ledger"])
        overhead.extend(review["ledger"])
        if review.get("status") == "failed":
            continue
        require(review["returned_model"] and review["independent_session"], "assessor provenance missing")
        require(review["independent_session"] not in sessions, "assessor session reused across candidates")
        sessions.add(review["independent_session"])
        require(review["returned_model"] not in run["in_task_review_models"], "returned assessor model was task reviewer")
        require(set(review["scores"]) == set(DIMENSIONS), "missing quality dimensions")
        require(all(number(v) <= 1 for v in review["scores"].values()), "scores must be in [0,1]")
        require(review["rationale"], "assessment rationale missing")
        artifact(path.parent, review["evidence"])
        require(review["ledger"] and all(e["scope"] == "evaluation" for e in review["ledger"]), "assessor cost must be evaluator-only")
        for event in review["ledger"]:
            artifact(path.parent, event["evidence"])
        number(review["wall_seconds"])
        money(review["ledger"])
        reviews[run["id"]][model] = review
    money(overhead)
    return reviews, overhead


def distribution(values):
    if not values:
        return None
    ordered = sorted(values)
    return {"n": len(values), "min": min(values), "median": statistics.median(values),
            "p95_nearest_rank": ordered[max(0, (95 * len(values) + 99) // 100 - 1)], "max": max(values)}


def report(m, runs, missing, reviews, overhead):


    money([e for r in runs for e in r["ledger"]] + overhead)
    groups = defaultdict(list)
    for run in runs:
        groups[(run["suite"], run["state"], run["arm"])].append(run)
    summary = []
    for (suite, state, arm), group in sorted(groups.items()):
        accepted = [r for r in group if r["status"] == "completed" and r["checks"] and all(c["passed"] for c in r["checks"])]
        totals = money([e for r in group for e in r["ledger"]])
        api = totals["task_api"]
        group_expected = sum(r["suite"] == suite and r["state"] == state and r["arm"] == arm for r in schedule(m))
        metered = len(group) == group_expected and all(r["coverage"]["task_api"] for r in group) and not api["unknown"] and not api["subscription"]
        actual_only = metered and all(e["basis"] == "actual" for r in group for e in r["ledger"] if e["scope"] == "task_api")
        scores = {d: [] for d in DIMENSIONS}
        disagreement = {d: [] for d in DIMENSIONS}
        distances = {d: [] for d in DIMENSIONS}
        assessed = 0
        for run in group:
            results = list(reviews.get(run["id"], {}).values())
            if len(results) != len(m["assessment"]["models"]):
                continue
            require(len({r["returned_model"] for r in results}) >= 2, "assessor aliases resolved to one model")
            assessed += 1
            for dim in DIMENSIONS:
                values = [float(r["scores"][dim]) for r in results]
                scores[dim].append(statistics.mean(values))
                disagreement[dim].append(max(values) - min(values))
                distances[dim].extend(abs(a - b) for a, b in itertools.combinations(values, 2))
        summary.append({"suite": suite, "state": state, "arm": arm, "runs": len(group),
                        "expected_runs": group_expected, "accepted_by_checks": len(accepted), "success_rate": len(accepted) / len(group),
                        "cost": totals, "coverage_complete": {s: all(r["coverage"][s] for r in group) for s in SCOPES},
                        "actual_api_usd_per_accepted": str(Decimal(api["actual_usd"]) / len(accepted)) if actual_only and accepted else None,
                        "estimated_plus_actual_api_usd_per_accepted": str((Decimal(api["actual_usd"]) + Decimal(api["estimated_usd"])) / len(accepted)) if metered and accepted else None,
                        "task_latency_seconds": distribution([float(r["task_wall_seconds"]) for r in group]),
                        "evaluation_latency_seconds": distribution([float(r["evaluation_wall_seconds"]) for r in group]),
                        "assessed_runs": assessed, "quality": {d: distribution(scores[d]) for d in DIMENSIONS},
                        "assessor_range": {d: distribution(disagreement[d]) for d in DIMENSIONS},
                        "assessor_pairwise_absolute_distance": {d: distribution(distances[d]) for d in DIMENSIONS}})
    return {"schema": 1, "purpose": m["purpose"], "manifest_sha256": identity(m),
            "arm_provenance": {name: {"runtime_patches": arm["runtime_patches"],
                                      "label": arm.get("control_label", name)} for name, arm in m["arms"].items()},
            "missing_runs": missing, "schedule_complete": not missing,
            "assessment_complete": all(len(reviews.get(r["id"], {})) == len(m["assessment"]["models"]) for r in runs) and not missing,
            "groups": summary, "assessor_overhead": money(overhead),
            "assessor_wall_seconds": sum(float(v["wall_seconds"]) for rs in reviews.values() for v in rs.values()),
            "claim": "Descriptive measurements only; no frozen quality/savings gate or population-equivalence claim."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("plan", "blind", "report"))
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--runs", type=Path)
    parser.add_argument("--key", type=Path)
    parser.add_argument("--assessments", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    root = args.manifest.parent
    m = validate_manifest(read(args.manifest), root)
    if args.command == "plan":
        write(args.output, {"manifest_sha256": identity(m), "schedule": schedule(m)})
        return
    require(args.runs, "--runs required")
    runs, missing = load_runs(m, root, args.runs)
    if args.command == "blind":
        blind(m, root, runs, args.output)
        return
    require(args.key and args.assessments, "--key and --assessments required")
    reviews, overhead = assessments(m, runs, args.key, args.assessments)
    write(args.output, report(m, runs, missing, reviews, overhead))


if __name__ == "__main__":
    main()
