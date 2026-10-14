import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

from scripts.mod_host_check import Host, MOCKS


class OfflineProbes(unittest.TestCase):
    def probe(self, output, error):
        with tempfile.TemporaryDirectory() as directory:
            host = Host.__new__(Host)
            host.work = Path(directory)
            host.run = Mock(return_value=(output, error))
            result = host.offline_command(Path(directory), "fixture", "probe")
            scenario = json.loads((host.work / "scenario.json").read_text())
            return result, scenario

    def test_exploratory_replies_are_explicitly_optional(self):
        result, scenario = self.probe({"steps": [{"value": None}]}, None)
        self.assertEqual(result, (set(), []))
        self.assertEqual(set(scenario["host_operations"]), set(MOCKS))
        self.assertTrue(all(reply.get("optional") is True and "unsafe" not in reply
                            for replies in scenario["host_operations"].values() for reply in replies))

    def test_unmocked_operations_remain_visible_while_other_failures_are_reported(self):
        result, _ = self.probe({"steps": [{"error": "offline_unmocked_host_operation: agents.spawn"}]}, None)
        self.assertEqual(result, ({"agents.spawn"}, []))
        result, _ = self.probe({"steps": [{"error": "offline_invalid_host_arguments: store.put"}]}, None)
        self.assertEqual(result[0], set())
        self.assertIn("offline_invalid_host_arguments", result[1][0])
        for error in ("timeout", "offline_invalid_mock_result: exec.run", "unused_mock_replies"):
            with self.subTest(error=error):
                self.assertEqual(self.probe(None, error)[0], (set(), [error]))
        for output in (None, [], {}, {"steps": []}, {"steps": [None]}):
            self.assertEqual(self.probe(output, None)[0], (set(), ["missing offline scenario result"]))
