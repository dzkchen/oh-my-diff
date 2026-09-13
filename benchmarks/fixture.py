import argparse
import difflib
import json
from pathlib import Path
import platform
import subprocess
import sys
import time
from datetime import datetime, timezone

from .compare import (ARMS, DIMENSIONS, SCOPES, artifact, assessments, blind, digest,
                      identity, load_runs, report, schedule, validate_manifest, write)


def put(root, name, data):
    path = Path(root) / name
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(data, str):
        data = data.encode()
    with path.open("xb") as stream:
        stream.write(data)
    return {"path": name, "sha256": digest(data)}


def charge(root, uid, scope="task_api", basis="actual", status="completed"):
    raw = {"fixture": True, "request_id": uid, "input_tokens": 100,
           "cached_tokens": 20, "cache_write_tokens": 10, "output_tokens": 30,
           "reasoning_tokens": 7}
    evidence = put(root, f"raw/{uid}.json", json.dumps(raw))
    return {"id": uid, "billing_unit": uid, "scope": scope, "category": "implementation" if scope == "task_api" else "assessment",
            "actor": "fixture-lead" if scope == "task_api" else "fixture-assessor", "attempt": 1,
            "status": status, "basis": basis, "usd": "0.01" if basis == "actual" else None,
            "currency": "USD", "evidence": evidence, "provider": "synthetic",
            "account_alias": "fixture", "requested_model": "fixture-lead", "returned_model": "fixture-lead",
            "request_id": uid, "raw_usage": raw}


def create_manifest(root):
    binary = put(root, "inputs/runtime.txt", "synthetic runtime; no CAI performance evidence\n")
    instructions = put(root, "inputs/instructions.txt", "Implement the requested change and run its check.\n")
    prompt = put(root, "inputs/task.txt", "Fix add(a, b) to return their sum.\n")
    source = put(root, "inputs/source.py", "def add(a, b):\n    return a - b\n")
    checks = put(root, "private/check.py", "from solution import add\nassert add(2, 3) == 5\nassert add(-2, 2) == 0\n")
    rubric = put(root, "private/rubric.txt", "Synthetic rubric: score correctness, scope and maintainability independently from 0 to 1.\n")
    cold = put(root, "inputs/cold.json", '{"memory": [], "graph": null}')
    reuse = put(root, "inputs/reuse.json", '{"memory": ["Python repository"], "graph": null}')
    pin = "6b9826e3aa83b1a5947db50f4332cb9c65f1b340"
    arms = {}
    for name in ARMS:
        config = put(root, f"inputs/{name}.json", json.dumps({"fixture_arm": name}))
        arms[name] = {"upstream_commit": pin, "runtime_patches": [], "version": "fixture-v1",
                      "binary": binary, "configuration": config, "instructions": instructions,
                      "provider": "synthetic", "requested_model": "fixture-lead",
                      "configuration_note": "Synthetic control only; not a competitive upstream configuration."}
    m = {"schema": 1, "purpose": "fixture", "experiment": "fixed-model", "upstream_commit": pin,
         "seed": 147, "trials": 3, "states": ["cold", "reuse"], "arms": arms,
         "configuration_review": "Fixture exercises three labels; no runtime performance comparison.",
         "tools": [{"name": "python", "version": platform.python_version(),
                    "artifact": put(root, "inputs/python.sha256", digest(Path(sys.executable).read_bytes()))}],
         "controls": {"permissions": "local synthetic fixture", "resource_limits": {"check_timeout_seconds": 10},
                      "environment": platform.platform(), "reasoning": "not applicable (synthetic)"},
         "tasks": [{"id": "add-fixture", "suite": "synthetic", "family": "add-fixture", "split": "fixture",
                    "source_revision": source["sha256"], "prompt": prompt, "source": source, "checks": checks}],
         "initial_state": {state: {"snapshot": ref, "provider_cache": "uncontrolled",
                                   "provenance": "synthetic frozen seed; contains no solution",
                                   "isolation": "fresh directory per run"} for state, ref in (("cold", cold), ("reuse", reuse))},
         "assessment": {"models": ["fixture-assessor-a", "fixture-assessor-b"], "rubric": rubric,
                        "aggregation": "mean-per-dimension", "disagreement": "report-range-and-pairwise-distance"}}
    write(root / "manifest.json", m)
    return validate_manifest(m, root)


