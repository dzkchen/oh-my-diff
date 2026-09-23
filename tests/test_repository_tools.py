import json
import os
from pathlib import Path
import select
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "plugins/bundled/oh-my-diff/plugins/omd-repository-tools"
SERVER = PLUGIN / "scripts/omd_repository_mcp.py"


GRAPH_FIXTURE = """#!/usr/bin/env python3
import json
from pathlib import Path
import sys

command = sys.argv[1]
repository = Path(sys.argv[2])
payload = {"identity": "fixture/repository", "root": str(repository), "revision": "fixture", "source_digest": "a" * 64}
if command == "snapshot":
    Path(sys.argv[3]).parent.mkdir(parents=True, exist_ok=True)
    Path(sys.argv[3]).write_text("graph")
    Path(sys.argv[4]).write_text("html")
elif command == "html":
    Path(sys.argv[4]).write_text("html")
elif command == "validate" and (repository / "stale").exists():
    raise SystemExit("graph snapshot is stale; regenerate it")
elif command == "select":
    payload = {"schema": 1, "graph_schema": 1, "graph_generator": "omd-bounded-code-graph-v1", "nodes": sys.argv[4:]}
print(json.dumps(payload))
"""


HEALTH_FIXTURE = """#!/usr/bin/env python3
import json
from pathlib import Path
import sys

command = sys.argv[1]
if command == "baseline":
    payload = {"schema": 1, "generator": "omd-focused-code-health-v1", "repository_identity": "fixture/repository", "revision": sys.argv[5], "source_digest": "a" * 64, "constraints_version": "fixture-v1", "constraints_sha256": "b" * 64, "checks": [{"key": "one"}], "existing_observations": []}
    Path(sys.argv[4]).parent.mkdir(parents=True, exist_ok=True)
    Path(sys.argv[4]).write_text(json.dumps(payload))
    print(json.dumps(payload))
else:
    finding = {"fingerprint": "one", "certainty": "certain", "origin": "introduced", "repair": "requires_authorization", "current_evidence": [{"path": "src/lib.rs", "start_line": 1}]}
    payload = {"schema": 1, "generator": "omd-focused-code-health-v1", "repository_identity": "fixture/repository", "baseline_revision": "base", "baseline_source_digest": "a" * 64, "current_revision": sys.argv[6], "current_source_digest": "c" * 64, "constraints_version": "fixture-v1", "constraints_sha256": "b" * 64, "introduced_findings": [finding], "existing_debt": [], "uncertain_findings": []}
    Path(sys.argv[5]).write_text(json.dumps(payload))
    print(json.dumps(payload))
    raise SystemExit(2)
"""


class RepositoryToolsTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.repository = self.root / "repository"
        self.repository.mkdir()
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.executable("omd-graph", GRAPH_FIXTURE)
        self.executable("omd-health", HEALTH_FIXTURE)
        self.process = subprocess.Popen(
            [sys.executable, str(SERVER)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            env={
                **os.environ,
                "PATH": f"{self.bin}{os.pathsep}{os.environ.get('PATH', '')}",
            },
        )
        self.call(
            1,
            "initialize",
            {
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": {"name": "test", "version": "1"},
            },
        )

    def tearDown(self):
        if self.process.stdin:
            self.process.stdin.close()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=5)
        if self.process.stdout:
            self.process.stdout.close()
        if self.process.stderr:
            self.process.stderr.close()
        self.temporary.cleanup()

    def executable(self, name, source):
        path = self.bin / name
        path.write_text(source)
        path.chmod(0o755)

    def call(self, identifier, method, params=None):
        self.process.stdin.write(
            json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": identifier,
                    "method": method,
                    "params": params or {},
                }
            )
            + "\n"
        )
        self.process.stdin.flush()
        ready, _, _ = select.select([self.process.stdout], [], [], 10)
        if not ready:
            detail = (
                self.process.stderr.read()
                if self.process.poll() is not None
                else "server remained live without responding"
            )
            self.fail(detail)
        response = json.loads(self.process.stdout.readline())
        self.assertEqual(response["id"], identifier)
        self.assertNotIn("error", response)
        return response["result"]

    def tool(self, identifier, name, arguments):
        return self.call(
            identifier, "tools/call", {"name": name, "arguments": arguments}
        )

    def test_manifest_prompts_for_every_local_tool(self):
        manifest = json.loads((PLUGIN / ".mcp.json").read_text())
        server = manifest["mcpServers"]["omd_repository"]
        self.assertEqual(server["default_tools_approval_mode"], "prompt")
        self.assertEqual(server["command"], "./scripts/omd_repository_mcp.py")
        listed = self.call(2, "tools/list")
        self.assertEqual(
            {tool["name"] for tool in listed["tools"]},
            {
                "graph_snapshot",
                "graph_validate",
                "graph_html",
                "graph_select",
                "health_baseline",
                "health_check",
                "health_report",
            },
        )

    def test_graph_snapshot_and_selection_are_repository_contained(self):
        snapshot = self.tool(
            2,
            "graph_snapshot",
            {
                "repository": str(self.repository),
                "graph_path": ".omd/graph.json",
                "html_path": ".omd/graph.html",
                "repository_id": "fixture/repository",
                "revision": "fixture",
            },
        )
        self.assertFalse(snapshot.get("isError"), snapshot)
        self.assertTrue((self.repository / ".omd/graph.json").is_file())
        selected = self.tool(
            3,
            "graph_select",
            {
                "repository": str(self.repository),
                "graph_path": ".omd/graph.json",
                "node_ids": ["src/lib.rs:1:item"],
            },
        )
        self.assertEqual(
            selected["structuredContent"]["selection"]["nodes"], ["src/lib.rs:1:item"]
        )
        escaped = self.tool(
            4,
            "graph_snapshot",
            {
                "repository": str(self.repository),
                "graph_path": "../outside.json",
                "html_path": ".omd/graph.html",
                "repository_id": "fixture/repository",
                "revision": "fixture",
            },
        )
        self.assertTrue(escaped["isError"])
        self.assertIn("repository-relative", escaped["content"][0]["text"])

    def test_symlinked_artifact_and_stale_graph_are_refused(self):
        outside = self.root / "outside.json"
        outside.write_text("outside")
        (self.repository / "graph.json").symlink_to(outside)
        linked = self.tool(
            2,
            "graph_validate",
            {
                "repository": str(self.repository),
                "graph_path": "graph.json",
            },
        )
        self.assertTrue(linked["isError"])
        self.assertEqual(outside.read_text(), "outside")
        (self.repository / "graph.json").unlink()
        (self.repository / "graph.json").write_text("graph")
        (self.repository / "stale").write_text("yes")
        stale = self.tool(
            3,
            "graph_validate",
            {
                "repository": str(self.repository),
                "graph_path": "graph.json",
            },
        )
        self.assertTrue(stale["isError"])
        self.assertIn("stale", stale["content"][0]["text"])

    def test_health_exit_two_is_a_completed_finding_report(self):
        (self.repository / "constraints.json").write_text("{}")
        baseline = self.tool(
            2,
            "health_baseline",
            {
                "repository": str(self.repository),
                "constraints_path": "constraints.json",
                "baseline_path": ".omd/baseline.json",
                "revision": "base",
            },
        )
        self.assertEqual(baseline["structuredContent"]["status"], "baseline_created")
        checked = self.tool(
            3,
            "health_check",
            {
                "repository": str(self.repository),
                "constraints_path": "constraints.json",
                "baseline_path": ".omd/baseline.json",
                "report_path": ".omd/report.json",
                "revision": "candidate",
            },
        )
        self.assertFalse(checked.get("isError"), checked)
        self.assertEqual(checked["structuredContent"]["status"], "introduced_findings")
        self.assertEqual(checked["structuredContent"]["counts"]["introduced"], 1)
        report = self.tool(
            4,
            "health_report",
            {
                "repository": str(self.repository),
                "report_path": ".omd/report.json",
                "report_sha256": checked["structuredContent"]["report"]["sha256"],
                "category": "introduced",
                "limit": 1,
            },
        )
        self.assertEqual(report["structuredContent"]["total"], 1)
        self.assertEqual(
            report["structuredContent"]["findings"][0]["repair"],
            "requires_authorization",
        )
        (self.repository / ".omd/report.json").write_text("{}")
        changed = self.tool(
            5,
            "health_report",
            {
                "repository": str(self.repository),
                "report_path": ".omd/report.json",
                "report_sha256": checked["structuredContent"]["report"]["sha256"],
                "category": "introduced",
            },
        )
        self.assertTrue(changed["isError"])
        self.assertIn("SHA256", changed["content"][0]["text"])


