import argparse
import base64
import http.server
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import threading
import time

from .compare import ARMS, digest, put, read, write
from .runner import run


class Provider(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        model = body["model"]
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()

        def emit(event):
            self.wfile.write(("data: " + json.dumps(event) + "\n\n").encode())
            self.wfile.flush()

        try:
            emit({"type": "response.created", "response": {"id": "fixture-response"}})
            outputs = [i for i in body.get("input", []) if i.get("type") == "function_call_output"]
            serialized = json.dumps(body.get("input", []))
            if "NATIVE_DELEGATION_FIXTURE" in serialized and not outputs:
                item = {"type": "function_call", "id": "spawn", "call_id": "spawn", "name": "spawn_agent",
                        "namespace": "multi_agent_v1", "arguments": json.dumps({"message": "CHILD_FIXTURE: report completion only."})}
            elif "NATIVE_DELEGATION_FIXTURE" in serialized and not any(i["call_id"] == "wait" for i in outputs):
                spawned = json.loads(next(i["output"] for i in outputs if i["call_id"] == "spawn"))
                item = {"type": "function_call", "id": "wait", "call_id": "wait", "name": "wait_agent",
                        "namespace": "multi_agent_v1", "arguments": json.dumps({"targets": [spawned.get("agent_id", spawned.get("id"))], "timeout_ms": 10000})}
            elif "CHILD_FIXTURE" in serialized or "NATIVE_DELEGATION_FIXTURE" in serialized:
                item = {"type": "message", "role": "assistant", "id": "message", "content": [{"type": "output_text", "text": "Worker fixture completed."}]}
            elif "assessor" in model:
                answer = json.dumps({"scores": {"correctness": 1, "scope": 1, "maintainability": 0.8},
                                     "rationale": "Synthetic transport response, not a real model judgment."})
                item = {"type": "message", "role": "assistant", "id": "message", "content": [{"type": "output_text", "text": answer}]}
            elif not any(i.get("type") == "function_call_output" for i in body.get("input", [])):
                item = {"type": "function_call", "id": "call", "call_id": "fixture-edit", "name": "exec_command",
                        "namespace": "functions", "arguments": json.dumps({"cmd": "printf 'def add(a, b):\\n    return a + b\\n' > solution.py", "max_output_tokens": 200})}
            else:
                item = {"type": "message", "role": "assistant", "id": "message", "content": [{"type": "output_text", "text": "Fixture edit completed."}]}
            emit({"type": "response.output_item.done", "item": item})
            emit({"type": "response.completed", "response": {"id": "fixture-response", "model": model,
                  "usage": {"input_tokens": 100, "input_tokens_details": {"cached_tokens": 20, "cache_write_tokens": 10},
                            "output_tokens": 30, "output_tokens_details": {"reasoning_tokens": 7}, "total_tokens": 130}}})
        except (BrokenPipeError, ConnectionResetError):
            pass


def tree(files):
    return {"format": "tree-v1", "files": {name: {"base64": base64.b64encode(text.encode()).decode(), "mode": 0o644}
                                            for name, text in files.items()}}


def build(root, upstream, custom, url, trials):
    root.mkdir(parents=True, exist_ok=False)
    binaries = {}
    for label, binary in (("upstream", upstream), ("custom", custom)):
        path = root / "inputs" / label / "codex"
        path.parent.mkdir(parents=True)
        os.link(binary.resolve(), path)
        binaries[label] = {"path": str(path.relative_to(root)), "sha256": digest(path.read_bytes())}
    common = 'model_reasoning_effort = "low"\nweb_search = "disabled"\n[analytics]\nenabled = false\n[feedback]\nenabled = false\n'
    default = put(root, "inputs/default.toml", common)
    configured = put(root, "inputs/configured.toml", common + '\n[agents]\nmax_threads = 2\n')
    instructions = put(root, "inputs/instructions.txt", "Make the requested bounded change; verify it with available tools.")
    prompt = put(root, "inputs/task.txt", "Fix solution.py so add(a, b) returns their sum.")
    source = put(root, "inputs/source.json", json.dumps(tree({"solution.py": "def add(a, b):\n    return a - b\n"})))
    checks = put(root, "private/checks.json", json.dumps({"backend": "macos-seatbelt",
                 "argv": [sys.executable, "-c", "from solution import add; assert add(2, 3) == 5; assert add(-2, 2) == 0; assert add(0, 0) == 0"],
                 "toolchain_reads": [str(Path(sys.executable).resolve().parents[1])]}))
    rubric = put(root, "private/rubric.txt", "Assess correctness, scope and maintainability. This is synthetic infrastructure validation.")
    cold = put(root, "inputs/cold.json", json.dumps(tree({})))
    reuse = put(root, "inputs/reuse.json", json.dumps(tree({"memories/seed.md": "Repository language: Python.\n"})))
    version = subprocess.check_output([str(upstream), "--version"], text=True).strip()
    pin = read(Path(__file__).resolve().parents[1] / "upstream.lock.json")["commit"]
    arms = {name: {"upstream_commit": pin, "runtime_patches": [], "version": version,
                   "binary": binaries["custom" if name == "omd" else "upstream"],
                   "configuration": default if name == "default-upstream" else configured,
                   "instructions": instructions, "provider": "fixture", "requested_model": "omd-fixture-coder",
                   "control_label": "unmodified-custom-build" if name == "omd" else name,
                   "configuration_note": "Fixture: common transport controls; configured arm enables a bounded native agent pool."} for name in ARMS}
    limits = {"seconds": 600, "requests": 100, "usd_exposure": "0", "max_output_tokens": 1000,
              "max_request_bytes": 4000000, "max_response_bytes": 4000000, "process_seconds": 30,
              "cpu_seconds": 30, "file_bytes": 16000000, "rss_bytes": 2000000000,
              "processes": 32, "snapshot_bytes": 16000000}
    assessors = [{"model": model, "provider": "fixture", "binary": binaries["upstream"],
                  "configuration": default, "instructions": instructions} for model in ("fixture-assessor-a", "fixture-assessor-b")]
    routes = {"fixture": {"url": url, "models": ["omd-fixture-coder", "fixture-assessor-a", "fixture-assessor-b"],
                          "billing": "estimate", "account_alias": "synthetic-only", "request_exposure_usd": "0",
                          "rate_card": "synthetic invented rates, USD per million tokens",
                          "rates": {"semantics": "input-includes-disjoint-cache;output-includes-reasoning",
                                    "input": "1", "cache_read": "0.1", "cache_write": "2", "output": "3"}}}
    m = {"schema": 1, "purpose": "fixture", "experiment": "fixed-model", "upstream_commit": pin,
         "seed": 147, "trials": trials, "states": ["cold", "reuse"], "arms": arms,
         "configuration_review": "Infrastructure smoke only. Competitive task-specific configuration is chosen for the bounded pilot.",
         "controls": {"permissions": "outer seatbelt filesystem/network allowlist; native command sandbox disabled because macOS cannot nest profiles",
                      "resource_limits": limits, "environment": platform.platform(), "reasoning": "low"},
         "tools": [{"name": "native-upstream", "version": version, "artifact": binaries["upstream"]}],
         "tasks": [{"id": "native-add", "suite": "synthetic", "family": "native-add", "split": "fixture",
                    "source_revision": source["sha256"], "source": source, "prompt": prompt, "checks": checks}],
         "initial_state": {state: {"snapshot": ref, "provider_cache": "uncontrolled", "provenance": "frozen fixture seed",
                                   "isolation": "fresh seatbelt-confined native state"} for state, ref in (("cold", cold), ("reuse", reuse))},
         "assessment": {"models": [a["model"] for a in assessors], "rubric": rubric,
                        "aggregation": "mean-per-dimension", "disagreement": "report-range-and-pairwise-distance"},
         "execution": {"backend": "macos-seatbelt", "routes": routes, "assessors": assessors, "limits": limits,
                       "authorization": {"manifest_purpose": "fixture", "reference": "user-authorized local implementation validation"},
                       "environment_cost": "unmetered-local", "guideline_cost": "none",
                       "observed_versions": {"upstream": version, "python": platform.python_version(), "platform": platform.platform()}}}
    write(root / "manifest.json", m)
    return root / "manifest.json"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--upstream", type=Path, required=True)
    parser.add_argument("--custom", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--trials", type=int, default=1)
    args = parser.parse_args()
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Provider)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        manifest = build(args.output / "inputs", args.upstream, args.custom, f"http://127.0.0.1:{server.server_port}/v1", args.trials)
        run(manifest, args.output / "results")
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
