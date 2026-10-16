#!/usr/bin/env python3
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys
import time

from scripts.pty_session import ROOT, Session, call, environment, fresh, git, provider

BROKEN_MANIFEST = {"schema": 1, "id": "broken_fixture", "version": "1.0.0", "api": "0.2.0-experimental.5", "state_version": 1,
                   "license": "Apache-2.0", "description": "Throws on every render.", "capabilities": ["terminal"],
                   "compatibility": {"required_features": ["terminal_surface_v1"]}}
BROKEN_SOURCE = "export default function activate(api) {\n  api.on('terminal', () => { throw new Error('broken on purpose'); });\n}\n"


def text_of(item):
    return " ".join(part.get("text", "") for part in item.get("content", []) if isinstance(part, dict))


def reply(body, count):
    items = body.get("input", [])
    last_user = max((index for index, item in enumerate(items) if item.get("role") == "user"), default=-1)
    prompt = text_of(items[last_user]) if last_user >= 0 else ""
    answered = any(item.get("type") == "function_call_output" for item in items[last_user + 1:])
    if "STALL_TURN" in prompt and not answered:
        time.sleep(12)
    if "APPROVE_ME" in prompt and not answered:
        arguments = {"cmd": "printf desk >> approved.txt && echo APPROVED_OUTPUT", "yield_time_ms": 500, "sandbox_permissions": "require_escalated",
                     "justification": "Write the approval fixture."}
        return [{"type": "function_call", "id": f"fc{count}", "call_id": f"call{count}", "name": "exec_command", "arguments": json.dumps(arguments)}]
    return [{"type": "message", "id": f"m{count}", "role": "assistant", "content": [{"type": "output_text", "text": "FIXTURE_DONE"}]}]


def store_with(manager, store, mods, init=True):
    if init:
        call([manager, "init", store, call(["mise", "which", "node"], ROOT).stdout.strip()], ROOT)
    for directory in mods:
        inspected = json.loads(call([manager, "inspect", directory], ROOT).stdout)
        call([manager, "trust", store, directory, inspected["sha256"], ",".join(inspected["manifest"]["capabilities"])], ROOT)
        call([manager, "enable", store, directory], ROOT)


class Host:
    def __init__(self, codex, repo, env, socket, log):
        self.argv = [str(codex), "app-server", "--listen", f"unix://{socket}"]
        self.repo, self.env, self.socket, self.log = repo, env, socket, log
        self.start()

    def start(self):
        self.socket.unlink(missing_ok=True)
        self.process = subprocess.Popen(self.argv, cwd=self.repo, env=self.env, stdin=subprocess.DEVNULL,
                                        stdout=subprocess.DEVNULL, stderr=self.log.open("ab"))
        deadline = time.monotonic() + 60
        while not self.socket.exists():
            if self.process.poll() is not None or time.monotonic() > deadline:
                raise RuntimeError(f"app-server did not listen; see {self.log}")
            time.sleep(0.1)

    def stop(self):
        self.process.terminate()
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()


def driver(mode, url, repo, env, answer):
    process = subprocess.Popen(["node", str(ROOT / "scripts/client_acceptance.mjs"), mode, url, str(repo)], cwd=ROOT, env=env,
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=sys.stderr, text=True, bufsize=1)
    result = None
    for line in process.stdout:
        message = json.loads(line)
        print(f"  {mode}: {line.strip()[:4000]}", flush=True)
        if "need" in message:
            process.stdin.write(json.dumps(answer(message["need"]) or {}) + "\n")
            process.stdin.flush()
        elif "done" in message or "failed" in message:
            result = message
    process.wait()
    if not result or "failed" in result:
        raise SystemExit(f"{mode} failed")
    return result["timings"]


def launch_client(tui, store):
    launched = store / "state-external_client.json"
    before = json.loads(launched.read_text())["value"].get("picked")
    assert tui.command("/external_client:launch", "Launching the text client"), "launch command"
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline and json.loads(launched.read_text())["value"].get("picked") == before:
        tui.pump(0.05)
    value = json.loads(launched.read_text())["value"]
    assert value["ui"] == "running" and value["picked"] != before, f"mod-launched client attached and acted: {value}"
    return value["picked"]


