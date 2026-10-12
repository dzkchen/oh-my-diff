import argparse
import hashlib
import json
import os
import platform
from pathlib import Path
import random
import re
import select
import signal
import shlex
import shutil
import statistics
import subprocess
import sys
import termios
import time
import tty

import pyte

from pty_session import ROOT, Session, call, environment, fresh, git, provider
from terminal_capture import Capture


def read_frame(session, stream, timeout):
    capture_fd = session.capture.channel.fileno()
    readers = [capture_fd, sys.stdin.fileno()] if session.relay else [capture_fd]
    ready = select.select(readers, [], [], 0 if session.capture.available() else timeout)[0]
    if session.relay and sys.stdin.fileno() in ready:
        os.write(session.master, os.read(sys.stdin.fileno(), 65536))
    if capture_fd in ready or session.capture.available():
        captured = session.capture.read()
        if captured is None:
            return False
        kind, received, data = captured
        if kind != b"D":
            raise RuntimeError("unexpected terminal capture record")
        session.frame_time = received / 1_000_000_000
        parse_started = time.perf_counter()
        queue_delay_ms = (parse_started - session.frame_time) * 1000
        session.capture_max_queue_delay_ms = max(session.capture_max_queue_delay_ms, queue_delay_ms)
        session.raw.extend(data)
        stream.feed(data)
        parsed = time.perf_counter() if session.read_metrics is not None else None
        session.display_text = "\n".join(stream.listener.display)
        if session.mods_status is None and re.search(r"\b[1-9]\d* mods on\b", session.display_text):
            session.mods_status = session.frame_time
        inspected = time.perf_counter() if session.read_metrics is not None else None
        if session.relay:
            os.write(sys.stdout.fileno(), data)
        if session.read_metrics is not None:
            session.read_metrics.append({"received_s": session.frame_time - session.started,
                                         "bytes": len(data), "queue_delay_ms": queue_delay_ms,
                                         "parse_ms": (parsed - parse_started) * 1000,
                                         "screen_scan_ms": (inspected - parsed) * 1000,
                                         "relay_ms": (time.perf_counter() - inspected) * 1000})
        return True
    return False


def observe(session, screen, stream, predicate, timeout=30):
    deadline = time.perf_counter() + timeout
    while time.perf_counter() < deadline:
        if predicate(session.display_text):
            return session.frame_time
        if read_frame(session, stream, 0.003):
            if predicate(session.display_text):
                return session.frame_time
        if session.process.poll() is not None:
            break
    raise RuntimeError("terminal observation failed:\n" + session.display_text)


