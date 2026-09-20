import fcntl
import hashlib
import json
import os
from pathlib import Path
import pty
import select
import signal
import struct
import subprocess
import tempfile
import termios
import time


BINARY = None
NODE = None
MODELS = Path(__file__).parent / "fixtures/controlled-models.json"


def fixture(label):
    root = Path(tempfile.mkdtemp(prefix=f"omd-pty-{label}-", dir="/private/tmp"))
    repo = root / "repo"
    home = root / "home"
    evidence = root / "evidence"
    repo.mkdir()
    home.mkdir()
    (repo / "sample.txt").write_text("fixture\n")
    git_env = {
        "PATH": "/usr/bin:/bin",
        "HOME": str(home),
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": "/dev/null",
    }
    for args in (
        ["init", "-q"],
        ["add", "."],
        [
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@localhost",
            "commit",
            "-qm",
            "Synthetic source",
        ],
    ):
        subprocess.run(["/usr/bin/git", *args], cwd=repo, env=git_env, check=True)
    grant = root / "grant.json"
    grant_bytes = json.dumps(
        {
            "schema": 1,
            "data_authorized": True,
            "revocable": True,
            "split": "development",
            "repositories": ["pty-fixture"],
        }
    ).encode()
    grant.write_bytes(grant_bytes)
    rates = {
        "input_microusd_per_million": 100000,
        "cached_microusd_per_million": 2000,
        "output_microusd_per_million": 200000,
        "reservation_microusd": 100000,
        "max_output_tokens": 128,
        "input_token_ceiling": 200000,
        "included_subscription": False,
    }
    route = lambda model, effort: {
        "model": model,
        "provider": "fixture",
        "reasoning_effort": effort,
        "responses_url": "http://127.0.0.1:9/v1/responses",
        "rates": rates,
    }
    manifest = {
        "repository": str(repo.resolve()),
        "evidence": str(evidence),
        "scratch": str(repo / ".omd"),
        "authorization": str(grant.resolve()),
        "authorization_sha256": hashlib.sha256(grant_bytes).hexdigest(),
        "repository_identity": "pty-fixture",
        "approved_untracked": [],
        "limits": {
            "requests": 12,
            "exposure_microusd": 1000000,
            "seconds": 120,
            "concurrent_workers": 2,
            "max_depth": 2,
            "max_reassessments": 1,
        },
        "worker_limits": {"requests": 4, "exposure_microusd": 400000, "seconds": 40},
        "checkpoint": {
            "objective": "PTY terminal validation",
            "acceptance_criteria": ["terminal restores"],
            "max_no_progress_calls": 2,
        },
        "legitimate_wait_tools": ["wait_agent", "write_stdin", "wait"],
        "lifecycle": {"explicit_resume": None},
        "recovery": {
            "contributor_attempts": 2,
            "equivalent_failure_threshold": 2,
            "fallback_to_opposite_lead": True,
        },
        "lead_policy": {"mode": "fixed", "lead": "sol"},
        "leads": {
            "sol": route("gpt-5.6-sol", "high"),
            "astra": route("gpt-6-astra", "xhigh"),
        },
        "context_policy": {"mode": "focused_brief", "max_bytes": 2000000},
        "escalation": {
            "allowed_failure_classes": ["environment", "edit", "diagnosis", "model"],
            "max_attempts": 1,
            "evidence_bytes": 100000,
        },
        "worker": route("muse-spark-1.3-contributor", "low"),
        "check_command": ["/usr/bin/true"],
        "toolchain_reads": [],
        "snapshot_bytes": 1000000,
        "max_request_bytes": 2000000,
    }
    manifest_path = root / "manifest.json"
    manifest_path.write_text(json.dumps(manifest))
    models = json.loads(MODELS.read_text())
    for model in models["models"]:
        model["tool_mode"] = "direct"
        model["prefer_websockets"] = False
    models_path = home / "models.json"
    models_path.write_text(json.dumps(models))
    config = f"""model = "gpt-5.6-sol"
model_provider = "fixture"
model_catalog_json = {json.dumps(str(models_path))}
model_reasoning_effort = "high"
web_search = "disabled"
approval_policy = "never"
check_for_update_on_startup = false
suppress_unstable_features_warning = true

[projects.{json.dumps(str(repo.resolve()))}]
trust_level = "trusted"

[features]
shell_snapshot = false
code_mode = false

[analytics]
enabled = false

[feedback]
enabled = false

[model_providers.fixture]
name = "PTY fixture"
base_url = "http://127.0.0.1:9/v1"
wire_api = "responses"
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
"""
    (home / "config.toml").write_text(config)
    (home / "auth.json").write_text(
        '{"OPENAI_API_KEY":"pty-fixture","tokens":null,"last_refresh":null}'
    )
    return root, repo, home, manifest_path


def set_size(fd, columns, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))


def drain(fd, output, duration):
    deadline = time.monotonic() + duration
    while time.monotonic() < deadline:
        ready, _, _ = select.select([fd], [], [], 0.05)
        if not ready:
            continue
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        output.extend(chunk)


