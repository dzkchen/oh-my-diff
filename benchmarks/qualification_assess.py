import argparse
from contextlib import contextmanager
from decimal import Decimal
import http.client
import json
from pathlib import Path
import signal
import time

from .compare import artifact, assessments, identity, load_runs, put, read, report, require, write
from .gateway import Budget, Gateway, bounded_request
from .pilot import parse_assessment, review_prompt


@contextmanager
def request_deadline(seconds):
    def expired(*_):
        raise TimeoutError("assessment request wall limit")
    previous = signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


def prepare(source, output):
    require(not output.exists(), "supplement already prepared")
    m = read(source / "manifest.json")
    require(m["purpose"] == "development", "development assessments only")
    entries = []
    for path in sorted((source / "blinded/packets").glob("*.json")):
        packet = read(path)
        for model, inp, cached, cache_write, out in (
                ("gpt-5.6-sol", "4", "0.4", "5", "20"),
                ("gpt-6-astra", "10", "1", "12.5", "50")):
            uid = packet["candidate_id"] + "-" + model
            body = {"model": model, "input": review_prompt(packet, path.parent, 32000),
                    "reasoning": {"effort": "high"}, "store": False, "stream": False,
                    "max_output_tokens": 4096, "service_tier": "default"}
            ceiling = len(json.dumps(body, ensure_ascii=False).encode()) + 4096
            exposure = (Decimal(ceiling) * Decimal(cache_write) + Decimal(4096) * Decimal(out)) / 1000000
            route = {"url": "https://api.openai.com/v1", "credential_env": "OPENAI_API_KEY",
                     "models": [model], "account_alias": "user-openai-api", "billing": "estimate",
                     "request_exposure_usd": str(exposure), "timeout_seconds": 115,
                     "bounds": {"input_token_ceiling": ceiling, "output_tokens": 4096, "requests_per_session": 1},
                     "rate_card": "https://developers.openai.com/api/docs/models/" + model + " checked 2026-09-13; default short-context USD rates; cache-write worst case reserved",
                     "rates": {"semantics": "input-includes-disjoint-cache;output-includes-reasoning",
                               "input": inp, "cache_read": cached, "cache_write": cache_write, "output": out}}
            require(bounded_request(body, route) == ceiling, "request bound mismatch")
            entries.append({"id": uid, "candidate_id": packet["candidate_id"], "packet_sha256": identity(packet),
                            "request": put(output, "requests/" + uid + ".json", json.dumps(body)), "route": route})
    total = sum(Decimal(entry["route"]["request_exposure_usd"]) for entry in entries)
    require(len(entries) == 24 and total <= 8, "supplement differs from fixed 24-review USD8 plan")
    plan = {"schema": 1, "source": str(source.resolve()), "manifest_sha256": identity(m),
            "original_assessments_sha256": identity({p.name: read(p) for p in sorted((source / "assessments").glob("*.json"))}),
            "allowance_started_unix": read(source / "allowance.json")["started_unix"],
            "authorization": "Pending explicit permission for paid API assessment supplement; no automatic subscription fallback.",
            "scope": "One fixed source-excerpt review per candidate and model, identical mode for all twelve saved candidates. No task reruns, score selection, adjudication or replacement of original assessments. Report this mode separately and preserve original results and overhead.",
            "maximum_reservation_usd": str(total), "maximum_wall_seconds": 2880, "automatic_retries": 0,
            "entries": entries}
    write(output / "plan.json", plan)
    return plan


