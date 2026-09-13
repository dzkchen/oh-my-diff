import copy
import http.client
import http.server
import json
from pathlib import Path
import tempfile
import threading
import unittest

from benchmarks.compare import money, put, read, write
from benchmarks.gateway import Budget, Gateway, validate_routes
from benchmarks.isolation import restore, snapshot
from benchmarks.native_fixture import tree
from benchmarks.reconcile import reconcile


class WireProvider(http.server.BaseHTTPRequestHandler):
    seen = []

    def log_message(self, *_):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.seen.append(body)
        failure = body.get("mode") == "failure"
        self.send_response(429 if failure else 200)
        self.send_header("Content-Type", "application/json")
        self.send_header("x-request-id", "provider-request-" + str(len(self.seen)))
        self.end_headers()
        self.wfile.write(json.dumps({"id": "response", "model": body["model"], "usage": {
            "input_tokens": 100, "input_tokens_details": {"cached_tokens": 20, "cache_write_tokens": 10},
            "output_tokens": 30, "output_tokens_details": {"reasoning_tokens": 7}}}).encode())


class ExecutionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), WireProvider)
        WireProvider.seen = []
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.routes = {"test": {"url": f"http://127.0.0.1:{self.server.server_port}/v1", "models": ["model"],
                               "account_alias": "fixture", "billing": "unknown", "request_exposure_usd": "0.25"}}
        self.limits = {"seconds": 10, "requests": 2, "usd_exposure": "0.5", "max_output_tokens": 50,
                       "max_request_bytes": 10000, "max_response_bytes": 10000}

    def request(self, gateway, **body):
        conn = http.client.HTTPConnection("127.0.0.1", gateway.port, timeout=5)
        conn.request("POST", "/test/responses", json.dumps({"model": "model", **body}),
                     {"Authorization": "Bearer " + gateway.token, "thread-id": body.pop("actor", "worker")})
        response = conn.getresponse()
        status = response.status
        response.read()
        conn.close()
        return status

    def test_failed_retry_and_worker_attribution_preserved(self):
        with Gateway(self.routes, Budget(self.limits, self.root / "budget"), self.root, fixture=True) as gateway:
            self.assertEqual(self.request(gateway, mode="failure"), 429)
            self.assertEqual(self.request(gateway), 200)
        ledger = gateway.ledger()
        self.assertEqual([e["status"] for e in ledger], ["failed", "completed"])
        self.assertEqual({e["actor"] for e in ledger}, {"worker"})
        self.assertEqual(money(ledger)["task_api"]["unknown"], 2)
        self.assertTrue(all(b["max_output_tokens"] == 50 for b in WireProvider.seen))

    def test_shared_budget_denies_before_provider_and_does_not_refund(self):
        budget = Budget(self.limits, self.root / "budget")
        with Gateway(self.routes, budget, self.root, fixture=True) as gateway:
            self.request(gateway, mode="failure")
            self.request(gateway)
            self.assertEqual(self.request(gateway), 502)
        self.assertEqual(len(WireProvider.seen), 2)
        ledger = gateway.ledger()
        self.assertEqual(ledger[-1]["usd"], "0")
        self.assertEqual(str(budget.reserved), "0.50")
        self.assertEqual(len(list((self.root / "budget").glob("*.json"))), 2)

    def test_live_routes_and_unknown_models_fail_closed(self):
        with self.assertRaisesRegex(ValueError, "loopback"):
            validate_routes({"test": dict(self.routes["test"], url="https://example.invalid")}, True)
        with self.assertRaisesRegex(ValueError, "HTTPS"):
            validate_routes(self.routes, False)
        with Gateway(self.routes, Budget(self.limits, self.root / "budget"), self.root, fixture=True) as gateway:
            self.assertEqual(self.request(gateway, model="unapproved"), 502)
        self.assertFalse(WireProvider.seen)

    def test_tool_charges_cannot_disappear_into_token_estimates(self):
        with Gateway(self.routes, Budget(self.limits, self.root / "budget"), self.root, fixture=True) as gateway:
            self.request(gateway, tools=[{"type": "web_search"}])
        self.assertEqual(len(gateway.ledger()), 2)

    def test_snapshots_reject_traversal_symlinks_and_hardlinks(self):
        dest = self.root / "tree"
        dest.mkdir()
        with self.assertRaisesRegex(ValueError, "unsafe"):
            restore(tree({"../escape": "bad"}), dest, 100)
        (dest / "link").symlink_to(self.root / "secret")
        with self.assertRaisesRegex(ValueError, "symlink"):
            snapshot(dest, 100)

    def test_reconciliation_replaces_unknown_and_preserves_original(self):
        with Gateway(self.routes, Budget(self.limits, self.root / "budget"), self.root / "run", fixture=True) as gateway:
            self.request(gateway)
        ledger = gateway.ledger()
        write(self.root / "run/run.json", {"ledger": ledger})
        proof = put(self.root, "invoice.json", '{"fixture":true,"USD":"0.12"}')
        unit = ledger[0]
        charges = {"currency": "USD", "provenance": "synthetic provider export", "units": [{
            "billing_unit": unit["billing_unit"], "provider": "test", "account_alias": "fixture",
            "request_id": unit["request_id"], "usd": "0.12", "evidence": proof}]}
        write(self.root / "charges.json", charges)
        reconcile(self.root / "run", self.root / "charges.json", self.root / "reconciled")
        self.assertEqual(read(self.root / "run/run.json")["ledger"][0]["basis"], "unknown")
        revised = read(self.root / "reconciled/run.json")["ledger"]
        self.assertEqual(len(revised), 1)
        self.assertEqual(money(revised)["task_api"]["actual_usd"], "0.12")


if __name__ == "__main__":
    unittest.main()
