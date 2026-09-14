import argparse
import hashlib
import http.server
import json
import os
from pathlib import Path
import re
import subprocess
import threading
import time


ROOT = Path(__file__).resolve().parents[1]


def run(binary, destination, scenario="success"):
    destination.mkdir(parents=True, exist_ok=False)
    repo, home = destination / "repo", destination / "home"
    repo.mkdir()
    home.mkdir()
    (repo / "solution.py").write_text("def add(a, b):\n    return a - b\n")
    (repo / ".gitignore").write_text(".omd/\n__pycache__/\n.omd-tmp/\n")
    git_env = {"PATH": "/usr/bin:/bin", "HOME": str(home), "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null"}
    for args in ([] if scenario == "runner" else (["init", "-q"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "commit", "-qm", "Synthetic source"])):
        subprocess.run(["/usr/bin/git", *args], cwd=repo, env=git_env, check=True, capture_output=True)
    (repo / "unrelated.txt").write_text("Uncommitted user work\n")
    requests = []

    class Provider(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests.append({"path": self.path, "model": body["model"], "thread_id": self.headers.get("thread-id"), "native_request_id": self.headers.get("x-omd-request-id"), "native_owner": self.headers.get("x-omd-owner"), "body": body})
            model = body["model"]
            outputs = [i for i in body.get("input", []) if i.get("type") == "function_call_output"]
            text = json.dumps(body.get("input", []))
            if model == "gpt-5.6-sol" and not outputs:
                item = {"type": "function_call", "id": "delegate", "call_id": "delegate", "name": "omd_contribute", "arguments": json.dumps({"brief": "Fix solution.py: add must return the sum. Preserve unrelated files."})}
            elif model == "muse-spark-1.3-contributor" and not outputs:
                command = "printf 'def add(a, b):\\n    return a + b\\n' > solution.py"
                if scenario == "permissions":
                    command += f"; if cat {json.dumps(str(home / 'secret'))}; then exit 81; fi; if printf bad > {json.dumps(str(repo / 'unrelated.txt'))}; then exit 82; fi"
                item = {"type": "function_call", "id": "edit", "call_id": "edit", "namespace": "functions", "name": "exec_command", "arguments": json.dumps({"cmd": command, "max_output_tokens": 500})}
            elif model == "gpt-6-astra":
                match = re.search(r"Candidate SHA256: ([0-9a-f]{64})", text)
                if scenario == "index-conflict":
                    (repo / "new-tracked.txt").write_text("concurrent tracked file\n")
                    subprocess.run(["/usr/bin/git", "add", "new-tracked.txt"], cwd=repo, env=git_env, check=True)
                if scenario == "conflict":
                    (repo / "solution.py").write_text("intervening user edit\n")
                answer = json.dumps({"approved": scenario != "review-reject", "candidate_sha256": match.group(1) if match else "missing", "findings": []})
                item = {"type": "message", "id": "answer", "role": "assistant", "content": [{"type": "output_text", "text": answer}]}
            else:
                item = {"type": "message", "id": "answer", "role": "assistant", "content": [{"type": "output_text", "text": "Synthetic worker completed."}]}
            if scenario == "revoked" and model == "muse-spark-1.3-contributor":
                grant.write_text(json.dumps({"data_authorized": False}))
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            usage = {"input_tokens": 100, "input_tokens_details": {"cached_tokens": 20}, "output_tokens": 30, "output_tokens_details": {"reasoning_tokens": 7}, "total_tokens": 130}
            for event in ({"type": "response.created", "response": {"id": str(len(requests))}}, {"type": "response.output_item.done", "item": item}, {"type": "response.completed", "response": {"id": str(len(requests)), "model": model, "usage": usage}}):
                try:
                    self.wfile.write(("data: " + json.dumps(event) + "\n\n").encode())
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    break

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Provider)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_port}/v1"
    grant = destination / "grant.json"
    grant.write_text(json.dumps({"schema": 1, "data_authorized": True, "revocable": True, "split": "development", "repositories": ["synthetic-fixture"]}))
    rates = {"input_microusd_per_million": 100000, "cached_microusd_per_million": 2000, "output_microusd_per_million": 200000, "reservation_microusd": 100000, "max_output_tokens": 128, "input_token_ceiling": 200000, "included_subscription": False}
    route = lambda model: {"model": model, "provider": "fixture", "responses_url": url + "/responses", "rates": rates}
    manifest = {"repository": str(repo), "evidence": str(destination / "evidence"), "scratch": str(repo / ".omd"), "authorization": str(grant), "authorization_sha256": hashlib.sha256(grant.read_bytes()).hexdigest(), "repository_identity": "synthetic-fixture", "approved_untracked": [], "limits": {"requests": 12, "exposure_microusd": 1000000, "seconds": 120, "concurrent_workers": 1}, "worker_limits": {"requests": 4, "exposure_microusd": 400000, "seconds": 40}, "lead": route("gpt-5.6-sol"), "worker": route("muse-spark-1.3-contributor"), "reviewer": route("gpt-6-astra"), "check_command": ["/usr/bin/grep", "return a + b", "solution.py"], "toolchain_reads": [], "snapshot_bytes": 1000000, "max_request_bytes": 2000000}
    if scenario == "request-cap":
        manifest["limits"]["requests"] = 1
        manifest["worker_limits"]["requests"] = 1
    if scenario == "deadline":
        manifest["limits"]["seconds"] = 3
        manifest["worker_limits"]["seconds"] = 3
        manifest["check_command"] = ["/bin/sleep", "30"]
    manifest_path = destination / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2))
    catalog = json.loads((ROOT / "benchmarks/fixtures/controlled-models.json").read_text())
    for model in catalog["models"]:
        model["tool_mode"] = "direct"
        model["prefer_websockets"] = False
    (home / "models.json").write_text(json.dumps(catalog))
    (home / "secret").write_text("SYNTHETIC_SECRET_MUST_NOT_REACH_WORKER")
    (home / "config.toml").write_text(f'''model = "gpt-5.6-sol"
model_provider = "fixture"
model_catalog_json = {json.dumps(str(home / "models.json"))}
model_reasoning_effort = "high"
web_search = "disabled"
approval_policy = "never"
default_permissions = "experiment"
developer_instructions = "LEAD_ONLY_INSTRUCTION_SENTINEL"
check_for_update_on_startup = false
[features]
shell_snapshot = false
code_mode = false
[analytics]
enabled = false
[feedback]
enabled = false
[shell_environment_policy]
inherit = "none"
[shell_environment_policy.set]
PATH = "/usr/bin:/bin:/usr/sbin:/sbin"
HOME = {json.dumps(str(repo))}
[model_providers.fixture]
name = "Synthetic fixture"
base_url = {json.dumps(url)}
wire_api = "responses"
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
[permissions.experiment.network]
enabled = false
[permissions.experiment.filesystem]
":minimal" = "read"
{json.dumps(str(repo))} = "write"
"/usr/bin" = "read"
"/bin" = "read"
"/usr/sbin" = "read"
"/sbin" = "read"
"/Library/Developer/CommandLineTools/usr" = "read"
''')
    env = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": str(home), "CODEX_HOME": str(home), "CODEX_SQLITE_HOME": str(home), "OMD_CONTROLLED_MANIFEST": str(manifest_path), "NO_PROXY": "127.0.0.1,localhost", "TERM": "dumb"}
    started = time.monotonic()
    try:
        if scenario == "runner":
            import shutil
            from types import SimpleNamespace
            from .compare import put
            from .controlled_experiment import freeze_file
            from .runner import native
            configuration = put(destination, "runner-config.toml", (home / "config.toml").read_text())
            instructions = put(destination, "runner-instructions.txt", "Use omd_contribute exactly once to fix solution.py.")
            grant_ref = put(destination, "runner-grant.json", grant.read_text())
            policy = put(destination, "runner-policy.json", json.dumps({"authorization": grant_ref}))
            runtime = {"binary": freeze_file(destination, "runner-codex", binary), "configuration": configuration,
                       "instructions": instructions, "provider": "subscription", "requested_model": "gpt-5.6-sol",
                       "native_permissions": True, "controlled": policy, "task_identity": "synthetic-fixture",
                       "helpers": [put(destination, "runner-models.json", (home / "models.json").read_text())]}
            from .gateway import Budget, Gateway
            from .controlled_experiment import controlled_attribution
            limits = {"process_seconds": 120, "cpu_seconds": 120, "file_bytes": 16000000, "rss_bytes": 6442450944, "processes": 64, "snapshot_bytes": 1000000,
                      "seconds": 120, "requests": 12, "max_request_bytes": 220000, "max_response_bytes": 4000000, "max_output_tokens": 8192, "usd_exposure": "1"}
            routes = {"subscription": {"url": url, "models": ["gpt-5.6-sol", "gpt-6-astra"], "account_alias": "fixture", "billing": "subscription", "request_exposure_usd": "0"},
                      "contributor": {"url": url, "models": ["muse-spark-1.3-contributor"], "account_alias": "fixture", "billing": "estimate", "request_exposure_usd": "0.025",
                                      "rate_card": "synthetic", "rates": {"semantics": "input-includes-disjoint-cache;output-includes-reasoning", "input": "0.10", "cache_read": "0.002", "cache_write": "0.10", "output": "0.20"},
                                      "bounds": {"input_token_ceiling": 220000, "output_tokens": 8192, "requests_per_session": 12, "reasoning_tokens_per_item": 8192}}}
            budget = Budget(limits, destination / "budget")
            with Gateway(routes, budget, destination, fixture=True) as gateway:
                result = native(destination, runtime, "Use omd_contribute to fix the addition bug.", repo, home, destination / "native", gateway, limits, 120)
            gateway.ledger()
            assert controlled_attribution(destination), "native/gateway admission join failed"
            process = SimpleNamespace(stdout=(destination / "native/stdout").read_text(), stderr=(destination / "native/stderr").read_text(), returncode=result["exit_code"])
            shutil.copytree(destination / "native/controlled-evidence", destination / "evidence")
        else:
            process = subprocess.run([str(binary), "exec", "--json", "--skip-git-repo-check", "Use omd_contribute to fix the addition bug."], cwd=repo, env=env, capture_output=True, text=True, timeout=150)
        (destination / "stdout.txt").write_text(process.stdout)
        (destination / "stderr.txt").write_text(process.stderr)
        (destination / "requests.json").write_text(json.dumps(requests, indent=2))
        results = list((destination / "evidence").glob("worker-result-*.json"))
        result = json.loads(results[0].read_text()) if results else {}
        if scenario == "deadline" and not result:
            assert 3 <= time.monotonic() - started < 15, "deadline was not exercised"
            assert any(json.loads(p.read_text())["record"].get("event") == "task_stopped" for p in (destination / "evidence").glob("0*.json")), "deadline did not stop task"
            result = {"status": "failed", "error": "native task interrupted at deadline; no worker result"}
        for request in requests:
            if request["model"] != "gpt-5.6-sol":
                assert "LEAD_ONLY_INSTRUCTION_SENTINEL" not in json.dumps(request)
        ids = [request["native_request_id"] for request in (gateway.records if scenario == "runner" else requests)]
        assert all(ids) and len(ids) == len(set(ids)), "wire attempts lack unique native admission IDs"
        expected = "integrated" if scenario in ("success", "permissions", "runner") else "failed"
        assert result.get("status") == expected, result or process.stderr[-2000:]
        if scenario == "permissions":
            output = " ".join(i.get("output", "") for r in requests if r["model"] == "muse-spark-1.3-contributor" for i in r["body"].get("input", []) if i.get("type") == "function_call_output")
            assert output.lower().count("operation not permitted") + output.lower().count("permission denied") >= 2, output
        assert (repo / "unrelated.txt").read_text() == "Uncommitted user work\n"
        assert "SYNTHETIC_SECRET_MUST_NOT_REACH_WORKER" not in json.dumps(requests)
        if scenario in ("review-reject", "index-conflict", "request-cap", "revoked", "deadline"):
            assert (repo / "solution.py").read_text() == "def add(a, b):\n    return a - b\n"
        if scenario == "conflict":
            assert (repo / "solution.py").read_text() == "intervening user edit\n"
        record = {"status": "pass", "scenario": scenario, "exit_code": process.returncode, "requests": len(requests), "worker_result": result, "wall_seconds": time.monotonic() - started, "scope": "synthetic native transport and isolation; no provider calls"}
        (destination / "verification.json").write_text(json.dumps(record, indent=2))
        return record
    finally:
        server.shutdown()
        server.server_close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("binary", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--scenario", choices=("success", "permissions", "conflict", "index-conflict", "review-reject", "request-cap", "revoked", "deadline", "runner"), default="success")
    args = parser.parse_args()
    print(json.dumps(run(args.binary.resolve(), args.destination.resolve(), args.scenario), indent=2))


if __name__ == "__main__":
    main()
