#!/usr/bin/env python3
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import select
import subprocess
import tempfile
import threading
import time


PAGE = b"""<!doctype html>
<html><head><title>OMD browser fixture</title></head>
<body>
<h1 id="status">ready</h1>
<button id="open" onclick="document.querySelector('dialog').showModal(); console.warn('dialog-opened')">Open evidence dialog</button>
<dialog><p>interaction-confirmed</p><button onclick="this.closest('dialog').close(); console.info('dialog-closed')">Close evidence dialog</button></dialog>
<script>console.info('fixture-ready')</script>
</body></html>"""


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(PAGE)))
        self.end_headers()
        self.wfile.write(PAGE)

    def log_message(self, *_args):
        return


def process_rows():
    result = subprocess.run(["ps", "-axo", "pid=,command="], text=True,
                            stdout=subprocess.PIPE, check=True)
    return result.stdout.splitlines()


def descendants(root):
    marker = str(root)
    matches = []
    for line in process_rows():
        stripped = line.strip()
        if marker not in stripped:
            continue
        pid = int(stripped.split(None, 1)[0])
        if pid != os.getpid():
            matches.append(stripped)
    return matches


def process_tree(root_pid):
    result = subprocess.run(["ps", "-axo", "pid=,ppid=,command="], text=True,
                            stdout=subprocess.PIPE, check=True)
    rows = []
    for line in result.stdout.splitlines():
        fields = line.strip().split(None, 2)
        if len(fields) == 3:
            rows.append((int(fields[0]), int(fields[1]), fields[2]))
    selected = {root_pid}
    changed = True
    while changed:
        changed = False
        for pid, parent, _command in rows:
            if parent in selected and pid not in selected:
                selected.add(pid)
                changed = True
    return [f"{pid} {parent} {command}" for pid, parent, command in rows if pid in selected]


def live_processes(pids):
    live = []
    wanted = set(pids)
    for line in process_rows():
        stripped = line.strip()
        pid = int(stripped.split(None, 1)[0])
        if pid in wanted:
            live.append(stripped)
    return live


def send(process, value):
    process.stdin.write(json.dumps(value, separators=(",", ":")) + "\n")
    process.stdin.flush()


