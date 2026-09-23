import base64
import hashlib
import json
import os
from pathlib import Path
import tempfile
import tomllib
import unittest
from unittest.mock import patch

from benchmarks.controlled_experiment import bind_subscription_credentials, controlled_attribution, final_candidate_matches, fixed_roles, fresh_spawns
from benchmarks.gateway import bounded_request
from benchmarks.isolation import snapshot
from benchmarks.runner import config_literal


class ControlledTests(unittest.TestCase):
    def test_subscription_credentials_bind_to_frozen_route_names(self):
        manifest = {"execution": {"routes": {"subscription": {
            "native_subscription": True,
            "credential_env": "CAI_SUBSCRIPTION_ACCESS",
            "account_env": "CAI_SUBSCRIPTION_ACCOUNT",
        }}}}
        with patch.dict(os.environ, {
            "OMD_SUBSCRIPTION_ACCESS": "access",
            "OMD_SUBSCRIPTION_ACCOUNT": "account",
        }, clear=True):
            bind_subscription_credentials(manifest)
            self.assertEqual(os.environ["CAI_SUBSCRIPTION_ACCESS"], "access")
            self.assertEqual(os.environ["CAI_SUBSCRIPTION_ACCOUNT"], "account")

    def test_native_permission_paths_survive_cli_toml_serialization(self):
        path = "/private/tmp/example.with.dots/source"
        filesystem = {":minimal": "read", path: "write", "/usr/bin": "read"}
        parsed = tomllib.loads("permissions.experiment.filesystem=" + config_literal(filesystem))
        self.assertEqual(parsed["permissions"]["experiment"]["filesystem"], filesystem)

    def test_only_reserved_scratch_is_excluded_from_candidate(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name in (".omd/worker/file", ".omd-tmp/cache", "build/output", "source.py"):
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(name)
            self.assertEqual(set(snapshot(root, 1000, excluded_roots=(".omd", ".omd-tmp"))["files"]), {"build/output", "source.py"})

    def test_attribution_requires_unique_native_id_owner_and_route(self):
        usage = {"input_tokens": 10, "output_tokens": 5}
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            evidence = root / "native/controlled-evidence"
            wire = root / "requests"
            evidence.mkdir(parents=True); wire.mkdir()
            attempt = {"request": 1, "owner": "contributor", "provider": "meta", "model": "muse-spark-1.3-contributor", "status": "completed", "raw_usage": usage}
            (evidence / "00000001.json").write_text(json.dumps({"record": {"attempt": attempt}}))
            record = {"native_request_id": "1", "native_owner": "contributor", "route": "contributor", "requested_model": attempt["model"], "status": "completed", "raw_usage": usage}
            for change, expected in (({}, True), ({"native_owner": "reviewer"}, False), ({"route": "subscription"}, False), ({"native_request_id": "2"}, False)):
                (wire / "wire.json").write_text(json.dumps({**record, **change}))
                (root / "native-attribution.json").unlink(missing_ok=True)
                self.assertEqual(controlled_attribution(root), expected)

    def test_fixed_roles_reject_extra_threads_model_switches_and_missing_usage(self):
        def request(thread, model):
            return {"thread_id": thread, "role": "collab_spawn" if thread != "lead" else None,
                    "requested_model": model, "returned_model": model, "raw_usage": {}, "status": "completed",
                    "request": {"reasoning": {"effort": "high"}}}
        records = [request("lead", "gpt-5.6-sol"), request("reviewer", "gpt-6-astra")]
        self.assertTrue(fixed_roles(records, {"lead"}, "default-upstream"))
        self.assertFalse(fixed_roles(records + [request("extra", "gpt-6-astra")], {"lead"}, "default-upstream"))
        records.append(request("worker", "gpt-5.6-sol"))
        self.assertTrue(fixed_roles(records, {"lead"}, "configured-upstream"))
        self.assertFalse(fixed_roles(records, {"lead"}, "default-upstream"))
        self.assertFalse(fixed_roles(records + [request("worker", "gpt-6-astra")], {"lead"}, "configured-upstream"))
        records[0]["raw_usage"] = None
        self.assertFalse(fixed_roles(records, {"lead"}, "configured-upstream"))

    def test_baseline_spawn_evidence_rejects_history_forks_and_wrong_order(self):
        args = {"model": "gpt-6-astra", "reasoning_effort": "high", "fork_context": False}
        def record(value):
            return {"thread_id": "lead", "events": [{"type": "response.output_item.done", "item": {"name": "spawn_agent", "arguments": json.dumps(value)}}]}
        self.assertTrue(fresh_spawns([record(args)], {"lead"}, "default-upstream"))
        self.assertFalse(fresh_spawns([record({**args, "fork_context": True})], {"lead"}, "default-upstream"))
        self.assertFalse(fresh_spawns([record(args), record({**args, "model": "gpt-5.6-sol"})], {"lead"}, "configured-upstream"))

    def test_final_candidate_must_equal_reviewed_content_and_modes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            evidence = root / "native/controlled-evidence"
            evidence.mkdir(parents=True)
            raw = json.dumps({"files": {"source": {"bytes": [65], "executable": False}}}).encode()
            (evidence / "candidate.json").write_bytes(raw)
            sha = hashlib.sha256(raw).hexdigest()
            result = {"status": "integrated", "candidate": {"sha256": sha}, "candidate_sha256": sha}
            entry = {"base64": base64.b64encode(b"A").decode(), "mode": 0o644}
            for change, expected in (({}, True), ({"mode": 0o755}, False), ({"base64": base64.b64encode(b"B").decode()}, False)):
                (root / "candidate-tree.json").write_text(json.dumps({"files": {"source": {**entry, **change}}}))
                self.assertEqual(final_candidate_matches(root, [result]), expected)

    def test_contributor_envelope_reserves_encrypted_reasoning_and_output(self):
        route = {"bounds": {"input_token_ceiling": 220000, "output_tokens": 8192, "reasoning_tokens_per_item": 8192},
                 "rates": {"input": "0.10", "cache_read": "0.002", "cache_write": "0.10", "output": "0.20"}, "request_exposure_usd": "0.025"}
        body = {"input": [{"type": "reasoning", "encrypted_content": "opaque"}], "max_output_tokens": 8192}
        ceiling = bounded_request(body, route)
        self.assertEqual(ceiling, len(json.dumps(body, ensure_ascii=False).encode()) + 4096 + 8192)
        body["input"].append({"type": "input_image", "image_url": "https://example.com/image"})
        with self.assertRaises(ValueError):
            bounded_request(body, route)


if __name__ == "__main__":
    unittest.main()
