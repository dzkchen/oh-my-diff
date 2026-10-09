import argparse
import json
from pathlib import Path
import random
import statistics
import subprocess
import tempfile
import time


ROOT = Path(__file__).resolve().parents[1]
ARMS = {
    "empty": (),
    "workspace": ("omd_workspace",),
    "workflow": ("omd_workflow",),
    "both": ("omd_workspace", "omd_workflow"),
}


def command(binary, *arguments):
    return subprocess.run(
        (str(binary), *map(str, arguments)),
        check=True,
        capture_output=True,
        text=True,
    )


def percentile(values, fraction):
    ordered = sorted(values)
    return ordered[round((len(ordered) - 1) * fraction)]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--bin", type=Path, required=True)
    parser.add_argument("--repeats", type=int, default=12)
    args = parser.parse_args()
    if args.repeats < 1:
        parser.error("--repeats must be positive")
    binary = args.bin.resolve(strict=True)
    node = subprocess.run(
        ("mise", "which", "node"), check=True, capture_output=True, text=True
    ).stdout.strip()
    node_version = command(node, "--version").stdout.strip()
    with tempfile.TemporaryDirectory(prefix="omd-first-run-", dir="/private/tmp") as temporary:
        stores = {}
        source = {}
        for arm, names in ARMS.items():
            store = Path(temporary) / arm
            command(binary, "init", store, node)
            for name in names:
                package = ROOT / "mods/first-party" / name
                manifest = json.loads((package / "mod.json").read_text())
                inspected = json.loads(command(binary, "inspect", package).stdout)
                command(binary, "trust", store, package, inspected["sha256"], ",".join(manifest["capabilities"]))
                command(binary, "enable", store, package)
                source[name] = {"version": manifest["version"], "api": manifest["api"], "sha256": inspected["sha256"]}
            stores[arm] = store
        order = list(ARMS) * args.repeats
        random.Random(110923).shuffle(order)
        samples = {arm: [] for arm in ARMS}
        statuses = {}
        for arm in order:
            start = time.perf_counter_ns()
            result = command(binary, "status", stores[arm])
            samples[arm].append(round((time.perf_counter_ns() - start) / 1_000_000, 3))
            status = json.loads(result.stdout)
            statuses[arm] = {
                "active": [mod["id"] for mod in status["mods"] if mod["error"] is None],
                "errors": {mod["id"]: mod["error"] for mod in status["mods"] if mod["error"] is not None},
                "rejected": status.get("rejected", []),
            }
            if statuses[arm]["errors"] or statuses[arm]["rejected"] or set(statuses[arm]["active"]) != set(ARMS[arm]):
                raise RuntimeError(f"invalid active mod status for {arm}: {statuses[arm]}")
        summary = {
            arm: {"median_ms": statistics.median(values), "p95_ms": percentile(values, 0.95)}
            for arm, values in samples.items()
        }
        print(json.dumps({
            "schema": 1,
            "method": "cold omd-mod status process with isolated temporary stores; no model request",
            "binary": str(binary),
            "node_version": node_version,
            "seed": 110923,
            "repeats": args.repeats,
            "arms": ARMS,
            "sources": source,
            "samples_ms": samples,
            "summary": summary,
            "statuses": statuses,
            "paid_requests": 0,
        }, indent=2))


if __name__ == "__main__":
    main()
