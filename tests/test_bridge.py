import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request


ROOT = Path(__file__).resolve().parents[1]
VERSION = "1" * 64


def load_python_client():
    spec = importlib.util.spec_from_file_location("omd_bridge", ROOT / "bridge/python/omd_bridge.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.BridgeClient


class Host:
    def __init__(self, root, policy):
        self.root = root
        self.policy_path = root / "policy.json"
        self.policy_path.write_text(json.dumps(policy))
        digest = hashlib.sha256(self.policy_path.read_bytes()).hexdigest()
        environment = {**os.environ, "OMD_BRIDGE_POLICY": str(self.policy_path.resolve()), "OMD_BRIDGE_POLICY_SHA256": digest}
        self.process = subprocess.Popen(
            ["node", str(ROOT / "bridge/host.mjs")],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            env=environment,
        )
        self.connection_file = Path(policy["connection_file"])
        deadline = time.monotonic() + 5
        while not self.connection_file.is_file() and time.monotonic() < deadline:
            if self.process.poll() is not None:
                raise RuntimeError(self.process.stderr.read())
            time.sleep(0.02)
        self.connection = json.loads(self.connection_file.read_text())
        self.next_id = 1

    def mcp(self, method, params=None):
        request_id = self.next_id
        self.next_id += 1
        self.process.stdin.write(json.dumps({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params or {}}) + "\n")
        self.process.stdin.flush()
        while True:
            line = self.process.stdout.readline()
            if not line:
                raise RuntimeError(self.process.stderr.read())
            response = json.loads(line)
            if response.get("id") == request_id:
                return response["result"]

    def tool(self, arguments):
        result = self.mcp("tools/call", {"name": "omd_bridge", "arguments": arguments})
        if result.get("isError"):
            raise RuntimeError(result["content"][0]["text"])
        return json.loads(result["content"][0]["text"])

    def close(self):
        if self.process.poll() is None:
            self.process.stdin.close()
            self.process.wait(timeout=5)
        self.process.stdout.close()
        self.process.stderr.close()


def post(connection, route, body, origin=None):
    headers = {"Content-Type": "application/json"}
    if origin:
        headers["Origin"] = origin
    request = urllib.request.Request(connection["url"] + route, data=json.dumps(body).encode(), headers=headers, method="POST")
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.load(response)


class BridgeTests(unittest.TestCase):
    def policy(self, root):
        applications = []
        for adapter in ("browser", "node", "rust", "python", "java"):
            applications.append({
                "id": adapter,
                "adapter": adapter,
                "version_sha256": VERSION,
                "reproduction_id": "repro-1",
                "origins": ["http://127.0.0.1:3000"] if adapter == "browser" else [],
                "exposed_state": ["health", "large"],
            })
        return {
            "schema": 1,
            "task_id": "task-1",
            "repository_identity": "fixture",
            "connection_file": str((root / "connection.json").resolve()),
            "applications": applications,
            "limits": {"max_events": 3, "max_total_bytes": 4096, "max_event_bytes": 1024, "max_log_chars": 128, "max_pending_state": 2, "state_timeout_ms": 2000},
            "redact_keys": ["private_value"],
        }

    def registration(self, host, adapter, **extra):
        return {
            "token": host.connection["token"], "app_id": adapter, "adapter": adapter,
            "version_sha256": VERSION, "reproduction_id": "repro-1", "exposed_state": ["health"], **extra,
        }

    def test_authorization_version_redaction_bounds_state_and_teardown(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            host = Host(root, self.policy(root))
            try:
                self.assertEqual(stat.S_IMODE(host.connection_file.stat().st_mode), 0o600)
                initialized = host.mcp("initialize", {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "test", "version": "1"}})
                self.assertEqual(initialized["serverInfo"]["name"], "oh-my-diff-bridge")
                listed = host.mcp("tools/list")
                self.assertEqual([tool["name"] for tool in listed["tools"]], ["omd_bridge"])
                browser = post(host.connection, "/v1/register", self.registration(host, "browser"), "http://127.0.0.1:3000")
                with self.assertRaises(urllib.error.HTTPError) as unauthorized:
                    post(host.connection, "/v1/register", self.registration(host, "browser", token="invalid"), "http://127.0.0.1:3000")
                unauthorized.exception.close()
                with self.assertRaises(urllib.error.HTTPError) as denied:
                    post(host.connection, "/v1/register", self.registration(host, "browser", version_sha256="2" * 64), "http://127.0.0.1:3000")
                denied.exception.close()
                with self.assertRaises(urllib.error.HTTPError) as origin_denied:
                    post(host.connection, "/v1/register", self.registration(host, "browser"), "http://127.0.0.1:3001")
                self.assertIsNone(origin_denied.exception.headers.get("Access-Control-Allow-Origin"))
                origin_denied.exception.close()
                base = self.registration(host, "browser", instance_id=browser["instance_id"])
                accepted = post(host.connection, "/v1/event", {**base, "kind": "error", "level": "error", "message": "Bearer abc123 token=visible", "data": {"password": "visible", "private_value": "visible"}}, "http://127.0.0.1:3000")
                self.assertTrue(accepted["accepted"])
                duplicate = post(host.connection, "/v1/event", {**base, "kind": "error", "level": "error", "message": "Bearer abc123 token=visible", "data": {"password": "visible", "private_value": "visible"}}, "http://127.0.0.1:3000")
                self.assertTrue(duplicate["deduplicated"])
                ignored = post(host.connection, "/v1/event", {**base, "kind": "log", "level": "debug", "message": "noise"}, "http://127.0.0.1:3000")
                self.assertEqual(ignored["reason"], "irrelevant")
                oversized = post(host.connection, "/v1/event", {**base, "kind": "error", "level": "error", "message": "large", "data": {"value": "x" * 2000}}, "http://127.0.0.1:3000")
                self.assertEqual(oversized["reason"], "oversized")
                events = host.tool({"action": "events"})
                self.assertEqual(events["events"][0]["repeats"], 2)
                rendered = json.dumps(events)
                self.assertNotIn("abc123", rendered)
                self.assertNotIn("visible", rendered)
                self.assertEqual(events["events"][0]["task_id"], "task-1")
                self.assertEqual(events["events"][0]["version_sha256"], VERSION)
                for index in range(4):
                    post(host.connection, "/v1/event", {**base, "kind": "error", "level": "error", "message": f"bounded-{index}"}, "http://127.0.0.1:3000")
                status = host.tool({"action": "status"})
                self.assertLessEqual(status["retained"]["events"], 3)
                self.assertLessEqual(status["retained"]["bytes"], 4096)
                self.assertGreater(status["retained"]["dropped"]["capacity"], 0)

                BridgeClient = load_python_client()
                client = BridgeClient(host.connection, {"id": "python", "adapter": "python", "version_sha256": VERSION, "reproduction_id": "repro-1"})
                client.expose("health", lambda: {"ready": True, "token": "do-not-retain"})
                client.expose("large", lambda: {"value": "x" * 2000})
                client.connect()
                client.start_polling(0.02)
                result = host.tool({"action": "request_state", "application": "python", "state": "health", "timeout_ms": 1500})
                self.assertEqual(result["value"]["ready"], True)
                self.assertEqual(result["value"]["token"], "[redacted]")
                large = host.tool({"action": "request_state", "application": "python", "state": "large", "timeout_ms": 1500})
                self.assertEqual(large["error"], "state response exceeds byte limit")
                with self.assertRaisesRegex(RuntimeError, "not policy-exposed"):
                    host.tool({"action": "request_state", "application": "python", "state": "private", "timeout_ms": 1500})
                client.close()
                teardown = host.tool({"action": "teardown"})
                self.assertTrue(teardown["authorization_revoked"])
                self.assertFalse(host.connection_file.exists())
            finally:
                host.close()

    def test_client_sources_compile_and_javascript_executes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            subprocess.run(["cargo", "+1.95.0", "check", "--offline", "--locked"], cwd=ROOT / "bridge/rust", check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            output = root / "java"
            output.mkdir()
            subprocess.run(["javac", "--release", "11", "-d", str(output), str(ROOT / "bridge/java/src/main/java/dev/ohmydiff/bridge/BridgeClient.java")], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            subprocess.run(["node", "--check", str(ROOT / "bridge/host.mjs")], check=True)
            subprocess.run(["node", "--check", str(ROOT / "bridge/client.mjs")], check=True)
            subprocess.run(["node", "--check", str(ROOT / "bridge/node-client.mjs")], check=True)

    def test_all_five_adapters_exchange_events_and_exposed_state(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            policy = self.policy(root)
            policy["limits"]["max_events"] = 10
            policy["limits"]["max_total_bytes"] = 16384
            host = Host(root, policy)
            processes = []
            try:
                java_output = root / "java"
                java_output.mkdir()
                subprocess.run([
                    "javac", "--release", "11", "-d", str(java_output),
                    str(ROOT / "bridge/java/src/main/java/dev/ohmydiff/bridge/BridgeClient.java"),
                    str(ROOT / "bridge/java/src/test/java/dev/ohmydiff/bridge/BridgeSmoke.java"),
                ], check=True)
                subprocess.run(["cargo", "+1.95.0", "build", "--offline", "--locked", "--quiet", "--example", "smoke"], cwd=ROOT / "bridge/rust", check=True)
                python_code = """
import sys,time
sys.path.insert(0, sys.argv[1])
from omd_bridge import BridgeClient
c=BridgeClient.from_connection_file(sys.argv[2], {'id':'python','adapter':'python','version_sha256':'1'*64,'reproduction_id':'repro-1'})
c.expose('health', lambda: {'ready':True,'secret':'python-secret'}).connect()
c.event('error','python-fixture',{'token':'python-token'},'error')
c.start_polling(.02); time.sleep(5); c.close()
"""
                node_code = """
import {fromConnectionFile} from './bridge/node-client.mjs';
const c=fromConnectionFile(process.argv[1],{id:'node',adapter:'node',version_sha256:'1'.repeat(64),reproduction_id:'repro-1'});
c.expose('health',()=>({ready:true,secret:'node-secret'})); await c.connect(); await c.event('error','node-fixture',{token:'node-token'},'error'); c.startPolling(20); await new Promise(r=>setTimeout(r,5000)); await c.close();
"""
                browser_code = """
import fs from 'node:fs'; import {BridgeClient} from './bridge/client.mjs';
const nativeFetch=globalThis.fetch; globalThis.fetch=(url,options={})=>nativeFetch(url,{...options,headers:{...Object.fromEntries(new Headers(options.headers).entries()),Origin:'http://127.0.0.1:3000'}});
const connection=JSON.parse(fs.readFileSync(process.argv[1])); const c=new BridgeClient(connection,{id:'browser',adapter:'browser',version_sha256:'1'.repeat(64),reproduction_id:'repro-1'});
c.expose('health',()=>({ready:true,secret:'browser-secret'})); await c.connect(); await c.event('error','browser-fixture',{token:'browser-token'},'error'); c.startPolling(20); await new Promise(r=>setTimeout(r,5000)); await c.close();
"""
                commands = [
                    ["python3", "-c", python_code, str(ROOT / "bridge/python"), str(host.connection_file)],
                    ["node", "--input-type=module", "-e", node_code, str(host.connection_file)],
                    ["node", "--input-type=module", "-e", browser_code, str(host.connection_file)],
                    [str(ROOT / "bridge/rust/target/debug/examples/smoke"), str(host.connection_file)],
                    ["java", "-cp", str(java_output), "dev.ohmydiff.bridge.BridgeSmoke", str(host.connection_file)],
                ]
                for command in commands:
                    processes.append(subprocess.Popen(command, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True))
                deadline = time.monotonic() + 10
                status = host.tool({"action": "status"})
                while len(status["applications"]) < 5 and time.monotonic() < deadline:
                    time.sleep(0.05)
                    status = host.tool({"action": "status"})
                observed = {app["adapter"] for app in status["applications"]}
                failures = []
                for command, process in zip(commands, processes):
                    if process.poll() is not None:
                        failures.append({"command": command[0], "code": process.returncode, "stderr": process.stderr.read()})
                self.assertEqual(observed, {"browser", "node", "rust", "python", "java"}, failures)
                for adapter in ("browser", "node", "rust", "python", "java"):
                    state = host.tool({"action": "request_state", "application": adapter, "state": "health", "timeout_ms": 2000})
                    self.assertTrue(state["value"]["ready"])
                    self.assertEqual(state["value"]["secret"], "[redacted]")
                events = host.tool({"action": "events", "limit": 20})["events"]
                self.assertEqual({event["adapter"] for event in events}, {"browser", "node", "rust", "python", "java"})
                self.assertNotIn("-token", json.dumps(events))
                for process in processes:
                    stdout, stderr = process.communicate(timeout=10)
                    self.assertEqual(process.returncode, 0, stderr or stdout)
            finally:
                for process in processes:
                    if process.poll() is None:
                        process.terminate()
                        process.wait(timeout=5)
                    if process.stdout:
                        process.stdout.close()
                    if process.stderr:
                        process.stderr.close()
                host.close()


if __name__ == "__main__":
    unittest.main()
