#!/usr/bin/env python3
import argparse
import json
import math
import os
import resource
from pathlib import Path
import shlex
import shutil
import statistics
import subprocess
import time

from client_acceptance import store_with
from pty_session import ROOT, call, environment, fresh, git, provider
from real_terminal_check import Kitty, Ghostty, WezTerm, state, wait


def process_cpu():
    rows = {}
    for line in call(["ps", "-axo", "pid=,ppid=,time="], ROOT).stdout.splitlines():
        pid, parent, duration = line.split()
        parts = duration.replace("-", ":").split(":")
        seconds = sum(float(value) * factor for value, factor in zip(reversed(parts), [1, 60, 3600, 86400]))
        rows[int(pid)] = (int(parent), seconds)
    return rows


def cpu_delta(before, after, root, exclude=()):
    children = {root}
    while True:
        added = {pid for pid, (parent, _) in after.items() if parent in children and pid not in exclude}
        if added <= children:
            break
        children |= added
    return sum(max(0, after[pid][1] - before.get(pid, (0, 0))[1]) for pid in children if pid in after)


def records(path):
    return map(json.loads, path.read_text().rpartition("\n")[0].splitlines())


def summarize(base):
    capture = list(records(base / "capture.jsonl"))
    samples = [row for row in capture if "display_ns" in row]
    produced = {row["sequence"]: row for row in records(base / "producer.jsonl") if "sequence" in row}
    if any(sequence >= 65536 for sequence in produced):
        raise AssertionError("producer exceeded the 16-bit frame marker range")
    shown = {}
    for sample in samples:
        if sample["status"] == 0 and sample["sequence"] in produced:
            shown.setdefault(sample["sequence"], sample["display_ns"])
    if not shown:
        raise AssertionError("capture found no valid sequence markers")
    start = min(shown.values()) + 3e9
    end = max((row["capture_end_ns"] for row in capture if "capture_end_ns" in row),
              default=max(sample["display_ns"] for sample in samples))
    duration = (end - start) / 1e9
    if duration < 5:
        raise AssertionError("fewer than five complete measured seconds")
    windows = [sum(start + n * 1e9 <= value < min(end, start + (n + 1) * 1e9) for value in shown.values())
               / min(1, duration - n) for n in range(math.ceil(duration))]
    latency = [(at - produced[sequence]["created_ns"]) / 1e6 for sequence, at in shown.items() if start <= at < end]
    complete = [row["display_ns"] for row in samples if row["status"] == 0 and start <= row["display_ns"] < end]
    cadence = [(b - a) / 1e6 for a, b in zip(complete, complete[1:]) if b > a]
    stages = {}
    trace = base / "stages.jsonl"
    for row in records(trace) if trace.exists() else []:
        if start <= row["at_ns"] < end:
            stages.setdefault(row["stage"], []).append(row)
    measured = [row for row in produced.values() if start <= row["created_ns"] < end]
    return {"shown_fps_windows": windows, "shown_fps_p50": statistics.median(windows),
            "latency_ms_p50": statistics.median(latency) if latency else None,
            "latency_ms_p95": sorted(latency)[int(len(latency) * .95)] if latency else None,
            "unique_shown": len(shown), "capture_samples": len(samples), "invalid_markers": sum(row["sequence"] < 0 for row in samples),
            "invalid_markers_measured": sum(row["sequence"] < 0 and row["status"] == 0 and start <= row["display_ns"] < end for row in samples),
            "capture_interval_ms_p50": statistics.median(cadence) if cadence else None,
            "capture_interval_ms_p95": sorted(cadence)[int(len(cadence) * .95)] if cadence else None,
            "measured_seconds": duration, "producer_frames": len(measured),
            "source_dimensions": [produced[max(produced)]["width"], produced[max(produced)]["height"]],
            "producer_cpu_ms": sum(row["cpu_us"] for row in measured) / 1000,
            "producer_generate_ms_p50": statistics.median(row["generate_ms"] for row in measured) if measured else None,
            "producer_encode_write_ms_p50": statistics.median(row["encode_write_ms"] for row in measured) if measured else None,
            "host_interval_ms_p50": {name: statistics.median((b["at_ns"] - a["at_ns"]) / 1e6 for a, b in zip(rows, rows[1:]))
                                     for name, rows in stages.items() if name in ("raw_snapshot", "raster_apply", "owned_frame") and len(rows) > 1},
            "stages": {name: {"samples": len(rows), "wall_ms_p50": statistics.median(row["wall_ns"] for row in rows) / 1e6,
                              "wall_ms_p95": sorted(row["wall_ns"] for row in rows)[int(len(rows) * .95)] / 1e6,
                              "cpu_ms": sum(row["cpu_ns"] for row in rows) / 1e6} for name, rows in stages.items()}}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--binaries", type=Path, required=True)
    parser.add_argument("--terminal", choices=["kitty", "ghostty", "wezterm", "orca"], required=True)
    parser.add_argument("--transport", choices=["png", "raw"], required=True)
    parser.add_argument("--seconds", type=int, default=20)
    parser.add_argument("--mouse", action="store_true")
    args = parser.parse_args()
    if not 9 <= args.seconds <= 400:
        parser.error("--seconds must be 9–400, leaving startup allowance before the 120 FPS 16-bit marker wraps")
    base = fresh(f"frames-{args.terminal}-{args.transport}")
    print(base, flush=True)
    call(["swiftc", "-parse-as-library", "-O", ROOT / "scripts/frame_capture.swift", "-o", base / "capture"], ROOT)
    repo = base / "repo"
    repo.mkdir()
    git(repo, "init", "-q")
    shutil.copy2(ROOT / "scripts/frame_producer.mjs", repo / "producer.mjs")
    if args.mouse:
        call(["swiftc", "-O", ROOT / "scripts/mouse_look.swift", "-o", repo / "mouse_look"], ROOT)
    package = ROOT / "mods/examples/frame_stream"
    store = base / "store"
    store_with(args.binaries / "omd-mod", store, [package])
    call([args.binaries / "omd-mod", "settings", store, package,
          json.dumps({"producer": str(repo / "producer.mjs"), "transport": args.transport,
                      "mouse_helper": str(repo / "mouse_look") if args.mouse else ""})], ROOT)
    server, url = provider()
    terminal, handle = None, None
    try:
        env = environment(base, args.binaries, repo, store, url)
        env.pop("TERM", None)
        env.pop("NO_COLOR", None)
        env.pop("FORCE_COLOR", None)
        env["OMD_FRAME_TRACE"] = str(base / "stages.jsonl")
        script = base / "run.sh"
        script.write_text("#!/bin/sh\nunset NO_COLOR FORCE_COLOR\n" + "".join(f"export {key}={shlex.quote(value)}\n" for key, value in env.items())
                          + f"cd {shlex.quote(str(repo))}\nprintf '%s\\n' \"$$\" > {shlex.quote(str(base / 'codex.pid'))}\n"
                          + f"exec {shlex.quote(str(args.binaries / 'codex'))} --no-daemon -C {shlex.quote(str(repo))}\n")
        launch_env = {key: value for key, value in os.environ.items()
                      if not key.startswith(("TERM_PROGRAM", "LC_TERMINAL", "COLORTERM", "TMUX", "KITTY_", "WEZTERM_", "GHOSTTY_", "NO_COLOR", "FORCE_COLOR"))}
        if args.terminal == "orca":
            result = json.loads(call(["orca", "terminal", "create", "--worktree", f"path:{ROOT}", "--title", "Frame measurement",
                                      "--command", f"sh {shlex.quote(str(script))}", "--json"], ROOT).stdout)
            (base / "terminal.json").write_text(json.dumps(result, indent=2))
            handle = result["result"]["terminal"]["handle"]
            call(["orca", "terminal", "switch", "--terminal", handle, "--json"], ROOT)
            apps = json.loads(call(["orca", "computer", "list-apps", "--json"], ROOT).stdout)["result"]["apps"]
            pid = next(app["pid"] for app in apps if app["bundleId"] == "com.stablyai.orca")
        else:
            terminal = {"kitty": Kitty, "ghostty": Ghostty, "wezterm": WezTerm}[args.terminal](base, script)
            terminal.start(launch_env)
            pid = terminal.pid()
        metrics = wait("producer metrics", lambda: state(store, "frame_stream").get("metrics"), 90)
        time.sleep(2)
        host_pid = int((base / "codex.pid").read_text())
        before = process_cpu()
        usage_before = resource.getrusage(resource.RUSAGE_CHILDREN)
        with (base / "capture.jsonl").open("w") as capture:
            subprocess.run([base / "capture", str(pid), str(args.seconds), base / "capture.png"], stdout=capture, check=True)
        usage_after = resource.getrusage(resource.RUSAGE_CHILDREN)
        after = process_cpu()
        shutil.copy2(metrics, base / "producer.jsonl")
        results = {"terminal": args.terminal, "transport": args.transport, "seconds": args.seconds,
                   "binaries": str(args.binaries), "run": str(base), "client": state(store, "frame_stream").get("client"),
                   "host_tree_cpu_seconds": cpu_delta(before, after, host_pid),
                   "terminal_tree_cpu_seconds": cpu_delta(before, after, pid, (host_pid,)),
                   "capture_cpu_seconds": usage_after.ru_utime + usage_after.ru_stime - usage_before.ru_utime - usage_before.ru_stime,
                   **summarize(base)}
        (base / "results.json").write_text(json.dumps(results, indent=2) + "\n")
        print(json.dumps(results), flush=True)
    finally:
        if terminal:
            terminal.close()
        if handle:
            call(["orca", "terminal", "close", "--terminal", handle, "--json"], ROOT, check=False)
        server.shutdown()


if __name__ == "__main__":
    main()
