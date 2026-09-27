import hashlib
import json
import os
from pathlib import Path
import select
import sys
import shutil
import subprocess
import tempfile
import re
import time
import unittest


ROOT = Path(__file__).resolve().parents[1]
RUNNER = (ROOT / "runtime/omd/src/mods/runner.mjs").read_text()
SOURCE = (ROOT / "mods/first-party/omd_lsp_sync/index.ts").read_text()
CAPABILITIES = ["lifecycle", "process", "state", "tools", "workspace"]
HOST = (ROOT / "runtime/omd/src/mods.rs").read_text()


def table(name):
    return re.search(rf"pub const {name}: &\[[^\]]*\] = &\[(.*?)\];", HOST, re.S).group(1)


LEGACY_SURFACE = {
    "events": dict(re.findall(r'\("([a-z_]+)", "([a-z_.]+)"\)', table("LEGACY_MOD_EVENTS"))),
    "replacements": re.findall(r'"([a-z_]+)"', table("LEGACY_MOD_REPLACEMENT_POINTS")),
    "middleware": re.findall(r'"([a-z_]+)"', table("MOD_MIDDLEWARE_EVENTS")),
    "state": "state",
    "contracts": "workflow",
}


def digest(data):
    return hashlib.sha256(data).hexdigest()


class Host:
    def __init__(self, repository, server):
        self.repository = repository
        self.server = server
        self.child = None
        self.buffer = b""
        self.sent = []
        self.operations = []

    def close(self):
        if self.child is not None:
            self.child.kill()
            self.child.wait(timeout=5)
            self.child.stdin.close()
            self.child.stdout.close()
            self.child = None

    def frames(self, wait_ms):
        deadline = time.monotonic() + wait_ms / 1000
        messages = []
        while True:
            if messages and not select.select([self.child.stdout], [], [], 0)[0] and b"\r\n\r\n" not in self.buffer:
                return messages
            marker = self.buffer.find(b"\r\n\r\n")
            if marker >= 0:
                headers = self.buffer[:marker].decode()
                length = next((int(line.split(":", 1)[1].strip()) for line in headers.split("\r\n")
                               if line.lower().startswith("content-length:")), None)
                if length is None:
                    raise AssertionError("server frame has no length")
                end = marker + 4 + length
                if len(self.buffer) >= end:
                    messages.append(json.loads(self.buffer[marker + 4:end]))
                    self.buffer = self.buffer[end:]
                    continue
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return messages
            ready, _, _ = select.select([self.child.stdout], [], [], remaining)
            if not ready:
                return messages
            chunk = os.read(self.child.stdout.fileno(), 65536)
            if not chunk:
                raise AssertionError("server stopped before replying")
            self.buffer += chunk

    def call(self, call):
        self.operations.append(call["operation"])
        operation = call["operation"]
        arguments = call["arguments"]
        if operation == "process.which":
            return {"found": [{"name": "pylsp", "path": self.server, "sha256": digest(Path(self.server).read_bytes())}]}
        if operation == "process.start":
            if self.child is not None:
                raise AssertionError("server started twice")
            self.child = subprocess.Popen([sys.executable, self.server] if self.server.endswith(".py") else [self.server], cwd=self.repository, stdin=subprocess.PIPE,
                                          stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            return {"session": "python", "running": True}
        if operation == "process.status":
            if self.child is None or self.child.poll() is not None:
                raise AssertionError("server is unavailable")
            return {"session": "python", "running": True, "idle_ms": 0}
        if operation == "process.exchange":
            for message in arguments.get("send", []):
                self.sent.append(message)
                payload = json.dumps(message, separators=(",", ":")).encode()
                self.child.stdin.write(f"Content-Length: {len(payload)}\r\n\r\n".encode() + payload)
                self.child.stdin.flush()
            return {"session": "python", "running": True,
                    "messages": self.frames(arguments.get("wait_ms", 0))}
        if operation == "process.stop":
            self.close()
            return {"stopped": True}
        if operation == "workspace.read":
            files = {}
            for name in arguments["paths"]:
                path = self.repository / name
                data = path.read_bytes() if path.exists() else None
                files[name] = {"text": data.decode(), "sha256": digest(data)} if data is not None else None
            return {"files": files}
        raise AssertionError(f"unexpected host operation {operation}")


def run(node, event, payload, state, host):
    receipts = []
    for _ in range(36):
        request = {"source": SOURCE, "filename": "omd_lsp_sync/index.ts", "capabilities": CAPABILITIES,
                   "state": state, "settings": {}, "event": event, "payload": payload, "receipts": receipts,
                   "hook_budget_ms": 1000, "surface": LEGACY_SURFACE}
        result = subprocess.run([node, "--no-warnings", "--experimental-vm-modules", "--input-type=module",
                                 "--eval", RUNNER], input=json.dumps(request), text=True, capture_output=True,
                                timeout=8, check=True)
        output = json.loads(result.stdout)
        if "error" in output:
            raise AssertionError(output["error"])
        if output.get("host_call") is None:
            return output
        call = output["host_call"]
        receipts.append({"call": call, "value": host.call(call)})
    raise AssertionError("mod callback did not complete")


FAKE_SERVER = r"""
import json, sys, time
def send(message):
    data = json.dumps(message).encode()
    sys.stdout.buffer.write(b"Content-Length: %d\r\n\r\n" % len(data) + data)
    sys.stdout.buffer.flush()
while True:
    length = None
    while True:
        line = sys.stdin.buffer.readline()
        if not line:
            sys.exit(0)
        if line in (b"\r\n", b"\n"):
            break
        if line.lower().startswith(b"content-length:"):
            length = int(line.split(b":", 1)[1])
    message = json.loads(sys.stdin.buffer.read(length))
    method = message.get("method")
    if method == "initialize":
        for index in range(20):
            send({"jsonrpc": "2.0", "method": "window/logMessage", "params": {"type": 4, "message": str(index)}})
            time.sleep(0.01)
        send({"jsonrpc": "2.0", "id": 1, "method": "workspace/configuration", "params": {"items": [{}]}})
        send({"jsonrpc": "2.0", "id": message["id"], "result": {"capabilities": {"workspace": {"fileOperations": {"willRename": {}}}}}})
    elif method == "textDocument/didOpen":
        document = message["params"]["textDocument"]
        send({"jsonrpc": "2.0", "method": "textDocument/publishDiagnostics", "params": {"uri": document["uri"], "version": document["version"], "diagnostics": [{}]}})
    elif method == "workspace/willRenameFiles":
        old = message["params"]["files"][0]["oldUri"]
        user = old.rsplit("/", 1)[0] + "/user.py"
        send({"jsonrpc": "2.0", "method": "window/logMessage", "params": {"type": 4, "message": "renaming"}})
        time.sleep(0.01)
        send({"jsonrpc": "2.0", "id": message["id"], "result": {"changes": {user: [{"range": {"start": {"line": 0, "character": 5}, "end": {"line": 0, "character": 8}}, "newText": "new"}]}}})
"""


class LspSyncModTest(unittest.TestCase):
    def test_fake_server_requests_rename_changes_and_idle(self):
        node = os.environ.get("OMD_TEST_NODE") or shutil.which("node")
        if not node or subprocess.check_output([node, "--version"], text=True).strip() != "v24.18.0":
            self.skipTest("pinned Node 24.18.0 required")
        with tempfile.TemporaryDirectory() as directory:
            repository = Path(directory).resolve() / "repo"
            repository.mkdir()
            server = Path(directory).resolve() / "fake_server.py"
            server.write_text(FAKE_SERVER)
            (repository / "old.py").write_text("value = 1\n")
            (repository / "user.py").write_text("from old import value\n")
            host = Host(repository, str(server))
            try:
                changes = [{"path": name, "before": None, "after": digest((repository / name).read_bytes())} for name in ("old.py", "user.py")]
                first = run(node, "workspace_write", {"repository": str(repository), "call_id": "1", "tool": "apply_patch",
                    "outcome": "success", "status": "observed", "changes": changes}, None, host)
                self.assertEqual(first["state"]["status"], "synced")
                self.assertEqual(first["state"]["diagnostics"]["old.py"]["count"], 1)
                self.assertIn({"jsonrpc": "2.0", "id": 1, "result": [None]}, host.sent)
                idle = run(node, "idle", {"cause": "Completed"}, first["state"], host)
                self.assertTrue(idle["state"]["running"])
                self.assertNotIn("process.stop", host.operations)
                rename = run(node, "workspace_pre_rename", {"repository": str(repository), "old": "old.py", "new": "new.py",
                    "expected": {"old.py": digest((repository / "old.py").read_bytes())}}, idle["state"], host)
                self.assertEqual(rename["value"]["status"], "ready", rename["value"])
                self.assertEqual(rename["value"]["writes"], {"user.py": "from new import value\n"})
                self.assertEqual(host.operations.count("process.start"), 1)
            finally:
                host.close()


    def test_installed_python_server_synchronizes_open_change_close(self):
        server = shutil.which("pylsp")
        node = os.environ.get("OMD_TEST_NODE") or shutil.which("node")
        if not server or not node or subprocess.check_output([node, "--version"], text=True).strip() != "v24.18.0":
            self.skipTest("installed pylsp and pinned Node 24.18.0 required")
        with tempfile.TemporaryDirectory() as directory:
            repository = Path(directory).resolve()
            path = repository / "sample.py"
            path.write_text("value = 1\n")
            host = Host(repository, server)
            try:
                first = run(node, "workspace_write", {"repository": str(repository), "call_id": "1",
                    "tool": "apply_patch", "outcome": "success", "status": "observed",
                    "changes": [{"path": "sample.py", "before": None, "after": digest(path.read_bytes())}]}, None, host)
                self.assertEqual(first["state"]["status"], "synced")
                self.assertTrue(any(item.get("method") == "textDocument/didOpen" for item in host.sent))
                path.write_text("value = 2\n")
                second = run(node, "workspace_write", {"repository": str(repository), "call_id": "2",
                    "tool": "apply_patch", "outcome": "success", "status": "observed",
                    "changes": [{"path": "sample.py", "before": first["state"]["documents"]["sample.py"]["sha256"],
                                 "after": digest(path.read_bytes())}]}, first["state"], host)
                self.assertEqual(second["state"]["documents"]["sample.py"]["version"], 2)
                self.assertTrue(any(item.get("method") == "textDocument/didChange" for item in host.sent))
                path.unlink()
                third = run(node, "workspace_write", {"repository": str(repository), "call_id": "3",
                    "tool": "apply_patch", "outcome": "success", "status": "observed",
                    "changes": [{"path": "sample.py", "before": second["state"]["documents"]["sample.py"]["sha256"],
                                 "after": None}]}, second["state"], host)
                self.assertEqual(third["state"]["documents"], {})
                self.assertTrue(any(item.get("method") == "textDocument/didClose" for item in host.sent))
            finally:
                host.close()


if __name__ == "__main__":
    unittest.main()