@unittest.skipUnless(
    os.environ.get("OMD_TEST_REPOSITORY_TOOLS_BIN_DIR"),
    "set OMD_TEST_REPOSITORY_TOOLS_BIN_DIR to exercise the real Rust operators",
)
class RealRepositoryToolsTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.repository = self.root / "repository"
        (self.repository / "src/domain").mkdir(parents=True)
        (self.repository / "src/infra").mkdir(parents=True)
        (self.repository / "tests").mkdir()
        (self.repository / "src/domain/order.rs").write_text(
            "pub fn entry() { validate(); persist(); }\n"
        )
        (self.repository / "src/infra/db.rs").write_text("pub fn db() {}\n")
        (self.repository / "tests/order_test.rs").write_text(
            "#[test]\nfn order_test() { assert_eq!(1 + 1, 2); }\n"
        )
        (self.repository / ".omd").mkdir()
        constraints = {
            "schema": 1,
            "version": "approved-v1",
            "repository_identity": "fixture/repository",
            "approval": {
                "actor": "fixture-maintainer",
                "reason": "exercise the approved repository boundaries",
            },
            "dependency_boundaries": [
                {
                    "id": "domain-must-not-import-infra",
                    "from_prefix": "src/domain",
                    "denied_to_prefix": "src/infra",
                }
            ],
            "duplication_scopes": [
                {
                    "id": "domain-logic",
                    "path_prefixes": ["src/domain"],
                    "minimum_logical_lines": 3,
                }
            ],
            "verification": [
                {
                    "id": "domain-tests",
                    "test_path_prefix": "tests",
                    "minimum_tests": 1,
                    "minimum_assertions_per_test": 1,
                }
            ],
            "repair_scope": ["src/domain"],
            "max_findings": 64,
        }
        (self.repository / ".omd/constraints.json").write_text(json.dumps(constraints))
        binary_path = str(
            Path(os.environ["OMD_TEST_REPOSITORY_TOOLS_BIN_DIR"]).resolve()
        )
        self.process = subprocess.Popen(
            [sys.executable, str(SERVER)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            env={
                **os.environ,
                "PATH": f"{binary_path}{os.pathsep}{os.environ.get('PATH', '')}",
            },
        )
        self.call(
            1,
            "initialize",
            {
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": {"name": "real-test", "version": "1"},
            },
        )

    def tearDown(self):
        self.process.stdin.close()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=5)
        self.process.stdout.close()
        self.process.stderr.close()
        self.temporary.cleanup()

    def call(self, identifier, method, params=None):
        self.process.stdin.write(
            json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": identifier,
                    "method": method,
                    "params": params or {},
                }
            )
            + "\n"
        )
        self.process.stdin.flush()
        ready, _, _ = select.select([self.process.stdout], [], [], 30)
        if not ready:
            detail = (
                self.process.stderr.read()
                if self.process.poll() is not None
                else "server remained live without responding"
            )
            self.fail(detail)
        response = json.loads(self.process.stdout.readline())
        self.assertNotIn("error", response)
        return response["result"]

    def tool(self, identifier, name, arguments):
        result = self.call(
            identifier, "tools/call", {"name": name, "arguments": arguments}
        )
        self.assertFalse(result.get("isError"), result)
        return result["structuredContent"]

    def test_real_graph_and_health_workflow(self):
        graph = self.tool(
            2,
            "graph_snapshot",
            {
                "repository": str(self.repository),
                "graph_path": ".omd/graph.json",
                "html_path": ".omd/graph.html",
                "repository_id": "fixture/repository",
                "revision": "baseline",
            },
        )
        self.assertEqual(graph["status"], "created")
        graph_value = json.loads((self.repository / ".omd/graph.json").read_text())
        entry = next(
            node["id"] for node in graph_value["nodes"] if node["name"] == "entry"
        )
        selection = self.tool(
            3,
            "graph_select",
            {
                "repository": str(self.repository),
                "graph_path": ".omd/graph.json",
                "node_ids": [entry],
            },
        )
        self.assertTrue(selection["selection"]["nodes"])
        baseline = self.tool(
            4,
            "health_baseline",
            {
                "repository": str(self.repository),
                "constraints_path": ".omd/constraints.json",
                "baseline_path": ".omd/baseline.json",
                "revision": "baseline",
            },
        )
        self.assertEqual(
            baseline["constraints_sha256"],
            json.loads((self.repository / ".omd/baseline.json").read_text())[
                "constraints_sha256"
            ],
        )
        (self.repository / "src/domain/new.rs").write_text(
            "use crate::infra::db;\npub fn new_path() { inspect(); finish(); }\n"
        )
        checked = self.tool(
            5,
            "health_check",
            {
                "repository": str(self.repository),
                "constraints_path": ".omd/constraints.json",
                "baseline_path": ".omd/baseline.json",
                "report_path": ".omd/report.json",
                "revision": "candidate",
            },
        )
        self.assertEqual(checked["status"], "introduced_findings")
        self.assertGreater(checked["counts"]["introduced"], 0)
        report = self.tool(
            6,
            "health_report",
            {
                "repository": str(self.repository),
                "report_path": ".omd/report.json",
                "report_sha256": checked["report"]["sha256"],
                "category": "introduced",
                "limit": 10,
            },
        )
        self.assertGreater(report["total"], 0)
        self.assertTrue(report["metadata"]["constraints_sha256"])


if __name__ == "__main__":
    unittest.main()