def sample(binary, repo, env, mods, trace, expected_packages, claude_plugin=None, probe=False, relay=False):
    def mark(phase):
        if env.get("OMD_PROFILE_LOG"):
            with open(env["OMD_PROFILE_LOG"], "a") as output:
                output.write(f"OMD_MARK {phase}\n")

    columns, rows = os.get_terminal_size() if relay else (110, 36)
    screen = pyte.Screen(columns, rows)
    stream = pyte.ByteStream(screen)
    args = ("--no-daemon",)
    if claude_plugin:
        args = ("-c", "exec " + shlex.join([str(binary), "--setting-sources", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--plugin-dir", str(claude_plugin)]))
        binary = Path("/bin/sh")
    capture = None
    def prepare(master):
        nonlocal capture
        capture = Capture(master)
    try:
        session = Session(binary, repo, env, columns=columns, rows=rows, args=args, before_spawn=prepare)
    except BaseException:
        if capture is not None:
            capture.close()
        raise
    session.capture = capture
    session.capture_max_queue_delay_ms = 0
    started_unix_ns, started = session.started_unix_ns, session.started
    session.relay = relay
    session.mods_status = None
    session.frame_time = started
    session.display_text = "\n".join(screen.display)
    session.started = started
    session.read_metrics = [] if env.get("OMD_PROFILE_LOG") else None
    command_times = {}
    screen.write_process_input = lambda value: None if relay else os.write(session.master, value.encode())
    previous = None
    try:
        if relay:
            previous = termios.tcgetattr(sys.stdin.fileno())
            tty.setraw(sys.stdin.fileno())
        marker = r"^\s*[›❯>]\s*(?:Try[^\n]*)?$" if claude_plugin else r"Ask (Codex|Oh My Diff) to do anything"
        composer = observe(session, screen, stream, lambda text: bool(re.search(marker, text, re.M)))
        os.write(session.master, b"LATENCY_PROBE")
        typed = observe(session, screen, stream, lambda text: "LATENCY_PROBE" in text)
        mark("typeable")
        os.write(session.master, b"\x15")
        readiness = None
        if mods and env.get("OMD_PROFILE_READY"):
            deadline = time.perf_counter() + 30
            while time.perf_counter() < deadline:
                try:
                    readiness = json.loads(Path(env["OMD_PROFILE_READY"]).read_text())
                    break
                except (FileNotFoundError, json.JSONDecodeError):
                    read_frame(session, stream, 0.003)
            if not readiness or readiness["pid"] != session.process.pid:
                raise RuntimeError("current startup preparation marker missing or wrong PID")
        settle = time.perf_counter() + 6
        while time.perf_counter() < settle:
            read_frame(session, stream, 0.01)
        if mods:
            status = json.loads((Path(env["OMD_MOD_STORE"]) / "mod-status.json").read_text())
            if status.get("reload_error") or status.get("rejected") or set(status["order"]) != set(expected_packages) or any(package.get("error") for package in status["mods"]):
                raise RuntimeError("current mod status is not the expected healthy active set")
            trace.with_suffix(".status.json").write_text(json.dumps(status, indent=2) + "\n")
        processes = subprocess.check_output(["ps", "-axo", "pid=,pgid=,rss=,comm="], text=True)
        members = [line.strip() for line in processes.splitlines() if line.split()[1] == str(session.process.pid)]
        compilers = [line.split()[0] for line in processes.splitlines() if Path(line.split()[-1]).name in {"rustc", "clang", "clang++"}]
        command = "/latency" if claude_plugin or probe else "/mods" if mods and expected_packages else "/status"
        prefix = ""
        for character in command:
            os.write(session.master, character.encode())
            prefix += character
            observe(session, screen, stream, lambda text: bool(re.search(r"^\s*[›❯>]\s*" + re.escape(prefix) + r"\s*$", text, re.M)))
        if claude_plugin or probe:
            observe(session, screen, stream, lambda text: "Print the local latency marker" in text)
        mark("command_enter")
        result_marker = "LATENCY_COMMAND_DONE" if claude_plugin or probe else "Add from source" if mods and expected_packages else "Model:"
        if result_marker in session.display_text:
            raise RuntimeError("command result marker was already visible before Enter")
        entered = time.perf_counter()
        command_times["entered_s"] = entered - started
        os.write(session.master, b"\r")
        completed = observe(session, screen, stream, lambda text: result_marker in text)
        if completed < entered:
            raise RuntimeError("command result was captured before Enter")
        command_times["completed_s"] = completed - started
        mark("command_result")
        clock_drift_ms = (time.time_ns() - started_unix_ns) / 1000000 - (time.perf_counter() - started) * 1000
        if readiness and abs(clock_drift_ms) > 5:
            raise RuntimeError(f"wall clock shifted during readiness measurement: {clock_drift_ms:.3f} ms")
        return {"first_composer_ms": (composer - started) * 1000, "typeable_ms": (typed - started) * 1000,
                "clock_drift_ms": clock_drift_ms,
                "mods_ready_ms": (readiness["ready_unix_ns"] - started_unix_ns) / 1000000 if readiness else None,
                "mods_ready_kind": "preparation completion marker" if readiness else None,
                "visible_mod_status_ms": (session.mods_status - started) * 1000 if session.mods_status is not None else None,
                "command_ms": (completed - entered) * 1000, "command": command,
                "capture_max_queue_delay_ms": session.capture_max_queue_delay_ms,
                "idle_rss_kib": sum(int(line.split()[2]) for line in members), "processes": members,
                "compiler_pids": compilers, "load_average": list(os.getloadavg())}
    finally:
        trace.write_bytes(session.raw)
        if session.read_metrics is not None:
            trace.with_suffix(".reads.json").write_text(json.dumps({"command": command_times, "reads": session.read_metrics}, indent=2) + "\n")
        os.close(session.master)
        capture_error = capture.close()
        if previous is not None:
            termios.tcsetattr(sys.stdin.fileno(), termios.TCSADRAIN, previous)
            os.write(sys.stdout.fileno(), b"\x1b[<u\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1004l\x1b[?1006l\x1b[?1049l\x1b[?25h\x1b[?2004l")
        try:
            os.killpg(session.process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            session.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(session.process.pid, signal.SIGKILL)
            session.process.wait(timeout=5)
        if capture_error:
            raise RuntimeError(capture_error)


def main():
    parser = argparse.ArgumentParser(description="Release TUI latency diagnostic; no model prompts are sent")
    parser.add_argument("--binaries", type=Path, required=True)
    parser.add_argument("--upstream", type=Path, required=True)
    parser.add_argument("--repeats", type=int, default=10)
    parser.add_argument("--claude", type=Path)
    parser.add_argument("--claude-plugin", type=Path)
    parser.add_argument("--probe-mod", type=Path)
    parser.add_argument("--terminal", choices=["pty", "kitty", "orca"], default="pty")
    parser.add_argument("--allow-unlocked-prototype", action="store_true")
    parser.add_argument("--profile-startup", action="store_true")
    parser.add_argument("--readiness-marker", action="store_true")
    parser.add_argument("--disable-mods", action="store_true")
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    if args.repeats < 1:
        parser.error("--repeats must be positive")
    if bool(args.claude) != bool(args.claude_plugin):
        parser.error("--claude and --claude-plugin are required together")
    if args.disable_mods and (args.claude or args.probe_mod):
        parser.error("--disable-mods requires the standard profile matrix")
    if args.readiness_marker and args.claude:
        parser.error("--readiness-marker requires an instrumented OMD prototype")
    if args.terminal != "pty" and not sys.stdin.isatty():
        parser.error("real-terminal measurements must run inside that terminal")
    if args.terminal == "orca" and os.environ.get("TERM_PROGRAM", "").lower() != "orca":
        parser.error("--terminal orca requires Orca's terminal environment")
    if args.terminal == "kitty" and not os.environ.get("KITTY_WINDOW_ID"):
        parser.error("--terminal kitty requires Kitty's terminal environment")
    base = fresh("latency")
    print(base, flush=True)
    repo = base / "repo"
    repo.mkdir()
    git(repo, "init", "-q")
    binaries = args.binaries.resolve()
    upstream = args.upstream.resolve()
    lock = json.loads((ROOT / "runtime/lean-release.lock.json").read_text())
    identities = {}
    for name, binary in {"omd": binaries / "codex", "upstream": upstream, "manager": binaries / "omd-mod"}.items():
        digest = hashlib.file_digest(binary.open("rb"), "sha256").hexdigest()
        identities[name] = {"path": str(binary), "sha256": digest}
        if name != "upstream" and digest != lock["artifacts"][binary.name]["sha256"] and not args.allow_unlocked_prototype:
            raise RuntimeError(f"{name} does not match the release lock")
    expected = lock["upstream_tag"].removeprefix("rust-v")
    for binary in (binaries / "codex", upstream):
        if call([binary, "--version"], repo).stdout.strip() != f"codex-cli {expected}":
            raise RuntimeError("comparison binaries must match the current upstream pin")
    if args.claude:
        binary = args.claude.resolve()
        identities["claude"] = {"path": str(binary), "sha256": hashlib.file_digest(binary.open("rb"), "sha256").hexdigest(),
                                "version": call([binary, "--version"], repo).stdout.strip()}
        identities["claude_plugin"] = {str(path.relative_to(args.claude_plugin)): hashlib.file_digest(path.open("rb"), "sha256").hexdigest()
                                       for path in sorted(args.claude_plugin.rglob("*")) if path.is_file()}
    node = call(["mise", "which", "node"], ROOT).stdout.strip()
    stores = {}
    packages = {}
    for profile in (() if args.claude else ("probe",) if args.probe_mod else ("platform", "full")):
        store = base / f"store-{profile}"
        call([binaries / "omd-mod", "init", store, node], repo)
        selected = {"first_party_installed": ["latency_probe"], "first_party_default_active": ["latency_probe"]} if profile == "probe" else lock["profiles"][profile]
        packages[profile] = {"active": [] if args.disable_mods else selected["first_party_default_active"], "installed": {}}
        for identifier in selected["first_party_installed"]:
            package = args.probe_mod.resolve() if profile == "probe" else ROOT / "mods/first-party" / identifier
            inspected = json.loads(call([binaries / "omd-mod", "inspect", package], repo).stdout)
            packages[profile]["installed"][identifier] = inspected
            call([binaries / "omd-mod", "trust", store, package, inspected["sha256"],
                  ",".join(inspected["manifest"]["capabilities"])], repo)
            if identifier in packages[profile]["active"]:
                call([binaries / "omd-mod", "enable", store, package], repo)
        stores[profile] = store
    server, url = provider()
    result = {"method": "110x36 synthetic PTY; release binaries; first composer then verified draft echo; Enter to command result",
              "identities": identities, "seed": 411, "samples": [], "paid_requests": None if args.claude else 0,
              "qualification": "diagnostic only; not Kitty or Orca acceptance"}
    result["unlocked_prototype"] = args.allow_unlocked_prototype
    result["startup_instrumentation"] = args.profile_startup
    result["readiness_marker"] = args.readiness_marker
    result["disabled_mods"] = args.disable_mods
    result["packages"] = packages
    result["run_directory"] = str(base)
    result["idle_seconds"] = 6
    result["completed"] = False
    result["upstream_tag"] = lock["upstream_tag"]
    result["machine"] = platform.platform()
    result["checkout_head"] = git(ROOT, "rev-parse", "HEAD").strip()
    result["harness_sha256"] = hashlib.file_digest(Path(__file__).open("rb"), "sha256").hexdigest()
    result["pty_session_sha256"] = hashlib.file_digest((ROOT / "scripts/pty_session.py").open("rb"), "sha256").hexdigest()
    result["terminal_capture_sha256"] = hashlib.file_digest((ROOT / "scripts/terminal_capture.py").open("rb"), "sha256").hexdigest()
    result["capture"] = "independent PTY reader process; ordered receipt timestamps; 8 MiB fail-closed queue; reader ready before launch clock"
    result["harness_pid"] = os.getpid()
    if args.terminal != "pty":
        result.update(method="PTY relay in real terminal; native terminal negotiation; timestamps at app output before terminal paint",
                      terminal=args.terminal, terminal_environment={key: value for key, value in os.environ.items() if key.startswith(("TERM", "LC_TERMINAL", "COLORTERM", "KITTY_"))}, dimensions=list(os.get_terminal_size()), qualification="real-terminal app response; excludes physical display scanout")
    try:
        arms = ["claude"] if args.claude else ["probe"] if args.probe_mod else ["upstream", "direct", "platform", "full"]
        order = arms + arms * args.repeats
        measured = order[len(arms):]
        random.Random(411).shuffle(measured)
        order[len(arms):] = measured
        for index, arm in enumerate(order):
            mods = arm in stores
            env = os.environ.copy() if arm == "claude" else environment(base, binaries, repo, stores.get(arm, next(iter(stores.values()))), url,
                              name=str(index), profile=arm if mods else "platform")
            for variable in ("OMD_PROFILE_STARTUP", "OMD_PROFILE_LOG", "OMD_PROFILE_READY"):
                env.pop(variable, None)
            if not mods:
                env["OMD_MODE"] = "upstream_direct"
                env.pop("OMD_MOD_STORE", None)
            if args.profile_startup:
                env["OMD_PROFILE_STARTUP"] = "1"
                env["OMD_PROFILE_LOG"] = str(base / f"{index}-{arm}-phases.log")
            if mods:
                (stores[arm] / "mod-status.json").unlink(missing_ok=True)
                if args.readiness_marker:
                    env["OMD_PROFILE_READY"] = str(base / f"{index}-{arm}-ready.json")
            if args.terminal != "pty":
                env.update({key: value for key, value in os.environ.items() if key.startswith(("TERM", "LC_TERMINAL", "COLORTERM", "KITTY_"))})
            binary = upstream if arm == "upstream" else binaries / "codex"
            if arm == "claude":
                binary = args.claude.resolve()
                env = os.environ.copy()
            try:
                entry = sample(binary, ROOT if arm == "claude" else repo, env, mods, base / f"{index}-{arm}.ansi", packages[arm]["active"] if mods else [], args.claude_plugin, bool(args.probe_mod), args.terminal != "pty")
            finally:
                # sample has reaped its process. Keep evidence, not disposable
                # launcher executables that become large copies when archived.
                launchers = base / f"codex-home-{index}" / "tmp" / "arg0"
                if arm != "claude" and launchers.exists():
                    shutil.rmtree(launchers)
            if mods and args.disable_mods and len(entry["processes"]) != 1:
                raise RuntimeError("disabled mods unexpectedly started child processes")
            result["samples"].append({"arm": arm, "warmup": index < len(arms), **entry})
            (base / "results.json").write_text(json.dumps(result, indent=2) + "\n")
            print(json.dumps({"arm": arm, "warmup": index < len(arms), **{key: round(value, 2) for key, value in entry.items() if isinstance(value, float)}}), flush=True)
        result["summary"] = {}
        for arm in arms:
            rows = [row for row in result["samples"] if row["arm"] == arm and not row["warmup"]]
            result["summary"][arm] = {}
            for metric in ("typeable_ms", "first_composer_ms", "mods_ready_ms", "command_ms", "idle_rss_kib"):
                values = sorted(row[metric] for row in rows if row[metric] is not None)
                if values:
                    result["summary"][arm][metric] = {"p50": statistics.median(values), "p75": values[round((len(values) - 1) * .75)], "p95": values[round((len(values) - 1) * .95)]}
        if server.RequestHandlerClass.requests:
            raise RuntimeError("latency diagnostic unexpectedly made model requests")
        result["completed"] = True
    except BaseException as error:
        result["failure"] = {"type": type(error).__name__, "message": str(error)}
        raise
    finally:
        result["local_mock_model_requests"] = len(server.RequestHandlerClass.requests)
        result["model_requests"] = None if args.claude else len(server.RequestHandlerClass.requests)
        (base / "results.json").write_text(json.dumps(result, indent=2) + "\n")
        if args.report:
            args.report.write_text(json.dumps(result, indent=2) + "\n")
        server.shutdown()


if __name__ == "__main__":
    main()
