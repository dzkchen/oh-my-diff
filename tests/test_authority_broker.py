import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from scripts import authority_broker


class AdministratorPolicyFileTest(unittest.TestCase):
    def test_install_rollback_and_remove_keep_one_previous_policy(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            policy = base / "OhMyDiff/policy.json"
            previous = policy.with_name("policy.json.previous")
            first, second = base / "first.json", base / "second.json"
            first.write_text(json.dumps({"schema": 1}))
            second.write_text(json.dumps({"schema": 1, "managed_only": True}))
            with mock.patch.object(authority_broker, "POLICY", policy), mock.patch("os.chown"):
                authority_broker.policy("policy-install", first)
                self.assertFalse(previous.exists())
                self.assertEqual(policy.stat().st_mode & 0o777, 0o644)
                authority_broker.policy("policy-install", second)
                self.assertEqual(json.loads(previous.read_text()), {"schema": 1})
                authority_broker.policy("policy-rollback")
                self.assertEqual(json.loads(policy.read_text()), {"schema": 1})
                self.assertTrue(json.loads(previous.read_text())["managed_only"])
                self.assertEqual(authority_broker.policy("policy-remove")["installed"], False)
                self.assertFalse(policy.exists())
                authority_broker.policy("policy-rollback")
                self.assertEqual(json.loads(policy.read_text()), {"schema": 1})
                self.assertFalse(previous.exists())
                with self.assertRaises(ValueError):
                    authority_broker.policy("policy-rollback")
                bad = base / "bad.json"
                bad.write_text("{")
                with self.assertRaises(ValueError):
                    authority_broker.policy("policy-install", bad)
                self.assertEqual(json.loads(policy.read_text()), {"schema": 1})


if __name__ == "__main__":
    unittest.main()
