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


SOLO_SCENARIOS = ("solo", "solo-denied")
CONTRACT_SCENARIOS = SOLO_SCENARIOS + ("contract-downgrade", "contract-resume")


def contract_plan(binary, choice):
    surface = binary.parent / "omd-contract"
    if not surface.exists():
        raise AssertionError(f"omd-contract selection surface is missing beside {binary}")
    plan = subprocess.run([str(surface), "plan", "-", "-", choice], capture_output=True, text=True, check=True)
    return json.loads(plan.stdout)


def run(binary, destination, scenario="success", context_policy="focused_brief", lead_policy="fixed", lead="sol", failure_class="edit", concise_user_updates=False, structured_worker_reports=False, reactive_rules=False, mod_node=None, mod_profile="counter"):
    policy_mod = mod_profile.startswith(("preview", "coordination", "recovery", "conformance", "exercise"))
    context_marker = ("atlas_policy 2.0.0 (paired) assembled turn" if mod_profile.startswith("exercise")
                      else "Coordination policy (omd_coordination" if policy_mod else "MOD_CONTEXT_SENTINEL")
    if mod_node is not None and scenario not in ("direct", "omd-off", "success", "client-loss-resume", "completion", "escalation", "outage-fallback", "outage-drift"):
        raise ValueError("mod fixture requires direct, omd-off, success, or client-loss-resume scenario")
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
        compacted = False

        def log_message(self, *_):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            model = body["model"]
            native_owner = self.headers.get("x-omd-owner")
            owner = native_owner
            if scenario == "omd-off" and owner is None:
                owner = {"gpt-5.6-sol": "lead", "muse-spark-1.3-contributor": "contributor", "gpt-6-astra": "reviewer"}[model]
            requests.append({"path": self.path, "model": model, "thread_id": self.headers.get("thread-id"), "native_request_id": self.headers.get("x-omd-request-id"), "native_owner": native_owner, "body": body})
            if owner and owner.startswith("mod-") and "MOD_CANCEL" in json.dumps(body):
                time.sleep(3)
            if scenario in ("contract-downgrade", "contract-resume") and owner and owner.startswith("contributor-") and not Provider.abrupt_delay_started:
                Provider.abrupt_delay_started = True
                time.sleep(30)
            if scenario == "client-loss-resume" and owner and ((mod_node is None and owner.startswith("contributor-")) or (mod_node is not None and policy_mod and owner.startswith("contributor-")) or (mod_node is not None and owner.startswith("mod-") and "MOD_ADAPTER" in json.dumps(body))) and not Provider.abrupt_delay_started:
                Provider.abrupt_delay_started = True
                time.sleep(30)
            if scenario in ("outage-fallback", "outage-drift") and owner and owner.startswith("contributor-") and "fallback" not in owner:
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
            completion_outputs = [i for i in outputs if calls.get(i.get("call_id")) == "omd_complete"]
            mod_outputs = [i for i in outputs if calls.get(i.get("call_id")) == "mod_fixture_count"]
            preview_outputs = [i for i in outputs if calls.get(i.get("call_id")) == "mod_omd_coordination_delegate"]
            conformance_outputs = [i for i in outputs if calls.get(i.get("call_id")) == "mod_conformance_context_note"]
            if mod_profile == "lifecycle" and "MOD_COMPACT_PROMPT_SENTINEL" in json.dumps(inputs[-1:]):
                Provider.compacted = True
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                summary = {"type": "message", "id": "summary", "role": "assistant", "content": [{"type": "output_text", "text": "MOD_COMPACTED_SUMMARY"}]}
                for event in ({"type": "response.created", "response": {"id": str(len(requests))}}, {"type": "response.output_item.done", "item": summary}, {"type": "response.completed", "response": {"id": str(len(requests)), "model": model, "usage": {"input_tokens": 100, "input_tokens_details": {"cached_tokens": 0}, "output_tokens": 10, "output_tokens_details": {"reasoning_tokens": 0}, "total_tokens": 110}}}):
                    self.wfile.write(("data: " + json.dumps(event) + "\n\n").encode())
                    self.wfile.flush()
                return
            if mod_profile == "failure" and owner == "lead" and mod_outputs:
                import socket
                with socket.socket() as probe:
                    closed = probe.connect_ex(("127.0.0.1", int((destination / "adapter-port").read_text()))) != 0
                (destination / "mod-cleanup-observed").write_text("closed" if closed else "still running")
            status_outputs = [i for i in outputs if calls.get(i.get("call_id")) == "omd_status"]
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
            elif owner == "lead" and mod_node is not None and policy_mod and scenario == "direct" and not search_outputs:
                item = {"type": "tool_search_call", "id": "search-preview", "call_id": "search-preview", "status": "completed", "execution": "client", "arguments": {"query": "coordination policy delegate worker context investigate"}}
            elif owner == "lead" and mod_node is not None and policy_mod and scenario == "direct" and not preview_outputs:
                item = {"type": "function_call", "id": "preview-delegate", "call_id": "preview-delegate", "name": "mod_omd_coordination_delegate", "arguments": json.dumps({"brief": "Fix solution.py: add must return the sum.", "selected_evidence": ["solution.py"]})}
            elif owner == "lead" and mod_node is not None and not policy_mod and scenario in ("direct", "success", "client-loss-resume") and not search_outputs:
                item = {"type": "tool_search_call", "id": "search-mod", "call_id": "search-mod", "status": "completed", "execution": "client", "arguments": {"query": "mod_fixture_count persistent mod counter effective settings task cost capture delegate isolated contributor implementation"}}
            elif owner == "lead" and mod_node is not None and not policy_mod and scenario in ("direct", "success", "client-loss-resume") and not mod_outputs:
                item = {"type": "function_call", "id": "mod-count", "call_id": "mod-count", "name": "mod_fixture_count", "arguments": "{}"}
            elif owner == "lead" and scenario == "direct" and not search_outputs:
                item = {"type": "tool_search_call", "id": "search-status", "call_id": "search-status", "status": "completed", "execution": "client", "arguments": {"query": "effective settings task cost capture"}}
            elif owner == "lead" and scenario == "direct" and not status_outputs:
                item = {"type": "function_call", "id": "status", "call_id": "status", "name": "omd_status", "arguments": "{}"}
            elif owner == "lead" and scenario in ("direct", "omd-off") and not exec_outputs:
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
            elif owner == "lead" and scenario not in ("direct", "omd-off", "escalation", *SOLO_SCENARIOS) and not search_outputs:
                item = {"type": "tool_search_call", "id": "search-delegation", "call_id": "search-delegation", "status": "completed", "execution": "client", "arguments": {"query": "delegate isolated contributor implementation"}}
            elif owner == "lead" and mod_node is not None and mod_profile.startswith("conformance") and scenario == "success" and not conformance_outputs:
                item = {"type": "function_call", "id": "conformance-note", "call_id": "conformance-note", "name": "mod_conformance_context_note", "arguments": "{}"}
            elif owner == "lead" and scenario not in ("direct", "omd-off", "escalation", *SOLO_SCENARIOS) and not [output for output in outputs if calls.get(output.get("call_id")) not in ("mod_fixture_count", "mod_conformance_context_note")]:
                arguments = {
                    "focused_brief": {"brief": "Fix solution.py: add must return the sum. Preserve unrelated files.", "selected_evidence": ["solution.py", "notes.txt"] if policy_mod else ["solution.py"]},
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
            elif owner == "lead" and scenario in SOLO_SCENARIOS:
                review_outputs = [i for i in outputs if calls.get(i.get("call_id")) == "omd_review"]
                criteria = manifest["checkpoint"]["acceptance_criteria"]
                live = lambda: json.loads((destination / "evidence/checkpoint.json").read_text())["live"]["workspace_sha256"]
                if not search_outputs:
                    item = {"type": "tool_search_call", "id": "search-solo", "call_id": "search-solo", "status": "completed", "execution": "client", "arguments": {"query": "workflow contract status final review checkpoint acceptance evidence completion gate"}}
                elif scenario == "solo-denied" and not spawn_outputs:
                    item = {"type": "function_call", "id": "denied-spawn", "call_id": "denied-spawn", "namespace": "collaboration", "name": "spawn_agent", "arguments": json.dumps({"message": "SOLO_DENIED_CHILD", "task_name": "denied_child"})}
                elif not exec_outputs:
                    item = {"type": "function_call", "id": "solo-fix", "call_id": "solo-fix", "name": "exec_command", "arguments": json.dumps({"cmd": "printf 'def add(a, b):\\n    return a + b\\n' > solution.py", "max_output_tokens": 500})}
                elif not checkpoint_outputs:
                    item = {"type": "function_call", "id": "solo-progress", "call_id": "solo-progress", "name": "omd_checkpoint", "arguments": json.dumps({"completed_acceptance": [], "completed_steering": ["Edited the candidate directly under the solo contract."], "remaining_work": criteria, "failed_hypotheses": [], "candidate_versions": [], "check_versions": []})}
                elif not status_outputs:
                    item = {"type": "function_call", "id": "status", "call_id": "status", "name": "omd_status", "arguments": "{}"}
                elif not review_outputs:
                    item = {"type": "function_call", "id": "solo-review", "call_id": "solo-review", "name": "omd_review", "arguments": json.dumps({"cadence": "final", "candidate_sha256": live(), "stable": True})}
                elif len(checkpoint_outputs) < 2:
                    review = next(json.loads(output["output"]) for output in outputs if calls.get(output.get("call_id")) == "omd_review")
                    assert review.get("status") == "approved", review
                    cycle = review["cycle"]
                    check = cycle["checks"][0]
                    acceptance = [{"criterion": criterion, "evidence": [check]} for criterion in criteria]
                    item = {"type": "function_call", "id": "solo-checkpoint", "call_id": "solo-checkpoint", "name": "omd_checkpoint", "arguments": json.dumps({"completed_acceptance": acceptance, "completed_steering": ["Edited the candidate directly under the solo contract.", "Recorded the approved final self-review."], "remaining_work": [], "failed_hypotheses": [], "candidate_versions": [cycle["candidate"]], "check_versions": [check]})}
                elif not completion_outputs:
                    contract_sha256 = hashlib.sha256(json.dumps(manifest["checkpoint"], separators=(",", ":")).encode()).hexdigest()
                    item = {"type": "function_call", "id": "solo-completion", "call_id": "solo-completion", "name": "omd_complete", "arguments": json.dumps({"candidate_sha256": live(), "contract_sha256": contract_sha256})}
                else:
                    item = {"type": "message", "id": "solo-answer", "role": "assistant", "content": [{"type": "output_text", "text": "Solo completion recorded."}]}
            elif owner and owner.startswith("completion-self-review-"):
                candidate_match = re.search(r"Candidate SHA256: ([0-9a-f]{64})", text)
                contract_match = re.search(r"Contract SHA256: ([0-9a-f]{64})", text)
                checkpoint = json.loads((destination / "evidence/checkpoint.json").read_text())
                requirements = [{"criterion": acceptance["criterion"], "verdict": "satisfied", "summary": "The final self-review checked this criterion against host-recorded check evidence.", "evidence_sha256s": [acceptance["evidence"][0]["evidence_sha256"]]} for acceptance in checkpoint["completed_acceptance"]]
                challenges = [{"kind": kind, "verdict": "passed", "summary": "The exact candidate retains the expected path and behavior.", "paths": ["solution.py"]} for kind in ("missing_wiring", "test_weakening", "negative_cases")]
                verification = {"candidate_sha256": candidate_match.group(1) if candidate_match else "missing", "contract_sha256": contract_match.group(1) if contract_match else "missing", "requirements": requirements, "challenges": challenges}
                if structured_worker_reports:
                    verification["report"] = {"schema": 1, "status": "completed", "summary": "The final self-review finished.", "scope": ["Assessed every criterion and mandatory challenge category."], "uncertainty": ["No independent reviewer checked this work."], "evidence": ["host-owned checkpoint and final self-review"], "required_clarification": []}
                item = {"type": "message", "id": "solo-self-review", "role": "assistant", "content": [{"type": "output_text", "text": json.dumps(verification)}]}
            elif owner == "lead" and scenario in ("completion", "completion-unverified") and not checkpoint_outputs:
                criteria = manifest["checkpoint"]["acceptance_criteria"]
                contribution = next(json.loads(output["output"])["result"] for output in outputs if calls.get(output.get("call_id")) == "omd_contribute")
                candidate = {"label": "integrated-candidate", "sha256": contribution["candidate_sha256"], "evidence": contribution["candidate"]["path"], "evidence_sha256": contribution["candidate"]["sha256"]}
                check = {"label": "candidate-check", "sha256": contribution["candidate_sha256"], "evidence": contribution["checks"]["path"], "evidence_sha256": contribution["checks"]["sha256"]}
                acceptance = [{"criterion": criterion, "evidence": [check]} for criterion in criteria]
                item = {"type": "function_call", "id": "completion-checkpoint", "call_id": "completion-checkpoint", "name": "omd_checkpoint", "arguments": json.dumps({"completed_acceptance": acceptance, "completed_steering": ["Integrated the reviewed exact candidate."], "remaining_work": [], "failed_hypotheses": [], "candidate_versions": [candidate], "check_versions": [check]})}
            elif owner == "lead" and scenario in ("completion", "completion-unverified") and not completion_outputs:
                checkpoint = json.loads((destination / "evidence/checkpoint.json").read_text())
                contract_sha256 = hashlib.sha256(json.dumps(manifest["checkpoint"], separators=(",", ":")).encode()).hexdigest()
                item = {"type": "function_call", "id": "completion-gate", "call_id": "completion-gate", "name": "omd_complete", "arguments": json.dumps({"candidate_sha256": checkpoint["live"]["workspace_sha256"], "contract_sha256": contract_sha256})}
            elif owner and owner.startswith("contributor-") and "fallback" not in owner and not exec_outputs:
                command = "printf 'def add(a, b):\\n    return a + b\\n' > solution.py"
                if scenario == "permissions":
                    command += f"; if cat {json.dumps(str(home / 'secret'))}; then exit 81; fi; if printf bad > {json.dumps(str(repo / 'unrelated.txt'))}; then exit 82; fi"
                item = {"type": "function_call", "id": "edit", "call_id": "edit", "namespace": "functions", "name": "exec_command", "arguments": json.dumps({"cmd": command, "max_output_tokens": 500})}
            elif owner == "contributor-outage-fallback" and not exec_outputs:
                item = {"type": "function_call", "id": "fallback-edit", "call_id": "fallback-edit", "namespace": "functions", "name": "exec_command", "arguments": json.dumps({"cmd": "printf 'def add(a, b):\\n    return a + b\\n' > solution.py", "max_output_tokens": 500})}
            elif owner and owner.startswith("reviewer-"):
                match = re.search(r"Candidate SHA256: ([0-9a-f]{64})", text)
                if scenario == "index-conflict":
                    (repo / "new-tracked.txt").write_text("concurrent tracked file\n")
                    subprocess.run(["/usr/bin/git", "add", "new-tracked.txt"], cwd=repo, env=git_env, check=True)
                if scenario in ("conflict", "outage-drift"):
                    (repo / "solution.py").write_text("intervening user edit\n")
                review = {"candidate_sha256": match.group(1) if match else "missing", "findings": [], "resolved_finding_ids": []}
                if scenario == "review-reject":
                    review["findings"] = [{"key": "synthetic-review-rejection", "severity": "blocking", "summary": "The synthetic reviewer rejected this candidate.", "paths": ["solution.py"]}]
                if structured_worker_reports:
                    review["report"] = {"schema": 1, "status": "completed", "summary": "The exact candidate passed review.", "scope": ["Reviewed the declared candidate and changed paths."], "uncertainty": [], "evidence": ["candidate SHA256 and configured check result"], "required_clarification": []}
                answer = json.dumps(review)
                item = {"type": "message", "id": "answer", "role": "assistant", "content": [{"type": "output_text", "text": answer}]}
            elif owner and owner.startswith("completion-verifier-"):
                candidate_match = re.search(r"Candidate SHA256: ([0-9a-f]{64})", text)
                contract_match = re.search(r"Contract SHA256: ([0-9a-f]{64})", text)
                checkpoint = json.loads((destination / "evidence/checkpoint.json").read_text())
                requirements = []
                for acceptance in checkpoint["completed_acceptance"]:
                    requirements.append({"criterion": acceptance["criterion"], "verdict": "unverified" if scenario == "completion-unverified" else "satisfied", "summary": "Synthetic evidence is unavailable." if scenario == "completion-unverified" else "The exact-candidate check evidence supports this criterion.", "evidence_sha256s": [] if scenario == "completion-unverified" else [acceptance["evidence"][0]["evidence_sha256"]]})
                challenges = [{"kind": kind, "verdict": "unverified" if scenario == "completion-unverified" else "passed", "summary": "Synthetic evidence is unavailable." if scenario == "completion-unverified" else "The exact candidate retains the expected path and behavior.", "paths": [] if scenario == "completion-unverified" else ["solution.py"]} for kind in ("missing_wiring", "test_weakening", "negative_cases")]
                verification = {"candidate_sha256": candidate_match.group(1) if candidate_match else "missing", "contract_sha256": contract_match.group(1) if contract_match else "missing", "requirements": requirements, "challenges": challenges}
                if structured_worker_reports:
                    verification["report"] = {"schema": 1, "status": "completed", "summary": "The independent completion verification finished.", "scope": ["Assessed every criterion and mandatory challenge category."], "uncertainty": ["Synthetic evidence is unavailable."] if scenario == "completion-unverified" else [], "evidence": ["host-owned checkpoint and final review"], "required_clarification": []}
                item = {"type": "message", "id": "completion-answer", "role": "assistant", "content": [{"type": "output_text", "text": json.dumps(verification)}]}
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
            if mod_profile == "lifecycle" and owner == "lead" and not Provider.compacted:
                usage = {"input_tokens": 40000, "input_tokens_details": {"cached_tokens": 0}, "output_tokens": 30, "output_tokens_details": {"reasoning_tokens": 7}, "total_tokens": 40030}
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
    capabilities = {"delegation": True, "escalation": True, "checkpoints": True, "guidelines": True, "repository_knowledge": True, "code_graph": True, "code_health": True, "semantic_lsp": True, "reactive_rules": True, "unified_review": True, "completion_gate": True, "terminal": True, "application_bridge": False}
    if scenario == "direct":
        capabilities.update({"delegation": False, "checkpoints": False, "unified_review": False, "completion_gate": False})
    manifest = {"repository": str(repo), "evidence": str(destination / "evidence"), "scratch": str(repo / ".omd"), "authorization": str(grant), "authorization_sha256": hashlib.sha256(grant.read_bytes()).hexdigest(), "repository_identity": "synthetic-fixture", "approved_untracked": [], "limits": {"requests": 12, "exposure_microusd": 1000000, "seconds": 120, "concurrent_workers": 2, "max_depth": 2, "max_reassessments": 1}, "worker_limits": {"requests": 4, "exposure_microusd": 400000, "seconds": 40}, "capabilities": capabilities, "communication": {"concise_user_updates": concise_user_updates, "structured_worker_reports": structured_worker_reports}, "checkpoint": {"objective": "Fix solution.py so add returns the sum while preserving unrelated work.", "acceptance_criteria": ["candidate check passes", "separate review approves the exact candidate", "reviewed candidate integrates without losing unrelated work"], "max_no_progress_calls": 2}, "legitimate_wait_tools": ["wait_agent", "write_stdin", "wait"], "lifecycle": {"explicit_resume": None}, "recovery": {"contributor_attempts": 2, "equivalent_failure_threshold": 2, "fallback_to_opposite_lead": True}, "lead_policy": {"mode": lead_policy, **({"lead": lead} if lead_policy == "fixed" else {})}, "leads": {"sol": route("gpt-5.6-sol", "high"), "astra": route("gpt-6-astra", "xhigh")}, "context_policy": context, "escalation": {"allowed_failure_classes": ["environment", "edit", "diagnosis", "model"], "max_attempts": 1, "evidence_bytes": 100000}, "worker": route("muse-spark-1.3-contributor", "low"), "check_command": ["/usr/bin/grep", "return a + b", "solution.py"], "toolchain_reads": [], "snapshot_bytes": 1000000, "max_request_bytes": 2000000}
    if mod_node is not None and policy_mod:
        available_contexts = {
            "focused_brief": {"mode": "focused_brief", "max_bytes": 2000000},
            "shared_task_packet": {"mode": "shared_task_packet", "max_bytes": 2000000, "packet": {"path": str(task_packet.resolve()), "sha256": hashlib.sha256(task_packet.read_bytes()).hexdigest()}},
            "parent_history": {"mode": "parent_history", "max_bytes": 2000000},
        }
        manifest["worker_contexts"] = [value for name, value in available_contexts.items() if name != context_policy]
    if reactive_rules or scenario == "reactive":
        reactive_source = destination / "reactive-rules.json"
        reactive_source.write_text(json.dumps({"schema": 1, "version": "fixture-reactive-v1", "rules": [{"id": "inspect-command-result", "scope": "lead", "trigger": {"event": "tool_finished", "tool": "exec_command", "outcome": "completed_host_success"}, "instruction": "Inspect the exact command result and exit code before choosing any follow-up.", "max_activations": 1, "max_context_reactivations": 1}, {"id": "inspect-worker-command-result", "scope": "worker", "trigger": {"event": "tool_finished", "tool": "exec_command", "outcome": "completed_host_success"}, "instruction": "Inspect the exact worker command result before reporting completion.", "max_activations": 1, "max_context_reactivations": 1}]}, sort_keys=True))
        manifest["reactive_rules"] = {"path": str(reactive_source.resolve()), "sha256": hashlib.sha256(reactive_source.read_bytes()).hexdigest()}
    if scenario in SOLO_SCENARIOS:
        plan = contract_plan(binary, "solo_evidence@1")
        assert plan["weakens"] is True, plan
        assert plan["before"]["assurance"] == "independently_verified", plan
        assert plan["after"]["assurance"] == "self_reviewed", plan
        (destination / "contract-plan.json").write_text(json.dumps(plan, indent=2))
        manifest["workflow"] = {"task_selection": {"id": "solo_evidence", "version": 1}, "confirmation": plan["confirmation"]}
        manifest["limits"]["requests"] = 16
    if scenario == "request-cap":
        manifest["limits"]["requests"] = 2
        manifest["worker_limits"]["requests"] = 1
    if scenario == "deadline":
        manifest["limits"]["seconds"] = 3
        manifest["worker_limits"]["seconds"] = 3
        manifest["check_command"] = ["/bin/sleep", "30"]
    if mod_node is not None:
        from benchmarks.mod_fixture import install
        install(destination, manifest, mod_node, mod_profile)
        if scenario == "client-loss-resume":
            manifest["limits"]["requests"] = 24
            manifest["limits"]["exposure_microusd"] = 2000000
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
    if mod_node is not None:
        from benchmarks.mod_fixture import configure
        configure(destination, mod_profile)
    env = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": str(home), "CODEX_HOME": str(home), "CODEX_SQLITE_HOME": str(home), "NO_PROXY": "127.0.0.1,localhost", "TERM": "dumb"}
    if scenario == "omd-off":
        env["OMD_MODE"] = "upstream_direct"
    else:
        env.update({"OMD_MODE": "enabled", "OMD_CONTROLLED_MANIFEST": str(manifest_path)})
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
        elif scenario in ("contract-downgrade", "contract-resume"):
            command = [str(binary), "exec", "--json", "--skip-git-repo-check", "PARENT_HISTORY_SENTINEL Use omd_contribute to fix the addition bug."]
            first = subprocess.Popen(command, cwd=repo, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            deadline = time.monotonic() + 20
            while not Provider.abrupt_delay_started and time.monotonic() < deadline:
                time.sleep(0.05)
            assert Provider.abrupt_delay_started, "Contributor request did not become in-flight"
            first.kill()
            first.communicate(timeout=10)
            activated = json.loads((destination / "evidence/workflow-contract.json").read_text())["provenance"]
            assert activated["contract"]["id"] == "reviewed_omd", activated["contract"]
            assert activated["assurance"] == "independently_verified", activated
            before = (destination / "evidence/workflow-contract.json").read_bytes()
            requested = {"id": "solo_evidence", "version": 1} if scenario == "contract-downgrade" else {"id": "reviewed_omd", "version": 1}
            manifest["lifecycle"]["explicit_resume"] = f"fixture explicit resume requesting {requested['id']}"
            manifest["workflow"] = {"task_selection": requested}
            manifest_path.write_text(json.dumps(manifest, indent=2))
            before_requests = len(requests)
            try:
                resumed = subprocess.run(command, cwd=repo, env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=45)
                stderr, timed_out = resumed.stderr, False
            except subprocess.TimeoutExpired as expired:
                stderr, timed_out = (expired.stderr or b"").decode(errors="replace"), True
            (destination / "resume-stderr.txt").write_text(stderr)
            if scenario == "contract-downgrade":
                assert "controlled runtime activation failed" in stderr, stderr[-2000:]
                assert "confirmation is required to migrate" in stderr, stderr[-2000:]
                assert len(requests) == before_requests, "the refused downgrade still reached the provider"
            else:
                assert "controlled runtime activation failed" not in stderr, stderr[-2000:]
                assert len(requests) > before_requests, "the resumed task never reached the provider"
            retained = json.loads((destination / "evidence/workflow-contract.json").read_text())["provenance"]
            assert (destination / "evidence/workflow-contract.json").read_bytes() == before, "resume rewrote the contract record"
            assert retained["contract"]["id"] == "reviewed_omd", retained["contract"]
            assert retained["assurance"] == "independently_verified", retained
            assert retained["migrations"] == [], retained["migrations"]
            record = {"status": "pass", "scenario": scenario, "requested_contract": requested, "retained_contract": retained["contract"], "retained_assurance": retained["assurance"], "activation_refused": scenario == "contract-downgrade", "process_timed_out": timed_out, "requests_after_resume": len(requests) - before_requests, "wall_seconds": time.monotonic() - started, "scope": "synthetic native transport and isolation; no provider calls"}
            (destination / "verification.json").write_text(json.dumps(record, indent=2))
            (destination / "requests.json").write_text(json.dumps(requests, indent=2))
            return record
        elif scenario == "client-loss-resume":
            command = [str(binary), "exec", "--json", "--skip-git-repo-check", "PARENT_HISTORY_SENTINEL Use omd_contribute to fix the addition bug."]
            first = subprocess.Popen(command, cwd=repo, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            deadline = time.monotonic() + 20
            while not Provider.abrupt_delay_started and time.monotonic() < deadline:
                time.sleep(0.05)
            assert Provider.abrupt_delay_started, "Contributor request did not become in-flight"
            first.kill()
            first.communicate(timeout=10)
            if mod_node is not None and (destination / "adapter-port").exists():
                import socket
                port = int((destination / "adapter-port").read_text())
                deadline = time.monotonic() + 4
                while time.monotonic() < deadline:
                    with socket.socket() as probe:
                        if probe.connect_ex(("127.0.0.1", port)) != 0:
                            break
                    time.sleep(.1)
                else:
                    raise AssertionError("managed provider survived abrupt host death")
            (repo / "notes.txt").write_text("intervening tracked user notes\n")
            manifest["lifecycle"]["explicit_resume"] = "fixture explicit resume after abrupt client loss"
            manifest_path.write_text(json.dumps(manifest, indent=2))
            process = subprocess.run(command, cwd=repo, env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=150)
        else:
            instruction = "PARENT_HISTORY_SENTINEL Fix the addition bug yourself, then run the final review and completion gate." if scenario in SOLO_SCENARIOS else "PARENT_HISTORY_SENTINEL Use omd_contribute to fix the addition bug."
            process = subprocess.run([str(binary), "exec", "--json", "--skip-git-repo-check", instruction], cwd=repo, env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=150)
        (destination / "stdout.txt").write_text(process.stdout)
        (destination / "stderr.txt").write_text(process.stderr)
        (destination / "requests.json").write_text(json.dumps(requests, indent=2))
        if mod_profile == "deny":
            from benchmarks.mod_fixture import verify_denied
            return verify_denied(destination, process, requests)
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
        reviewer_requests = [request for request in requests if (request["native_owner"] or "").startswith("reviewer-")]
        completion_verifier_requests = [request for request in requests if (request["native_owner"] or "").startswith("completion-verifier-")]
        escalation_requests = [request for request in requests if (request["native_owner"] or "").startswith("escalation-")]
        if scenario not in ("request-cap", "direct", "omd-off", "escalation", "reactive", "recursion", "no-progress", *SOLO_SCENARIOS):
            assert worker_requests, "worker route was not observed"
        if scenario in SOLO_SCENARIOS:
            assert not worker_requests, "solo contract admitted a Contributor route"
        expected_context = {"coordination-shared": "shared_task_packet", "coordination-parent": "parent_history"}.get(mod_profile, context_policy)
        if worker_requests:
            assert all("GLOBAL_INSTRUCTION_SENTINEL" in json.dumps(request) for request in worker_requests + reviewer_requests), "project instructions were not inherited"
            worker_context = json.dumps(worker_requests)
            assert ("SHARED_PACKET_SENTINEL" in worker_context) == (expected_context == "shared_task_packet"), "shared packet selection drifted"
            assert ("PARENT_HISTORY_SENTINEL" in worker_context) == (expected_context == "parent_history"), "parent history selection drifted"
            assert ("return a - b" in worker_context) == (expected_context == "focused_brief"), "focused evidence selection drifted"
            assert ("LEAD_ONLY_INSTRUCTION_SENTINEL" in worker_context) == (expected_context == "parent_history"), "parent instruction selection drifted"
            assert ("required_clarification" in worker_context) == structured_worker_reports, "worker report schema selection drifted"
        lead_context = json.dumps(requests[0]["body"].get("input", []))
        assert ("concise ordinary-language sentences" in lead_context) == concise_user_updates, "user update policy selection drifted"
        mod_routed = mod_profile == "routing" or (policy_mod and mod_profile not in ("preview-denied", "coordination-broken"))
        task_entry_mod = mod_profile == "coordination-task-entry"
        expected_lead = lead_model if task_entry_mod else "gpt-6-astra" if mod_routed else lead_model
        effective_lead = {"gpt-5.6-sol": "sol", "gpt-6-astra": "astra"}[expected_lead]
        assert requests[0]["model"] == expected_lead
        if mod_routed:
            assert requests[0]["body"]["reasoning"]["effort"] == ("xhigh" if expected_lead == "gpt-6-astra" else "high")
        assert (requests[0]["native_owner"] == "lead") == (scenario != "omd-off"), "lead route drifted"
        first_tools = json.dumps([item for item in requests[0]["body"].get("input", []) if item.get("type") == "additional_tools"])
        if scenario == "omd-off":
            assert all(name not in first_tools for name in ("omd_contribute", "omd_escalate", "omd_checkpoint", "omd_complete", "omd_status")), "OMD-off exposed OMD tools"
        else:
            assert "tool_search" in first_tools and "omd_contribute" not in first_tools and "omd_escalate" not in first_tools and "omd_checkpoint" not in first_tools and "omd_complete" not in first_tools, "controlled tools were not deferred"
        if scenario not in ("direct", "omd-off", "reactive", "request-cap", "recursion"):
            assert any(i.get("type") == "tool_search_call" for request in requests for i in request["body"].get("input", [])), "task-scoped tool discovery was not exercised"
        if reviewer_requests:
            same_lead = {"sol": "gpt-5.6-sol", "astra": "gpt-6-astra"}[effective_lead]
            opposite_lead = {"sol": "gpt-6-astra", "astra": "gpt-5.6-sol"}[effective_lead]
            expected_reviewer = same_lead if scenario in ("outage-fallback", "outage-drift", *SOLO_SCENARIOS) else opposite_lead
            if scenario in SOLO_SCENARIOS:
                assert reviewer_requests[0]["model"] == expected_reviewer, "solo final review did not resolve to the lead's own route"
                assert "your own final self-review" in json.dumps(reviewer_requests[0]), "solo review prompt did not name itself a self-review"
            else:
                assert reviewer_requests[0]["model"] == expected_reviewer, "reviewer route did not remain separate from the implementer"
            assert ("report field" in json.dumps(reviewer_requests[0])) == structured_worker_reports, "review report instruction selection drifted"
        if scenario in ("completion", "completion-unverified"):
            assert len(completion_verifier_requests) == 1
            assert completion_verifier_requests[0]["model"] == {"sol": "gpt-6-astra", "astra": "gpt-5.6-sol"}[lead]
            assert "missing public/runtime wiring" in json.dumps(completion_verifier_requests[0])
            assert "weakened or removed tests/checks" in json.dumps(completion_verifier_requests[0])
            assert "relevant negative cases" in json.dumps(completion_verifier_requests[0])
        ids = [request["native_request_id"] for request in (gateway.records if scenario == "runner" else requests)]
        if scenario == "omd-off":
            assert not any(ids), "OMD-off requests unexpectedly carried native admission IDs"
        else:
            assert all(ids) and len(ids) == len(set(ids)), "wire attempts lack unique native admission IDs"
        if scenario == "escalation" and mod_profile == "recovery-denied":
            assert not escalation_result and not escalation_requests
        elif scenario == "escalation":
            assert escalation_result.get("status") == "consulted", escalation_result or process.stderr[-2000:]
            assert escalation_result["failure"]["class"] == failure_class
            assert escalation_requests and escalation_requests[0]["model"] == {"sol": "gpt-6-astra", "astra": "gpt-5.6-sol"}[effective_lead]
            source = json.loads(next((destination / "evidence").glob("failure-source-*.json")).read_text())
            assert source["call_ids"] == ["failed-edit"] and any(i.get("type") == "function_call_output" for i in source["items"]), source
        elif scenario in SOLO_SCENARIOS:
            assert not result and not worker_requests and not escalation_requests
            snapshot = json.loads((destination / "evidence/workflow-contract.json").read_text())
            provenance = snapshot["provenance"]
            assert provenance["contract"]["id"] == "solo_evidence", provenance["contract"]
            assert provenance["assurance"] == "self_reviewed", provenance
            assert provenance["source"] == "task_selection", provenance
            assert provenance["weakens_default"] is True, provenance
            assert provenance["confirmation"]["token"] == manifest["workflow"]["confirmation"], provenance
            assert provenance["binding"]["repository_identity"] == "synthetic-fixture", provenance["binding"]
            requirements = provenance["contract"]["requirements"]
            assert requirements["delegation"] is False and requirements["child_agents"] is False
            assert requirements["opposite_lead"] is False and requirements["escalation"] is False
            assert requirements["milestone_review"] is False
            assert requirements["final_review"] == "self_review" and requirements["completion"] == "self_verified"

            settings = json.loads((destination / "evidence/effective-settings.json").read_text())
            assert settings["capabilities"]["delegation"] is False, settings["capabilities"]
            assert settings["capabilities"]["escalation"] is False, settings["capabilities"]
            assert settings["capabilities"]["unified_review"] is True and settings["capabilities"]["completion_gate"] is True
            status = next(json.loads(item["output"])["workflow"] for request in requests for item in request["body"].get("input", []) if item.get("type") == "function_call_output" and item.get("call_id") == "status")
            assert status["contract"] == "solo_evidence v1", status
            assert status["assurance"] == "self-reviewed", status
            discovered = json.dumps([item for request in requests for item in request["body"].get("input", []) if item.get("type") == "tool_search_output"])
            assert "omd_review" in discovered and "omd_complete" in discovered, discovered[:2000]
            assert "omd_contribute" not in discovered, "solo contract exposed the delegation tool"
            assert "omd_escalate" not in discovered, "solo contract exposed the escalation tool"

            receipts = list((destination / "evidence").glob("completion-receipt-*.json"))
            assert len(receipts) == 1, receipts
            receipt = json.loads(receipts[0].read_text())["receipt"]
            assert receipt["status"] == "completed", receipt
            assert receipt["assurance"] == "self_reviewed", receipt
            assert receipt["independent_review"] is False, receipt
            assert receipt["separate_verifier"] is False, receipt
            assert [entry["criterion"] for entry in receipt["requirements"]] == manifest["checkpoint"]["acceptance_criteria"]
            assert [entry["kind"] for entry in receipt["challenges"]] == ["missing_wiring", "test_weakening", "negative_cases"]
            assert all(entry["verdict"] == "satisfied" for entry in receipt["requirements"])
            self_review_requests = [request for request in requests if (request["native_owner"] or "").startswith("completion-self-review-")]
            assert len(self_review_requests) == 1, self_review_requests
            assert self_review_requests[0]["model"] == {"sol": "gpt-5.6-sol", "astra": "gpt-6-astra"}[lead]
            assert not [request for request in requests if (request["native_owner"] or "").startswith("completion-verifier-")]
            assert "No independent reviewer will check this work" in json.dumps(self_review_requests[0])
            checkpoint = json.loads((destination / "evidence/checkpoint.json").read_text())
            assert checkpoint["task_status"] == "completed", checkpoint["task_status"]
            review_state = json.loads((destination / "evidence/review-state.json").read_text())
            assert review_state["policy"]["milestone_review"] is False, review_state["policy"]
            assert review_state["policy"]["final_review"] == "self_review", review_state["policy"]
            assert [cycle["cadence"] for cycle in review_state["cycles"]] == ["final"], review_state["cycles"]
            assert review_state["cycles"][0]["separate_reviewer"] is False, review_state["cycles"][0]
            assert review_state["cycles"][0]["final_approved"] is True, review_state["cycles"][0]
            if scenario == "solo-denied":
                assert snapshot["denied"], "the denied child-agent call was not recorded"
                assert any(entry["operation"] == "spawn_child_agent" for entry in snapshot["denied"]), snapshot["denied"]
                assert not [request for request in requests if (request["native_owner"] or "").startswith("agent:")], "solo contract admitted a child agent"
        elif scenario in ("direct", "omd-off", "reactive", "recursion"):
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
            expected = "integrated" if scenario in ("success", "permissions", "runner", "outage-fallback", "client-loss-resume", "checkpoint", "completion", "completion-unverified") and mod_profile != "recovery-pause" else "blocked" if scenario == "structured-clarification" else "failed"
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
            if scenario in ("completion", "completion-unverified"):
                receipts = list((destination / "evidence").glob("completion-receipt-*.json"))
                assert len(receipts) == 1
                record = json.loads(receipts[0].read_text())
                receipt = record["receipt"]
                assert receipt["status"] == ("completed" if scenario == "completion" else "unverified")
                assert [entry["criterion"] for entry in receipt["requirements"]] == manifest["checkpoint"]["acceptance_criteria"]
                assert [entry["kind"] for entry in receipt["challenges"]] == ["missing_wiring", "test_weakening", "negative_cases"]
                assert all(entry["verdict"] == ("satisfied" if scenario == "completion" else "unverified") for entry in receipt["requirements"])
                checkpoint = json.loads((destination / "evidence/checkpoint.json").read_text())
                assert checkpoint["task_status"] == ("completed" if scenario == "completion" else "stopped")
            if scenario == "outage-fallback":
                if mod_profile != "recovery-pause":
                    assert result["implementation"]["fallback_used"] is True
                    assert len(result["implementation"]["contributor_failures"]) == 2
                events = [json.loads(path.read_text())["record"]["event"] for path in sorted((destination / "evidence").glob("0*.json"))]
                assert "loop_reassessed" in events
            if scenario == "outage-drift":
                assert result["status"] == "failed" and "integration refused" in result["error"], result
            if scenario == "client-loss-resume":
                assert any(attempt["status"] in ("unknown", "in_flight") for attempt in result["attempts"])
                events = [json.loads(path.read_text())["record"] for path in sorted((destination / "evidence").glob("0*.json"))]
                assert any(event.get("event") == "task_paused" and event.get("reason") == "abrupt_client_loss" for event in events)
                assert any(event.get("event") == "task_resumed" for event in events)
                reconciliation = json.loads(next((destination / "evidence").glob("resume-*-reconciliation.json")).read_text())
                assert reconciliation["workspace"]["current_sha256"] != reconciliation["workspace"]["prior_sha256"]
                if mod_node is None or policy_mod:
                    assert reconciliation["workspace"]["changed_paths"] == ["notes.txt"]
                else:
                    assert reconciliation["workspace"]["changed_paths"] is None
                    assert reconciliation["workspace"]["prior_sha256"] is None
                assert reconciliation["permissions"]["effective_policy_rederived"] is True
                assert reconciliation["uncertain_requests"]
                assert (repo / "notes.txt").read_text() == "intervening tracked user notes\n"
                assert not (repo / ".omd").exists()
        if scenario == "permissions":
            output = " ".join(i.get("output", "") for r in requests if r["model"] == "muse-spark-1.3-contributor" for i in r["body"].get("input", []) if i.get("type") == "function_call_output")
            assert output.lower().count("operation not permitted") + output.lower().count("permission denied") >= 2, output
        if scenario not in ("omd-off", *CONTRACT_SCENARIOS) and (destination / "evidence/workflow-contract.json").exists():
            provenance = json.loads((destination / "evidence/workflow-contract.json").read_text())["provenance"]
            expected_contract, expected_assurance = ("legacy_capabilities", "unreviewed") if scenario == "direct" else ("reviewed_omd", "independently_verified")
            assert provenance["contract"]["id"] == expected_contract, provenance["contract"]
            assert provenance["assurance"] == expected_assurance, provenance
            assert provenance["contract"]["requirements"]["delegation"] == capabilities["delegation"], provenance["contract"]["requirements"]
            assert provenance["confirmation"] is None, provenance["confirmation"]
        assert (repo / "unrelated.txt").read_text() == "Uncommitted user work\n"
        assert "SYNTHETIC_SECRET_MUST_NOT_REACH_WORKER" not in json.dumps(requests)
        if scenario in ("review-reject", "index-conflict", "request-cap", "revoked", "deadline", "structured-clarification"):
            assert (repo / "solution.py").read_text() == "def add(a, b):\n    return a - b\n"
        if mod_profile == "recovery-pause":
            assert (repo / "solution.py").read_text() == "def add(a, b):\n    return a - b\n"
        if scenario in ("direct", "omd-off", "escalation", "reactive", *SOLO_SCENARIOS):
            assert (repo / "solution.py").read_text() == "def add(a, b):\n    return a + b\n"
        if scenario == "conflict":
            assert (repo / "solution.py").read_text() == "intervening user edit\n"
        if scenario == "outage-drift":
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
        if scenario == "direct":
            settings = json.loads((destination / "evidence/effective-settings.json").read_text())
            cost = json.loads((destination / "evidence/task-cost.json").read_text())
            checkpoint = json.loads((destination / "evidence/checkpoint.json").read_text())
            assert settings["direct_single_agent"] is True
            assert settings["capabilities"]["delegation"] is False
            assert settings["capabilities"]["checkpoints"] is False
            assert cost["raw_usage_attempts"] == len(requests)
            assert len(cost["attempts"]) == len(requests)
            assert checkpoint["task_status"] == "completed"
            status = next(
                json.loads(item["output"])["effective_settings"]
                for request in requests
                for item in request["body"].get("input", [])
                if item.get("type") == "function_call_output"
                and item.get("call_id") == "status"
            )
            assert status["direct_single_agent"] is True
        if mod_node is not None:
            expected_marker = scenario != "omd-off" and mod_profile not in ("preview-denied", "coordination-broken")
            assert (context_marker in json.dumps(requests)) == expected_marker
            if scenario != "omd-off":
                from benchmarks.mod_fixture import verify
                verify(destination, requests, mod_profile, scenario)
            elif not policy_mod:
                assert not (destination / "mod-store/state-fixture.json").exists()
        if scenario == "omd-off":
            assert not (destination / "evidence").exists()
        if scenario not in ("direct", "escalation", "reactive") and (destination / "evidence/context.json").exists():
            context_record = json.loads((destination / "evidence/context.json").read_text())
            assert context_record["context"]["policy"] == expected_context
            assert context_record["lead_policy"] == lead_policy and context_record["selected_lead"]["name"] == effective_lead
            assert context_record["communication"] == manifest["communication"]
        record = {"status": "pass", "scenario": scenario, "failure_class": failure_class if scenario == "escalation" else None, "context_policy": context_policy, "lead_policy": lead_policy, "lead": lead, "communication": manifest["communication"], "reactive_rules": manifest.get("reactive_rules"), "mods": mod_node is not None, "exit_code": process.returncode, "requests": len(requests), "worker_result": result, "escalation_result": escalation_result, "wall_seconds": time.monotonic() - started, "scope": "synthetic native transport and isolation; no provider calls"}
        (destination / "verification.json").write_text(json.dumps(record, indent=2))
        return record
    finally:
        server.shutdown()
        server.server_close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("binary", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--scenario", choices=("success", "permissions", "conflict", "index-conflict", "review-reject", "request-cap", "revoked", "deadline", "runner", "direct", "omd-off", "escalation", "reactive", "outage-fallback", "outage-drift", "client-loss-resume", "recursion", "checkpoint", "no-progress", "structured-clarification", "completion", "completion-unverified", *CONTRACT_SCENARIOS), default="success")
    parser.add_argument("--context-policy", choices=("focused_brief", "shared_task_packet", "parent_history"), default="focused_brief")
    parser.add_argument("--lead-policy", choices=("fixed", "task_entry"), default="fixed")
    parser.add_argument("--lead", choices=("sol", "astra"), default="sol")
    parser.add_argument("--failure-class", choices=("environment", "edit", "diagnosis", "model"), default="edit")
    parser.add_argument("--concise-user-updates", action="store_true")
    parser.add_argument("--structured-worker-reports", action="store_true")
    parser.add_argument("--reactive-rules", action="store_true")
    parser.add_argument("--mod-node", type=Path)
    parser.add_argument("--mod-profile", choices=("counter", "full", "provider", "cancel", "failure", "policy", "opaque", "routing", "lifecycle", "deny", "preview", "preview-denied", "preview-broken", "coordination-focused", "coordination-shared", "coordination-parent", "coordination-task-entry", "coordination-broken", "recovery", "recovery-denied", "recovery-pause", "recovery-broken", "conformance", "conformance-conflict", "exercise"), default="counter")
    args = parser.parse_args()
    print(json.dumps(run(args.binary.resolve(), args.destination.resolve(), args.scenario, args.context_policy, args.lead_policy, args.lead, args.failure_class, args.concise_user_updates, args.structured_worker_reports, args.reactive_rules, args.mod_node, args.mod_profile), indent=2))


if __name__ == "__main__":
    main()
