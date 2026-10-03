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
MANIFEST = json.loads((ROOT / "mods/first-party/omd_lsp_sync/mod.json").read_text())
CAPABILITIES = MANIFEST["capabilities"]
HOST = (ROOT / "runtime/omd/src/mods.rs").read_text()


def table(name):
    return re.search(rf"pub const {name}: &\[[^\]]*\] = &\[(.*?)\];", HOST, re.S).group(1)


CURRENT_SURFACE = {
    "events": dict(re.findall(r'\("([a-z_]+)", "([a-z_.]+)"\)', table("MOD_EVENTS"))),
    "replacements": re.findall(r'"([a-z_]+)"', table("MOD_REPLACEMENT_POINTS")),
    "middleware": re.findall(r'"([a-z_]+)"', table("MOD_MIDDLEWARE_EVENTS")),
    "state": "store",
    "contracts": "contracts",
}


def digest(data):
    return hashlib.sha256(data).hexdigest()


class HostFailure(Exception):
    pass


class Host:
    def __init__(self, repository, server):
        self.repository = repository
        self.server = server
        self.child = None
        self.buffer = b""
        self.sent = []
        self.operations = []
        self.store = {}
        self.backups = {}
        self.fail_sync_once = False
        self.fail_open_once = None
        self.start_error = None
        self.thread_id = "thread-a"
        self.published = []

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
            remaining = max(0, deadline - time.monotonic())
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
        if operation == "store.get":
            return self.store.get(arguments["key"])
        if operation == "store.put":
            current = self.store.get(arguments["key"])
            if (current["revision"] if current else None) != arguments["expected_revision"]:
                raise AssertionError("store revision mismatch")
            revision = (current["revision"] if current else 0) + 1
            self.store[arguments["key"]] = {"revision": revision, "value": arguments["value"], "provenance": {"thread_id": self.thread_id}}
            return {"revision": revision}
        if operation == "process.which":
            return {"found": [{"name": "pylsp", "path": self.server, "sha256": digest(Path(self.server).read_bytes())}] if self.server else []}
        if operation == "process.start":
            if self.start_error:
                raise HostFailure(self.start_error)
            if self.child is not None:
                raise HostFailure("process_session_limit_or_duplicate: python")
            self.child = subprocess.Popen([sys.executable, self.server] if self.server.endswith(".py") else [self.server], cwd=self.repository, stdin=subprocess.PIPE,
                                          stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            return {"session": "python", "running": True}
        if operation == "process.status":
            if self.child is None or self.child.poll() is not None:
                raise AssertionError("server is unavailable")
            return {"session": "python", "running": True, "idle_ms": 0}
        if operation == "process.exchange":
            if self.fail_open_once and any(message.get("method") == "textDocument/didOpen" for message in arguments.get("send", [])):
                error, self.fail_open_once = self.fail_open_once, None
                raise HostFailure(error)
            if self.fail_sync_once and any(message.get("method") == "textDocument/didChange" for message in arguments.get("send", [])):
                self.fail_sync_once = False
                raise HostFailure("synthetic_sync_failure")
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
        if operation == "workspace.stat":
            files = {}
            for name in arguments["paths"]:
                path = self.repository / name
                files[name] = {"kind": "file", "size": path.stat().st_size, "mtime_ms": 0, "sha256": digest(path.read_bytes())} if path.exists() else None
            return {"files": files}
        if operation == "workspace.read":
            files = {}
            for name in arguments["paths"]:
                path = self.repository / name
                data = path.read_bytes() if path.exists() else None
                files[name] = {"text": data.decode(), "sha256": digest(data)} if data is not None else None
            return {"files": files}
        if operation == "workspace.backup":
            files = {}
            for name, expected in arguments["expected"].items():
                path = self.repository / name
                data = path.read_bytes() if path.exists() else None
                if (digest(data) if data is not None else None) != expected:
                    raise HostFailure("stale_backup_input")
                files[name] = data
            reference = digest(json.dumps({name: data.hex() if data is not None else None for name, data in files.items()}, sort_keys=True).encode())
            self.backups[reference] = files
            return {"backup": {"reference": reference, "sha256": reference}}
        if operation == "workspace.transaction":
            if set(arguments["expected"]) != set(arguments["writes"]):
                raise HostFailure("transaction_scope_invalid")
            for name, expected in arguments["expected"].items():
                data = (self.repository / name).read_bytes()
                if digest(data) != expected:
                    raise HostFailure("stale_transaction_input")
            for name, value in arguments["writes"].items():
                (self.repository / name).write_text(value)
            return {"files": {name: digest((self.repository / name).read_bytes()) for name in arguments["writes"]}, "backup": None}
        if operation == "workspace.restore":
            files = self.backups[arguments["backup"]["reference"]]
            if set(files) != set(arguments["expected"]):
                raise HostFailure("restore_scope_invalid")
            for name, expected in arguments["expected"].items():
                path = self.repository / name
                data = path.read_bytes() if path.exists() else None
                if (digest(data) if data is not None else None) != expected:
                    raise HostFailure("restore_conflict")
            for name, data in files.items():
                path = self.repository / name
                if data is None:
                    path.unlink(missing_ok=True)
                else:
                    path.write_bytes(data)
            return {"files": {name: digest(data) if data is not None else None for name, data in files.items()}}
        if operation == "terminal.prompt":
            return {"status": "accepted"}
        if operation == "events.publish":
            self.published.append(arguments)
            return {"delivered": 1, "dropped": 0}
        if operation == "exec.run":
            result = subprocess.run([arguments["program"], *arguments.get("argv", [])], cwd=self.repository, capture_output=True, text=True)
            return {"exit_code": result.returncode, "stdout": result.stdout, "stderr": result.stderr, "stdout_sha256": digest(result.stdout.encode())}
        raise AssertionError(f"unexpected host operation {operation}")


def run(node, event, payload, state, host, name=None):
    receipts = []
    for _ in range(36):
        request = {"source": SOURCE, "filename": "omd_lsp_sync/index.ts", "api": MANIFEST["api"], "capabilities": CAPABILITIES,
                   "state": state, "settings": {}, "event": event, "name": name, "payload": payload, "receipts": receipts,
                   "hook_budget_ms": 1000, "surface": CURRENT_SURFACE}
        result = subprocess.run([node, "--no-warnings", "--experimental-vm-modules", "--input-type=module",
                                 "--eval", RUNNER], input=json.dumps(request), text=True, capture_output=True,
                                timeout=8, check=True)
        output = json.loads(result.stdout)
        if "error" in output:
            raise AssertionError(output["error"])
        if output.get("host_call") is None:
            return output
        call = output["host_call"]
        try:
            receipts.append({"call": call, "value": host.call(call)})
        except HostFailure as error:
            receipts.append({"call": call, "error": str(error)})
    raise AssertionError("mod callback did not complete")


FAKE_SERVER = r"""
import json, sys, time
action_requests = 0
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
        send({"jsonrpc": "2.0", "id": message["id"], "result": {"capabilities": {"definitionProvider": True, "referencesProvider": True, "codeActionProvider": True, "renameProvider": {"prepareProvider": True}, "workspace": {"fileOperations": {"willRename": {}}}}}})
    elif method == "textDocument/didOpen":
        document = message["params"]["textDocument"]
        send({"jsonrpc": "2.0", "method": "textDocument/publishDiagnostics", "params": {"uri": document["uri"], "version": document["version"], "diagnostics": [{}]}})
    elif method == "workspace/willRenameFiles":
        old = message["params"]["files"][0]["oldUri"]
        user = old.rsplit("/", 1)[0] + "/user.py"
        send({"jsonrpc": "2.0", "method": "window/logMessage", "params": {"type": 4, "message": "renaming"}})
        time.sleep(0.01)
        send({"jsonrpc": "2.0", "id": message["id"], "result": {"changes": {user: [{"range": {"start": {"line": 0, "character": 5}, "end": {"line": 0, "character": 8}}, "newText": "new"}]}}})
    elif method in ("textDocument/definition", "textDocument/references"):
        source = message["params"]["textDocument"]["uri"]
        target = source.rsplit("/", 1)[0] + ("/" + "x" * 4000 + ".py" if source.endswith("/longtarget.py") else "/old.py")
        send({"jsonrpc": "2.0", "id": message["id"], "result": [{"uri": target, "range": {"start": {"line": 0, "character": 0}, "end": {"line": 0, "character": 5}}}]})
    elif method == "textDocument/prepareRename":
        send({"jsonrpc": "2.0", "id": message["id"], "result": {"range": {"start": {"line": 0, "character": 0}, "end": {"line": 0, "character": 5}}}})
    elif method == "textDocument/rename":
        source = message["params"]["textDocument"]["uri"]
        user = source.rsplit("/", 1)[0] + "/user.py"
        if message["params"]["newName"] == "resource":
            send({"jsonrpc": "2.0", "id": message["id"], "result": {"documentChanges": [{"kind": "rename", "oldUri": source, "newUri": user}]}})
            continue
        version = 9 if message["params"]["newName"] == "stale" else 1
        send({"jsonrpc": "2.0", "id": message["id"], "result": {"documentChanges": [
            {"textDocument": {"uri": source, "version": version}, "edits": [{"range": {"start": {"line": 0, "character": 0}, "end": {"line": 0, "character": 5}}, "newText": message["params"]["newName"]}]},
            {"textDocument": {"uri": user, "version": 1}, "edits": [{"range": {"start": {"line": 0, "character": 16}, "end": {"line": 0, "character": 21}}, "newText": message["params"]["newName"]}]}
        ]}})
    elif method == "textDocument/codeAction":
        source = message["params"]["textDocument"]["uri"]
        if message["params"]["textDocument"]["uri"].endswith("/longkind.py"):
            send({"jsonrpc": "2.0", "id": message["id"], "result": [{"title": "Oversized", "kind": "x" * 70000}]})
        elif message["params"]["textDocument"]["uri"].endswith("/longtitle.py"):
            send({"jsonrpc": "2.0", "id": message["id"], "result": [{"title": "é" * 512, "kind": "quickfix"} for _ in range(32)]})
        elif source.endswith("/deferred.py"):
            send({"jsonrpc": "2.0", "id": message["id"], "result": [{"title": "Deferred", "kind": "quickfix", "data": {"token": "fixture"}}]})
        else:
            user = source.rsplit("/", 1)[0] + "/user.py"
            action_requests += 1
            replacement = "other" if source.endswith("/unstable.py") and action_requests > 1 else "new"
            edit = {"changes": {user: [{"range": {"start": {"line": 0, "character": 5}, "end": {"line": 0, "character": 8}}, "newText": replacement}]}}
            send({"jsonrpc": "2.0", "id": message["id"], "result": [{"title": "Update import", "kind": "quickfix", "edit": edit}, {"title": "Run tool", "command": "unsafe.command"}]})
"""


DIAGNOSTIC_SERVER = r"""
import json, sys, time
documents = {}
def send(message):
    data = json.dumps(message).encode()
    sys.stdout.buffer.write(b"Content-Length: %d\r\n\r\n" % len(data) + data)
    sys.stdout.buffer.flush()
def publish():
    exported = any("value" in text for uri, (_, text) in documents.items() if uri.endswith("/old.py"))
    for uri, (version, text) in documents.items():
        errors = [(index, line.split("ERR ", 1)[1]) for index, line in enumerate(text.splitlines()) if "ERR " in line]
        if uri.endswith("/user.py") and not exported:
            errors.append((0, "value is undefined"))
        diagnostics = [{"range": {"start": {"line": line, "character": 0}, "end": {"line": line, "character": 1}}, "severity": 1, "message": error} for line, error in errors]
        send({"jsonrpc": "2.0", "method": "textDocument/publishDiagnostics", "params": {"uri": uri, "version": version, "diagnostics": diagnostics + [{"severity": 2, "message": "style"}]}})
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
    method, params = message.get("method"), message.get("params", {})
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": message["id"], "result": {"capabilities": {}}})
    elif method == "textDocument/didOpen":
        documents[params["textDocument"]["uri"]] = (params["textDocument"]["version"], params["textDocument"]["text"])
        time.sleep(0.3)
        publish()
    elif method == "textDocument/didChange":
        documents[params["textDocument"]["uri"]] = (params["textDocument"]["version"], params["contentChanges"][0]["text"])
        publish()
"""


VIEW_SERVER = r"""
import json, sys
def send(message):
    data = json.dumps(message).encode()
    sys.stdout.buffer.write(b"Content-Length: %d\r\n\r\n" % len(data) + data)
    sys.stdout.buffer.flush()
def span(line, start, end):
    return {"start": {"line": line, "character": start}, "end": {"line": line, "character": end}}
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
    method, params = message.get("method"), message.get("params", {})
    reply = lambda result: send({"jsonrpc": "2.0", "id": message["id"], "result": result})
    if method == "initialize":
        reply({"capabilities": {"hoverProvider": True, "documentSymbolProvider": True, "documentFormattingProvider": True, "codeActionProvider": True}})
    elif method == "textDocument/didOpen":
        document = params["textDocument"]
        send({"jsonrpc": "2.0", "method": "textDocument/publishDiagnostics", "params": {"uri": document["uri"], "version": document["version"],
              "diagnostics": [{"range": span(2, 4, 8), "severity": 1, "message": "size is unused"}]}})
    elif method == "textDocument/hover":
        reply({"contents": [{"language": "python", "value": "value: int"}, "Module constant"]})
    elif method == "textDocument/documentSymbol":
        reply([{"name": "Box", "kind": 5, "range": span(1, 0, 9), "selectionRange": span(1, 6, 9), "children": [{"name": "size", "kind": 8, "range": span(2, 4, 12), "selectionRange": span(2, 4, 8)}]}])
    elif method == "textDocument/formatting":
        reply([{"range": span(0, 0, 7), "newText": "value = 1"}])
    elif method == "textDocument/codeAction":
        uri = params["textDocument"]["uri"]
        reply([{"title": "Rename Box", "kind": "quickfix", "edit": {"changes": {uri: [{"range": span(1, 6, 9), "newText": "Crate"}]}}}])
"""


class LspSyncModTest(unittest.TestCase):
    def test_lsp_service_answers_through_the_running_server_and_confirms_edits(self):
        node = os.environ.get("OMD_TEST_NODE") or shutil.which("node")
        if not node or subprocess.check_output([node, "--version"], text=True).strip() != "v24.18.0":
            self.skipTest("pinned Node 24.18.0 required")
        with tempfile.TemporaryDirectory() as directory:
            repository = Path(directory).resolve() / "repo"
            repository.mkdir()
            server = Path(directory).resolve() / "view_server.py"
            server.write_text(VIEW_SERVER)
            (repository / "box.py").write_text("value=1\nclass Box:\n    size = 2\n")
            host = Host(repository, str(server))
            state = None
            try:
                def query(**request):
                    nonlocal state
                    answered = run(node, "service", request, state, host, "omd.lsp.query")
                    state = answered["state"]
                    return answered["value"]
                self.assertEqual(query(op="hover", path="box.py", line=1, character=1)["text"], "```python\nvalue: int\n```\n\nModule constant")
                symbols = query(op="symbols", path="box.py")["items"]
                self.assertEqual(symbols, [{"label": "class Box · 2", "value": "box.py:2"}, {"label": "  field size · 3", "value": "box.py:3"}])
                self.assertEqual(query(op="diagnostics", path="box.py")["items"], [{"label": "box.py:3:5 size is unused", "value": "box.py:3"}])
                self.assertEqual(query(op="format", path="box.py")["text"], "Formatted box.py")
                self.assertEqual((repository / "box.py").read_text(), "value = 1\nclass Box:\n    size = 2\n")
                actions = query(op="actions", path="box.py", line=2, character=1)
                self.assertEqual((actions["action"], actions["items"]), ("apply", [{"label": "Rename Box", "value": "0:box.py"}]))
                self.assertEqual(query(op="apply", path="box.py", index=0)["text"], "Applied: Rename Box")
                self.assertEqual((repository / "box.py").read_text(), "value = 1\nclass Crate:\n    size = 2\n")
                self.assertEqual(query(op="hover", path="../box.py", line=1, character=1)["status"], "error")
                self.assertEqual(host.operations.count("process.start"), 1)
            finally:
                host.close()

    def test_post_edit_feedback_reports_only_introduced_and_resolved_errors(self):
        node = os.environ.get("OMD_TEST_NODE") or shutil.which("node")
        if not node or subprocess.check_output([node, "--version"], text=True).strip() != "v24.18.0":
            self.skipTest("pinned Node 24.18.0 required")
        with tempfile.TemporaryDirectory() as directory:
            repository = Path(directory).resolve() / "repo"
            repository.mkdir()
            server = Path(directory).resolve() / "diagnostic_server.py"
            server.write_text(DIAGNOSTIC_SERVER)
            (repository / "old.py").write_text("value = 1\n")
            (repository / "user.py").write_text("from old import value\n")
            host = Host(repository, str(server))
            output = lambda arguments: {"call_id": "c", "tool": "apply_patch", "arguments": arguments, "success": True, "text": "Done", "tail": None, "bytes": 4, "original": None}
            try:
                state = run(node, "workspace_change", {"repository": str(repository), "source": "tool", "call_id": "1", "status": "observed",
                    "changes": [{"path": name, "before": None, "after": digest((repository / name).read_bytes())} for name in ("old.py", "user.py")]}, None, host)["state"]
                time.sleep(1)
                (repository / "old.py").write_text("val = 1\nERR broken syntax\n")
                broken = run(node, "tool_output", output("*** Update File: old.py"), state, host)
                self.assertEqual(broken["value"]["append"], "Language-server errors after this call:\nold.py: 1 new, 0 resolved\n  + 2:1 broken syntax\nuser.py (dependent): 1 new, 0 resolved\n  + 1:1 value is undefined")
                (repository / "old.py").write_text("value = 1\n")
                fixed = run(node, "tool_output", output(f"{repository}/old.py"), broken["state"], host)
                self.assertIn("old.py: 0 new, 1 resolved\n  - 2:1 broken syntax", fixed["value"]["append"])
                self.assertIn("user.py (dependent): 0 new, 1 resolved", fixed["value"]["append"])
                self.assertIsNone(run(node, "tool_output", output("cat old.py"), fixed["state"], host)["value"])
                (repository / "new.py").write_text("ERR preexisting\n")
                read = run(node, "tool_output", {**output({"cmd": "sed -n 1p new.py"}), "tool": "exec_command"}, fixed["state"], host)
                self.assertEqual(read["value"]["append"], "Language-server errors after this call:\nnew.py: 1 existing (v1)\n  1:1 preexisting")
                self.assertEqual(host.published[-1]["data"][0]["errors"], ["new.py:1:1 preexisting"])
                opened = run(node, "tool_output", output("*** Add File: new.py"), fixed["state"], host)
                self.assertIsNone(opened["value"])
                self.assertIn("new.py", opened["state"]["servers"]["python"]["documents"])
                (repository / "new.py").write_text("ERR preexisting\nERR added\n")
                (repository / "old.py").write_text("value = 1\nERR also\n")
                edited = run(node, "tool_output", output(None), opened["state"], host)
                self.assertEqual(edited["value"]["append"], "Language-server errors after this call:\nold.py: 1 new, 0 resolved\n  + 2:1 also\nnew.py: 1 new, 0 resolved\n  + 2:1 added")
                self.assertEqual(host.operations.count("process.start"), 1)
            finally:
                host.close()

    def test_explicit_reads_start_only_the_viewed_server_set_the_edit_baseline_and_never_write(self):
        node = os.environ.get("OMD_TEST_NODE") or shutil.which("node")
        if not node or subprocess.check_output([node, "--version"], text=True).strip() != "v24.18.0":
            self.skipTest("pinned Node 24.18.0 required")
        with tempfile.TemporaryDirectory() as directory:
            repository = Path(directory).resolve() / "repo"
            repository.mkdir()
            server = Path(directory).resolve() / "diagnostic_server.py"
            server.write_text(DIAGNOSTIC_SERVER)
            (repository / "old.py").write_text("value = 1\nERR before\n")
            read = lambda command: {"call_id": "c", "tool": "exec_command", "arguments": {"cmd": command}, "success": True, "text": "", "tail": None, "bytes": 0, "original": None}
            denied = Host(repository, str(server))
            denied.start_error = "managed_process_requires_native_sandbox"
            for host, unavailable in ((Host(repository, str(server)), None), (Host(repository, None), "python_server_absent"), (denied, denied.start_error)):
                host.store["lsp.observed_repository"] = {"revision": 1, "value": {"repository": str(repository)}, "provenance": {"thread_id": "thread-a"}}
                try:
                    self.assertIsNone(run(node, "tool_output", read("rg -n value old.py"), None, host)["value"])
                    self.assertIsNone(run(node, "tool_output", read("cat README.md"), None, host)["value"])
                    self.assertNotIn("process.which", host.operations)
                    first = run(node, "tool_output", read("cat old.py"), None, host)
                    self.assertFalse({"workspace.transaction", "workspace.backup", "workspace.restore"} & set(host.operations))
                    if unavailable:
                        self.assertEqual(first["value"]["append"], f"Language-server errors after this call:\npython language server unavailable: {unavailable}")
                        self.assertIsNone(run(node, "tool_output", read("cat old.py"), first["state"], host)["value"])
                        continue
                    self.assertEqual(first["value"]["append"], "Language-server errors after this call:\nold.py: 1 existing (v1)\n  2:1 before")
                    self.assertIsNone(run(node, "tool_output", read("nl -ba old.py"), first["state"], host)["value"])
                    (repository / "old.py").write_text("value = 1\nERR before\nERR after\n")
                    edited = run(node, "tool_output", {**read("*** Update File: old.py"), "tool": "apply_patch"}, first["state"], host)
                    self.assertEqual(edited["value"]["append"], "Language-server errors after this call:\nold.py: 1 new, 0 resolved\n  + 3:1 after")
                    self.assertEqual(host.operations.count("process.start"), 1)
                finally:
                    host.close()

    def test_cancelled_reads_recover_without_orphaned_servers(self):
        node = os.environ.get("OMD_TEST_NODE") or shutil.which("node")
        if not node or subprocess.check_output([node, "--version"], text=True).strip() != "v24.18.0":
            self.skipTest("pinned Node 24.18.0 required")
        with tempfile.TemporaryDirectory() as directory:
            repository = Path(directory).resolve() / "repo"
            repository.mkdir()
            server = Path(directory).resolve() / "diagnostic_server.py"
            server.write_text(DIAGNOSTIC_SERVER)
            (repository / "old.py").write_text("ERR before\n")
            read = {"call_id": "c", "tool": "exec_command", "arguments": {"cmd": "cat old.py"}, "success": True, "text": "", "tail": None, "bytes": 0, "original": None}
            reported = "Language-server errors after this call:\nold.py: 1 existing (v1)\n  1:1 before"
            host = Host(repository, str(server))
            host.store["lsp.observed_repository"] = {"revision": 1, "value": {"repository": str(repository)}, "provenance": {"thread_id": "thread-a"}}
            try:
                host.fail_open_once = "process_cancelled"
                cancelled = run(node, "tool_output", read, None, host)
                self.assertIsNone(cancelled["value"])
                self.assertEqual(cancelled["state"]["servers"]["python"]["status"], "stale")
                self.assertFalse(cancelled["state"]["servers"]["python"]["running"])
                self.assertIsNone(host.child)
                self.assertEqual(run(node, "tool_output", read, cancelled["state"], host)["value"]["append"], reported)
                self.assertEqual(run(node, "tool_output", read, cancelled["state"], host)["value"]["append"], reported)
                self.assertEqual(host.operations.count("process.start"), 4)
            finally:
                host.close()

    def test_symbol_rename_and_code_action_apply_exact_text_scopes(self):
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
                expected = {name: digest((repository / name).read_bytes()) for name in ("old.py", "user.py")}
                opened = run(node, "workspace_change", {"repository": str(repository), "source": "tool", "call_id": "1", "status": "observed",
                    "changes": [{"path": name, "before": None, "after": sha} for name, sha in expected.items()]}, None, host)
                base = {"path": "old.py", "source_sha256": expected["old.py"]}
                refused = run(node, "tool", {**base, "line": 0, "character": 1, "new_name": "stale", "scope": ["old.py", "user.py"], "expected": expected}, opened["state"], host, "rename_symbol")
                self.assertEqual(refused["value"]["reason"], "server_edit_stale")
                resource = run(node, "tool", {**base, "line": 0, "character": 1, "new_name": "resource", "scope": ["old.py", "user.py"], "expected": expected}, opened["state"], host, "rename_symbol")
                self.assertEqual(resource["value"]["reason"], "server_edit_invalid")
                narrow = run(node, "tool", {**base, "line": 0, "character": 1, "new_name": "renamed", "scope": ["old.py"], "expected": {"old.py": expected["old.py"]}}, opened["state"], host, "rename_symbol")
                self.assertEqual(narrow["value"]["reason"], "server_edit_scope_mismatch")
                self.assertNotIn("workspace.transaction", host.operations)
                renamed = run(node, "tool", {**base, "line": 0, "character": 1, "new_name": "renamed", "scope": ["old.py", "user.py"], "expected": expected}, opened["state"], host, "rename_symbol")
                self.assertEqual(renamed["value"]["status"], "applied", renamed["value"])
                self.assertEqual((repository / "old.py").read_text(), "renamed = 1\n")
                self.assertEqual((repository / "user.py").read_text(), "from old import renamed\n")
                self.assertEqual(renamed["state"]["servers"]["python"]["documents"]["old.py"]["version"], 2)
                self.assertIn("workspace.backup", host.operations)
                self.assertIn("workspace.transaction", host.operations)
                self.assertNotIn("workspace.restore", host.operations)
            finally:
                host.close()
        with tempfile.TemporaryDirectory() as directory:
            repository = Path(directory).resolve() / "repo"
            repository.mkdir()
            server = Path(directory).resolve() / "fake_server.py"
            server.write_text(FAKE_SERVER)
            (repository / "old.py").write_text("value = 1\n")
            (repository / "user.py").write_text("from old import value\n")
            host = Host(repository, str(server))
            try:
                expected = {name: digest((repository / name).read_bytes()) for name in ("old.py", "user.py")}
                opened = run(node, "workspace_change", {"repository": str(repository), "source": "tool", "call_id": "1", "status": "observed",
                    "changes": [{"path": name, "before": None, "after": sha} for name, sha in expected.items()]}, None, host)
                base = {"path": "old.py", "source_sha256": expected["old.py"], "range": {"start": {"line": 0, "character": 0}, "end": {"line": 0, "character": 5}}, "scope": ["user.py"], "expected": {"user.py": expected["user.py"]}}
                preview = run(node, "tool", {"path": base["path"], "range": base["range"]}, opened["state"], host, "code_actions")
                self.assertEqual(preview["value"]["application"], "exact_scope_text_edits_only")
                command = run(node, "tool", {**base, "action_index": 1, "title": "Run tool"}, preview["state"], host, "apply_code_action")
                self.assertEqual(command["value"]["reason"], "server_code_action_unsupported")
                applied = run(node, "tool", {**base, "action_index": 0, "title": "Update import"}, command["state"], host, "apply_code_action")
                self.assertEqual(applied["value"]["status"], "applied", applied["value"])
                self.assertEqual((repository / "user.py").read_text(), "from new import value\n")
                self.assertNotIn("workspace.restore", host.operations)
            finally:
                host.close()

    def test_failed_semantic_sync_restores_exact_backup(self):
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
                expected = {name: digest((repository / name).read_bytes()) for name in ("old.py", "user.py")}
                opened = run(node, "workspace_change", {"repository": str(repository), "source": "tool", "call_id": "1", "status": "observed",
                    "changes": [{"path": name, "before": None, "after": sha} for name, sha in expected.items()]}, None, host)
                host.fail_sync_once = True
                failed = run(node, "tool", {"path": "old.py", "source_sha256": expected["old.py"], "line": 0, "character": 1,
                    "new_name": "renamed", "scope": ["old.py", "user.py"], "expected": expected}, opened["state"], host, "rename_symbol")
                self.assertEqual(failed["value"]["reason"], "sync_failed_rolled_back")
                self.assertEqual({name: digest((repository / name).read_bytes()) for name in expected}, expected)
                self.assertIn("workspace.transaction", host.operations)
                self.assertIn("workspace.restore", host.operations)
                self.assertFalse(failed["state"]["servers"]["python"]["running"])
            finally:
                host.close()

    def test_code_action_apply_requires_exact_preview_and_rejects_deferred_edit(self):
        node = os.environ.get("OMD_TEST_NODE") or shutil.which("node")
        if not node or subprocess.check_output([node, "--version"], text=True).strip() != "v24.18.0":
            self.skipTest("pinned Node 24.18.0 required")
        with tempfile.TemporaryDirectory() as directory:
            repository = Path(directory).resolve() / "repo"
            repository.mkdir()
            server = Path(directory).resolve() / "fake_server.py"
            server.write_text(FAKE_SERVER)
            for name, content in {"unstable.py": "value = 1\n", "deferred.py": "value = 1\n", "user.py": "from old import value\n"}.items():
                (repository / name).write_text(content)
            host = Host(repository, str(server))
            try:
                expected = {name: digest((repository / name).read_bytes()) for name in ("unstable.py", "deferred.py", "user.py")}
                opened = run(node, "workspace_change", {"repository": str(repository), "source": "tool", "call_id": "1", "status": "observed",
                    "changes": [{"path": name, "before": None, "after": sha} for name, sha in expected.items()]}, None, host)
                area = {"start": {"line": 0, "character": 0}, "end": {"line": 0, "character": 5}}
                preview = run(node, "tool", {"path": "unstable.py", "range": area}, opened["state"], host, "code_actions")
                self.assertEqual(preview["value"]["actions"][0]["title"], "Update import")
                host.thread_id = "thread-b"
                foreign = run(node, "tool", {"path": "unstable.py", "source_sha256": expected["unstable.py"], "range": area, "action_index": 0,
                    "title": "Update import", "scope": ["user.py"], "expected": {"user.py": expected["user.py"]}}, preview["state"], host, "apply_code_action")
                self.assertEqual(foreign["value"]["reason"], "code_action_preview_thread_mismatch")
                host.thread_id = "thread-a"
                changed = run(node, "tool", {"path": "unstable.py", "source_sha256": expected["unstable.py"], "range": area, "action_index": 0,
                    "title": "Update import", "scope": ["user.py"], "expected": {"user.py": expected["user.py"]}}, foreign["state"], host, "apply_code_action")
                self.assertEqual(changed["value"]["reason"], "code_action_preview_stale")
                deferred_preview = run(node, "tool", {"path": "deferred.py", "range": area}, changed["state"], host, "code_actions")
                deferred = run(node, "tool", {"path": "deferred.py", "source_sha256": expected["deferred.py"], "range": area, "action_index": 0,
                    "title": "Deferred", "scope": ["user.py"], "expected": {"user.py": expected["user.py"]}}, deferred_preview["state"], host, "apply_code_action")
                self.assertEqual(deferred["value"]["reason"], "server_code_action_deferred_unsupported")
                self.assertNotIn("workspace.backup", host.operations)
                self.assertNotIn("workspace.transaction", host.operations)
                self.assertEqual((repository / "user.py").read_text(), "from old import value\n")
            finally:
                host.close()

    def test_semantic_reads_are_scoped_and_actions_are_discovery_only(self):
        node = os.environ.get("OMD_TEST_NODE") or shutil.which("node")
        if not node or subprocess.check_output([node, "--version"], text=True).strip() != "v24.18.0":
            self.skipTest("pinned Node 24.18.0 required")
        with tempfile.TemporaryDirectory() as directory:
            repository = Path(directory).resolve() / "repo"
            repository.mkdir()
            server = Path(directory).resolve() / "fake_server.py"
            server.write_text(FAKE_SERVER)
            (repository / "old.py").write_text("value = 1\n")
            host = Host(repository, str(server))
            try:
                opened = run(node, "workspace_change", {"repository": str(repository), "source": "tool", "call_id": "1",
                    "status": "observed", "changes": [{"path": "old.py", "before": None,
                    "after": digest((repository / "old.py").read_bytes())}]}, None, host)
                state = opened["state"]
                definition = run(node, "tool", {"path": "old.py", "line": 0, "character": 1}, state, host, "definition")
                self.assertEqual(definition["value"]["status"], "ready")
                self.assertEqual(definition["value"]["locations"][0]["path"], "old.py")
                self.assertEqual(definition["value"]["locations"][0]["sha256"], digest((repository / "old.py").read_bytes()))
                references = run(node, "tool", {"path": "old.py", "line": 0, "character": 1, "include_declaration": True}, definition["state"], host, "references")
                self.assertEqual(references["value"]["status"], "ready")
                self.assertTrue(any(item.get("method") == "textDocument/references" and item["params"]["context"]["includeDeclaration"] for item in host.sent))
                actions = run(node, "tool", {"path": "old.py", "range": {"start": {"line": 0, "character": 0}, "end": {"line": 0, "character": 5}}}, references["state"], host, "code_actions")
                self.assertEqual(actions["value"]["application"], "exact_scope_text_edits_only")
                self.assertEqual([item["has_command"] for item in actions["value"]["actions"]], [False, True])
                no_actions = json.loads(json.dumps(actions["state"]))
                no_actions["servers"]["python"]["capabilities"]["codeActionProvider"] = False
                unsupported = run(node, "tool", {"path": "old.py", "range": {"start": {"line": 0, "character": 0}, "end": {"line": 0, "character": 5}}}, no_actions, host, "code_actions")
                self.assertEqual(unsupported["value"]["reason"], "server_code_actions_unsupported")
                invalid = run(node, "tool", {"path": "../old.py", "line": 0, "character": 1}, actions["state"], host, "definition")
                self.assertEqual(invalid["value"]["reason"], "unsupported_or_invalid_path")
                (repository / "old.py").write_text("x\n")
                stale = run(node, "tool", {"path": "old.py", "line": 0, "character": 0}, actions["state"], host, "definition")
                self.assertEqual(stale["value"]["reason"], "server_location_stale_or_invalid")
                (repository / "longkind.py").write_text("value = 1\n")
                added = run(node, "workspace_change", {"repository": str(repository), "source": "tool", "call_id": "2",
                    "status": "observed", "changes": [{"path": "longkind.py", "before": None,
                    "after": digest((repository / "longkind.py").read_bytes())}]}, stale["state"], host)
                oversized = run(node, "tool", {"path": "longkind.py", "range": {"start": {"line": 0, "character": 0}, "end": {"line": 0, "character": 5}}}, added["state"], host, "code_actions")
                self.assertEqual(oversized["value"]["reason"], "server_code_actions_invalid")
                (repository / "longtitle.py").write_text("value = 1\n")
                title_added = run(node, "workspace_change", {"repository": str(repository), "source": "tool", "call_id": "3",
                    "status": "observed", "changes": [{"path": "longtitle.py", "before": None,
                    "after": digest((repository / "longtitle.py").read_bytes())}]}, oversized["state"], host)
                title_overflow = run(node, "tool", {"path": "longtitle.py", "range": {"start": {"line": 0, "character": 0}, "end": {"line": 0, "character": 5}}}, title_added["state"], host, "code_actions")
                self.assertEqual(title_overflow["value"]["reason"], "server_code_actions_output_limit")
                (repository / "longtarget.py").write_text("value = 1\n")
                target_added = run(node, "workspace_change", {"repository": str(repository), "source": "tool", "call_id": "4",
                    "status": "observed", "changes": [{"path": "longtarget.py", "before": None,
                    "after": digest((repository / "longtarget.py").read_bytes())}]}, title_overflow["state"], host)
                target_overflow = run(node, "tool", {"path": "longtarget.py", "line": 0, "character": 1}, target_added["state"], host, "definition")
                self.assertEqual(target_overflow["value"]["reason"], "server_location_invalid")
                self.assertFalse(any(item.get("method") == "workspace/applyEdit" for item in host.sent))
            finally:
                host.close()

    def test_semantic_request_rejects_untracked_target_and_foreign_store(self):
        node = os.environ.get("OMD_TEST_NODE") or shutil.which("node")
        if not node or subprocess.check_output([node, "--version"], text=True).strip() != "v24.18.0":
            self.skipTest("pinned Node 24.18.0 required")
        with tempfile.TemporaryDirectory() as directory:
            repository = Path(directory).resolve() / "repo-a"
            other = Path(directory).resolve() / "repo-b"
            repository.mkdir()
            other.mkdir()
            server = Path(directory).resolve() / "fake_server.py"
            server.write_text(FAKE_SERVER)
            (repository / "old.py").write_text("value = 1\n")
            (repository / "user.py").write_text("from old import value\n")
            host = Host(repository, str(server))
            foreign = Host(other, str(server))
            try:
                opened = run(node, "workspace_change", {"repository": str(repository), "source": "tool", "call_id": "1",
                    "status": "observed", "changes": [{"path": "user.py", "before": None,
                    "after": digest((repository / "user.py").read_bytes())}]}, None, host)
                location = run(node, "tool", {"path": "user.py", "line": 0, "character": 5}, opened["state"], host, "definition")
                self.assertEqual(location["value"]["reason"], "server_location_unobserved_or_stale")
                foreign.store["lsp.observed_repository"] = {"revision": 1, "value": {"repository": str(other)}}
                bound = run(node, "tool", {"path": "user.py", "line": 0, "character": 5}, opened["state"], foreign, "definition")
                self.assertEqual(bound["value"]["reason"], "repository_binding_mismatch")
                self.assertNotIn("process.start", foreign.operations)
                self.assertNotIn("workspace.read", foreign.operations)
            finally:
                host.close()
                foreign.close()

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
                first = run(node, "workspace_change", {"repository": str(repository), "call_id": "1", "tool": "apply_patch",
                    "outcome": "success", "status": "observed", "changes": changes}, None, host)
                self.assertEqual(first["state"]["servers"]["python"]["status"], "synced")
                self.assertEqual(first["state"]["servers"]["python"]["diagnostics"]["old.py"]["count"], 1)
                self.assertIn({"jsonrpc": "2.0", "id": 1, "result": [None]}, host.sent)
                stops = host.operations.count("process.stop")
                idle = run(node, "idle", {"cause": "Completed"}, first["state"], host)
                self.assertTrue(idle["state"]["servers"]["python"]["running"])
                self.assertEqual(host.operations.count("process.stop"), stops)
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
                first = run(node, "workspace_change", {"repository": str(repository), "call_id": "1",
                    "tool": "apply_patch", "outcome": "success", "status": "observed",
                    "changes": [{"path": "sample.py", "before": None, "after": digest(path.read_bytes())}]}, None, host)
                self.assertEqual(first["state"]["servers"]["python"]["status"], "synced")
                self.assertTrue(any(item.get("method") == "textDocument/didOpen" for item in host.sent))
                path.write_text("value = 2\n")
                second = run(node, "workspace_change", {"repository": str(repository), "call_id": "2",
                    "tool": "apply_patch", "outcome": "success", "status": "observed",
                    "changes": [{"path": "sample.py", "before": first["state"]["servers"]["python"]["documents"]["sample.py"]["sha256"],
                                 "after": digest(path.read_bytes())}]}, first["state"], host)
                self.assertEqual(second["state"]["servers"]["python"]["documents"]["sample.py"]["version"], 2)
                self.assertTrue(any(item.get("method") == "textDocument/didChange" for item in host.sent))
                path.unlink()
                third = run(node, "workspace_change", {"repository": str(repository), "call_id": "3",
                    "tool": "apply_patch", "outcome": "success", "status": "observed",
                    "changes": [{"path": "sample.py", "before": second["state"]["servers"]["python"]["documents"]["sample.py"]["sha256"],
                                 "after": None}]}, second["state"], host)
                self.assertEqual(third["state"]["servers"]["python"]["documents"], {})
                self.assertTrue(any(item.get("method") == "textDocument/didClose" for item in host.sent))
            finally:
                host.close()


if __name__ == "__main__":
    unittest.main()
