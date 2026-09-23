import copy
import os
import unittest
from unittest.mock import patch

from benchmarks.gateway import bounded_request, validate_routes


class SubscriptionTests(unittest.TestCase):
    def route(self):
        return {"url":"https://chatgpt.com/backend-api/codex", "credential_env":"TEST_ACCESS", "account_env":"TEST_ACCOUNT",
                "models":["gpt-5.6-sol"], "account_alias":"test-subscription", "billing":"subscription",
                "native_subscription":True, "included_usage_verified":True, "request_exposure_usd":"0",
                "bounds":{"input_accounting":"observed-prefix-v1", "input_token_ceiling":240000, "output_tokens":32000, "input_items":512}}

    def test_zero_reservation_requires_verified_subscription_endpoint(self):
        with patch.dict(os.environ, {"TEST_ACCESS":"synthetic", "TEST_ACCOUNT":"synthetic"}):
            route=self.route()
            validate_routes({"subscription":route},False)
            for field,value in (("url","https://api.openai.com/v1"),("billing","estimate"),("included_usage_verified",False),("request_exposure_usd","1")):
                invalid=copy.deepcopy(route)
                invalid[field]=value
                with self.assertRaises(ValueError):validate_routes({"subscription":invalid},False)

    def test_observed_prefix_reuse_requires_matching_context_and_completed_usage(self):
        route=self.route()
        prior={"model":"gpt-5.6-sol", "instructions":"same", "input":[{"type":"message","content":"x"*250000}]}
        current=copy.deepcopy(prior)
        current["input"].append({"type":"function_call_output","output":"new"})
        record={"request":prior,"status":"completed","raw_usage":{"input_tokens":40000}}
        self.assertLess(bounded_request(current,route,[record]),50000)
        for change in ("instructions","prefix","status","usage"):
            body=copy.deepcopy(current)
            evidence=copy.deepcopy(record)
            if change=="instructions":body["instructions"]="different"
            if change=="prefix":body["input"][0]["content"]+="different"
            if change=="status":evidence["status"]="failed"
            if change=="usage":evidence["raw_usage"]={}
            with self.assertRaisesRegex(ValueError,"input ceiling"):bounded_request(body,route,[evidence])

    def test_subscription_rejects_remote_context_paid_tools_and_output_mutation(self):
        for extra in ({"previous_response_id":"hidden"},{"tools":[{"type":"web_search"}]},{"max_output_tokens":1}):
            with self.assertRaises(ValueError):bounded_request({"input":[],**extra},self.route())
