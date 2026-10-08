#!/usr/bin/env python3
import argparse
import fcntl
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import tempfile
import termios
import time

try:
    from scripts import install_support as support
    from scripts.lean_profile_acceptance import isolated_environment
except ModuleNotFoundError:
    import install_support as support
    from lean_profile_acceptance import isolated_environment


ROOT = Path(__file__).resolve().parents[1]


def call(args, env):
    result = subprocess.run([str(item) for item in args], cwd=ROOT, env=env,
                            capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError((result.stderr or result.stdout)[-1200:])
    return json.loads(result.stdout)


def terminal(binary, repo, env, width, version, greetings, profile=None, *,
             logo=True, greeting="", exercise=False, arguments=(), status=None, status_selector=None,
             backdrop=None, absent=(), cache_store=None, startup_seconds=10, trace_path=None,
             check_first_paint=True, ascii_logo=False, live_mods=(), native_session=None,
             live_recovery=None):
    import pyte

    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 28, width, 0, 0))
    launched_wall_ns = time.time_ns()
    process = subprocess.Popen([str(binary), "-C", str(repo), *arguments], cwd=repo, env=env,
                               stdin=slave, stdout=slave, stderr=slave,
                               start_new_session=True)
    os.close(slave)
    output = bytearray()
    screen = pyte.Screen(width, 28)
    screen.write_process_input = lambda text: os.write(master, text.encode())
    stream = pyte.ByteStream(screen)
    stages = {}
    started = time.monotonic()
    cache_events = []
    cache_states = {}
    completed_frames = 0
    completed_screen_digest = None
    prelive_frames = []
    live_seen = False
    sync_begin = b"\x1b[?2026h"
    sync_end = b"\x1b[?2026l"
    mark = ("╭─╮ ╭╮╭╮ ┌─╮", "│ │ │╰╯│ │ │", "╰─╯ ╵  ╵ └─╯")
    ascii_mark = (".-. |\\/| |-.", "| | |  | | |", "'-' |  | |-'")
    title = f"OpenAI Codex (v{version})" + (f" | {profile}" if profile else "")

    def compact(text):
        return re.sub(r"\s+", "", text)

    def visible(phrase):
        return compact(phrase) in compact("\n".join(screen.display))

    def mark_visible():
        if screen.columns < 15:
            return any(line.strip() == "OMD" for line in screen.display)
        return (all(visible(row) for row in ascii_mark) if ascii_logo else
                all(visible(row) for row in mark) or all(visible(row) for row in ascii_mark))

    def native_greeting_visible():
        # Long upstream phrases can be truncated: their first 24 characters still fit at 80 columns.
        return any(visible(phrase[:24]) for phrase in greetings)

    def appearance():
        return (visible(title) and mark_visible() == logo
                and (visible(greeting) if greeting else not native_greeting_visible()
                     and not visible("THEME GREETING PROBE"))
                and (not backdrop or visible(backdrop))
                and all(not visible(phrase) for phrase in absent))

    def capture():
        text = "\n".join(screen.display)
        return {"width": screen.columns, "screen": screen.display,
                "screen_sha256": hashlib.sha256(text.encode()).hexdigest(),
                "backgrounds": sorted({cell.bg for row in screen.buffer.values()
                                       for cell in row.values()})}

    def startup_appearance():
        if greeting is None:
            return (visible(title) and not mark_visible() and native_greeting_visible()
                    and not visible("| OMD+") and not visible("| OMD Core"))
        return appearance()

    def feed(chunk):
        nonlocal completed_frames, completed_screen_digest
        previous_length = len(output)
        output.extend(chunk)
        # Split at actual synchronized-update end markers, including markers split across
        # transport reads. Feed all other bytes immediately so terminal queries can reply.
        scan_start = max(0, previous_length - len(sync_end) + 1)
        ends = [scan_start + match.end() for match in re.finditer(re.escape(sync_end),
                                                                output[scan_start:])
                if scan_start + match.end() > previous_length]
        consumed = 0
        for end in ends:
            through = end - previous_length
            stream.feed(chunk[consumed:through])
            consumed = through
            if sync_begin not in output[:end]:
                continue
            completed_frames += 1
            completed_screen_digest = capture()["screen_sha256"]
            if "first_paint" not in stages and visible(f"OpenAI Codex (v{version})"):
                stages["first_paint"] = {**capture(), "completed_frame": completed_frames,
                    "trace_end_offset": end, "elapsed_ms": round((time.monotonic() - started) * 1000),
                    "boundary": "DEC synchronized update end (2026)"}
                if check_first_paint and not startup_appearance():
                    raise AssertionError("first completed editable frame assertion failed:\n"
                                         + "\n".join(screen.display))
            if (check_first_paint and not live_seen and screen.columns == width
                    and visible(f"OpenAI Codex (v{version})")):
                prelive_frames.append({"completed_frame": completed_frames, "trace_end_offset": end,
                    "screen_sha256": capture()["screen_sha256"],
                    "elapsed_ms": round((time.monotonic() - started) * 1000)})
                if not startup_appearance():
                    raise AssertionError("completed startup frame lost presentation before live publication:\n"
                                         + "\n".join(screen.display))
        stream.feed(chunk[consumed:])

    def read_frame(label, predicate, seconds=10, complete_frame=False):
        nonlocal live_seen
        deadline = time.monotonic() + seconds
        unchanged_since = time.monotonic()
        while time.monotonic() < deadline:
            if cache_store:
                for name in ("mod-view.json", "mod-status.json"):
                    path = cache_store / name
                    metadata = path.stat() if path.is_file() else None
                    state = (metadata.st_size, metadata.st_mtime_ns) if metadata else None
                    if name not in cache_states or cache_states[name] != state:
                        cache_states[name] = state
                        event = {"file": name, "elapsed_ms": round((time.monotonic() - started) * 1000),
                                 "bytes": metadata.st_size if metadata else None,
                                 "modified_after_launch": metadata.st_mtime_ns >= launched_wall_ns
                                     if metadata else False}
                        if metadata:
                            value = json.loads(path.read_text())
                            if name == "mod-view.json":
                                event.update(presentation=(value.get("input") or {}).get("presentation"),
                                    identity=(value.get("input") or {}).get("identity"),
                                    greeting=value.get("view", {}).get("greeting"),
                                    suffix=value.get("view", {}).get("session_title_suffix"))
                                if event["modified_after_launch"] and (event["presentation"] or {}).get("thread_id"):
                                    live_seen = True
                            else:
                                event.update(mods=[{key: item.get(key) for key in ("id", "error")}
                                                   for item in value.get("mods", [])],
                                             rejected=value.get("rejected"),
                                             reload_error=value.get("reload_error"))
                        cache_events.append(event)
            ready, _, _ = select.select([master], [], [], 0.05)
            if ready:
                try:
                    chunk = os.read(master, 65536)
                except OSError:
                    break
                before = tuple(screen.display)
                feed(chunk)
                if tuple(screen.display) != before:
                    unchanged_since = time.monotonic()
            settled = (completed_screen_digest == capture()["screen_sha256"] if complete_frame
                       else time.monotonic() - unchanged_since >= 0.3)
            if predicate() and settled:
                stages[label] = {**capture(), "elapsed_ms": round((time.monotonic() - started) * 1000)}
                return
        raise AssertionError(f"{label} current-screen assertion failed:\n" + "\n".join(screen.display))

    def send(data, label, predicate):
        os.write(master, data)
        read_frame(label, predicate)

    def resize(columns, label, predicate):
        screen.resize(columns=columns)
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 28, columns, 0, 0))
        os.kill(process.pid, signal.SIGWINCH)
        read_frame(label, predicate)

    try:
        read_frame("startup_fallback" if greeting is None else "startup",
                   startup_appearance, startup_seconds, complete_frame=check_first_paint)
        if check_first_paint and "first_paint" not in stages:
            raise AssertionError("no completed synchronized editable frame was observed")
        if exercise:
            send(b"draft-marker", "typing", lambda: appearance() and visible("draft-marker"))
            send(b"\x7fedit", "editing", lambda: appearance() and visible("draft-markeedit"))
            send(b"\x01\x0b", "clear", lambda: appearance() and not visible("draft-markeedit"))
            send(b"\x1b[200~paste-marker\x1b[201~", "paste",
                 lambda: appearance() and visible("paste-marker"))
            send(b"\x01\x0b", "paste_clear", lambda: appearance() and not visible("paste-marker"))
            resize(24, "narrow", mark_visible)
            resize(12, "tiny", mark_visible)
            resize(80, "resize_restored", appearance)
        if live_mods:
            def live_publication():
                views = [event for event in cache_events if event["file"] == "mod-view.json"]
                statuses = [event for event in cache_events if event["file"] == "mod-status.json"]
                if not views or not statuses:
                    return False
                view, published = views[-1], statuses[-1]
                identity = view.get("identity") or {}
                presentation = view.get("presentation") or {}
                mods = published.get("mods") or []
                return (identity.get("codex_version") == version
                        and identity.get("install_profile") == {"OMD Core": "platform_only", "OMD+": "full"}[profile]
                        and identity.get("mods", {}).get("active") == len(live_mods)
                        and view["modified_after_launch"] and published["modified_after_launch"]
                        and presentation.get("thread_id") and presentation.get("phase") == "fresh"
                        and sorted(item["id"] for item in mods) == sorted(live_mods)
                        and all(item["error"] is None for item in mods)
                        and not published.get("rejected") and published.get("reload_error") is None
                        and visible(f"{len(live_mods)} mod")
                        and not visible("mod status unavailable") and appearance())
            read_frame("live_publication", live_publication)
        if native_session:
            action, seed_id = native_session
            def selected_session():
                views = [event for event in cache_events if event["file"] == "mod-view.json"]
                if not views:
                    return False
                view = views[-1]
                presentation = view.get("presentation") or {}
                thread_id = presentation.get("thread_id")
                return (view["modified_after_launch"] and presentation.get("phase") == "resumed"
                        and thread_id and (thread_id == seed_id if action == "resume" else thread_id != seed_id)
                        and appearance())
            read_frame("native_session_selected", selected_session)
        if status:
            send(b"/status", "status_completion", lambda: visible("/status"))
            send(b"\r", "status", lambda: visible(f"Install profile: {status_selector}")
                 and visible(f"Effective mode: {status}"))
        recovery = live_recovery(send, read_frame, visible, mark_visible, capture, process,
                                 cache_events) if live_recovery else None
        return {"stages": stages, "cache_events": cache_events,
                "completed_frames": completed_frames, "prelive_frames": prelive_frames,
                "trace_sha256": hashlib.sha256(output).hexdigest(),
                "trace_path": str(trace_path) if trace_path else None,
                **({"live_recovery": recovery} if recovery is not None else {})}
    except Exception:
        logs = sorted(Path(env["CODEX_HOME"]).rglob("*.log"))[:3]
        print(json.dumps({"terminal_exit_code": process.poll(),
                          "cache_events": cache_events, "stages": stages,
                          "prelive_frames": prelive_frames,
                          "trace_path": str(trace_path) if trace_path else None,
                          "native_logs": {str(path): path.read_text(errors="replace")[-6000:]
                                          for path in logs}}), flush=True)
        raise
    finally:
        if trace_path:
            trace_path.parent.mkdir(parents=True, exist_ok=True)
            trace_path.write_bytes(output)
        os.close(master)
        if process.poll() is None:
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                if process.poll() is None:
                    process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    if process.poll() is None:
                        process.kill()
                    process.wait(timeout=10)


