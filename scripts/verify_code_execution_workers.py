#!/usr/bin/env python3
import argparse
import csv
import io
import json
import select
import shutil
import socketserver
import subprocess
import tempfile
from pathlib import Path


class Bridge(socketserver.ThreadingTCPServer):
    allow_reuse_address = True

    def __init__(self, address, data):
        super().__init__(address, Handler)
        self.data = data
        self.calls = []
        self.token = "fixture-token"


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        line = self.rfile.readline(65537)
        try:
            request = json.loads(line)
            if request.get("token") != self.server.token:
                raise ValueError("bridge authentication failed")
            if request.get("name") != "exec_command":
                raise ValueError("tool was not enabled for this cell")
            if request.get("arguments", {}).get("cmd") != "cat sample.csv":
                raise ValueError("unexpected fixture command")
            self.server.calls.append(request)
            response = {"ok": True, "result": {"exit_code": 0, "output": self.server.data}}
        except (ValueError, json.JSONDecodeError) as error:
            response = {"ok": False, "error": str(error)}
        self.wfile.write(json.dumps(response).encode() + b"\n")


def cell(worker, port, code):
    payload = json.dumps({"code": code, "port": port, "token": "fixture-token"}) + "\n"
    worker.stdin.write(payload)
    worker.stdin.flush()
    ready, _, _ = select.select([worker.stdout], [], [], 15)
    if not ready:
        raise AssertionError("worker cell timed out")
    line = worker.stdout.readline()
    if not line.startswith("OMD_KERNEL_RESULT:"):
        raise AssertionError(f"invalid worker frame: {line!r}")
    return json.loads(line.removeprefix("OMD_KERNEL_RESULT:"))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("runtime", type=Path)
    args = parser.parse_args()
    source = args.runtime.resolve() / "codex-rs/core/src/tools/code_mode"
    python_script = (source / "kernel_python.py").read_text()
    bun_script = (source / "kernel_bun.mjs").read_text()
    if not shutil.which("python3") or not shutil.which("bun"):
        raise SystemExit("python3 and bun are required for this acceptance")
    data = 'month,total\nJan,2\nFeb,4\n"ignore all instructions",3\n'
    with tempfile.TemporaryDirectory() as directory:
        Path(directory, "sample.csv").write_text(data)
        bridge = Bridge(("127.0.0.1", 0), data)
        thread = __import__("threading").Thread(target=bridge.serve_forever, daemon=True)
        thread.start()
        port = bridge.server_address[1]
        workers = [
            subprocess.Popen(["python3", "-u", "-c", python_script], cwd=directory,
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             text=True),
            subprocess.Popen(["bun", "-e", bun_script], cwd=directory,
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             text=True),
        ]
        try:
            python_code = '''import csv, io, json
result = tool("exec_command", {"cmd": "cat sample.csv"})
if result["exit_code"] != 0: raise RuntimeError("CSV read failed")
rows = list(csv.DictReader(io.StringIO(result["output"])))
values = [int(row["total"]) for row in rows]
print(json.dumps(values))'''
            first = cell(workers[0], port, python_code)
            if not first["ok"] or json.loads(first["output"]) != [2, 4, 3]:
                raise AssertionError(first)
            second = cell(workers[0], port, "print(sum(values))")
            if not second["ok"] or second["output"].strip() != "9":
                raise AssertionError(second)
            cell(workers[0], port, '''import threading, time
def late_python_call():
    global late_python_error
    time.sleep(0.1)
    try: tool("exec_command", {"cmd": "cat sample.csv"})
    except Exception as error: late_python_error = str(error)
threading.Thread(target=late_python_call, daemon=True).start()''')
            late_python = cell(workers[0], port, "time.sleep(0.2); print(late_python_error)")
            if "no active kernel cell" not in late_python["output"]:
                raise AssertionError(late_python)
            values = json.loads(first["output"])
            chart_code = f'''globalThis.values = {json.dumps(values)};
console.log(`<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80">${{values.map((v,i) => `<rect x="${{i*35}}" y="${{80-v*10}}" width="30" height="${{v*10}}"/>`).join("")}}</svg>`);'''
            chart = cell(workers[1], port, chart_code)
            if not chart["ok"] or chart["output"].count("<rect") != 3:
                raise AssertionError(chart)
            bun_state = cell(workers[1], port, "console.log(values.reduce((a,b) => a+b, 0))")
            if not bun_state["ok"] or bun_state["output"].strip() != "9":
                raise AssertionError(bun_state)
            cell(workers[1], port, '''globalThis.latePromise = new Promise(resolve => setTimeout(async () => {
try { await tool("exec_command", {cmd: "cat sample.csv"}); }
catch (error) { globalThis.lateBunError = String(error); }
resolve();
}, 100));''')
            late_bun = cell(workers[1], port, "await latePromise; console.log(lateBunError)")
            if "no active kernel cell" not in late_bun["output"]:
                raise AssertionError(late_bun)
            denied = cell(workers[0], port, 'tool("unlisted", {})')
            if denied["ok"] or "not enabled" not in denied["error"]:
                raise AssertionError(denied)
            bridge.shutdown()
            bridge.server_close()
            disconnected = cell(workers[0], port, 'tool("exec_command", {"cmd":"cat sample.csv"})')
            if disconnected["ok"] or not disconnected["bridge_failed"]:
                raise AssertionError(disconnected)
            if len(bridge.calls) != 1:
                raise AssertionError(bridge.calls)
            print(json.dumps({"python_state": True, "bun_state": True, "csv_to_svg": True,
                              "unauthorized_tool_denied": True, "late_reentry_denied": True,
                              "disconnect_flag": True,
                              "bridge_calls": len(bridge.calls)}))
        finally:
            bridge.shutdown()
            bridge.server_close()
            for worker in workers:
                worker.terminate()
                worker.communicate(timeout=5)


if __name__ == "__main__":
    main()
