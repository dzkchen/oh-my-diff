#!/usr/bin/env python3
import argparse
import base64
import json
import os
from pathlib import Path
import shlex
import shutil
import struct
import subprocess
import time
import zlib

from client_acceptance import reply, store_with
from pty_session import ROOT, Session, call, environment, fresh, git, provider

KITTY = Path("/Applications/kitty.app/Contents/MacOS")
WEZTERM = Path("/Applications/WezTerm.app/Contents/MacOS/wezterm")
COLUMNS, ROWS = 150, 46
PROBE_MANIFEST = {"schema": 1, "id": "terminal_probe", "version": "1.0.0", "api": "0.2.0-experimental.5", "state_version": 1,
                  "license": "Apache-2.0", "description": "Records terminal client facts and pointer reports over an image.",
                  "capabilities": ["terminal", "commands", "lifecycle", "store"],
                  "compatibility": {"required_features": ["terminal_surface_v1", "terminal_media_v1", "binary_evidence_v1", "ui_controls_v1"]}}
PROBE_SOURCE = """export default function activate(api) {
  const read = () => ({ image: null, client: null, pointer: [], ...(api.state.get() ?? {}) });
  const write = patch => api.state.set({ ...read(), ...patch });
  api.on('start', () => {
    if (!read().image) write({ image: api.host.call('evidence.write', { media_type: 'image/png', base64: '%s', label: 'probe' }) });
  });
  api.on('terminal', input => {
    const s = read();
    if (JSON.stringify(input.client) !== JSON.stringify(s.client)) write({ client: input.client });
    if (s.note_at_ms && s.rendered_note !== s.note) write({ rendered_note: s.note, component_to_view_ms: Date.now() - s.note_at_ms });
    const last = s.pointer.at(-1);
    const facts = `probe ${input.client?.graphics} ${input.client?.pointer} last ${last ? `${last.action} ${last.column},${last.row} half ${last.half}` : 'none'}`;
    return { sites: { header: { components: [
      ...(s.image ? [{ type: 'image', id: 'probe_image', label: 'Probe', image: s.image, alt: 'probe image', height: 1, pointer: true }] : []),
      { type: 'text', id: 'probe_facts', label: 'Probe facts', text: facts },
      { type: 'pane', id: 'probe_pane', label: 'Probe pane', title: 'Probe pane', children: [
        { type: 'input', id: 'probe_note', label: 'Probe note', value: s.note ?? '', autofocus: true, action: { command: 'terminal_probe:note' } },
      ] },
    ] } } };
  });
  api.command('note', value => {
    write({ note: String(value ?? '') });
    return { display: 'noted' };
  });
  api.intercept('component_change', (e, next) => (e.kind === 'focus' && e.from === 'probe_note' && e.to !== null ? { deny: 'probe keeps focus' } : next(e)));
  api.on('component_event', ({ component, kind, pointer, value, origin }) => {
    if (component === 'probe_image' && kind === 'pointer') write({ pointer: [...read().pointer, pointer].slice(-60) });
    if (component === 'probe_note' && kind === 'change') write({ note: value, note_at_ms: Date.now() });
    if (component === 'probe_note' && kind === 'focus') write({ focused_by: origin });
  });
}
"""

CONTROL_SOURCE = """export default function activate(api) {
  const read = () => api.state.get() ?? {};
  const write = patch => api.state.set({ ...read(), ...patch });
  api.on('terminal', input => {
    if (JSON.stringify(read().client) !== JSON.stringify(input.client)) write({ client: input.client });
    return { sites: { header: { components: [
      { type: 'button', id: 'read_selection', label: 'Read selection', text: 'READ SELECTION', action: { command: 'terminal_probe:selection' } },
      { type: 'button', id: 'copy_control', label: 'Copy control', text: 'COPY CONTROL', action: { command: 'terminal_probe:copy' } },
    ] } } };
  });
  api.command('selection', () => {
    write({ selection: api.host.call('terminal.selection', {}) });
    return { display: 'SELECTION_RECORDED' };
  }, { immediate: true });
  api.command('copy', () => {
    write({ copy: api.host.call('terminal.copy', { text: 'OMD_CONTROL_COPY' }) });
    return { display: 'COPY_SUBMITTED' };
  }, { immediate: true });
  api.command('watch', () => { write({ watch: true }); return { display: 'WATCH_ARMED' }; });
  api.on('turn_start', ({ turn_id }) => {
    write({ turn_id });
    if (read().watch) api.host.call('events.schedule', { key: 'abort', delay_ms: 100 });
  });
  api.on('timer', ({ key }) => {
    if (key !== 'abort') return;
    const turn_id = read().turn_id;
    write({ abort: api.host.call('turns.abort', { turn_id }), aborted_turn: turn_id, watch: false });
  });
  api.on('turn_end', end => write({ ends: [...(read().ends ?? []), end] }));
}
"""


