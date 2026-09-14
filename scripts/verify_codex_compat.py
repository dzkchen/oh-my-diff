#!/usr/bin/env python3
import argparse
import base64
import hashlib
import http.server
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading


def main():
    if not __debug__:
        raise RuntimeError("Run without Python -O: compatibility assertions must remain enabled")
    parser = argparse.ArgumentParser(description='Exercise two Codex binaries against synthetic shared state and a local mock.\n\nNo real credentials or provider inference are used. This checks persistence and\nrequest construction, not provider acceptance or model behavior.\n')
    parser.add_argument("upstream", type=Path)
    parser.add_argument("candidate", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--keyring", action="store_true",
                        help="also create and remove one synthetic credential in the OS keyring")
    args = parser.parse_args()
    binaries = [args.upstream.resolve(), args.candidate.resolve()]
    requests = []
    held_request = threading.Event()
    release_request = threading.Event()

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            self.send_error(404)

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            if not self.path.endswith("/responses"):
                self.send_error(404)
                return
            requests.append((body, self.headers.get("Authorization")))
            number = len(requests)
            if "AUDIT_HOLD_WRITER" in json.dumps(body):
                held_request.set()
                if not release_request.wait(120):
                    self.send_error(504)
                    return
            events = [
                {"type": "response.created", "response": {"id": f"resp-{number}"}},
                {"type": "response.output_item.done", "item": {
                    "type": "message", "role": "assistant", "id": f"msg-{number}",
                    "content": [{"type": "output_text", "text": f"AUDIT_REPLY_{number}"}]}},
                {"type": "response.completed", "response": {
                    "id": f"resp-{number}", "usage": {
                        "input_tokens": 1, "output_tokens": 1, "total_tokens": 2}}},
            ]
            payload = "".join(f"data: {json.dumps(event)}\n\n" for event in events).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    results = {"scope": "synthetic local Responses fixture; no provider acceptance claim",
               "binaries": [], "checks": []}
    try:
        with tempfile.TemporaryDirectory(prefix="omd-compat-") as temporary:
            root = Path(temporary)
            state, repo = root / "state", root / "repo"
            state.mkdir()
            repo.mkdir()
            (repo / ".git").mkdir()
            (state / "AGENTS.md").write_text("Global fixture: AUDIT_GLOBAL_INSTRUCTION\n")
            (repo / "AGENTS.md").write_text("Project fixture: AUDIT_PROJECT_INSTRUCTION\n")
            config = f'''model = "gpt-5.6-sol"
model_provider = "audit"
cli_auth_credentials_store = "file"
check_for_update_on_startup = false
web_search = "disabled"
approval_policy = "never"
sandbox_mode = "read-only"
[features]
shell_snapshot = false
[analytics]
enabled = false
[feedback]
enabled = false
[model_providers.audit]
name = "Local compatibility fixture"
base_url = "http://127.0.0.1:{server.server_port}/v1"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = false
[projects.{json.dumps(str(repo))}]
trust_level = "trusted"
'''
            (state / "config.toml").write_text(config)
            env = {key: os.environ[key] for key in ("PATH", "HOME", "TMPDIR", "TERM")
                   if key in os.environ}
            env.update(CODEX_HOME=str(state), CODEX_SQLITE_HOME=str(state),
                       NO_PROXY="127.0.0.1,localhost")

            def run(binary, arguments, input_text=None):
                result = subprocess.run([str(binary), *arguments], cwd=repo, env=env,
                                        input=input_text, text=True, capture_output=True, timeout=120)
                if result.returncode:
                    raise RuntimeError(f"{arguments}: exit {result.returncode}\n{result.stderr[-5000:]}")
                return result

            for binary in binaries:
                results["binaries"].append({"path": str(binary),
                    "version": run(binary, ["--version"]).stdout.strip(),
                    "sha256": hashlib.sha256(binary.read_bytes()).hexdigest()})
            run(binaries[0], ["login", "--with-api-key"], "sk-omd-synthetic-fixture-only\n")
            auth_before = (state / "auth.json").read_bytes()
            for binary in binaries:
                status = run(binary, ["login", "status"])
                assert "API key" in status.stdout + status.stderr
            results["checks"].append("both binaries read the same synthetic file credential")
            thread_id = None
            for index, binary in enumerate([binaries[0], binaries[1], binaries[0]]):
                prompt = f"AUDIT_USER_TURN_{index + 1}"
                arguments = ["exec", "--json", "--skip-git-repo-check"]
                arguments += [prompt] if thread_id is None else ["resume", thread_id, prompt]
                result = run(binary, arguments)
                events = [json.loads(line) for line in result.stdout.splitlines() if line.startswith("{")]
                ids = [event["thread_id"] for event in events if event.get("type") == "thread.started"]
                assert ids, result.stdout
                if thread_id is None:
                    thread_id = ids[0]
                assert ids[0] == thread_id
                assert any(event.get("type") == "turn.completed" for event in events), result.stdout
                body, auth = requests[-1]
                assert body["model"] == "gpt-5.6-sol"
                assert auth == "Bearer sk-omd-synthetic-fixture-only"
                rendered = json.dumps(body)
                for marker in ("AUDIT_GLOBAL_INSTRUCTION", "AUDIT_PROJECT_INSTRUCTION", prompt):
                    assert marker in rendered, marker
                for previous in range(1, index + 1):
                    assert f"AUDIT_USER_TURN_{previous}" in rendered
                    assert f"AUDIT_REPLY_{previous}" in rendered
                results["checks"].append(f"turn {index + 1}: same session, config, credentials, instructions and prior history")
            assert (state / "auth.json").read_bytes() == auth_before
            assert (state / "config.toml").read_text() == config
            results["checks"].append("configuration and credential file unchanged after upstream/candidate/upstream")

            with tempfile.TemporaryFile(mode="w+") as held_out, tempfile.TemporaryFile(mode="w+") as held_err:
                writer = subprocess.Popen([str(binaries[0]), "exec", "--json", "--skip-git-repo-check",
                                           "resume", thread_id, "AUDIT_HOLD_WRITER"],
                                          cwd=repo, env=env, stdout=held_out, stderr=held_err)
                try:
                    assert held_request.wait(60), "first writer did not reach mock server"
                    competing = subprocess.run([str(binaries[1]), "exec", "--json", "--skip-git-repo-check",
                                               "resume", thread_id, "AUDIT_COMPETING_WRITER"],
                                              cwd=repo, env=env, capture_output=True, text=True, timeout=30)
                    assert competing.returncode != 0, "competing session writer was accepted"
                    assert "active writer" in competing.stdout + competing.stderr, competing.stderr
                    assert "AUDIT_COMPETING_WRITER" not in json.dumps(requests)
                    other = run(binaries[1], ["exec", "--json", "--skip-git-repo-check", "AUDIT_INDEPENDENT_THREAD"])
                    assert '"type":"turn.completed"' in other.stdout
                    results["checks"].append("concurrent same-session writer rejected; independent session completed")
                finally:
                    release_request.set()
                    try:
                        writer.wait(timeout=30)
                    except subprocess.TimeoutExpired:
                        writer.kill()
                        writer.wait()
                        raise
                assert writer.returncode == 0

            def encode(value):
                return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")

            jwt = ".".join([encode({"alg": "none", "typ": "JWT"}), encode({
                "email": "fixture@example.invalid",
                "https://api.openai.com/auth": {"chatgpt_account_id": "fixture-account"}}), "c2ln"])
            (state / "auth.json").write_text(json.dumps({
                "auth_mode": "chatgpt", "OPENAI_API_KEY": None,
                "tokens": {"id_token": jwt, "access_token": "fixture-access", "refresh_token": "fixture-refresh",
                           "account_id": "fixture-account"}}))
            oauth_before = (state / "auth.json").read_bytes()
            for binary in binaries:
                status = run(binary, ["login", "status"])
                assert "ChatGPT" in status.stdout + status.stderr
            assert (state / "auth.json").read_bytes() == oauth_before
            results["checks"].append("both binaries parse the same synthetic OAuth file; no refresh or acceptance tested")
            if args.keyring:
                keyring_state = root / "keyring-state"
                keyring_state.mkdir()
                (keyring_state / "config.toml").write_text(config.replace(
                    'cli_auth_credentials_store = "file"', 'cli_auth_credentials_store = "keyring"'))
                env.update(CODEX_HOME=str(keyring_state), CODEX_SQLITE_HOME=str(keyring_state))
                try:
                    run(binaries[0], ["login", "--with-api-key"], "sk-omd-synthetic-keyring-only\n")
                    for binary in binaries:
                        status = run(binary, ["login", "status"])
                        assert "API key" in status.stdout + status.stderr
                    assert not (keyring_state / "auth.json").exists()
                    results["checks"].append("both binaries read one synthetic OS-keyring credential in an isolated namespace")
                finally:
                    run(binaries[0], ["logout"])
                for binary in binaries:
                    status = subprocess.run([str(binary), "login", "status"], cwd=repo, env=env,
                                            capture_output=True, text=True, timeout=30)
                    assert status.returncode != 0 and "Not logged in" in status.stdout + status.stderr
                results["checks"].append("synthetic keyring logout visible to both binaries; test credential removed")
            results["response_requests"] = len(requests)
            results["passed"] = True
    finally:
        release_request.set()
        server.shutdown()
        server.server_close()
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(results, indent=2) + "\n")
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
