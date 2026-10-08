#!/usr/bin/env python3
import fcntl
import http.server
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
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
CSI = re.compile(rb"\x1b\[[0-?]*[ -/]*[@-~]")
OSC = re.compile(rb"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)")


def call(argv, cwd, env=None, check=True):
    result = subprocess.run([str(value) for value in argv], cwd=cwd, env=env, capture_output=True, text=True,
                            timeout=120, stdin=subprocess.DEVNULL)
    if check and result.returncode:
        raise RuntimeError(f"{argv[0]} {argv[1] if len(argv) > 1 else ''}: {(result.stderr or result.stdout)[-1200:]}")
    return result


def git(repo, *argv):
    return call(["git", "-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", *argv], repo).stdout


class Provider(http.server.BaseHTTPRequestHandler):
    requests = []
    reply = None
    headers_for = None

    def log_message(self, *_):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        type(self).requests.append(body)
        if "SLOW_TURN" in json.dumps(body.get("input", [])):
            time.sleep(12)
        count = len(type(self).requests)
        items = type(self).reply(body, count) if type(self).reply else [
            {"type": "message", "id": "m1", "role": "assistant", "content": [{"type": "output_text", "text": "FIXTURE_DONE"}]}]
        usage = {"input_tokens": 10, "input_tokens_details": {"cached_tokens": 0}, "output_tokens": 5,
                 "output_tokens_details": {"reasoning_tokens": 0}, "total_tokens": 15}
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            for name, value in (type(self).headers_for(count) if type(self).headers_for else {}).items():
                self.send_header(name, str(value))
            self.end_headers()
            for event in ({"type": "response.created", "response": {"id": f"r{count}"}},
                          *({"type": "response.output_item.done", "item": item} for item in items),
                          {"type": "response.completed", "response": {"id": f"r{count}", "model": body["model"], "usage": usage}}):
                self.wfile.write(("data: " + json.dumps(event) + "\n\n").encode())
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass


def provider(reply=None, headers=None):
    handler = type("ScriptedProvider", (Provider,), {"requests": [], "reply": staticmethod(reply) if reply else None,
                                                     "headers_for": staticmethod(headers) if headers else None})
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_port}/v1"


def fresh(name):
    root = Path("/private/tmp/omd-pty")
    root.mkdir(exist_ok=True)
    return Path(tempfile.mkdtemp(prefix=f"{name}-", dir=root)).resolve()


def environment(base, binaries, repo, store, url, name="main", profile="full"):
    home = base / f"codex-home-{name}"
    home.mkdir()
    (base / f"sqlite-{name}").mkdir()
    (base / f"home-{name}").mkdir()
    shutil.copy2(ROOT / "tests/fixtures/controlled-models.json", home / "models.json")
    (home / "config.toml").write_text("\n".join([
        'model = "gpt-5.6-sol"', 'model_provider = "omd_local_fixture"', 'model_reasoning_effort = "low"',
        f'model_catalog_json = {json.dumps(str(home / "models.json"))}', "check_for_update_on_startup = false",
        'approval_policy = "on-request"', 'sandbox_mode = "workspace-write"',
        "[features]", "daemon_auto_start = false", "code_mode = false", "plugins = false", "[tui]", "show_tooltips = false",
        "[notice.model_migrations]", '"gpt-5.5" = "gpt-6.1-sol"',
        "[model_providers.omd_local_fixture]", 'name = "Local fixture"', f"base_url = {json.dumps(url)}",
        'wire_api = "responses"', "requires_openai_auth = false", "request_max_retries = 0", "stream_max_retries = 0",
        f"[projects.{json.dumps(str(repo))}]", 'trust_level = "trusted"']) + "\n")
    node = Path(call(["mise", "which", "node"], ROOT).stdout.strip())
    env = {key: value for key, value in os.environ.items()
           if not key.startswith(("OMD_", "CODEX_", "TERM_PROGRAM", "TMUX", "COLORTERM"))}
    env.update(HOME=str(base / f"home-{name}"), CODEX_HOME=str(home), CODEX_SQLITE_HOME=str(base / f"sqlite-{name}"),
               OMD_MODE="omd", OMD_INSTALL_PROFILE=profile, OMD_MOD_STORE=str(store), TERM="xterm-256color",
               LANG="en_CA.UTF-8", PATH=f"{binaries}:{node.parent}:/usr/bin:/bin:/usr/sbin:/sbin")
    return env


class Session:
    def __init__(self, binary, repo, env, columns=150, rows=46, cwd=None, args=()):
        self.master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
        self.process = subprocess.Popen([str(binary), *map(str, args), "-C", str(repo)], cwd=cwd or repo, env=env, stdin=slave,
                                        stdout=slave, stderr=slave, start_new_session=True)
        os.close(slave)
        self.raw = bytearray()

    def pump(self, seconds=0.2):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            ready, _, _ = select.select([self.master], [], [], 0.05)
            if ready:
                try:
                    chunk = os.read(self.master, 65_536)
                except OSError:
                    return
                if not chunk:
                    return
                self.raw.extend(chunk)

    def text(self, offset=0):
        return " ".join(CSI.sub(b"", OSC.sub(b"", bytes(self.raw[offset:]))).decode(errors="replace").split())

    def wait(self, phrase, seconds=20, offset=0):
        deadline = time.monotonic() + seconds
        expected = "".join(phrase.split())
        while time.monotonic() < deadline:
            self.pump()
            if expected in "".join(self.text(offset).split()):
                return True
            if self.process.poll() is not None:
                return False
        return False

    def ready(self, seconds=90):
        return self.wait("mods on", seconds)

    def type(self, text, delay=0.03):
        for char in text:
            os.write(self.master, char.encode())
            self.pump(delay)

    def keys(self, data, settle=0.6):
        mark = len(self.raw)
        os.write(self.master, data)
        self.pump(settle)
        return mark

    def command(self, value, expected, seconds=30):
        mark = len(self.raw)
        os.write(self.master, b"\x15")
        self.type(value)
        self.pump(1.0)
        os.write(self.master, b"\r")
        return self.wait(expected, seconds, mark)

    def resize(self, columns, rows):
        fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
        os.killpg(self.process.pid, signal.SIGWINCH)
        self.pump(1.0)

    def close(self, trace):
        for _ in range(4):
            if self.process.poll() is not None:
                break
            try:
                os.write(self.master, b"\x1b")
                self.pump(0.3)
                os.write(self.master, b"\x15/exit")
                self.pump(0.8)
                os.write(self.master, b"\r")
            except OSError:
                break
            deadline = time.monotonic() + 5
            while self.process.poll() is None and time.monotonic() < deadline:
                self.pump(0.2)
        if self.process.poll() is None:
            os.killpg(self.process.pid, signal.SIGTERM)
            try:
                self.process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                os.killpg(self.process.pid, signal.SIGKILL)
        self.process.wait(timeout=5)
        os.close(self.master)
        trace.write_bytes(self.raw)
        return self.process.returncode
