#!/usr/bin/env python3
import json
import os
from pathlib import Path
import statistics
import subprocess
import tempfile
import time


ROOT = Path(__file__).resolve().parents[1]
BINARY = Path(os.environ.get("OMD_MOD_BIN", ROOT / "runtime/omd/target/debug/omd-mod"))
NODE = Path(os.environ.get("OMD_MOD_NODE", subprocess.check_output(["mise", "which", "node"], text=True).strip()))
PACKAGE = ROOT / "mods/exercise/task_scope"


def call(*args):
    completed = subprocess.run([str(BINARY), *map(str, args)], capture_output=True, text=True)
    if completed.returncode:
        raise RuntimeError((completed.stderr or completed.stdout).strip())
    return json.loads(completed.stdout)


def run(store, scenario):
    started = time.perf_counter_ns()
    result = call("test", store, scenario)
    elapsed_ms = (time.perf_counter_ns() - started) / 1_000_000
    return result, elapsed_ms


def main():
    exposure = {"type": "tool_exposure", "payload": None}
    scope = lambda paths: {"type": "invoke", "mod": "task_scope", "event": "command", "name": "scope", "payload": paths}
    steps = [exposure] * 30 + [exposure] * 10
    scoped = [scope("scripts/mod_conformance.py"), *steps[:30], scope("README.md"), *steps[30:]]
    with tempfile.TemporaryDirectory(prefix="omd-author-surface-") as directory:
        store = Path(directory) / "store"
        scenario_path = Path(directory) / "scenario.json"
        baseline_path = Path(directory) / "baseline.json"
        scenario_path.write_text(json.dumps({"schema": 1, "virtual_time_ms": 1000, "steps": scoped}, separators=(",", ":")))
        baseline_path.write_text(json.dumps({"schema": 1, "virtual_time_ms": 1000, "steps": steps}, separators=(",", ":")))
        call("init", store, NODE)
        inspected = call("inspect", PACKAGE)
        call("trust", store, PACKAGE, inspected["sha256"], ",".join(inspected["manifest"]["capabilities"]))
        call("enable", store, PACKAGE)
        enabled = [run(store, scenario_path) for _ in range(3)]
        call("disable", store, PACKAGE)
        disabled = [run(store, baseline_path) for _ in range(3)]
    values = [step["value"] for step in enabled[-1][0]["steps"] if step["type"] == "tool_exposure"]
    telemetry = enabled[-1][0]["status"]["mods"][0]["telemetry"]
    callbacks = [entry["elapsed_micros"] / 1000 for entry in telemetry["logs"] if entry["event"] == "tool_exposure"]
    if len(callbacks) != len(steps):
        raise RuntimeError("missing tool exposure timing samples")
    selected_python = sum(value == ["mod_task_scope_check_python"] for value in values)
    selected_none = sum(value == [] for value in values)
    if selected_python != 30 or selected_none != 10:
        raise RuntimeError("unexpected task tool selection")
    if any(step["value"] != [] for result, _ in disabled for step in result["steps"]):
        raise RuntimeError("disabled package exposed tools")
    output = {
        "schema": 1,
        "codex": json.loads((ROOT / "upstream.lock.json").read_text())["tag"],
        "mod_api": enabled[-1][0]["status"]["api"],
        "paid_requests": 0,
        "samples": len(steps),
        "selected_python": selected_python,
        "selected_none": selected_none,
        "callback_ms": {"median": statistics.median(callbacks), "p95": sorted(callbacks)[int(len(callbacks) * 0.95) - 1], "max": max(callbacks)},
        "run_wall_ms": {"enabled": [time_ms for _, time_ms in enabled], "disabled": [time_ms for _, time_ms in disabled]},
        "source_bytes": sum((PACKAGE / name).stat().st_size for name in ("index.ts", "mod.json")),
        "baseline_tools": disabled[-1][0]["steps"][0]["value"],
    }
    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    main()
