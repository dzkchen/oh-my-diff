#!/usr/bin/env python3
"""Exercise the pinned native runtime with synthetic local Responses streams only."""
import argparse
import base64
from datetime import datetime, timezone
import hashlib
import http.server
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import threading
import time


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    binary = args.binary.resolve()
    requests, checks = [], []
    holding, release = threading.Event(), threading.Event()
    usage = {"input_tokens": 100, "input_tokens_details": {
        "cached_tokens": 20, "cache_write_tokens": 10}, "output_tokens": 30,
        "output_tokens_details": {"reasoning_tokens": 7}, "total_tokens": 130}

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            self.send_error(404)

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests.append({"path": self.path, "body": body,
                             "bearer": self.headers.get("Authorization"),
                             "account": self.headers.get("ChatGPT-Account-Id")})
            if not self.path.endswith("/responses"):
                self.send_error(404)
                return
            number = len(requests)
            if "AUDIT_429" in json.dumps(body):
                payload = b'{"error":{"type":"rate_limit_error","message":"synthetic rate limit"}}'
                self.send_response(429)
                self.send_header("Retry-After", "1")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()

            def emit(event):
                self.wfile.write(("data: " + json.dumps(event) + "\n\n").encode())
                self.wfile.flush()

            try:
                emit({"type": "response.created", "response": {"id": f"resp-{number}"}})
                if "AUDIT_HOLD" in json.dumps(body):
                    holding.set()
                    release.wait(30)
                    return
                outputs = [item for item in body.get("input", [])
                           if item.get("type") == "function_call_output"]
                if not outputs:
                    item = {"type": "function_call", "id": f"fc-{number}",
                            "call_id": "audit-tool", "name": "update_plan", "namespace": "functions",
                            "arguments": json.dumps({"plan": [
                                {"step": "Synthetic transport check", "status": "completed"}]})}
                else:
                    item = {"type": "message", "role": "assistant", "id": f"msg-{number}",
                            "content": [{"type": "output_text", "text": "AUDIT_OK"}]}
                emit({"type": "response.output_item.done", "item": item})
                emit({"type": "response.completed", "response": {
                    "id": f"resp-{number}", "usage": usage}})
            except (BrokenPipeError, ConnectionResetError):
                pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    report = {"scope": "synthetic localhost only; no provider acceptance or billing claim",
              "binary": str(binary), "sha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
              "checks": checks, "raw_usage_per_response": usage}
    try:
        with tempfile.TemporaryDirectory(prefix="cai-provider-") as tmp:
            root = Path(tmp)
            repo, home = root / "repo", root / "state"
            repo.mkdir()
            (repo / ".git").mkdir()
            home.mkdir()
            env = {k: os.environ[k] for k in ("PATH", "HOME", "TMPDIR", "TERM") if k in os.environ}
            env.update(CODEX_HOME=str(home), CODEX_SQLITE_HOME=str(home),
                       NO_PROXY="localhost,127.0.0.1", CAI_FIXTURE_KEY="synthetic-provider-key")
            base = f'''model = "gpt-5.6-sol"
model_reasoning_effort = "high"
model_provider = "audit"
cli_auth_credentials_store = "file"
check_for_update_on_startup = false
web_search = "disabled"
approval_policy = "never"
sandbox_mode = "read-only"
[tools.update_plan]
enabled = true
[features]
shell_snapshot = false
[analytics]
enabled = false
[feedback]
enabled = false
[projects.{json.dumps(str(repo))}]
trust_level = "trusted"
[model_providers.audit]
name = "Synthetic audit"
base_url = "http://127.0.0.1:{server.server_port}/v1"
wire_api = "responses"
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
'''

            def config(extra):
                (home / "config.toml").write_text(base + extra)

            def run(prompt):
                return subprocess.run([str(binary), "exec", "--json", "--skip-git-repo-check", prompt],
                                      cwd=repo, env=env, text=True, capture_output=True, timeout=45)

            def encode(value):
                return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")

            jwt = encode({"alg": "none"}) + "." + encode({
                "email": "fixture@example.invalid", "https://api.openai.com/auth": {
                    "chatgpt_account_id": "fixture-account"}}) + ".c2ln"
            oauth = {"auth_mode": "chatgpt", "OPENAI_API_KEY": None, "tokens": {
                "id_token": jwt, "access_token": jwt, "refresh_token": "synthetic-refresh",
                "account_id": "fixture-account"}, "last_refresh": datetime.now(timezone.utc).isoformat()}
            for route in ("file_api", "oauth", "env_provider", "contributor_identifier"):
                auth = {"OPENAI_API_KEY": "synthetic-file-key"} if route == "file_api" else oauth
                (home / "auth.json").write_text(json.dumps(auth))
                config('requires_openai_auth = true\n' if route in ("file_api", "oauth") else
                       'requires_openai_auth = false\nenv_key = "CAI_FIXTURE_KEY"\n')
                model = "muse-spark-1.3-contributor" if route == "contributor_identifier" else "gpt-5.6-sol"
                if route == "contributor_identifier":
                    path = home / "config.toml"
                    path.write_text(path.read_text().replace('model = "gpt-5.6-sol"', f'model = "{model}"'))
                start = len(requests)
                result = run("AUDIT_TOOL_ROUNDTRIP")
                require(result.returncode == 0, result.stderr[-4000:] + result.stdout[-2000:])
                batch = requests[start:]
                require(len(batch) == 2, f"{route}: expected two requests, got {len(batch)}")
                expected = {"file_api": "synthetic-file-key", "oauth": jwt,
                            "env_provider": "synthetic-provider-key",
                            "contributor_identifier": "synthetic-provider-key"}[route]
                require(all(r["bearer"] == "Bearer " + expected for r in batch), "wrong credential")
                if route in ("env_provider", "contributor_identifier"):
                    require(all(r["account"] is None for r in batch), "OAuth account leaked")
                if route == "oauth":
                    require(all(r["account"] == "fixture-account" for r in batch), "OAuth account missing")
                require(batch[0]["body"]["reasoning"]["effort"] == "high", "effort missing")
                require(batch[0]["body"]["model"] == model, "model changed")
                tool_items = batch[0]["body"].get("tools", []) or [
                    i for i in batch[0]["body"]["input"] if i.get("type") == "additional_tools"]
                require('update_plan' in json.dumps(tool_items), "plan tool absent: " + json.dumps(tool_items)[-2500:])
                require(any(i.get("type") == "function_call_output" and i.get("call_id") == "audit-tool"
                            and "Plan updated" in str(i.get("output"))
                            for i in batch[1]["body"]["input"]), "tool result missing: " + json.dumps([
                                i for i in batch[1]["body"]["input"] if "output" in i.get("type", "")]))
                events = [json.loads(line) for line in result.stdout.splitlines() if line.startswith("{")]
                completed = [e for e in events if e.get("type") == "turn.completed"]
                require(len(completed) == 1, "turn completion missing")
                expected_usage = {"input_tokens": 200, "cached_input_tokens": 40,
                                  "cache_write_input_tokens": 20, "output_tokens": 60,
                                  "reasoning_output_tokens": 14}
                require(all(completed[0]["usage"].get(k) == v for k, v in expected_usage.items()),
                        f"usage mismatch: {completed}")
                checks.append({"route": route, "request_count": len(batch),
                               "requested_model": model,
                               "result": "credential, reasoning, tool roundtrip, detailed usage passed",
                               "usage": completed[0]["usage"],
                               "tool_encoding": "top-level" if batch[0]["body"].get("tools") else "additional_tools"})
            start = len(requests)
            path = home / "config.toml"
            good_config = path.read_text()
            path.write_text(good_config.replace('wire_api = "responses"', 'wire_api = "chat"'))
            result = run("AUDIT_REJECT_CHAT")
            require(result.returncode != 0 and len(requests) == start and "no longer supported" in result.stderr,
                    "chat configuration not rejected before request")
            checks.append({"result": "wire_api=chat rejected before any request"})
            path.write_text(good_config)
            result = run("AUDIT_429")
            require(result.returncode != 0 and len(requests) == start + 1, "429 retried or succeeded")
            checks.append({"result": "429 fails with one request when retries disabled"})
            process = subprocess.Popen([str(binary), "exec", "--json", "--skip-git-repo-check", "AUDIT_HOLD"],
                                       cwd=repo, env=env, text=True, stdout=subprocess.PIPE,
                                       stderr=subprocess.PIPE)
            try:
                require(holding.wait(20), "held stream did not start")
                start = time.monotonic()
                process.send_signal(signal.SIGINT)
                stdout, stderr = process.communicate(timeout=15)
                require('"type":"turn.completed"' not in stdout, "interruption reported success")
                checks.append({"result": "SIGINT exits during open SSE without completed turn",
                               "exit_code": process.returncode,
                               "seconds": round(time.monotonic() - start, 3)})
            finally:
                release.set()
                if process.poll() is None:
                    process.kill()
                    process.communicate()
            report["request_count"] = len(requests)
    finally:
        release.set()
        server.shutdown()
        server.server_close()
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