class PseudoTerminal:
    drives_keys = True

    def __init__(self, binary, repo, env, base):
        self.session = Session(binary, repo, env)
        self.base = base

    def send(self, text):
        self.session.type(text)

    def key(self, name):
        self.session.keys({"enter": b"\r", "esc": b"\x1b"}[name])

    def screen(self):
        self.session.pump()
        return self.session.text()

    def close(self):
        self.session.close(self.base / "trace.ansi")


def control_check(terminal, store, results):
    def observed(predicate):
        terminal.screen()
        return predicate(state(store, "terminal_probe"))

    def command(name, predicate):
        terminal.send(f"/terminal_probe:{name}")
        time.sleep(0.5)
        started = time.monotonic()
        terminal.key("enter")
        value = wait(name, lambda: observed(predicate))
        results.setdefault("command_ms", {})[name] = round((time.monotonic() - started) * 1000)
        return value

    command("selection", lambda s: "selection" in s)
    assert state(store, "terminal_probe")["selection"] == {"text": None, "truncated": False}
    command("copy", lambda s: s.get("copy"))
    command("watch", lambda s: s.get("watch"))
    terminal.send("SLOW_TURN controlled cancellation")
    time.sleep(0.5)
    terminal.key("enter")
    wait("running turn aborted", lambda: observed(lambda s: s.get("abort", {}).get("accepted")
         and any(e["turn_id"] == s["aborted_turn"] and e["outcome"] == "aborted" for e in s.get("ends", []))))
    terminal.send("continue after cancellation")
    time.sleep(0.5)
    terminal.key("enter")
    wait("subsequent turn completed", lambda: observed(lambda s: any(e["outcome"] == "completed" for e in s.get("ends", []))), 45)
    if isinstance(terminal, PseudoTerminal):
        import pyte
        terminal.session.pump(0.5)
        screen = pyte.Screen(COLUMNS, ROWS)
        pyte.Stream(screen).feed(terminal.session.raw.decode(errors="replace"))
        def position(text):
            for row, line in enumerate(screen.display):
                if text in line:
                    return line.index(text) + 1, row + 1
            raise AssertionError(f"missing {text}: {screen.display}")
        column, row = position("FIXTURE_DONE")
        mouse = lambda button, x, y, suffix: f"\x1b[<{button};{x};{y}{suffix}".encode()
        terminal.session.keys(mouse(0, column, row, "M") + mouse(32, column + 12, row, "M") + mouse(0, column + 12, row, "m"))
        column, row = position("READ SELECTION")
        terminal.session.keys(mouse(0, column, row, "M") + mouse(0, column, row, "m"))
        wait("selected transcript returned", lambda: observed(lambda s: "FIXTURE_DONE" in (s.get("selection", {}).get("text") or "")))
    results["controls"] = state(store, "terminal_probe")
    results["zero_first_party"] = True


def png(width=48, height=16):
    rows = b"".join(b"\x00" + b"".join(struct.pack("BBBB", 40 + x * 4, 80 + y * 10, 200, 255) for x in range(width)) for y in range(height))
    chunk = lambda kind, data: struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")


class Terminal:
    drives_keys = True

    def __init__(self, base, script):
        self.base, self.script = base, script

    def screen(self):
        return ""

    def bounds(self):
        return json.loads(call([self.base / "macos_window", self.pid()], ROOT).stdout.strip())

    def wait_for_exit(self):
        pid = int((self.base / "codex.pid").read_text())
        while True:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return
            time.sleep(0.25)


