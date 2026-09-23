import json
from pathlib import Path
import tempfile
import unittest

from benchmarks.native_usage import extract


class NativeUsageTests(unittest.TestCase):
    def test_replay_aggregate_and_failure_are_not_billed_twice(self):
        response = {"method": "rawResponse/completed", "params": {
            "threadId": "child", "turnId": "turn", "responseId": "response",
            "usage": {"inputTokens": 100, "outputTokens": 20}, "usageMetadata": {"amount": "2"}}}
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "native.jsonl"
            events = [response, response, {"type": "turn.completed", "usage": {"input_tokens": 100}},
                      {"type": "event_msg", "payload": {"type": "token_count", "info": {"total": 100}}},
                      {"type": "turn.failed", "error": {"message": "interrupted"}}]
            path.write_text("\n".join(json.dumps(e) for e in events))
            result = extract([path])
        self.assertEqual(len(result["response_observations"]), 1)
        self.assertEqual(len(result["response_observations"][0]["origins"]), 2)
        self.assertEqual(len(result["aggregate_observations_do_not_sum"]), 2)
        self.assertEqual(len(result["failure_observations"]), 1)
        self.assertFalse(result["accounting_complete"])
        self.assertIsNone(result["actual_usd"])

    def test_conflicting_completion_is_rejected(self):
        response = {"method": "rawResponse/completed", "params": {
            "threadId": "lead", "turnId": "turn", "responseId": "same", "usage": None}}
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "native.jsonl"
            first = json.dumps(response)
            response["params"]["usage"] = {"inputTokens": 999}
            path.write_text(first + "\n" + json.dumps(response))
            with self.assertRaisesRegex(ValueError, "conflicting"):
                extract([path])


if __name__ == "__main__":
    unittest.main()
