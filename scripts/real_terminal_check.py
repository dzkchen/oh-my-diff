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
from pty_session import ROOT, call, environment, fresh, git, provider

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
    const last = s.pointer.at(-1);
    const facts = `probe ${input.client?.graphics} ${input.client?.pointer} last ${last ? `${last.action} ${last.column},${last.row} half ${last.half}` : 'none'}`;
    return { sites: { header: { components: [
      ...(s.image ? [{ type: 'image', id: 'probe_image', label: 'Probe', image: s.image, alt: 'probe image', height: 4, pointer: true }] : []),
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
    if (component === 'probe_note' && kind === 'change') write({ note: value });
    if (component === 'probe_note' && kind === 'focus') write({ focused_by: origin });
  });
}
"""


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
    parser = argparse.ArgumentParser(description="Real-terminal check: drives Kitty, Ghostty or WezTerm running the patched codex "
                                                 "with example mods and a scripted local provider; moves the mouse and types.")
    parser.add_argument("--binaries", type=Path, required=True)
    parser.add_argument("--terminal", choices=["kitty", "ghostty", "wezterm"], required=True)
    parser.add_argument("--reduced-motion", action="store_true")
    parser.add_argument("--keep-open", action="store_true", help="leave the terminal running for pointer checks driven by hand or computer use")
    args = parser.parse_args()
    base = fresh(f"terminal-{args.terminal}")
    call(["swiftc", "-O", "-o", base / "macos_window", ROOT / "scripts/macos_window.swift"], ROOT)
    repo = base / "repo"
    repo.mkdir()
    git(repo, "init", "-q")
    (repo / "README.md").write_text("terminal check\n")
    git(repo, "add", ".")
    git(repo, "commit", "-qm", "fixture")
    server, url = provider(reply)
    probe = base / "mods/terminal_probe"
    probe.mkdir(parents=True)
    (probe / "mod.json").write_text(json.dumps(PROBE_MANIFEST))
    (probe / "index.ts").write_text(PROBE_SOURCE % base64.b64encode(png()).decode())
    store = base / "store"
    store_with(args.binaries / "omd-mod", store, [ROOT / "mods/examples/raster_canvas", ROOT / "mods/examples/approval_desk", probe])
    env = environment(base, args.binaries, repo, store, url)
    env.pop("TERM")
    script = base / "run.sh"
    overrides = ["-c", "tui.animations=false"] if args.reduced_motion else []
    script.write_text("#!/bin/sh\n" + "".join(f"export {key}={shlex.quote(value)}\n" for key, value in env.items())
                      + f"cd {shlex.quote(str(repo))}\nexec {shlex.quote(str(args.binaries / 'codex'))} {' '.join(overrides)} -C {shlex.quote(str(repo))}\n")
    terminal = {"kitty": Kitty, "ghostty": Ghostty, "wezterm": WezTerm}[args.terminal](base, script)
    results = {"terminal": args.terminal, "run": str(base)}
    terminal.start({key: value for key, value in os.environ.items()
                    if not key.startswith(("TERM_PROGRAM", "LC_TERMINAL", "COLORTERM", "TMUX", "KITTY_", "WEZTERM_", "GHOSTTY_"))})
    try:
        client = wait("probe saw the terminal", lambda: state(store, "terminal_probe").get("client"), 90)
        image = wait("probe image written", lambda: state(store, "terminal_probe").get("image"))
        results["client"] = client
        results["pid"] = terminal.pid()
        shot = lambda name: call(["screencapture", "-x", "-o", "-l", str(terminal.bounds()["id"]), base / f"{name}.png"], ROOT, check=False)
        time.sleep(3)
        shot("start")
        lines = terminal.screen().splitlines()
        results["screen_start"] = "\n".join(lines)[-4000:]
        results["raster_client"] = state(store, "raster_canvas").get("client")
        if terminal.drives_keys:
            terminal.send("probe")
            time.sleep(0.4)
            terminal.send("\t")
            time.sleep(0.4)
            terminal.send("!")
            time.sleep(0.8)
            probe = state(store, "terminal_probe")
            results["autofocus"] = probe.get("focused_by")
            results["probe_note"] = probe.get("note")
            terminal.send("\x1b")
            time.sleep(0.4)
        if not terminal.drives_keys:
            return finish(results, base)
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
    finally:
        if not args.keep_open:
            terminal.close()
        server.shutdown()
    finish(results, base)


def finish(results, base):
    (base / "results.json").write_text(json.dumps(results, indent=2))
    print(json.dumps({key: value for key, value in results.items() if not key.startswith("screen")}, indent=2))
    print(f"screenshots and results in {base}")


if __name__ == "__main__":
    main()
