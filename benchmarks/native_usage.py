import argparse
import json
from pathlib import Path

from .compare import digest, identity, require, write


def extract(paths):
    responses = {}
    totals, failures, sources = [], [], []
    for path in paths:
        data = Path(path).read_bytes()
        source = {"name": Path(path).name, "sha256": digest(data)}
        sources.append(source)
        thread = None
        for lineno, line in enumerate(data.splitlines(), 1):
            if not line.strip():
                continue
            event = json.loads(line)
            require(isinstance(event, dict), "JSONL events must be objects")
            origin = {"source_sha256": source["sha256"], "line": lineno}
            method = event.get("method")
            if method == "rawResponse/completed":
                payload = event["params"]
                response = {"thread_id": payload["threadId"], "turn_id": payload["turnId"],
                            "response_id": payload["responseId"], "raw_usage": payload.get("usage"),
                            "usage_metadata": payload.get("usageMetadata")}
                key = response["response_id"]
                require(key, "missing response ID")
                if key in responses:
                    require(identity(responses[key]["observation"]) == identity(response), "conflicting response replay")
                    responses[key]["origins"].append(origin)
                else:
                    responses[key] = {"observation": response, "origins": [origin]}
                continue
            if event.get("type") == "session_meta":
                thread = event["payload"].get("id")
            if event.get("type") == "thread.started":
                thread = event.get("thread_id")
            if event.get("type") == "event_msg":
                event = event["payload"]
            kind = event.get("type")
            if kind in ("turn.completed", "token_count") or method == "thread/tokenUsage/updated":
                totals.append({"thread_id": thread, "origin": origin, "raw_event": event})
            if kind in ("turn.failed", "error", "turn_aborted", "stream_error") or method == "error":
                failures.append({"thread_id": thread, "origin": origin, "raw_event": event})
    return {"schema": 1, "sources": sources, "response_observations": list(responses.values()),
            "aggregate_observations_do_not_sum": totals, "failure_observations": failures,
            "accounting_complete": False, "actual_usd": None,
            "limitations": ["Completion events cannot enumerate all attempted, failed or in-flight requests.",
                            "Descendant coverage requires a separately verified thread/request census.",
                            "Requested/returned models, account, category and billing must be joined from execution evidence.",
                            "usageMetadata.amount has no assumed currency or billing semantics.",
                            "Turn and token_count totals can overlap, replay or contain estimates; do not sum them."]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("jsonl", nargs="+", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    write(args.output, extract(args.jsonl))


if __name__ == "__main__":
    main()
