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


def run(binary, destination, scenario="success", context_policy="focused_brief", lead_policy="fixed", lead="sol", failure_class="edit", concise_user_updates=False, structured_worker_reports=False, reactive_rules=False):
    destination.mkdir(parents=True, exist_ok=False)
    repo, home = destination / "repo", destination / "home"
    repo.mkdir()
    home.mkdir()
    (repo / "solution.py").write_text("def add(a, b):\n    return a - b\n")
    (repo / "notes.txt").write_text("tracked user notes\n")
    (repo / "AGENTS.md").write_text("GLOBAL_INSTRUCTION_SENTINEL: preserve unrelated files.\n")
    (repo / ".gitignore").write_text(".omd/\n__pycache__/\n.omd-tmp/\n")
    git_env = {"PATH": "/usr/bin:/bin", "HOME": str(home), "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null"}
    for args in ([] if scenario == "runner" else (["init", "-q"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "commit", "-qm", "Synthetic source"])):
        subprocess.run(["/usr/bin/git", *args], cwd=repo, env=git_env, check=True, capture_output=True)
    (repo / "unrelated.txt").write_text("Uncommitted user work\n")
    requests = []

    class Provider(http.server.BaseHTTPRequestHandler):
        abrupt_delay_started = False

        def log_message(self, *_):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            model = body["model"]
            owner = self.headers.get("x-omd-owner")
            if scenario == "runner" and owner is None:
                owner = {"gpt-5.6-sol": "lead", "muse-spark-1.3-contributor": "contributor", "gpt-6-astra": "reviewer"}[model]
            requests.append({"path": self.path, "model": model, "thread_id": self.headers.get("thread-id"), "native_request_id": self.headers.get("x-omd-request-id"), "native_owner": owner, "body": body})
            if scenario == "client-loss-resume" and owner and owner.startswith("contributor-") and not Provider.abrupt_delay_started:
                Provider.abrupt_delay_started = True
                time.sleep(30)
            if scenario == "outage-fallback" and owner and owner.startswith("contributor-") and "fallback" not in owner:
                self.send_response(503)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"error":{"message":"synthetic Contributor outage"}}')
                return
            inputs = body.get("input", [])
            outputs = [i for i in inputs if i.get("type") == "function_call_output"]
            search_outputs = [i for i in inputs if i.get("type") == "tool_search_output"]
            calls = {i.get("call_id"): i.get("name") for i in inputs if i.get("type") == "function_call"}
            exec_outputs = [i for i in outputs if calls.get(i.get("call_id")) == "exec_command"]
            escalation_outputs = [i for i in outputs if calls.get(i.get("call_id")) == "omd_escalate"]
            checkpoint_outputs = [i for i in outputs if calls.get(i.get("call_id")) == "omd_checkpoint"]
            spawn_outputs = [i for i in outputs if calls.get(i.get("call_id")) == "spawn_agent"]
            wait_outputs = [i for i in outputs if calls.get(i.get("call_id")) == "wait_agent"]
            text = json.dumps(body.get("input", []))
            if scenario == "recursion" and owner == "lead" and not spawn_outputs:
                item = {"type": "function_call", "id": "spawn-level-one", "call_id": "spawn-level-one", "namespace": "collaboration", "name": "spawn_agent", "arguments": json.dumps({"message": "LEVEL_ONE_WORKER", "task_name": "level_one"})}
            elif scenario == "recursion" and owner == "lead" and not wait_outputs:
                item = {"type": "function_call", "id": "wait-level-one", "call_id": "wait-level-one", "namespace": "collaboration", "name": "wait_agent", "arguments": json.dumps({"timeout_ms": 30000})}
            elif scenario == "recursion" and owner and owner.startswith("agent:") and "LEVEL_ONE_WORKER" in text and "spawn-level-two" not in text:
                item = {"type": "function_call", "id": "spawn-level-two", "call_id": "spawn-level-two", "namespace": "collaboration", "name": "spawn_agent", "arguments": json.dumps({"message": "LEVEL_TWO_WORKER", "task_name": "level_two"})}
            elif scenario == "recursion" and owner and owner.startswith("agent:") and "LEVEL_ONE_WORKER" in text and not wait_outputs:
                item = {"type": "function_call", "id": "wait-level-two", "call_id": "wait-level-two", "namespace": "collaboration", "name": "wait_agent", "arguments": json.dumps({"timeout_ms": 30000})}
            elif scenario == "recursion":
                item = {"type": "message", "id": "recursive-answer", "role": "assistant", "content": [{"type": "output_text", "text": "Recursive worker completed."}]}
            elif owner == "lead" and scenario == "no-progress" and not search_outputs:
                item = {"type": "tool_search_call", "id": "search-checkpoint", "call_id": "search-checkpoint", "status": "completed", "execution": "client", "arguments": {"query": "durable task checkpoint"}}
            elif owner == "lead" and scenario == "no-progress" and len(checkpoint_outputs) < 4:
                criteria = manifest["checkpoint"]["acceptance_criteria"]
                sequence = len(checkpoint_outputs) + 1
                item = {"type": "function_call", "id": f"unchanged-checkpoint-{sequence}", "call_id": f"unchanged-checkpoint-{sequence}", "name": "omd_checkpoint", "arguments": json.dumps({"completed_acceptance": [], "completed_steering": [], "remaining_work": criteria, "failed_hypotheses": [], "candidate_versions": [], "check_versions": []})}
            elif owner == "lead" and scenario == "direct" and not exec_outputs:
                item = {"type": "function_call", "id": "direct-fix", "call_id": "direct-fix", "name": "exec_command", "arguments": json.dumps({"cmd": "printf 'def add(a, b):\\n    return a + b\\n' > solution.py", "max_output_tokens": 500})}
            elif owner == "lead" and scenario == "reactive" and not exec_outputs:
                item = {"type": "function_call", "id": "reactive-failure", "call_id": "reactive-failure", "name": "exec_command", "arguments": json.dumps({"cmd": "/usr/bin/false", "max_output_tokens": 500})}
            elif owner == "lead" and scenario == "reactive" and len(exec_outputs) == 1:
                item = {"type": "function_call", "id": "reactive-fix", "call_id": "reactive-fix", "name": "exec_command", "arguments": json.dumps({"cmd": "printf 'def add(a, b):\\n    return a + b\\n' > solution.py", "max_output_tokens": 500})}
            elif owner == "lead" and scenario == "escalation" and not exec_outputs:
                item = {"type": "function_call", "id": "failed-edit", "call_id": "failed-edit", "name": "exec_command", "arguments": json.dumps({"cmd": "/usr/bin/false", "max_output_tokens": 500})}
            elif owner == "lead" and scenario == "escalation" and not search_outputs:
                item = {"type": "tool_search_call", "id": "search-escalation", "call_id": "search-escalation", "status": "completed", "execution": "client", "arguments": {"query": "preserve failure evidence bounded model escalation"}}
            elif owner == "lead" and scenario == "escalation" and not escalation_outputs:
                item = {"type": "function_call", "id": "escalate", "call_id": "escalate", "name": "omd_escalate", "arguments": json.dumps({"failure_class": failure_class, "summary": "The first direct edit command failed.", "call_ids": ["failed-edit"]})}
            elif owner == "lead" and scenario == "escalation" and not any(i.get("call_id") == "direct-fix" for i in exec_outputs):
                item = {"type": "function_call", "id": "direct-fix", "call_id": "direct-fix", "name": "exec_command", "arguments": json.dumps({"cmd": "printf 'def add(a, b):\\n    return a + b\\n' > solution.py", "max_output_tokens": 500})}
            elif owner == "lead" and scenario not in ("direct", "escalation") and not search_outputs:
                item = {"type": "tool_search_call", "id": "search-delegation", "call_id": "search-delegation", "status": "completed", "execution": "client", "arguments": {"query": "delegate isolated contributor implementation"}}
            elif owner == "lead" and scenario not in ("direct", "escalation") and not outputs:
                arguments = {
                    "focused_brief": {"brief": "Fix solution.py: add must return the sum. Preserve unrelated files.", "selected_evidence": ["solution.py"]},
                    "shared_task_packet": {},
                    "parent_history": {"brief": "Fix solution.py: add must return the sum. Preserve unrelated files."},
                }[context_policy]
                item = {"type": "function_call", "id": "delegate", "call_id": "delegate", "name": "omd_contribute", "arguments": json.dumps(arguments)}
            elif owner == "lead" and scenario == "checkpoint" and not checkpoint_outputs:
                criteria = manifest["checkpoint"]["acceptance_criteria"]
                contribution = next(json.loads(output["output"])["result"] for output in outputs if calls.get(output.get("call_id")) == "omd_contribute")
                candidate = {"label": "integrated-candidate", "sha256": contribution["candidate_sha256"], "evidence": contribution["candidate"]["path"], "evidence_sha256": contribution["candidate"]["sha256"]}
                check = {"label": "candidate-check", "sha256": contribution["candidate_sha256"], "evidence": contribution["checks"]["path"], "evidence_sha256": contribution["checks"]["sha256"]}
                item = {"type": "function_call", "id": "checkpoint", "call_id": "checkpoint", "name": "omd_checkpoint", "arguments": json.dumps({"completed_acceptance": [], "completed_steering": ["Delegated the bounded implementation and retained its result."], "remaining_work": criteria, "failed_hypotheses": [], "candidate_versions": [candidate], "check_versions": [check]})}
            elif owner and owner.startswith("contributor-") and "fallback" not in owner and not exec_outputs:
                command = "printf 'def add(a, b):\\n    return a + b\\n' > solution.py"
                if scenario == "permissions":
                    command += f"; if cat {json.dumps(str(home / 'secret'))}; then exit 81; fi; if printf bad > {json.dumps(str(repo / 'unrelated.txt'))}; then exit 82; fi"
                item = {"type": "function_call", "id": "edit", "call_id": "edit", "namespace": "functions", "name": "exec_command", "arguments": json.dumps({"cmd": command, "max_output_tokens": 500})}
            elif owner == "contributor-outage-fallback" and not exec_outputs:
                item = {"type": "function_call", "id": "fallback-edit", "call_id": "fallback-edit", "namespace": "functions", "name": "exec_command", "arguments": json.dumps({"cmd": "printf 'def add(a, b):\\n    return a + b\\n' > solution.py", "max_output_tokens": 500})}
            elif owner == "reviewer":
                match = re.search(r"Candidate SHA256: ([0-9a-f]{64})", text)
                if scenario == "index-conflict":
                    (repo / "new-tracked.txt").write_text("concurrent tracked file\n")
                    subprocess.run(["/usr/bin/git", "add", "new-tracked.txt"], cwd=repo, env=git_env, check=True)
                if scenario == "conflict":
                    (repo / "solution.py").write_text("intervening user edit\n")
                review = {"approved": scenario != "review-reject", "candidate_sha256": match.group(1) if match else "missing", "findings": []}
                if structured_worker_reports:
                    review["report"] = {"schema": 1, "status": "completed", "summary": "The exact candidate passed review.", "scope": ["Reviewed the declared candidate and changed paths."], "uncertainty": [], "evidence": ["candidate SHA256 and configured check result"], "required_clarification": []}
                answer = json.dumps(review)
                item = {"type": "message", "id": "answer", "role": "assistant", "content": [{"type": "output_text", "text": answer}]}
            elif owner and owner.startswith("escalation-"):
                answer = json.dumps({"schema": 1, "status": "partial", "summary": "Retry the edit directly with a simpler command.", "scope": ["Diagnosed the cited edit failure only."], "uncertainty": ["The replacement command has not run."], "evidence": ["host-preserved failure source"], "required_clarification": []}) if structured_worker_reports else "The cited failure is preserved. Retry the edit directly with a simpler command."
                item = {"type": "message", "id": "advice", "role": "assistant", "content": [{"type": "output_text", "text": answer}]}
            else:
                report_status = "blocked" if scenario == "structured-clarification" else "completed"
                clarification = ["Should the public addition behavior change for negative inputs?"] if report_status == "blocked" else []
                answer = json.dumps({"schema": 1, "status": report_status, "summary": "Clarification is required before integration." if clarification else "Synthetic worker completed.", "scope": ["Changed solution.py only."], "uncertainty": ["Negative-input behavior is unresolved."] if clarification else [], "evidence": ["solution.py and the edit tool result"], "required_clarification": clarification}) if structured_worker_reports and owner != "lead" else "Synthetic worker completed."
                item = {"type": "message", "id": "answer", "role": "assistant", "content": [{"type": "output_text", "text": answer}]}
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
    task_packet = destination / "task-packet.txt"
    task_packet.write_text("SHARED_PACKET_SENTINEL: Fix solution.py so add returns the sum. Preserve unrelated files.\n")
    route = lambda model, effort: {"model": model, "provider": "fixture", "reasoning_effort": effort, "responses_url": url + "/responses", "rates": rates}
    context = {"mode": context_policy, "max_bytes": 2000000}
    if context_policy == "shared_task_packet":
        context["packet"] = {"path": str(task_packet.resolve()), "sha256": hashlib.sha256(task_packet.read_bytes()).hexdigest()}
    manifest = {"repository": str(repo), "evidence": str(destination / "evidence"), "scratch": str(repo / ".omd"), "authorization": str(grant), "authorization_sha256": hashlib.sha256(grant.read_bytes()).hexdigest(), "repository_identity": "synthetic-fixture", "approved_untracked": [], "limits": {"requests": 12, "exposure_microusd": 1000000, "seconds": 120, "concurrent_workers": 2, "max_depth": 2, "max_reassessments": 1}, "worker_limits": {"requests": 4, "exposure_microusd": 400000, "seconds": 40}, "communication": {"concise_user_updates": concise_user_updates, "structured_worker_reports": structured_worker_reports}, "checkpoint": {"objective": "Fix solution.py so add returns the sum while preserving unrelated work.", "acceptance_criteria": ["candidate check passes", "separate review approves the exact candidate", "reviewed candidate integrates without losing unrelated work"], "max_no_progress_calls": 2}, "legitimate_wait_tools": ["wait_agent", "write_stdin", "wait"], "lifecycle": {"explicit_resume": None}, "recovery": {"contributor_attempts": 2, "equivalent_failure_threshold": 2, "fallback_to_opposite_lead": True}, "lead_policy": {"mode": lead_policy, **({"lead": lead} if lead_policy == "fixed" else {})}, "leads": {"sol": route("gpt-5.6-sol", "high"), "astra": route("gpt-6-astra", "xhigh")}, "context_policy": context, "escalation": {"allowed_failure_classes": ["environment", "edit", "diagnosis", "model"], "max_attempts": 1, "evidence_bytes": 100000}, "worker": route("muse-spark-1.3-contributor", "low"), "check_command": ["/usr/bin/grep", "return a + b", "solution.py"], "toolchain_reads": [], "snapshot_bytes": 1000000, "max_request_bytes": 2000000}
    if reactive_rules or scenario == "reactive":
        reactive_source = destination / "reactive-rules.json"
        reactive_source.write_text(json.dumps({"schema": 1, "version": "fixture-reactive-v1", "rules": [{"id": "inspect-command-result", "scope": "lead", "trigger": {"event": "tool_finished", "tool": "exec_command", "outcome": "completed_host_success"}, "instruction": "Inspect the exact command result and exit code before choosing any follow-up.", "max_activations": 1, "max_context_reactivations": 1}, {"id": "inspect-worker-command-result", "scope": "worker", "trigger": {"event": "tool_finished", "tool": "exec_command", "outcome": "completed_host_success"}, "instruction": "Inspect the exact worker command result before reporting completion.", "max_activations": 1, "max_context_reactivations": 1}]}, sort_keys=True))
        manifest["reactive_rules"] = {"path": str(reactive_source.resolve()), "sha256": hashlib.sha256(reactive_source.read_bytes()).hexdigest()}
    if scenario == "request-cap":
        manifest["limits"]["requests"] = 2
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
    lead_model = {"sol": "gpt-5.6-sol", "astra": "gpt-6-astra"}[lead]
    lead_effort = {"sol": "high", "astra": "xhigh"}[lead]
    (home / "config.toml").write_text(f'''model = {json.dumps(lead_model)}
model_provider = "fixture"
model_catalog_json = {json.dumps(str(home / "models.json"))}
model_reasoning_effort = {json.dumps(lead_effort)}
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
        elif scenario == "client-loss-resume":
            command = [str(binary), "exec", "--json", "--skip-git-repo-check", "PARENT_HISTORY_SENTINEL Use omd_contribute to fix the addition bug."]
            first = subprocess.Popen(command, cwd=repo, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            deadline = time.monotonic() + 20
            while not Provider.abrupt_delay_started and time.monotonic() < deadline:
                time.sleep(0.05)
            assert Provider.abrupt_delay_started, "Contributor request did not become in-flight"
            first.kill()
            first.communicate(timeout=10)
            (repo / "notes.txt").write_text("intervening tracked user notes\n")
            manifest["lifecycle"]["explicit_resume"] = "fixture explicit resume after abrupt client loss"
            manifest_path.write_text(json.dumps(manifest, indent=2))
            process = subprocess.run(command, cwd=repo, env=env, capture_output=True, text=True, timeout=150)
        else:
            process = subprocess.run([str(binary), "exec", "--json", "--skip-git-repo-check", "PARENT_HISTORY_SENTINEL Use omd_contribute to fix the addition bug."], cwd=repo, env=env, capture_output=True, text=True, timeout=150)
        (destination / "stdout.txt").write_text(process.stdout)
        (destination / "stderr.txt").write_text(process.stderr)
        (destination / "requests.json").write_text(json.dumps(requests, indent=2))
        results = list((destination / "evidence").glob("*worker-result-*.json"))
        result = json.loads(results[0].read_text()) if results else {}
        escalation_results = list((destination / "evidence").glob("escalation-result-*.json"))
        escalation_result = json.loads(escalation_results[0].read_text()) if escalation_results else {}
        if scenario == "deadline" and not result:
            assert 3 <= time.monotonic() - started < 15, "deadline was not exercised"
            assert any(json.loads(p.read_text())["record"].get("event") == "task_stopped" for p in (destination / "evidence").glob("0*.json")), "deadline did not stop task"
            result = {"status": "failed", "error": "native task interrupted at deadline; no worker result"}
        if scenario == "no-progress" and not result:
            events = [json.loads(path.read_text())["record"] for path in sorted((destination / "evidence").glob("0*.json"))]
            decisions = [event["decision"] for event in events if event.get("event") == "call_observed"]
            assert decisions[-3:] == ["progress", "reassess", "paused"], decisions
            checkpoint = json.loads((destination / "evidence/checkpoint.json").read_text())
            assert checkpoint["task_status"] == "paused"
            result = {"status": "failed", "error": "unchanged tool results paused the task"}
        worker_requests = [request for request in requests if (request["native_owner"] or "").startswith("contributor-")]
        reviewer_requests = [request for request in requests if request["native_owner"] == "reviewer"]
        escalation_requests = [request for request in requests if (request["native_owner"] or "").startswith("escalation-")]
        if scenario not in ("request-cap", "direct", "escalation", "reactive", "recursion", "no-progress"):
            assert worker_requests, "worker route was not observed"
        if worker_requests:
            assert all("GLOBAL_INSTRUCTION_SENTINEL" in json.dumps(request) for request in worker_requests + reviewer_requests), "project instructions were not inherited"
            worker_context = json.dumps(worker_requests)
            assert ("SHARED_PACKET_SENTINEL" in worker_context) == (context_policy == "shared_task_packet"), "shared packet selection drifted"
            assert ("PARENT_HISTORY_SENTINEL" in worker_context) == (context_policy == "parent_history"), "parent history selection drifted"
            assert ("return a - b" in worker_context) == (context_policy == "focused_brief"), "focused evidence selection drifted"
            assert ("LEAD_ONLY_INSTRUCTION_SENTINEL" in worker_context) == (context_policy == "parent_history"), "parent instruction selection drifted"
            assert ("required_clarification" in worker_context) == structured_worker_reports, "worker report schema selection drifted"
        lead_context = json.dumps(requests[0]["body"].get("input", []))
        assert ("concise ordinary-language sentences" in lead_context) == concise_user_updates, "user update policy selection drifted"
        assert requests[0]["model"] == lead_model and requests[0]["native_owner"] == "lead", "lead route drifted"
        first_tools = json.dumps([item for item in requests[0]["body"].get("input", []) if item.get("type") == "additional_tools"])
        assert "tool_search" in first_tools and "omd_contribute" not in first_tools and "omd_escalate" not in first_tools and "omd_checkpoint" not in first_tools, "controlled tools were not deferred"
        if scenario not in ("direct", "reactive", "request-cap", "recursion"):
            assert any(i.get("type") == "tool_search_call" for request in requests for i in request["body"].get("input", [])), "task-scoped tool discovery was not exercised"
        if reviewer_requests:
            expected_reviewer = {"sol": "gpt-5.6-sol", "astra": "gpt-6-astra"}[lead] if scenario == "outage-fallback" else {"sol": "gpt-6-astra", "astra": "gpt-5.6-sol"}[lead]
            assert reviewer_requests[0]["model"] == expected_reviewer, "reviewer route did not remain separate from the implementer"
            assert ("Keep the approval decision" in json.dumps(reviewer_requests[0])) == structured_worker_reports, "review report instruction selection drifted"
        ids = [request["native_request_id"] for request in (gateway.records if scenario == "runner" else requests)]
        assert all(ids) and len(ids) == len(set(ids)), "wire attempts lack unique native admission IDs"
        if scenario == "escalation":
            assert escalation_result.get("status") == "consulted", escalation_result or process.stderr[-2000:]
            assert escalation_result["failure"]["class"] == failure_class
            assert escalation_requests and escalation_requests[0]["model"] == {"sol": "gpt-6-astra", "astra": "gpt-5.6-sol"}[lead]
            source = json.loads(next((destination / "evidence").glob("failure-source-*.json")).read_text())
            assert source["call_ids"] == ["failed-edit"] and any(i.get("type") == "function_call_output" for i in source["items"]), source
        elif scenario in ("direct", "reactive", "recursion"):
            assert not result and not worker_requests and not reviewer_requests and not escalation_requests
            if scenario == "recursion":
                recursive_requests = [request for request in requests if (request["native_owner"] or "").startswith("agent:")]
                assert len({request["native_owner"] for request in recursive_requests}) == 2
                events = [json.loads(path.read_text())["record"] for path in sorted((destination / "evidence").glob("0*.json"))]
                depths = [event["depth"] for event in events if event.get("event") == "worker_started"]
                assert depths == [1, 2], depths
            if scenario == "reactive":
                assert len(requests) >= 3
                assert "scoped reactive rule was activated" not in json.dumps(requests[0])
                assert "inspect-command-result" in json.dumps(requests[1])
                assert "no executed effect was rolled back" in json.dumps(requests[1])
                activations = list((destination / "evidence").glob("reactive-*.json"))
                assert len(activations) == 1
                activation = json.loads(activations[0].read_text())
                assert activation["activation"]["source_sha256"] == manifest["reactive_rules"]["sha256"]
                assert activation["activation"]["retry_started"] is False
                assert activation["activation"]["executed_effects_rolled_back"] is False
                assert activation["stream_interrupted"] is False
                checkpoint = json.loads((destination / "evidence/checkpoint.json").read_text())
                assert checkpoint["allowance"]["requests_consumed"] == len(requests)
        else:
            expected = "integrated" if scenario in ("success", "permissions", "runner", "outage-fallback", "client-loss-resume", "checkpoint") else "blocked" if scenario == "structured-clarification" else "failed"
            assert result.get("status") == expected, result or process.stderr[-2000:]
            if result.get("status") == "integrated":
                assert (result.get("worker_report") is not None) == structured_worker_reports
            if scenario == "structured-clarification":
                assert result["worker_report"]["required_clarification"] == ["Should the public addition behavior change for negative inputs?"]
                assert not reviewer_requests
            if scenario == "checkpoint":
                checkpoint = json.loads((destination / "evidence/checkpoint.json").read_text())
                assert checkpoint["completed_steering"] == ["Delegated the bounded implementation and retained its result."]
                assert checkpoint["remaining_work"] == manifest["checkpoint"]["acceptance_criteria"]
                assert [item["label"] for item in checkpoint["candidate_versions"]] == ["integrated-candidate"]
                assert [item["label"] for item in checkpoint["check_versions"]] == ["candidate-check"]
                assert checkpoint["task_status"] == "stopped"
                assert checkpoint["allowance"]["requests_consumed"] == len(requests)
            if scenario == "outage-fallback":
                assert result["implementation"]["fallback_used"] is True
                assert len(result["implementation"]["contributor_failures"]) == 2
                events = [json.loads(path.read_text())["record"]["event"] for path in sorted((destination / "evidence").glob("0*.json"))]
                assert "loop_reassessed" in events
            if scenario == "client-loss-resume":
                assert any(attempt["status"] in ("unknown", "in_flight") for attempt in result["attempts"])
                events = [json.loads(path.read_text())["record"] for path in sorted((destination / "evidence").glob("0*.json"))]
                assert any(event.get("event") == "task_paused" and event.get("reason") == "abrupt_client_loss" for event in events)
                assert any(event.get("event") == "task_resumed" for event in events)
                reconciliation = json.loads(next((destination / "evidence").glob("resume-*-reconciliation.json")).read_text())
                assert reconciliation["workspace"]["current_sha256"] != reconciliation["workspace"]["prior_sha256"]
                assert reconciliation["workspace"]["changed_paths"] == ["notes.txt"]
                assert reconciliation["permissions"]["effective_policy_rederived"] is True
                assert reconciliation["uncertain_requests"]
                assert (repo / "notes.txt").read_text() == "intervening tracked user notes\n"
                assert not (repo / ".omd").exists()
        if scenario == "permissions":
            output = " ".join(i.get("output", "") for r in requests if r["model"] == "muse-spark-1.3-contributor" for i in r["body"].get("input", []) if i.get("type") == "function_call_output")
            assert output.lower().count("operation not permitted") + output.lower().count("permission denied") >= 2, output
        assert (repo / "unrelated.txt").read_text() == "Uncommitted user work\n"
        assert "SYNTHETIC_SECRET_MUST_NOT_REACH_WORKER" not in json.dumps(requests)
        if scenario in ("review-reject", "index-conflict", "request-cap", "revoked", "deadline", "structured-clarification"):
            assert (repo / "solution.py").read_text() == "def add(a, b):\n    return a - b\n"
        if scenario in ("direct", "escalation", "reactive"):
            assert (repo / "solution.py").read_text() == "def add(a, b):\n    return a + b\n"
        if scenario == "conflict":
            assert (repo / "solution.py").read_text() == "intervening user edit\n"
        if reactive_rules and scenario != "reactive":
            activations = [json.loads(path.read_text()) for path in (destination / "evidence").glob("reactive-*.json")]
            worker_activations = [activation for activation in activations if activation["activation"]["scope"] == "worker"]
            assert len(worker_activations) == 1
            assert worker_activations[0]["owner"].startswith("contributor-")
            assert "inspect-worker-command-result" in json.dumps(worker_requests[1:])
            assert worker_activations[0]["activation"]["retry_started"] is False
            assert worker_activations[0]["activation"]["executed_effects_rolled_back"] is False
            assert worker_activations[0]["stream_interrupted"] is False
        assert not (repo / ".omd").exists(), "owned runtime scratch was not cleaned"
        if scenario not in ("direct", "escalation", "reactive") and (destination / "evidence/context.json").exists():
            context_record = json.loads((destination / "evidence/context.json").read_text())
            assert context_record["context"]["policy"] == context_policy
            assert context_record["lead_policy"] == lead_policy and context_record["selected_lead"]["name"] == lead
            assert context_record["communication"] == manifest["communication"]
        record = {"status": "pass", "scenario": scenario, "failure_class": failure_class if scenario == "escalation" else None, "context_policy": context_policy, "lead_policy": lead_policy, "lead": lead, "communication": manifest["communication"], "reactive_rules": manifest.get("reactive_rules"), "exit_code": process.returncode, "requests": len(requests), "worker_result": result, "escalation_result": escalation_result, "wall_seconds": time.monotonic() - started, "scope": "synthetic native transport and isolation; no provider calls"}
        (destination / "verification.json").write_text(json.dumps(record, indent=2))
        return record
    finally:
        server.shutdown()
        server.server_close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("binary", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--scenario", choices=("success", "permissions", "conflict", "index-conflict", "review-reject", "request-cap", "revoked", "deadline", "runner", "direct", "escalation", "reactive", "outage-fallback", "client-loss-resume", "recursion", "checkpoint", "no-progress", "structured-clarification"), default="success")
    parser.add_argument("--context-policy", choices=("focused_brief", "shared_task_packet", "parent_history"), default="focused_brief")
    parser.add_argument("--lead-policy", choices=("fixed", "task_entry"), default="fixed")
    parser.add_argument("--lead", choices=("sol", "astra"), default="sol")
    parser.add_argument("--failure-class", choices=("environment", "edit", "diagnosis", "model"), default="edit")
    parser.add_argument("--concise-user-updates", action="store_true")
    parser.add_argument("--structured-worker-reports", action="store_true")
    parser.add_argument("--reactive-rules", action="store_true")
    args = parser.parse_args()
    print(json.dumps(run(args.binary.resolve(), args.destination.resolve(), args.scenario, args.context_policy, args.lead_policy, args.lead, args.failure_class, args.concise_user_updates, args.structured_worker_reports, args.reactive_rules), indent=2))


if __name__ == "__main__":
    main()