def run(artifact_dir, upstream, output, greeting_source, profiles=("platform", "full"),
        diagnostic_only=False):
    import pyte

    if output.exists():
        raise ValueError("evidence output already exists")
    node = Path(subprocess.check_output(["mise", "which", "node"], cwd=ROOT, text=True).strip()).resolve()
    version = json.loads((ROOT / "upstream.lock.json").read_text())["tag"].removeprefix("rust-v")
    greetings = [json.loads(line.strip().removesuffix(","))
                 for line in greeting_source.read_text().splitlines()
                 if re.match(r'^    ".*",$', line)]
    if len(greetings) < 50:
        raise ValueError("reviewed native greeting source did not contain the expected phrase list")
    with tempfile.TemporaryDirectory(prefix="omd-terminal-acceptance-", dir="/private/tmp") as temporary:
        base = Path(temporary)
        home = base / "codex-home"
        home.mkdir()
        shutil.copy2(ROOT / "benchmarks/fixtures/controlled-models.json", home / "models.json")
        repo = base / "repo"
        repo.mkdir()
        (home / "config.toml").write_text(
            'model = "gpt-5.6-sol"\nmodel_provider = "omd_local_probe"\n'
            f'model_catalog_json = {json.dumps(str(home / "models.json"))}\n'
            'check_for_update_on_startup = false\n'
            '[features]\ndaemon_auto_start = false\n'
            '[model_providers.omd_local_probe]\nname = "Local inactive probe"\n'
            'base_url = "http://127.0.0.1:9/v1"\nwire_api = "responses"\n'
            'requires_openai_auth = false\n'
            f'[projects.{json.dumps(str(repo))}]\ntrust_level = "trusted"\n'
        )
        env = isolated_environment(base, home, upstream)
        env.update(TERM="xterm-256color")
        for name in ("FORCE_COLOR", "COLORTERM", "NO_COLOR", "TMUX", "TMUX_PANE",
                     "SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY", "TERM_PROGRAM"):
            env.pop(name, None)
        observations = {}
        synthetic_sessions = []
        for profile in profiles:
            expected = {"platform": "OMD Core", "full": "OMD+"}[profile]
            prefix = base / f"{profile}-prefix"
            bin_dir = base / f"{profile}-bin"
            store = base / f"{profile}-store"
            command = ["python3", "-m", "scripts.lean_profiles", "--prefix", prefix,
                       "--bin-dir", bin_dir]
            install = ["install", "--profile", profile, "--binary", artifact_dir / "codex",
                       "--manager", artifact_dir / "omd-mod", "--omd", artifact_dir / "omd", "--omd-contract", artifact_dir / "omd-contract", "--author-archive", artifact_dir / "mod-api.tgz",
                       "--node", node, "--store", store]
            call(command + install, env)
            def save_progress(status, **extra):
                output.parent.mkdir(parents=True, exist_ok=True)
                output.write_text(json.dumps({"status": status, "checks": observations,
                    "artifact_sha256": support.digest(artifact_dir / "codex"),
                    "synthetic_sessions": synthetic_sessions, **extra},
                    indent=2, sort_keys=True) + "\n")

            def launch(label, environment=None, **options):
                try:
                    observations[label] = terminal(bin_dir / "codex", repo, environment or env,
                                                   80, version, greetings, cache_store=store,
                                                   trace_path=output.with_name(f"{output.stem}-{label}.trace"),
                                                   check_first_paint=not diagnostic_only, **options)
                except Exception as error:
                    caches = {}
                    for name in ("mod-status.json", "mod-view.json"):
                        path = store / name
                        caches[name] = {"exists": path.is_file()}
                        if path.is_file():
                            caches[name].update(bytes=path.stat().st_size,
                                                sha256=support.digest(path))
                            try:
                                value = json.loads(path.read_text())
                                if name == "mod-view.json":
                                    caches[name]["view"] = value.get("view")
                                    caches[name]["input"] = value.get("input")
                                caches[name]["diagnostics"] = value.get("diagnostics")
                                caches[name]["mods"] = [{key: item.get(key) for key in ("id", "error")}
                                                        for item in value.get("mods", [])]
                            except ValueError:
                                caches[name]["parse_error"] = True
                    diagnostic = {"caches": caches,
                                  "host_status": call([prefix / "artifacts/omd-mod", "status", store], env)}
                    save_progress("fail", failed_check=label, error=str(error), diagnostics=diagnostic)
                    print(json.dumps(diagnostic), flush=True)
                    raise
                save_progress("partial")
                print(json.dumps({"check": label, "status": "pass"}), flush=True)

            launch(profile, profile=expected, exercise=not diagnostic_only,
                   status=None if diagnostic_only else "Oh My Diff",
                   status_selector="platform_only" if profile == "platform" else "full",
                   live_mods=() if diagnostic_only else (("omd_logo", "omd_mods", "omd_update") if profile == "platform" else
                       ("omd_inspector", "omd_logo", "omd_model_picker", "omd_mods", "omd_tool_lines", "omd_update", "omd_workspace")),
                   startup_seconds=30 if diagnostic_only else 10)
            if diagnostic_only:
                call(command + ["uninstall"], env)
                continue
            if profile == "platform":
                session_ids = [event["presentation"]["thread_id"]
                               for event in observations[profile]["cache_events"]
                               if (event.get("presentation") or {}).get("thread_id")]
                if not session_ids:
                    raise AssertionError("base launch never observed a real host thread")
                session_id = session_ids[-1]
                # An unused thread intentionally defers its rollout file. Seed only native-valid
                # SessionMeta, following tui/src/app/tests.rs's offline root-session fixture.
                if not list(home.rglob(f"*{session_id}*.jsonl")):
                    timestamp = "2026-09-29T12:00:00Z"
                    seeded = home / "sessions/2026/09/29" / f"rollout-2026-09-29T12-00-00-{session_id}.jsonl"
                    seeded.parent.mkdir(parents=True, exist_ok=True)
                    seeded.write_text(json.dumps({"timestamp": timestamp, "type": "session_meta", "payload": {
                        "id": session_id, "session_id": session_id, "timestamp": timestamp, "cwd": str(repo),
                        "originator": "omd-offline-appearance-fixture", "cli_version": version,
                        "source": "cli", "model_provider": "omd_local_probe",
                    }}) + "\n")
                    synthetic_sessions.append({"thread_id": session_id, "sha256": support.digest(seeded),
                        "provenance": "synthetic metadata-only rollout using a real host-generated UUIDv7; no user/model history",
                        "native_shape": "tui/src/app/tests.rs offline root SessionMeta fixture",
                        "validation": "actual CLI/native reader must publish resumed phase; fork must publish a distinct thread"})
                for action in ("resume", "fork"):
                    launch(f"{profile}_{action}_first_paint", profile=expected, logo=False,
                           arguments=(action, session_id), native_session=(action, session_id))
            manager = prefix / "artifacts/omd-mod"
            call(command + ["mod", "disable", "omd_logo"], env)
            launch(f"{profile}_logo_disabled", logo=False, greeting=None)
            call(command + ["mod", "enable", "omd_logo"], env)
            launch(f"{profile}_logo_reenabled", profile=expected)
            if profile == "platform":
                logo_source = store / "sources/omd_logo"
                call([manager, "settings", store, logo_source, '{"icons":"ascii"}'], env)
                launch("platform_logo_ascii", profile=expected, ascii_logo=True)
                call([manager, "settings", store, logo_source, '{"icons":"unicode"}'], env)

            def broken_package(identifier, launch_options, repaired_options=None):
                source = store / "sources" / identifier
                entry = source / "index.ts"
                original = entry.read_bytes()
                entry.write_text("throw new Error('intentional isolated appearance fixture');\n")
                declared = json.loads((source / "mod.json").read_text())
                def trust_current():
                    inspected = call([manager, "inspect", source], env)
                    call([manager, "trust", store, source, inspected["sha256"],
                          ",".join(declared["capabilities"])], env)
                    call([manager, "enable", store, source], env)
                    call([manager, "reload", store], env)
                try:
                    trust_current()
                    failed = next(item for item in call([manager, "status", store], env)["mods"]
                                  if item["id"] == identifier)
                    assert failed["error"], f"{identifier} fixture did not actually break"
                    launch(f"{profile}_{identifier}_broken", **launch_options)
                finally:
                    entry.write_bytes(original)
                    trust_current()
                launch(f"{profile}_{identifier}_repaired_reload_next_launch",
                       **(repaired_options or {"profile": expected}))

            broken_package("omd_logo", {"logo": False, "greeting": None})
            if profile == "full":
                call(command + ["mod", "disable", "omd_workspace"], env)
                theme_source = store / "sources/omd_theme"
                call([manager, "settings", store, theme_source, json.dumps({
                    "greeting_enabled": True, "greeting_text": "THEME GREETING PROBE",
                    "backdrop_mode": "ascii", "ascii_text": "THEMEPROBE", "position": "tile",
                    "composer_gloss": True, "backdrop_gloss": True,
                })], env)
                call(command + ["mod", "enable", "omd_theme"], env)
                launch("theme_composed", profile=expected, greeting="THEME GREETING PROBE",
                       backdrop="THEMEPROBE")
                for label, changes, arguments in (
                    ("no_color", {"NO_COLOR": "1"}, ()),
                    ("ssh_environment", {"SSH_CONNECTION": "127.0.0.1 1 127.0.0.1 2"}, ()),
                    ("tmux_environment", {"TMUX": str(base / "unconnected-tmux")}, ()),
                    ("reduced_motion", {}, ("-c", "tui.animations=false")),
                ):
                    launch(f"theme_{label}", environment={**env, **changes}, profile=expected,
                        greeting="THEME GREETING PROBE", arguments=arguments,
                        backdrop=None if label == "no_color" else "THEMEPROBE",
                        absent=("THEMEPROBE",) if label == "no_color" else ())
                for label, arguments in (
                    ("inline", ("--no-alt-screen",)),
                    ("raw", ("-c", "tui.raw_output_mode=true")),
                ):
                    launch(f"theme_{label}", profile=expected, logo=False,
                        greeting="THEME GREETING PROBE", arguments=arguments)
                call(command + ["mod", "disable", "omd_theme"], env)
                launch("theme_disabled", profile=expected, absent=("THEMEPROBE",))
                call(command + ["mod", "enable", "omd_theme"], env)
                broken_package("omd_theme", {"profile": expected, "absent": ("THEMEPROBE",)}, {
                    "profile": expected, "greeting": "THEME GREETING PROBE", "backdrop": "THEMEPROBE",
                })
                call(command + ["mod", "disable", "omd_theme"], env)
                for identifier in ("omd_inspector", "omd_logo", "omd_model_picker", "omd_mods", "omd_tool_lines", "omd_update"):
                    call(command + ["mod", "disable", identifier], env)
                launch("full_zero_first_party", logo=False, greeting=None)
            call(command + ["activate", "direct"], env)
            launch(f"{profile}_direct", logo=False, greeting=None, status="upstream-style direct",
                   status_selector="platform_only" if profile == "platform" else "full")
            call(command + ["uninstall"], env)
    result = {"status": "diagnostic" if diagnostic_only else "pass", "candidate_lock_sha256": support.digest(ROOT / "runtime/lean-release.lock.json"),
              "artifact_sha256": support.digest(artifact_dir / "codex"),
              "checks": observations, "synthetic_sessions": synthetic_sessions,
              "screen_parser": {"package": "pyte", "version": importlib.metadata.version("pyte"),
                                "source_sha256": support.digest(Path(pyte.__file__)),
                                "screen_source_sha256": support.digest(Path(pyte.screens.__file__)),
                                "stream_source_sha256": support.digest(Path(pyte.streams.__file__))},
              "greeting_source_sha256": support.digest(greeting_source),
              "fixture_sha256": support.digest(Path(__file__)),
              "scope": "isolated current-screen PTY appearance with an inactive loopback provider; no model request",
              "limits": ["repaired reload is checked on the next launch, not a live accepted-turn boundary",
                         "SSH/tmux flags are synthetic; physical graphics, real remote/multiplexer painting are untested",
                         "resume/fork PTY uses synthetic metadata-only local history; no prior provider session or model-history replay claim",
                         "accepted/rejected lifecycle is covered by targeted native tests"]}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    print(json.dumps({"status": result["status"], "checks": list(observations)}))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifact-dir", type=Path, required=True)
    parser.add_argument("--upstream", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--greeting-source", type=Path, required=True)
    parser.add_argument("--profiles", choices=("platform", "full"), nargs="+", default=("platform", "full"))
    parser.add_argument("--diagnostic-only", action="store_true")
    args = parser.parse_args()
    run(args.artifact_dir.resolve(), args.upstream.resolve(), args.output.resolve(),
        args.greeting_source.resolve(), args.profiles, args.diagnostic_only)


if __name__ == "__main__":
    main()
