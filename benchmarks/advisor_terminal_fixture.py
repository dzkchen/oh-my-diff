import argparse
import hashlib
import http.server
import json
import os
from pathlib import Path
import pty
import re
import signal
import subprocess
import threading
import time

from benchmarks.mod_fixture import install
from benchmarks.mod_terminal_fixture import drain, fixture, set_size


def visible(fd, output, text, seconds):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        drain(fd, output, 0.2)
        clean = " ".join(re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", " ", output.decode(errors="replace")).split())
        if text in clean:
            return True
    return False


def run(binary, node, inline):
    raise RuntimeError("legacy advisor terminal fixture requires rebuilt OMD_MODE=omd host routes and mod selections; native terminal assertions are not current-host evidence")
    root, repo, home, manifest_path = fixture("advisor-inline" if inline else "advisor-fullscreen")
    requests = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            owner = self.headers.get("x-omd-owner", "")
            requests.append({"owner": owner, "body": body})
            worker = owner.startswith("mod-omd_advisor-")
            answer = json.dumps({"findings": [{"key": "visible-claim", "severity": "advice", "summary": "PTY_ADVISOR_NOTE Check the visible claim.", "paths": [], "quote": "A visible synthetic completed turn"}]}) if worker else "A visible synthetic completed turn; no workspace changes."
            if owner.startswith("auxiliary:"):
                answer = json.dumps({"title": "Report fixture"})
            item = {"type": "message", "id": "advisor-pty-answer", "role": "assistant", "content": [{"type": "output_text", "text": answer}]}
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            for event in ({"type": "response.created", "response": {"id": str(len(requests))}}, {"type": "response.output_item.done", "item": item}, {"type": "response.completed", "response": {"id": str(len(requests)), "model": body["model"], "usage": {"input_tokens": 100, "input_tokens_details": {"cached_tokens": 0}, "output_tokens": 10, "total_tokens": 110}}}):
                self.wfile.write(("data: " + json.dumps(event) + "\n\n").encode())
                self.wfile.flush()

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_port}/v1"
    manifest = json.loads(manifest_path.read_text())
    for route in (manifest["leads"]["sol"], manifest["leads"]["astra"], manifest["worker"]):
        route["responses_url"] = url + "/responses"
    install(root, manifest, node, "advisor")
    manifest_path.write_text(json.dumps(manifest))
    config = home / "config.toml"
    config.write_text('default_permissions = "advisor_fixture"\n' + config.read_text().replace("http://127.0.0.1:9/v1", url) + f'\n[permissions.advisor_fixture.filesystem]\n":minimal" = "read"\n{json.dumps(str(repo))} = "read"\n"/usr/bin" = "read"\n"/bin" = "read"\n[permissions.advisor_fixture.network]\nenabled = false\n')
    master, slave = pty.openpty()
    set_size(slave, 110, 34)
    env = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": str(home), "CODEX_HOME": str(home), "CODEX_SQLITE_HOME": str(home), "OMD_CONTROLLED_MANIFEST": str(manifest_path), "OPENAI_API_KEY": "pty-fixture", "TERM": "xterm-256color", "COLORTERM": "truecolor", "LANG": "en_CA.UTF-8", "LC_ALL": "en_CA.UTF-8", "NO_PROXY": "127.0.0.1,localhost"}
    child = subprocess.Popen([str(binary), *(["--no-alt-screen"] if inline else []), "-C", str(repo)], stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True)
    os.close(slave)
    output = bytearray()
    checks = {}
    try:
        checks["selected_status_visible"] = visible(master, output, "Advisor selected", 15)
        os.write(master, b"Report the synthetic fixture result.")
        drain(master, output, 0.5)
        os.write(master, b"\r")
        checks["completed_lead_visible"] = visible(master, output, "visible synthetic completed turn", 20)
        if inline:
            deadline = time.monotonic() + 20
            state_path = root / "mod-store/state-omd_advisor.json"
            while (not state_path.exists() or '"recorded"' not in state_path.read_text()) and time.monotonic() < deadline:
                drain(master, output, 0.2)
            drain(master, output, 0.5)
            set_size(master, 145, 34)
            os.write(master, b"\x0c")
        checks["review_presentation_visible"] = visible(master, output, "Advisor: 1 note" if inline else "PTY_ADVISOR_NOTE", 20)
        drain(master, output, 1)
        checks["one_independent_worker"] = sum(request["owner"].startswith("mod-omd_advisor-") for request in requests) == 1
        checks["background_task_separate_and_accounted"] = len(requests) == 3 and sum(request["owner"].startswith("auxiliary:") for request in requests) == 1
        checks["source_unchanged"] = (repo / "sample.txt").read_text() == "fixture\n"
        state = json.loads((root / "mod-store/state-omd_advisor.json").read_text())["value"]
        checks["recorded_exact_finding"] = state["status"] == "recorded" and len(state["findings"]) == 1 and "PTY_ADVISOR_NOTE" in state["findings"][0]["summary"]
    finally:
        os.write(master, b"\x03\x03")
        drain(master, output, 2)
        if child.poll() is None:
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except (PermissionError, ProcessLookupError):
                child.terminate()
        status = child.wait(timeout=5)
        os.close(master)
        server.shutdown()
        server.server_close()
        (root / "terminal.raw").write_bytes(output)
        (root / "requests.json").write_text(json.dumps(requests, indent=2))
    checks["terminal_restored"] = b"\x1b[?25h" in output and (inline or b"\x1b[?1049l" in output)
    result = {"status": "pass" if status == 0 and all(checks.values()) else "fail", "root": str(root), "mode": "inline" if inline else "fullscreen", "checks": checks, "trace_sha256": hashlib.sha256(output).hexdigest(), "scope": "real PTY rendering and native review with synthetic responses; no physical-terminal or real-model quality claim"}
    (root / "verification.json").write_text(json.dumps(result, indent=2))
    print(json.dumps(result), flush=True)
    assert result["status"] == "pass", result
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("binary", type=Path)
    parser.add_argument("node", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    results = [run(args.binary.resolve(), args.node.resolve(), inline) for inline in (False, True)]
    args.output.write_text(json.dumps({"status": "pass", "results": results}, indent=2) + "\n")
