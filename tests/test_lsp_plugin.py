import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "plugins/bundled/oh-my-diff/plugins/omd-lsp-adapters"
SERVER = PLUGIN / "scripts/omd_lsp_mcp.py"
TOOLS = {
    "rust_lsp": "rust",
    "typescript_lsp": "typescript",
    "javascript_lsp": "javascript",
    "python_lsp": "python",
    "java_lsp": "java",
}


class LspPluginTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.repository = self.root / "repository"
        self.repository.mkdir()
        self.store = self.root / "preferences.json"
        self.store.write_text("{}\n")
        self.bin = self.root / "bin"
        self.bin.mkdir()
        native = self.bin / "omd-lsp"
        native.write_text(
            """#!/usr/bin/env python3
import json, os, sys
request = json.load(sys.stdin)
status = os.environ.get('OMD_FAKE_LSP_STATUS', 'completed')
payload = {
    'schema': 1,
    'status': status,
    'language': sys.argv[-1],
    'command': request['action'],
    'native_argv': sys.argv[1:],
    'native_request': request,
}
if status == 'unsupported':
    payload.update(reason='fixture server unavailable', fallback='use ordinary fixture tools')
elif status == 'failed':
    payload.update(error='fixture native failure')
else:
    payload.update(result={'fixture': True})
print(json.dumps(payload))
"""
        )
        native.chmod(0o755)

    def tearDown(self):
        self.temporary.cleanup()

    def exchange(self, requests, status="completed"):
        environment = os.environ.copy()
        environment["PATH"] = os.pathsep.join(
            [str(self.bin), environment.get("PATH", "")]
        )
        environment["OMD_FAKE_LSP_STATUS"] = status
        result = subprocess.run(
            [str(SERVER)],
            input="".join(json.dumps(request) + "\n" for request in requests),
            text=True,
            capture_output=True,
            env=environment,
            check=True,
        )
        return [json.loads(line) for line in result.stdout.splitlines()]

    def arguments(self, action="status", **values):
        return {
            "repository": str(self.repository),
            "preference_store": str(self.store),
            "repository_identity": "fixture/repository",
            "action": action,
            **values,
        }

    def test_manifest_prompts_for_each_language_adapter(self):
        manifest = json.loads((PLUGIN / ".mcp.json").read_text())
        server = manifest["mcpServers"]["omd_lsp_adapters"]
        self.assertEqual(server["default_tools_approval_mode"], "prompt")
        self.assertEqual(server["command"], "./scripts/omd_lsp_mcp.py")
        listed = self.exchange(
            [{"jsonrpc": "2.0", "id": 1, "method": "tools/list"}]
        )[0]["result"]["tools"]
        self.assertEqual({tool["name"] for tool in listed}, set(TOOLS))
        for tool in listed:
            self.assertFalse(tool["inputSchema"]["additionalProperties"])

    def test_each_tool_fixes_its_language_and_uses_the_native_boundary(self):
        requests = [
            {
                "jsonrpc": "2.0",
                "id": index,
                "method": "tools/call",
                "params": {"name": name, "arguments": self.arguments()},
            }
            for index, name in enumerate(TOOLS, 1)
        ]
        responses = self.exchange(requests)
        for response, (name, language) in zip(responses, TOOLS.items(), strict=True):
            result = response["result"]
            self.assertFalse(result.get("isError", False), result)
            payload = result["structuredContent"]
            self.assertEqual(payload["language"], language)
            self.assertEqual(payload["native_argv"][-1], language)
            self.assertEqual(payload["adapter"]["tool"], name)
            self.assertEqual(payload["presentation"]["outcome"], "completed")

    def test_unsupported_server_is_a_visible_non_success_fallback(self):
        response = self.exchange(
            [
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "tools/call",
                    "params": {
                        "name": "java_lsp",
                        "arguments": self.arguments(
                            "diagnostics", paths=["src/Main.java"]
                        ),
                    },
                }
            ],
            status="unsupported",
        )[0]["result"]
        self.assertFalse(response.get("isError", False), response)
        payload = response["structuredContent"]
        self.assertEqual(payload["status"], "unsupported")
        self.assertEqual(payload["presentation"]["outcome"], "unsupported")
        self.assertIn("did not produce semantic evidence", payload["presentation"]["summary"])
        self.assertEqual(payload["presentation"]["next_step"], "use ordinary fixture tools")

    def test_edit_command_preserves_exact_scope_hashes_and_native_failure(self):
        digest = "a" * 64
        response = self.exchange(
            [
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "tools/call",
                    "params": {
                        "name": "python_lsp",
                        "arguments": self.arguments(
                            "rename_symbol",
                            paths=["a.py", "b.py"],
                            path="a.py",
                            position={"line": 0, "character": 1},
                            new_name="renamed",
                            scope=["a.py", "b.py"],
                            expected_versions={"a.py": digest, "b.py": digest},
                        ),
                    },
                }
            ],
            status="failed",
        )[0]["result"]
        self.assertTrue(response["isError"])
        payload = response["structuredContent"]
        self.assertEqual(payload["native_request"]["scope"], ["a.py", "b.py"])
        self.assertEqual(payload["native_request"]["expected_versions"]["a.py"], digest)
        self.assertEqual(payload["presentation"]["outcome"], "failed")

    def test_escaping_path_is_refused_before_native_dispatch(self):
        response = self.exchange(
            [
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "tools/call",
                    "params": {
                        "name": "rust_lsp",
                        "arguments": self.arguments(
                            "diagnostics", paths=["../outside.rs"]
                        ),
                    },
                }
            ]
        )[0]["result"]
        self.assertTrue(response["isError"])
        self.assertIn("repository-relative", response["content"][0]["text"])


if __name__ == "__main__":
    unittest.main()