def run(plan_path, approved_sha256):
    plan = read(plan_path)
    require(identity(plan) == approved_sha256, "explicit approval must bind the prepared plan")
    root = plan_path.parent
    require(not (root / "started.json").exists(), "supplement already started; no automatic retry")
    source = Path(plan["source"])
    m = read(source / "manifest.json")
    require(identity(m) == plan["manifest_sha256"], "source manifest changed")
    require(identity({p.name: read(p) for p in sorted((source / "assessments").glob("*.json"))}) == plan["original_assessments_sha256"], "original assessments changed")
    remaining = int(28800 - (time.time() - plan["allowance_started_unix"]))
    require(remaining >= plan["maximum_wall_seconds"], "complete assessment schedule does not fit original allowance")
    limits = {**m["execution"]["limits"], "seconds": plan["maximum_wall_seconds"], "requests": 24,
              "usd_exposure": plan["maximum_reservation_usd"], "scope_usd": {"evaluation": plan["maximum_reservation_usd"]},
              "max_output_tokens": 4096}
    budget = Budget(limits, root / "budget")
    write(root / "controller-sources.json", {p.name: put(root, "controller/" + p.name, p.read_bytes()) for p in Path(__file__).parent.glob("*.py")})
    write(root / "started.json", {"unix": time.time(), "approved_plan_sha256": approved_sha256})
    for entry in plan["entries"]:
        uid = entry["id"]
        output = root / "assessments"
        start = time.monotonic()
        result, error = {}, None
        with Gateway({"review": entry["route"]}, budget, output / uid, scope="evaluation") as gateway:
            try:
                require(budget.remaining_seconds() > 0, "assessment time exhausted")
                body = read(artifact(root, entry["request"]))
                conn = http.client.HTTPConnection("127.0.0.1", gateway.port, timeout=min(115, budget.remaining_seconds()))
                try:
                    with request_deadline(min(110, budget.remaining_seconds())):
                        conn.request("POST", "/review/responses", json.dumps(body), {"Authorization": "Bearer " + gateway.token, "thread-id": uid})
                        response = conn.getresponse()
                        result = json.loads(response.read())
                        require(response.status == 200 and result.get("status") == "completed", "assessment did not complete")
                        require(result.get("model") == body["model"], "assessor identity changed")
                        scores = parse_assessment(result)
                finally:
                    conn.close()
            except Exception as failure:
                error = type(failure).__name__ + ": " + str(failure)
        ledger = gateway.ledger()
        for event in ledger:
            event["evidence"]["path"] = uid + "/" + event["evidence"]["path"]
        record = {"candidate_id": entry["candidate_id"], "packet_sha256": entry["packet_sha256"],
                  "model": entry["route"]["models"][0], "returned_model": result.get("model"),
                  "independent_session": uid, "wall_seconds": time.monotonic() - start,
                  "evidence": put(output, uid + "/response.json", json.dumps(result)), "ledger": ledger,
                  "status": "failed" if error else "completed", "error": error}
        if not error:
            record.update(scores)
        write(output / (uid + ".json"), record)
        print(json.dumps({"id": uid, "status": record["status"], "error": error}), flush=True)
    runs, missing = load_runs(m, source, source / "runs")
    reviews, overhead = assessments(m, runs, source / "blinded/private/key.json", root / "assessments")
    write(root / "report.json", report(m, runs, missing, reviews, overhead))
    write(root / "budget-summary.json", {"reserved_usd": str(budget.reserved), "requests": budget.count,
          "active_seconds_since_allowance_start": time.time() - plan["allowance_started_unix"],
          "paid_reserve_unreserved_usd": str(Decimal(15) - budget.reserved), "original_assessments_included_in_this_mode_report": False})


def main():
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    prepare_command = commands.add_parser("prepare")
    prepare_command.add_argument("source", type=Path)
    prepare_command.add_argument("output", type=Path)
    run_command = commands.add_parser("run")
    run_command.add_argument("plan", type=Path)
    run_command.add_argument("--approved-plan-sha256", required=True)
    args = parser.parse_args()
    if args.command == "prepare":
        print(identity(prepare(args.source.resolve(), args.output.resolve())))
    else:
        run(args.plan.resolve(), args.approved_plan_sha256)


if __name__ == "__main__":
    main()