def receive(process, request_id, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        ready, _, _ = select.select([process.stdout], [], [], max(0, deadline - time.monotonic()))
        if not ready:
            break
        line = process.stdout.readline()
        if not line:
            error = process.stderr.read()
            raise RuntimeError(f"browser MCP exited while awaiting {request_id}: {error[-4000:]}")
        value = json.loads(line)
        if value.get("id") == request_id:
            if "error" in value:
                raise RuntimeError(f"browser MCP request {request_id} failed: {value['error']}")
            return value["result"]
    raise RuntimeError(f"timed out awaiting browser MCP request {request_id}")


def call(process, request_id, method, params=None):
    send(process, {"jsonrpc": "2.0", "id": request_id, "method": method,
                   "params": params or {}})
    return receive(process, request_id)


def content_text(result):
    return "\n".join(item.get("text", "") for item in result.get("content", [])
                     if item.get("type") == "text")


def artifact_text(result, evidence, suffix):
    text = content_text(result)
    names = re.findall(r'\]\(\./([^\)]+)\)', text)
    for name in names:
        path = evidence / name
        if path.suffix == suffix and path.is_file():
            text += "\n" + path.read_text()
    return text


def tool(process, request_id, name, arguments=None):
    result = call(process, request_id, "tools/call", {"name": name, "arguments": arguments or {}})
    if result.get("isError"):
        raise RuntimeError(f"browser tool {name} failed: {content_text(result)}")
    return result


def run(bundle, evidence, abrupt=False):
    bundle = bundle.resolve()
    evidence = evidence.resolve()
    evidence.mkdir(parents=True, exist_ok=True)
    before = descendants(bundle)
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    environment = {"OMD_BROWSER_ARTIFACTS_DIR": str(evidence)}
    process = subprocess.Popen([str(bundle / "bin/omd-browser-mcp")], cwd=evidence,
                               env={**dict(os.environ), **environment},
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, text=True, bufsize=1)
    owned_pids = set()
    try:
        initialized = call(process, 1, "initialize", {
            "protocolVersion": "2025-03-26",
            "capabilities": {},
            "clientInfo": {"name": "omd-browser-smoke", "version": "1"},
        })
        send(process, {"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}})
        listed = call(process, 2, "tools/list")
        names = {item["name"] for item in listed["tools"]}
        required = {"browser_navigate", "browser_snapshot", "browser_click", "browser_take_screenshot",
                    "browser_console_messages", "browser_close"}
        missing = sorted(required - names)
        if missing:
            raise RuntimeError(f"browser MCP is missing required tools: {missing}")
        url = f"http://127.0.0.1:{server.server_port}/"
        navigation = tool(process, 3, "browser_navigate", {"url": url})
        snapshot_result = tool(process, 4, "browser_snapshot")
        snapshot = artifact_text(snapshot_result, evidence, ".yml")
        match = re.search(r'button "Open evidence dialog" \[ref=([^\]]+)\]', snapshot)
        if not match:
            raise RuntimeError(f"open button reference missing from snapshot: {snapshot[-2000:]}")
        opened = tool(process, 5, "browser_click", {
            "element": "Open evidence dialog", "target": match.group(1),
        })
        opened_snapshot = tool(process, 6, "browser_snapshot")
        opened_text = artifact_text(opened_snapshot, evidence, ".yml")
        if "interaction-confirmed" not in opened_text:
            raise RuntimeError("dialog content missing after browser interaction")
        screenshot_name = "interaction.png"
        screenshot = tool(process, 7, "browser_take_screenshot", {
            "type": "png", "filename": screenshot_name, "fullPage": True,
        })
        console = tool(process, 8, "browser_console_messages", {"level": "debug"})
        console_text = artifact_text(console, evidence, ".log")
        if "fixture-ready" not in console_text or "dialog-opened" not in console_text:
            raise RuntimeError(f"expected console evidence missing: {console_text[-2000:]}")
        during = process_tree(process.pid)
        owned_pids = {int(line.split(None, 1)[0]) for line in during}
        if abrupt:
            process.terminate()
            close_text = "MCP process terminated with an open browser"
        else:
            close_text = content_text(tool(process, 9, "browser_close"))
        screenshot_path = evidence / screenshot_name
        if not screenshot_path.is_file() or screenshot_path.stat().st_size == 0:
            raise RuntimeError("browser screenshot artifact is absent or empty")
        return {
            "protocol": initialized.get("protocolVersion"),
            "tools": sorted(required),
            "interaction": "dialog opened and content observed",
            "screenshot": {"path": str(screenshot_path), "bytes": screenshot_path.stat().st_size,
                           "response": content_text(screenshot)[-1000:]},
            "console": console_text,
            "before_processes": before,
            "during_processes": during,
            "browser_close": close_text,
        }
    finally:
        server.shutdown()
        server.server_close()
        try:
            process.stdin.close()
        except BrokenPipeError:
            pass
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        deadline = time.monotonic() + 10
        after = descendants(bundle) + live_processes(owned_pids)
        while after and time.monotonic() < deadline:
            time.sleep(0.2)
            after = descendants(bundle) + live_processes(owned_pids)
        if after:
            raise RuntimeError(f"browser processes remained after MCP shutdown: {after}")


def main():
    parser = argparse.ArgumentParser(description="Exercise the installed Oh My Diff browser MCP bundle")
    parser.add_argument("bundle", type=Path)
    parser.add_argument("evidence", type=Path)
    parser.add_argument("--abrupt", action="store_true")
    args = parser.parse_args()
    result = run(args.bundle, args.evidence, args.abrupt)
    result["after_processes"] = descendants(args.bundle.resolve())
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