def drain_until(fd, output, needle, timeout):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        drain(fd, output, 0.2)
        if needle in output:
            return True
    return False


def run_mod():
    root, repo, home, manifest_path = fixture("mods")
    manifest = json.loads(manifest_path.read_text())
    from benchmarks.mod_fixture import install

    install(root, manifest, NODE, "full")
    manifest_path.write_text(json.dumps(manifest))
    master, slave = pty.openpty()
    set_size(slave, 100, 30)
    env = {
        "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
        "HOME": str(home),
        "CODEX_HOME": str(home),
        "CODEX_SQLITE_HOME": str(home),
        "OMD_CONTROLLED_MANIFEST": str(manifest_path),
        "OPENAI_API_KEY": "pty-fixture",
        "TERM": "xterm-256color",
        "LANG": "en_CA.UTF-8",
        "LC_ALL": "en_CA.UTF-8",
        "NO_PROXY": "127.0.0.1,localhost",
    }
    child = subprocess.Popen(
        [str(BINARY), "-C", str(repo)],
        stdin=slave,
        stdout=slave,
        stderr=slave,
        env=env,
        start_new_session=True,
    )
    os.close(slave)
    output = bytearray()
    ready = drain_until(master, output, b"Fixture workspace", 15)
    os.write(master, b"\x1b[17~")
    key = drain_until(master, output, b"Review current work", 5)
    set_size(master, 62, 20)
    os.killpg(child.pid, signal.SIGWINCH)
    drain(master, output, 1)
    os.write(master, b"\x15/omd")
    drain_until(master, output, b"/omd", 3)
    drain(master, output, 0.5)
    os.write(master, b"\r")
    inspector = drain_until(master, output, b"Close inspector", 5)
    os.write(master, b"\x1b")
    drain(master, output, 0.5)
    os.write(master, b"\x03\x03")
    drain(master, output, 2)
    if child.poll() is None:
        os.killpg(child.pid, signal.SIGTERM)
    status = child.wait(timeout=5)
    raw = bytes(output)
    (root / "terminal.raw").write_bytes(raw)
    result = {
        "root": str(root),
        "exit_code": status,
        "panel": ready,
        "function_key_draft": key,
        "native_inspector_after_resize": inspector,
        "terminal_restored": b"\x1b[?1049l" in raw and b"\x1b[?25h" in raw,
    }
    print(json.dumps(result, indent=2))
    assert status == 0 and all(
        result[k]
        for k in (
            "panel",
            "function_key_draft",
            "native_inspector_after_resize",
            "terminal_restored",
        )
    )


def provider():
    import http.server
    import threading

    requests = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests.append(body)
            inputs = body.get("input", [])
            users = [i for i in inputs if i.get("type") == "message" and i.get("role") == "user"]
            asking = bool(users) and "PTY_ASK" in json.dumps(users[-1])
            searched = any(i.get("type") == "tool_search_output" for i in inputs)
            called = any(
                i.get("type") == "function_call_output" and i.get("call_id") == "pty-count"
                for i in inputs
            )
            if not asking:
                item = {"type": "message", "id": "pty-reply", "role": "assistant", "content": [{"type": "output_text", "text": "PTY_DONE"}]}
            elif not searched:
                item = {"type": "tool_search_call", "id": "pty-search", "call_id": "pty-search", "status": "completed", "execution": "client", "arguments": {"query": "mod_fixture_count persistent mod counter"}}
            elif not called:
                item = {"type": "function_call", "id": "pty-count", "call_id": "pty-count", "name": "mod_fixture_count", "arguments": "{}"}
            else:
                item = {"type": "message", "id": "pty-done", "role": "assistant", "content": [{"type": "output_text", "text": "PTY_DONE"}]}
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            usage = {"input_tokens": 100, "input_tokens_details": {"cached_tokens": 0}, "output_tokens": 10, "output_tokens_details": {"reasoning_tokens": 0}, "total_tokens": 110}
            for event in (
                {"type": "response.created", "response": {"id": str(len(requests))}},
                {"type": "response.output_item.done", "item": item},
                {"type": "response.completed", "response": {"id": str(len(requests)), "model": body["model"], "usage": usage}},
            ):
                self.wfile.write(("data: " + json.dumps(event) + "\n\n").encode())
                self.wfile.flush()

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{server.server_port}/v1", requests