class Kitty(Terminal):

    def start(self, env):
        self.socket = self.base / "kitty.sock"
        self.process = subprocess.Popen([KITTY / "kitty", "--single-instance=no", "-o", "allow_remote_control=socket-only", "--listen-on",
                                         f"unix:{self.socket}", "-o", f"initial_window_width={COLUMNS}c", "-o", f"initial_window_height={ROWS}c",
                                         "-o", "remember_window_size=no", "-o", "window_padding_width=0", "-o", "confirm_os_window_close=0",
                                         "sh", self.script], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def pid(self):
        return self.process.pid

    def remote(self, *argv):
        return call([KITTY / "kitten", "@", "--to", f"unix:{self.socket}", *argv], ROOT, check=False).stdout

    def send(self, text):
        self.remote("send-text", "--", text)

    def key(self, name):
        self.remote("send-key", {"esc": "escape"}.get(name, name))

    def screen(self):
        return self.remote("get-text", "--extent", "screen")

    def resize(self, columns, rows):
        self.remote("resize-os-window", "--unit", "cells", "--width", str(columns), "--height", str(rows))

    def close(self):
        self.process.terminate()


class WezTerm(Terminal):

    def start(self, env):
        self.process = subprocess.Popen([WEZTERM, "--config", f"initial_cols={COLUMNS}", "--config", f"initial_rows={ROWS}",
                                         "--config", "window_padding={left=0,right=0,top=0,bottom=0}", "--config", "enable_tab_bar=false",
                                         "start", "--always-new-process", "--cwd", str(self.base), "--", "sh", self.script],
                                        env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def pid(self):
        return int(wait("wezterm-gui", lambda: call(["pgrep", "-n", "-f", f"wezterm-gui.*{self.script}"], ROOT, check=False).stdout.split())[0])

    def cli(self, *argv):
        socket = Path(os.environ["HOME"]) / f".local/share/wezterm/gui-sock-{self.pid()}"
        return call([WEZTERM, "cli", *argv], ROOT, env={**os.environ, "WEZTERM_UNIX_SOCKET": str(socket)}, check=False).stdout

    def send(self, text):
        self.cli("send-text", "--pane-id", "0", "--no-paste", text)

    def key(self, name):
        self.send({"enter": "\r", "esc": "\x1b", "space": " ", "down": "\x1b[B", "alt+k": "\x1bk", "tab": "\t"}[name])

    def screen(self):
        return self.cli("get-text", "--pane-id", "0")

    def close(self):
        call(["kill", self.pid()], ROOT, check=False)


class Ghostty(Terminal):
    drives_keys = False

    def start(self, env):
        self.process = subprocess.Popen(["open", "-n", "-W", "/Applications/Ghostty.app", "--args", f"--window-width={COLUMNS}",
                                         f"--window-height={ROWS}", "--confirm-close-surface=false", "-e", "sh", str(self.script)],
                                        env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def pid(self):
        return int(wait("ghostty instance", lambda: call(["pgrep", "-n", "-f", f"ghostty.*{self.script}"], ROOT, check=False).stdout.split())[0])

    def close(self):
        call(["kill", self.pid()], ROOT, check=False)


class Orca(Terminal):
    drives_keys = False

    def start(self, env):
        print(f"Run in an Orca terminal: sh {shlex.quote(str(self.script))}", flush=True)
        wait("Orca terminal launch", lambda: (self.base / "codex.pid").exists(), 600)

    def pid(self):
        return int((self.base / "codex.pid").read_text().strip())

    def close(self):
        if (self.base / "codex.pid").is_file():
            call(["kill", self.pid()], ROOT, check=False)


def state(store, mod):
    path = store / f"state-{mod}.json"
    return json.loads(path.read_text())["value"] if path.exists() else {}


def wait(label, check, seconds=30):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        value = check()
        if value:
            return value
        time.sleep(0.25)
    raise AssertionError(f"timed out: {label}")


def main():
    parser = argparse.ArgumentParser(description="Real-terminal check: runs patched codex with example mods and a scripted local provider; "
                                                 "Orca is launched and inspected through computer use.")
    parser.add_argument("--binaries", type=Path, required=True)
    parser.add_argument("--terminal", choices=["kitty", "ghostty", "wezterm", "orca", "pty"], required=True)
    parser.add_argument("--controls", action="store_true", help="check cancellation and clipboard with only the independent probe mod")
    parser.add_argument("--reduced-motion", action="store_true")
    parser.add_argument("--keep-open", action="store_true", help="leave the terminal running for pointer checks driven by hand or computer use")
    args = parser.parse_args()
    if args.terminal == "pty" and not args.controls:
        parser.error("--terminal pty requires --controls")
    base = fresh(f"terminal-{args.terminal}")
    call(["swiftc", "-O", "-o", base / "macos_window", ROOT / "scripts/macos_window.swift"], ROOT)
    repo = base / "repo"
    repo.mkdir()
    git(repo, "init", "-q")
    (repo / "README.md").write_text("terminal check\n")
    git(repo, "add", ".")
    git(repo, "commit", "-qm", "fixture")
    probe = base / "mods/terminal_probe"
    probe.mkdir(parents=True)
    manifest = {**PROBE_MANIFEST, "capabilities": [*PROBE_MANIFEST["capabilities"], "threads", "events"]} if args.controls else PROBE_MANIFEST
    (probe / "mod.json").write_text(json.dumps(manifest))
    (probe / "index.ts").write_text(CONTROL_SOURCE if args.controls else PROBE_SOURCE % base64.b64encode(png()).decode())
    store = base / "store"
    store_with(args.binaries / "omd-mod", store, [probe] if args.controls else [ROOT / "mods/examples/raster_canvas", ROOT / "mods/examples/approval_desk", probe])
    if args.controls:
        status = json.loads(call([args.binaries / "omd-mod", "status", store], ROOT).stdout)
        assert status["order"] == ["terminal_probe"], status
        (base / "mod-status.json").write_text(json.dumps(status, indent=2))
    server, url = provider(reply)
    terminal = None
    try:
        env = environment(base, args.binaries, repo, store, url)
        if args.terminal != "pty":
            env.pop("TERM")
        env.pop("NO_COLOR", None)
        env.pop("FORCE_COLOR", None)
        if args.terminal == "pty":
            terminal = PseudoTerminal(args.binaries / "codex", repo, env, base)
            wait("probe saw the PTY", lambda: state(store, "terminal_probe").get("client") if terminal.screen() else None, 90)
            results = {"terminal": "pty", "run": str(base)}
            control_check(terminal, store, results)
            finish(results, base)
            return
        script = base / "run.sh"
        overrides = ["-c", "tui.animations=false"] if args.reduced_motion else []
        script.write_text("#!/bin/sh\nunset NO_COLOR FORCE_COLOR\n" + "".join(f"export {key}={shlex.quote(value)}\n" for key, value in env.items())
                          + f"cd {shlex.quote(str(repo))}\nprintf '%s\\n' \"$$\" > {shlex.quote(str(base / 'codex.pid'))}\n"
                          + f"exec {shlex.quote(str(args.binaries / 'codex'))} {' '.join(overrides)} -C {shlex.quote(str(repo))}\n")
        terminal = {"kitty": Kitty, "ghostty": Ghostty, "wezterm": WezTerm, "orca": Orca}[args.terminal](base, script)
        results = {"terminal": args.terminal, "run": str(base)}
        terminal.start({key: value for key, value in os.environ.items()
                        if not key.startswith(("TERM_PROGRAM", "LC_TERMINAL", "COLORTERM", "TMUX", "KITTY_", "WEZTERM_", "GHOSTTY_", "NO_COLOR", "FORCE_COLOR"))})
        client = wait("probe saw the terminal", lambda: state(store, "terminal_probe").get("client"), 90)
        if args.controls:
            results["client"] = client
            if terminal.drives_keys:
                control_check(terminal, store, results)
            finish(results, base)
            if args.keep_open:
                terminal.wait_for_exit()
            return
        image = wait("probe image written", lambda: state(store, "terminal_probe").get("image"))
        results["client"] = client
        results["pid"] = terminal.pid()
        shot = lambda name: None if isinstance(terminal, Orca) else call(
            ["screencapture", "-x", "-o", "-l", str(terminal.bounds()["id"]), base / f"{name}.png"], ROOT, check=False)
        time.sleep(3)
        shot("start")
        lines = terminal.screen().splitlines()
        results["screen_start"] = "\n".join(lines)[-4000:]
        results["raster_client"] = state(store, "raster_canvas").get("client")
        if terminal.drives_keys:
            typed = time.monotonic()
            terminal.send("probe")
            wait("probe accepts typing", lambda: state(store, "terminal_probe").get("note") == "probe")
            results["typeable_input_ms"] = round((time.monotonic() - typed) * 1000)
            terminal.send("\t")
            time.sleep(0.4)
            terminal.send("!")
            time.sleep(0.8)
            probe = state(store, "terminal_probe")
            results["autofocus"] = probe.get("focused_by")
            results["probe_note"] = probe.get("note")
            terminal.send("\x1b")
            time.sleep(0.4)
            terminal.key("alt+k")
            time.sleep(0.4)
            terminal.key("down")
            terminal.key("space")
            terminal.key("enter")
            time.sleep(1)
            results["desk_kinds"] = state(store, "approval_desk").get("kinds")
            terminal.key("esc")
            time.sleep(0.3)
            terminal.send("APPROVE_ME from a real terminal")
            time.sleep(0.5)
            terminal.key("enter")
            time.sleep(4)
            shot("approval")
            terminal.send("y")
            wait("approval decided", lambda: any(entry.get("decision") for entry in state(store, "approval_desk").get("entries", [])), 60)
            time.sleep(1)
            results["desk_entries"] = state(store, "approval_desk").get("entries")
            results["screen_after_approval"] = terminal.screen()[-3000:]
            shot("notice")
            if isinstance(terminal, Kitty):
                terminal.resize(100, 30)
                time.sleep(2)
                resized = terminal.screen().splitlines()
                results["resized_grid"] = [max(map(len, resized), default=0), len(resized)]
                results["screen_resized"] = "\n".join(resized)
                shot("resized")
        finish(results, base)
        if args.keep_open:
            terminal.wait_for_exit()
    finally:
        try:
            if terminal is not None and not args.keep_open:
                terminal.close()
        finally:
            server.shutdown()


def finish(results, base):
    (base / "results.json").write_text(json.dumps(results, indent=2))
    print(json.dumps({key: value for key, value in results.items() if not key.startswith("screen")}, indent=2), flush=True)
    print(f"screenshots and results in {base}", flush=True)


if __name__ == "__main__":
    main()
