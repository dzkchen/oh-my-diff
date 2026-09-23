import json
from pathlib import Path
import random
import statistics
import subprocess
import tempfile
import time


ROOT = Path(__file__).resolve().parents[1]
BIN = ROOT / "runtime/omd/target/debug/omd-mod"
NAMES = ("omd_task_tools", "omd_session_anchor", "omd_verification_gate")


def call(*args):
    started = time.perf_counter_ns()
    result = subprocess.run((str(BIN), *map(str, args)), check=True, capture_output=True, text=True)
    return json.loads(result.stdout), (time.perf_counter_ns() - started) / 1_000_000


def percentile(samples, fraction):
    ordered = sorted(samples)
    return ordered[min(len(ordered) - 1, int((len(ordered) - 1) * fraction + 0.5))]


def main():
    node = subprocess.run(("mise", "which", "node"), check=True, capture_output=True, text=True).stdout.strip()
    with tempfile.TemporaryDirectory(prefix="omd-mod-cost-", dir="/private/tmp") as temporary:
        base = Path(temporary)
        stores = {}
        for arm, names in (("empty", ()), *((name, (name,)) for name in NAMES), ("combined", NAMES)):
            store = base / arm
            call("init", store, node)
            for name in names:
                source = ROOT / "mods/first-party" / name
                manifest = json.loads((source / "mod.json").read_text())
                inspected, _ = call("inspect", source)
                call("trust", store, source, inspected["sha256"], ",".join(manifest["capabilities"]))
                call("enable", store, source)
            stores[arm] = store
        scenario = base / "scenario.json"
        scenario.write_text(json.dumps({"schema": 1, "steps": [
            {"type": "event", "event": "start", "payload": {}},
            {"type": "tool_exposure", "thread_id": "task", "payload": {"remaining_work": ["edit view.ts"]}},
            {"type": "event", "event": "compaction", "payload": {"token_limit": 20000, "context_window": 30000}},
            {"type": "event", "event": "compaction_end", "payload": {"turn_id": "one", "trigger": "auto"}},
            {"type": "event", "event": "context", "payload": {"thread_id": "task", "turn_id": "two", "checkpoint": {"remaining_work": ["edit view.ts"]}}}
        ]}))
        cold = base / "cold.json"
        cold.write_text(json.dumps({"schema": 1, "steps": [{"type": "status"}]}))
        randomizer = random.Random(110226)
        order = [arm for _ in range(12) for arm in stores]
        randomizer.shuffle(order)
        measurements = {arm: {"cold_ms": [], "scenario_ms": [], "callback_micros": []} for arm in stores}
        for arm in order:
            _, elapsed = call("test", stores[arm], cold)
            measurements[arm]["cold_ms"].append(elapsed)
            result, elapsed = call("test", stores[arm], scenario)
            measurements[arm]["scenario_ms"].append(elapsed)
            measurements[arm]["context_bytes"] = sum(len(value["value"]["text"].encode()) for step in result["steps"] if step["type"] == "event" and isinstance(step["value"], list) for value in step["value"] if isinstance(value.get("value"), dict) and isinstance(value["value"].get("text"), str))
            measurements[arm]["exposed_tools"] = result["steps"][1]["value"]
            measurements[arm]["callback_micros"].append({mod["id"]: [log["elapsed_micros"] for log in mod["telemetry"]["logs"]] for mod in result["status"]["mods"]})
        summary = {}
        for arm, values in measurements.items():
            summary[arm] = {
                "cold_median_ms": statistics.median(values["cold_ms"]),
                "cold_p95_ms": percentile(values["cold_ms"], 0.95),
                "scenario_median_ms": statistics.median(values["scenario_ms"]),
                "scenario_p95_ms": percentile(values["scenario_ms"], 0.95),
                "context_bytes": values["context_bytes"],
                "exposed_tools": values["exposed_tools"],
                "callback_median_ms": {name: statistics.median(value for sample in values["callback_micros"] for value in sample.get(name, [])) / 1000 if any(sample.get(name) for sample in values["callback_micros"]) else 0 for name in (() if arm == "empty" else NAMES if arm == "combined" else (arm,))},
                "callback_p95_ms": {name: percentile([value for sample in values["callback_micros"] for value in sample.get(name, [])], 0.95) / 1000 if any(sample.get(name) for sample in values["callback_micros"]) else 0 for name in (() if arm == "empty" else NAMES if arm == "combined" else (arm,))},
                "source_bytes": sum((ROOT / "mods/first-party" / name / file).stat().st_size for name in (() if arm == "empty" else NAMES if arm == "combined" else (arm,)) for file in ("mod.json", "index.ts")),
            }
        print(json.dumps({"samples_per_arm": 12, "seed": 110226, "raw": measurements, "summary": summary, "paid_requests": 0}, indent=2))


if __name__ == "__main__":
    main()
