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
    steps = [{"type": "tool_exposure", "payload": {"remaining_work": ["fix scripts/mod_conformance.py"]}}
             for _ in range(30)]
    steps += [{"type": "tool_exposure", "payload": {"remaining_work": ["update README.md"]}}
              for _ in range(10)]
    scenario = {"schema": 1, "virtual_time_ms": 1000, "steps": steps}
    with tempfile.TemporaryDirectory(prefix="omd-author-surface-") as directory:
        store = Path(directory) / "store"
        scenario_path = Path(directory) / "scenario.json"
        scenario_path.write_text(json.dumps(scenario, separators=(",", ":")))
        call("init", store, NODE)
        inspected = call("inspect", PACKAGE)
        call("trust", store, PACKAGE, inspected["sha256"], "tools,context,execution")
        call("enable", store, PACKAGE)
        enabled = [run(store, scenario_path) for _ in range(3)]
        call("disable", store, PACKAGE)
        disabled = [run(store, scenario_path) for _ in range(3)]
    values = [step["value"] for step in enabled[-1][0]["steps"]]
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
        "codex": "0.155.1",
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