def main():
    parser = argparse.ArgumentParser(description="External-client acceptance: two author examples drive patched codex hosts "
                                                 "over omd-client/1 with a scripted provider (local, no paid calls).")
    parser.add_argument("--binaries", type=Path, required=True, help="directory with the patched codex and omd-mod")
    parser.add_argument("--hop-only", action="store_true", help="check the command-to-channel hop before the first provider turn")
    args = parser.parse_args()
    codex, manager = (args.binaries / name for name in ["codex", "omd-mod"])
    base = fresh("client")
    repo = base / "repo"
    repo.mkdir()
    git(repo, "init", "-q")
    (repo / "README.md").write_text("client acceptance\n")
    git(repo, "add", ".")
    git(repo, "commit", "-qm", "fixture")
    server, url = provider(reply)
    mods = base / "mods"
    for name in ["external_client", "approval_desk", "client_tag"]:
        shutil.copytree(ROOT / "mods/examples" / name, mods / name)
    (mods / "broken_fixture").mkdir()
    (mods / "broken_fixture/mod.json").write_text(json.dumps(BROKEN_MANIFEST))
    (mods / "broken_fixture/index.ts").write_text(BROKEN_SOURCE)
    results = {"run": str(base)}

    store = base / "store"
    store_with(manager, store, [mods / "external_client", mods / "approval_desk", mods / "client_tag", mods / "broken_fixture"])
    call([manager, "settings", store, mods / "external_client", json.dumps({
        "listen_url": f"unix://{base / 'tui.sock'}", "token_file": "", "client_path": str(ROOT / "mods/examples/external_client/client.mjs")})], ROOT)
    env = environment(base, args.binaries, repo, store, url)
    if args.hop_only:
        started = time.monotonic()
        tui = Session(codex, repo, env, args=("--listen", f"unix://{base / 'tui.sock'}"))
        try:
            assert tui.ready(), "TUI did not start"
            results["tui_ready_s"] = round(time.monotonic() - started, 2)
            mark = len(tui.raw)
            typed = time.monotonic()
            tui.keys(b"draft-marker", settle=0)
            while time.monotonic() - typed < 3 and "draft-marker" not in tui.text(mark):
                tui.pump(0.005)
            assert "draft-marker" in tui.text(mark), "release TUI did not render typed input"
            results["typeable_input_ms"] = round((time.monotonic() - typed) * 1000)
            tui.keys(b"\x15")
            results["mod_launched_client"] = launch_client(tui, store)
            assert not server.RequestHandlerClass.requests, "hop check must precede every provider turn"
            results["provider_requests"] = 0
        finally:
            tui.close(base / "tui.trace")
            server.shutdown()
        (base / "results.json").write_text(json.dumps(results, indent=2))
        print(json.dumps(results, indent=2))
        return

    empty = base / "store-empty"
    store_with(manager, empty, [])
    bare_env = environment(base, args.binaries, repo, empty, url, name="bare")
    host = Host(codex, repo, bare_env, base / "bare.sock", base / "bare.log")
    try:
        results["bare"] = driver("bare", f"unix://{base / 'bare.sock'}", repo, bare_env, lambda need: None)
    finally:
        host.stop()

    host = Host(codex, repo, env, base / "omd.sock", base / "headless.log")
    desk_source = (mods / "approval_desk/index.ts").read_text()

    def headless(need):
        if need == "change_source":
            (mods / "approval_desk/index.ts").write_text(desk_source.replace("label: 'Approvals'", "label: 'Approvals v2'"))
        elif need in ("disable_desk", "enable_desk"):
            call([manager, need.removesuffix("_desk"), store, mods / "approval_desk"], ROOT)
        elif need == "trust_source":
            store_with(manager, store, [mods / "approval_desk"], init=False)
        elif need == "restart_host":
            host.stop()
            host.start()

    try:
        results["headless"] = driver("headless", f"unix://{base / 'omd.sock'}", repo, env, headless)
    finally:
        host.stop()

    started = time.monotonic()
    tui = Session(codex, repo, env, args=("--listen", f"unix://{base / 'tui.sock'}"))
    try:
        assert tui.ready(), "TUI did not start"
        results["tui_ready_s"] = round(time.monotonic() - started, 2)

        def coattach(need):
            if need in ("tui_prompt_client_answers", "tui_prompt_terminal_answers"):
                mark = len(tui.raw)
                tui.type(f"APPROVE_ME {need}")
                tui.pump(0.5)
                tui.keys(b"\r")
                if need == "tui_prompt_terminal_answers":
                    assert tui.wait("Would you like to run", 60, mark), "TUI approval prompt"
                    tui.keys(b"y", 2)
                assert tui.wait("FIXTURE_DONE", 60, mark), "turn finished in the TUI"
            elif need == "client_visible":
                assert tui.wait("approval desk gui", 20), "TUI lists the attached client"
                mark = len(tui.raw)
                tui.pump(5)
                results["tui_idle_bytes_5s_attached"] = len(tui.raw) - mark
            elif need == "client_gone":
                mark = len(tui.raw)
                tui.type("hello after the client left")
                tui.keys(b"\r")
                assert tui.wait("FIXTURE_DONE", 60, mark), "TUI keeps working after the client vanished"

        results["coattach"] = driver("coattach", f"unix://{base / 'tui.sock'}", repo, env, coattach)
        results["mod_launched_client"] = launch_client(tui, store)
        mark = len(tui.raw)
        tui.pump(5)
        results["tui_idle_bytes_5s_mods"] = len(tui.raw) - mark
    finally:
        tui.close(base / "tui.trace")

    started = time.monotonic()
    plain = Session(codex, repo, environment(base, args.binaries, repo, empty, url, name="plain"))
    try:
        assert plain.ready(), "TUI without mods did not start"
        results["tui_ready_s_no_mods"] = round(time.monotonic() - started, 2)
        mark = len(plain.raw)
        plain.pump(5)
        results["tui_idle_bytes_5s_no_mods"] = len(plain.raw) - mark
    finally:
        plain.close(base / "plain.trace")
    server.shutdown()
    (base / "results.json").write_text(json.dumps(results, indent=2))
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