def run_extensions(inline=False):
    root, repo, home, manifest_path = fixture("inline" if inline else "extensions")
    url, requests = provider()
    manifest = json.loads(manifest_path.read_text())
    for route in (manifest["leads"]["sol"], manifest["leads"]["astra"], manifest["worker"]):
        route["responses_url"] = url + "/responses"
    manifest["limits"]["requests"] = 40
    manifest["checkpoint"]["max_no_progress_calls"] = 16
    pi_user = root / "pi-user"
    (pi_user / "prompts").mkdir(parents=True)
    (pi_user / "prompts/review.md").write_text(
        "---\ndescription: Review a file\nargument-hint: <path>\n---\nPTY_PI_REVIEW $1 carefully\n"
    )
    manifest["mod_pi_user"] = str(pi_user)
    from benchmarks.mod_fixture import install

    install(root, manifest, NODE, "terminal")
    manifest_path.write_text(json.dumps(manifest))
    config = home / "config.toml"
    config.write_text(config.read_text().replace("http://127.0.0.1:9/v1", url))
    master, slave = pty.openpty()
    set_size(slave, 110, 34)
    env = {
        "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
        "HOME": str(home),
        "CODEX_HOME": str(home),
        "CODEX_SQLITE_HOME": str(home),
        "OMD_CONTROLLED_MANIFEST": str(manifest_path),
        "OPENAI_API_KEY": "pty-fixture",
        "TERM": "xterm-256color",
        "COLORTERM": "truecolor",
        "LANG": "en_CA.UTF-8",
        "LC_ALL": "en_CA.UTF-8",
        "NO_PROXY": "127.0.0.1,localhost",
    }
    child = subprocess.Popen(
        [str(BINARY), *(["--no-alt-screen"] if inline else []), "-C", str(repo)],
        stdin=slave,
        stdout=slave,
        stderr=slave,
        env=env,
        start_new_session=True,
    )
    os.close(slave)
    output = bytearray()
    checks = {}
    checks["status_segment"] = drain_until(master, output, b"PTY_STATUS", 20)
    if not inline:
        checks["layout"] = drain_until(master, output, b"PTY_HEADER", 5) and drain_until(
            master, output, b"PTY left", 5
        )
        checks["footer"] = drain_until(master, output, b"PTY_FOOTER", 5)

    def command(text, needle, timeout=15):
        os.write(master, b"\x15" + text.encode())
        drain(master, output, 0.6)
        os.write(master, b"\r")
        return drain_until(master, output, needle, timeout)

    checks["namespaced_command"] = command("/fixture:hello world", b"PTY_HELLO world")
    checks["bare_alias"] = command("/hello again", b"PTY_HELLO again")
    os.write(master, b"\x15/pi:rev")
    checks["pi_alias_conflict_visible"] = drain_until(master, output, b"bare /review unavailable", 5)
    os.write(master, b"\x15")
    drain(master, output, 0.3)
    checks["command_submit"] = command("/fixture:ask counting", b"PTY_DONE", 30)
    checks["activity_line"] = drain_until(master, output, b"Ran Fixture counter", 10)
    os.write(master, b"\x1bx")
    checks["key_command"] = drain_until(master, output, b"PTY_HELLO from-key", 15)
    before = len(requests)
    os.write(master, b"\x1b[18~")
    drain_until(master, output, b"PTY_KEY_SUBMIT", 10)
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline and not any("PTY_KEY_SUBMIT" in json.dumps(r) for r in requests[before:]):
        drain(master, output, 0.3)
    checks["key_submit"] = any("PTY_KEY_SUBMIT" in json.dumps(r) for r in requests[before:])
    before = len(requests)
    command("/pi:review src/main.rs", b"PTY_PI_REVIEW", 15)
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline and not any("PTY_PI_REVIEW src/main.rs carefully" in json.dumps(r) for r in requests[before:]):
        drain(master, output, 0.3)
    checks["pi_prompt_expanded"] = any(
        "PTY_PI_REVIEW src/main.rs carefully" in json.dumps(r) for r in requests[before:]
    )
    os.write(master, b"\x14")
    checks["key_conflict_visible"] = drain_until(master, output, b"Mod keybinding Ctrl+t ignored", 10)
    drain(master, output, 0.5)
    os.write(master, b"q")
    drain(master, output, 0.5)
    raw = bytes(output)
    checks["ask_reached_model"] = any("PTY_ASK counting" in json.dumps(r) for r in requests)
    checks["accent_color"] = b"38;5;201" in raw
    checks["user_message_background"] = b"48;2;18;52;86" in raw
    os.write(master, b"\x03\x03")
    drain(master, output, 2)
    if child.poll() is None:
        try:
            os.killpg(child.pid, signal.SIGTERM)
        except (PermissionError, ProcessLookupError):
            child.terminate()
    status = child.wait(timeout=5)
    raw = bytes(output)
    (root / "terminal.raw").write_bytes(raw)
    (root / "requests.json").write_text(json.dumps(requests, indent=2))
    if inline:
        checks["fullscreen_panels_hidden"] = b"PTY_HEADER" not in raw and b"PTY_FOOTER" not in raw
        checks["terminal_restored"] = b"\x1b[?25h" in raw
    else:
        checks["terminal_restored"] = b"\x1b[?1049l" in raw and b"\x1b[?25h" in raw
    result = {"root": str(root), "inline": inline, "exit_code": status, **checks}
    print(json.dumps(result, indent=2))
    assert status == 0 and all(checks.values()), result


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("binary", type=Path)
    parser.add_argument("node", type=Path)
    arguments = parser.parse_args()
    BINARY = arguments.binary.resolve()
    NODE = arguments.node.resolve()
    run_mod()
    run_extensions()
    run_extensions(inline=True)