def execute(root, m):
    for spec in schedule(m):
        home = root / "runs" / spec["id"]
        home.mkdir(parents=True)
        start = time.monotonic()
        started = datetime.now(timezone.utc).isoformat()
        task = m["tasks"][0]
        original = artifact(root, task["source"]).read_text()

        good = spec["trial"] != 1
        final = original.replace("a - b", "a + b") if good else original
        workspace = home / "workspace"
        workspace.mkdir()
        (workspace / "solution.py").write_text(final)
        seed = artifact(root, m["initial_state"][spec["state"]]["snapshot"]).read_bytes()
        (workspace / "initial-state.json").write_bytes(seed)
        patch = "".join(difflib.unified_diff(original.splitlines(True), final.splitlines(True),
                                           fromfile="a/solution.py", tofile="b/solution.py"))
        candidate = put(home, "candidate.patch", patch)
        task_seconds = time.monotonic() - start
        check_start = time.monotonic()
        check = subprocess.run([sys.executable, "-c", artifact(root, task["checks"]).read_text()],
                               cwd=workspace, capture_output=True, timeout=10)
        check_seconds = time.monotonic() - check_start
        check_log = put(home, "check.log", check.stdout + check.stderr)
        trace = put(home, "trace.json", json.dumps({"fixture": True, "passed": check.returncode == 0}))
        config = put(home, "resolved.json", artifact(root, m["arms"][spec["arm"]]["configuration"]).read_bytes())
        coverage = put(home, "coverage.json", json.dumps({"fixture": True, "task_api": "all invented requests listed",
                       "task_environment": "local synthetic execution; no metered environment charges",
                       "evaluation": "local checks; synthetic assessor charges recorded separately",
                       "guideline_development": "none in fixture"}))
        events = [charge(home, spec["id"] + "-lead")]

        if not good:
            events.append(charge(home, spec["id"] + "-retry", status="failed"))
        run = {**spec, "manifest_sha256": identity(m), "status": "completed",
               "started_at": started, "finished_at": datetime.now(timezone.utc).isoformat(),
               "task_wall_seconds": task_seconds, "evaluation_wall_seconds": check_seconds,
               "candidate": candidate, "trace": trace, "resolved_configuration": config,
               "observed_versions": {"python": platform.python_version(), "runtime": "fixture-v1"},
               "binary_sha256": m["arms"][spec["arm"]]["binary"]["sha256"], "controls_sha256": identity(m["controls"]),
               "source_sha256": task["source"]["sha256"], "check_definition_sha256": task["checks"]["sha256"],
               "requested_model": "fixture-lead", "returned_models": ["fixture-lead"], "in_task_review_models": [],
               "initial_state_sha256": digest(seed), "state_observations": "fresh workspace with copied frozen seed",
               "isolation_evidence": "synthetic code only; directory isolation is not a security sandbox",
               "coverage": {s: True for s in SCOPES}, "coverage_evidence": {s: coverage for s in SCOPES}, "ledger": events,
               "checks": [{"command": [sys.executable, "-c", "<pinned check>"], "passed": check.returncode == 0,
                           "candidate_sha256": candidate["sha256"], "evidence": check_log}]}
        write(home / "run.json", run)


def assess_fixture(root, m):
    key = json.loads((root / "blinded/private/key.json").read_text())
    for token, entry in key["candidates"].items():
        packet = json.loads((root / "blinded/packets" / f"{token}.json").read_text())

        for index, model in enumerate(m["assessment"]["models"]):
            uid = f"{token}-{index}"
            home = root / "assessments"
            evidence = put(home, f"responses/{uid}.txt", "SYNTHETIC assessor response; no model called")
            score = (1.0 if index == 0 else 0.8) if packet["patch"] else 0.0
            review = {"candidate_id": token, "packet_sha256": identity(packet), "model": model,
                      "returned_model": model, "independent_session": uid, "scores": {d: score for d in DIMENSIONS},
                      "rationale": "Synthetic pipeline fixture; not a quality assessment.", "wall_seconds": 0,
                      "evidence": evidence, "ledger": [charge(home, uid, scope="evaluation")]}
            write(home / f"{uid}.json", review)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    m = create_manifest(args.output)
    write(args.output / "plan.json", {"manifest_sha256": identity(m), "schedule": schedule(m)})
    execute(args.output, m)
    runs, missing = load_runs(m, args.output, args.output / "runs")
    blind(m, args.output, runs, args.output / "blinded")
    assess_fixture(args.output, m)
    reviews, overhead = assessments(m, runs, args.output / "blinded/private/key.json", args.output / "assessments")
    write(args.output / "report.json", report(m, runs, missing, reviews, overhead))
    print(f"18 synthetic runs and 36 synthetic assessments: {args.output / 'report.json'}")


if __name__ == "__main__":
    main()
