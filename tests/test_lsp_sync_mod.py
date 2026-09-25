import hashlib
import json
import os
from pathlib import Path
import select
import shutil
import subprocess
import tempfile
import time
import unittest


ROOT = Path(__file__).resolve().parents[1]
RUNNER = (ROOT / "runtime/omd/src/mods/runner.mjs").read_text()
SOURCE = (ROOT / "mods/first-party/omd_lsp_sync/index.ts").read_text()
CAPABILITIES = ["lifecycle", "process", "state", "tools", "workspace"]


def digest(data):
    return hashlib.sha256(data).hexdigest()


class Host:
    def __init__(self, repository, server):
        self.repository = repository
        self.server = server
        self.child = None
        self.buffer = b""
        self.sent = []

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
        operation = call["operation"]
        arguments = call["arguments"]
        if operation == "process.which":
            return {"found": [{"name": "pylsp", "path": self.server, "sha256": digest(Path(self.server).read_bytes())}]}
        if operation == "process.start":
            if self.child is not None:
                raise AssertionError("server started twice")
            self.child = subprocess.Popen([self.server], cwd=self.repository, stdin=subprocess.PIPE,
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
                   "hook_budget_ms": 1000}
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


class LspSyncModTest(unittest.TestCase):
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
