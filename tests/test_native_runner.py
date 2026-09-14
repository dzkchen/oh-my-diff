import http.server
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest

from benchmarks.gateway import Budget, Gateway
from benchmarks.isolation import launch
from benchmarks.native_fixture import Provider, build, tree
from benchmarks.runner import clean_env, evaluate, native
from benchmarks.compare import read


@unittest.skipUnless(os.environ.get("CAI_NATIVE_TESTS") == "1", "explicit macOS/native validation required")
class NativeRunnerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="cai-native-test-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.work, self.home = self.root / "work", self.root / "home"
        self.work.mkdir()
        self.home.mkdir()
        (self.home / "tmp").mkdir()
        self.limits = {"process_seconds": 5, "cpu_seconds": 5, "file_bytes": 1000000,
                       "rss_bytes": 1000000000, "processes": 16, "snapshot_bytes": 1000000}

    def test_private_test_inputs_are_restored_without_replacing_candidate_code(self):
        protected=tree({"tests/edited.txt":"trusted", "tests/deleted.txt":"restored"})["files"]
        protected["tests/new.txt"]=None
        candidate=tree({"implementation.txt":"candidate", "tests/edited.txt":"tampered", "tests/new.txt":"tampered"})
        check={"backend":"macos-seatbelt", "protected_tests":protected,
               "argv":["/bin/sh","-c",'test "$(cat implementation.txt)" = candidate && test "$(cat tests/edited.txt)" = trusted && test "$(cat tests/deleted.txt)" = restored && test ! -e tests/new.txt']}
        result=evaluate(check,candidate,self.root/"protected-check",self.limits,5)
        self.assertEqual(result["exit_code"],0)
        self.assertNotIn("tests/deleted.txt",candidate["files"])

    def test_private_checks_credentials_other_trials_and_external_network_denied(self):
        (self.root / "private").write_text("GOLD_AND_CREDENTIAL_CANARY")
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Provider)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        script = ('test -z "$OPENAI_API_KEY" && '
                  f'! /bin/cat {self.root / "private"} && '
                  f'! /usr/bin/curl --max-time 1 http://127.0.0.1:{server.server_port} && '
                  'echo permitted > local.txt && test -f local.txt')
        result = launch(["/bin/sh", "-c", script], self.work, clean_env(self.home), [self.work, self.home],
                        self.root / "evidence", self.limits, reads=[self.work, self.home])
        self.assertEqual(result["exit_code"], 0)
        self.assertNotIn("GOLD_AND_CREDENTIAL_CANARY", (self.root / "evidence/stdout").read_text())

    def test_timeout_cleans_observed_child_processes(self):
        result = launch(["/bin/sh", "-c", "sleep 20 & wait"], self.work, clean_env(self.home), [self.work, self.home],
                        self.root / "evidence", self.limits, reads=[self.work, self.home], seconds=0.4)
        self.assertEqual(result["stop_reason"], "wall_limit")
        self.assertGreaterEqual(len(result["observed_pids"]), 2)
        self.assertLess(result["wall_seconds"], 3)

    def test_linux_docker_evaluator_is_separate_and_offline(self):
        image = "mswebench/serde-rs_m_serde@sha256:359320345fb3a9dc9853b6fee3a23e5e81e1b3a3fbe7cc63c79a9acc403b3a64"
        result = evaluate({"backend": "docker", "image": image, "argv": ["/bin/sh", "-c",
            "test -f solution.py && test ! -S /var/run/docker.sock && ! touch /root/cai-write-probe"]},
            tree({"solution.py": "def add(a, b): return a+b\n"}), self.root / "evaluator", dict(self.limits, process_seconds=20))
        self.assertEqual(result["exit_code"], 0)
        self.assertEqual(result["image"]["Os"], "linux")

    def test_cancelled_native_request_keeps_unknown_exposure(self):
        class HoldingProvider(Provider):
            def do_POST(self):
                self.rfile.read(int(self.headers["Content-Length"]))
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                self.wfile.write(b'data: {"type":"response.created","response":{"id":"held"}}\n\n')
                self.wfile.flush()
                threading.Event().wait(4)
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), HoldingProvider)
        server.daemon_threads = True
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        upstream = Path("/opt/homebrew/Caskroom/codex/0.154.0/bin/codex")
        manifest = build(self.root / "inputs", upstream, upstream, f"http://127.0.0.1:{server.server_port}", 1)
        m = read(manifest)
        budget = Budget(m["execution"]["limits"], self.root / "budget")
        with Gateway(m["execution"]["routes"], budget, self.root / "evidence", fixture=True) as gateway:
            result = native(manifest.parent, m["arms"]["default-upstream"], "Synthetic cancellation fixture", self.work,
                            self.home, self.root / "process", gateway, m["execution"]["limits"], 2)
        ledger = gateway.ledger()
        self.assertEqual(result["stop_reason"], "wall_limit")
        self.assertTrue(ledger)
        self.assertTrue(all(e["usd"] is None for e in ledger))
        self.assertTrue(all(e["basis"] == "unknown" for e in ledger))

    def test_native_descendant_requests_share_gateway_and_budget(self):
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Provider)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        upstream = Path("/opt/homebrew/Caskroom/codex/0.154.0/bin/codex")
        manifest = build(self.root / "inputs", upstream, upstream, f"http://127.0.0.1:{server.server_port}", 1)
        m = read(manifest)
        budget = Budget(m["execution"]["limits"], self.root / "budget")
        with Gateway(m["execution"]["routes"], budget, self.root / "evidence", fixture=True) as gateway:
            result = native(manifest.parent, m["arms"]["configured-upstream"],
                "NATIVE_DELEGATION_FIXTURE: Use a subagent for this synthetic worker test and wait for its completion.",
                self.work, self.home, self.root / "process", gateway, m["execution"]["limits"], 20)
        ledger = gateway.ledger()
        self.assertTrue(result["turn_completed"])
        self.assertGreaterEqual(len({e["actor"] for e in ledger}), 2)
        self.assertEqual(budget.count, len(ledger))


if __name__ == "__main__":
    unittest.main()
