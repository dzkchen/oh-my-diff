import argparse
import base64
import copy
from decimal import Decimal
import hashlib
import http.client
import json
import os
from pathlib import Path
import shutil
import tempfile
import time

from .compare import artifact, assessments, blind, digest, identity, load_runs, put, read, report, require, schedule, validate_manifest, write
from .gateway import Budget, Gateway, bounded_request
from .isolation import snapshot
from .pilot import parse_assessment, review_prompt
from .qualification import credentials, quota, score
from .qualification_assess import request_deadline
from .runner import execute_run, native, validate_execution


ROOT = Path(__file__).resolve().parents[1]
MODELS = ("gpt-5.6-sol", "gpt-5.6-luna")
ASSESSOR_ROUTES = dict(zip(MODELS, ("assessor_sol", "assessor_luna")))


def freeze_file(root, name, source):
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, path)
    with path.open("rb") as stream:
        return {"path": name, "sha256": hashlib.file_digest(stream, "sha256").hexdigest()}


def prepare(source, binary, output):
    require(not output.exists(), "experiment destination exists")
    previous = read(source / "manifest.json")
    m = copy.deepcopy(previous)
    require(m["purpose"] == "development", "development inputs required")
    output.mkdir(parents=True)
    def copy_refs(node):
        if isinstance(node, dict):
            if set(node) == {"path", "sha256"}:
                original = artifact(source, node)
                target = output / node["path"]
                if not target.exists():
                    freeze_file(output, node["path"], original)
            else:
                for value in node.values():
                    copy_refs(value)
        elif isinstance(node, list):
            for value in node:
                copy_refs(value)
    copy_refs(m)
    catalog = read(ROOT / "benchmarks/corpus/catalog.json")
    for task in m["tasks"]:
        selected = next(t for t in catalog["tasks"] if t["id"] == task["id"])
        require(selected["split"] == "development" and selected["source_revision"] == task["source_revision"], "frozen task identity differs")
        check = read(artifact(output, task["checks"]))
        check["seconds"] = min(check["seconds"], 300)
        task["checks"] = put(output, "private/controlled-" + task["suite"] + ".json", json.dumps(check))
    require({t["id"] for t in m["tasks"]} == {"serde-rs/serde#2798", "psf/requests#6028"}, "unexpected benchmark selection")
    m.pop("evaluation_replay", None)
    m.pop("qualification", None)
    m.update(comparison="three-arm", trials=3, states=["cold"], experiment="fixed-model")
    m["assessment"]["models"] = list(MODELS)
    models = read(artifact(output, m["arms"]["default-upstream"]["helpers"][0]))
    for model in models["models"]:
        model.update(tool_mode="direct", prefer_websockets=False)
    model_ref = put(output, "inputs/controlled-models.json", json.dumps(models))
    config = 'model_context_window=272000\nmodel_auto_compact_token_limit=240000\nmodel_reasoning_effort="high"\nmodel_catalog_json=' + json.dumps(str(output / model_ref["path"])) + '\nweb_search="disabled"\n[features]\nenable_request_compression=false\ncode_mode=false\nshell_snapshot=false\napps=false\nplugins=false\nmemories=false\nmulti_agent=true\n[agents]\nmax_threads=2\nmax_depth=1\n[model_providers.subscription]\nrequest_max_retries=0\nstream_max_retries=0\nstream_idle_timeout_ms=120000\n[model_providers.contributor]\nrequest_max_retries=0\nstream_max_retries=0\nstream_idle_timeout_ms=120000\n[analytics]\nenabled=false\n[feedback]\nenabled=false\n'
    config_ref = put(output, "inputs/controlled-common.toml", config)
    common = "Fixed assignment: you are the Sol/high lead. Keep the whole task within 60 total model requests and 900 seconds, including children and review. Do not use other models except the assigned worker and Astra/high reviewer. After implementation, obtain one fresh review with instructions to read only from gpt-6-astra with high reasoning, using native spawn_agent with fork_context false; inspect its findings and account for any repair before finishing. Close finished workers before starting another. Preserve unrelated behavior. Local executable checks are limited; official tests run separately."
    instructions = {
        "default-upstream": "Implement the task directly using the native tools. " + common,
        "configured-upstream": "Use targeted searches, batch independent reads, reuse existing abstractions, and make the smallest complete change. Delegate the bounded implementation to one fresh native gpt-5.6-sol/high worker with fork_context false and a focused brief. Inspect its result before review. " + common,
        "omd": "Use targeted searches to prepare a focused implementation brief, then call omd_contribute exactly once. That native tool assigns Contributor/low, runs git diff --check, obtains fresh Astra/high review, and integrates only the approved candidate. Do not call spawn_agent or bypass a failed integration gate by editing the parent. Report tool failure accurately. The task has 60 shared model requests and 900 seconds; the worker has 20 requests and 300 seconds."
    }
    for name, arm in m["arms"].items():
        arm.update(control_label=name, configuration=config_ref, helpers=[model_ref], native_permissions=True,
                   in_task_review_models=["gpt-6-astra"], instructions=put(output, "inputs/" + name + ".txt", instructions[name]),
                   configuration_note="Pinned unmodified upstream; common native restricted filesystem, tools, included subscription, Sol/high lead and Astra/high review. " + ("Direct implementation." if name == "default-upstream" else "Focused native Sol/high implementation worker; qualify before the fixed experiment."))
    omd = copy.deepcopy(m["arms"]["configured-upstream"])
    omd.update(control_label="omd", binary=freeze_file(output, "inputs/omd/codex", binary),
               instructions=put(output, "inputs/omd.txt", instructions["omd"]),
               configuration_note="Pinned native controlled-delegation patch; Contributor/low implementation replaces the native Sol/high worker. Common Sol/high lead, Astra/high review, source, local tools and resource bounds. OMD enforces reviewer read-only permissions; unmodified baseline reviewers inherit parent write permissions and are instructed to read only.",
               runtime_patches=[freeze_file(output, "inputs/controlled-runtime.patch", ROOT / read(ROOT / "runtime/patches/manifest.json")["patch"]["path"])])
    grant = read(ROOT / ".docs/audits/evidence/controlled-contributor-20260913/data-authorization.json")
    require(grant.get("data_authorized") is True, "Contributor grant missing")
    authorization = put(output, "private/contributor-authorization.json", json.dumps(grant))
    omd["controlled"] = put(output, "inputs/controlled-policy.json", json.dumps({"authorization": authorization, "revocation_authority": str(ROOT / ".docs/audits/evidence/controlled-contributor-20260913/data-authorization.json"), "authority_sha256": digest((ROOT / ".docs/audits/evidence/controlled-contributor-20260913/data-authorization.json").read_bytes())}))
    m["arms"]["omd"] = omd
    m["controls"]["permissions"] = "Native named profile: source write, minimal platform defaults, explicit executable/toolchain reads, no tool network, no provider credentials; host-owned runtime and gateway outside tool sandbox. Shared process census and OS CPU/file limits."
    m["configuration_review"] = "Qualify one configured native-delegation run per development suite before the randomized three-arm schedule. Fixed lead/reviewer assignments, common permissions/tools/resources, native Sol worker versus controlled Contributor worker. If native delegation cannot qualify, retain its failures and stop with an inconclusive comparison; do not promote a weak comparator."
    limits = m["execution"]["limits"]
    limits.update(seconds=28800, requests=1300, max_request_bytes=220000, usd_exposure="15", scope_usd={"task_api": "3.10", "evaluation": "11.90"})
    m["controls"]["resource_limits"] = copy.deepcopy(limits)
    subscription = m["execution"]["routes"]["subscription"]
    contributor = {"url": "https://api.meta.ai/v1", "credential_env": "OMD_CONTRIBUTOR_KEY", "models": ["muse-spark-1.3-contributor"],
                   "account_alias": "user-meta-contributor", "billing": "estimate", "request_exposure_usd": "0.025",
                   "timeout_seconds": 120, "settle_completed_usage": True,
                   "bounds": {"input_token_ceiling": 220000, "output_tokens": 8192, "requests_per_session": 60, "reasoning_tokens_per_item": 8192, "session_usd": "0.50", "input_items": 512},
                   "rates": {"semantics": "input-includes-disjoint-cache;output-includes-reasoning", "input": "0.10", "cache_read": "0.002", "cache_write": "0.10", "output": "0.20"},
                   "rate_card": "User account display supplied 2026-09-14; USD per million tokens and cache writes at ordinary input rate are explicit approval assumptions, not verified account documentation."}
    routes = {"subscription": subscription, "contributor": contributor}
    for model, inp, cache, out in ((MODELS[0], "4", "0.4", "20"), (MODELS[1], "0.20", "0.02", "1.20")):
        write_rate = Decimal(inp) * Decimal("1.25")
        reservation = (Decimal(40000) * write_rate + Decimal(4096) * Decimal(out)) / 1000000
        routes[ASSESSOR_ROUTES[model]] = {"url": "https://api.openai.com/v1", "credential_env": "OPENAI_API_KEY", "models": [model],
                         "account_alias": "user-openai-api", "billing": "estimate", "request_exposure_usd": str(reservation),
                         "timeout_seconds": 115, "bounds": {"input_token_ceiling": 40000, "output_tokens": 4096, "requests_per_session": 1},
                         "rates": {"semantics": "input-includes-disjoint-cache;output-includes-reasoning", "input": inp, "cache_read": cache, "cache_write": str(write_rate), "output": out},
                         "rate_card": "https://developers.openai.com/api/docs/models/" + model + " verified 2026-09-14; USD per 1M, default tier, short context; cache writes reserved at 1.25x input."}
    m["execution"]["routes"] = routes
    m["execution"]["assessors"] = [{**copy.deepcopy(m["arms"]["default-upstream"]), "model": model, "provider": ASSESSOR_ROUTES[model]} for model in MODELS]
    m["execution"]["authorization"] = {"manifest_purpose": "development", "paid_requests_approved": False, "subscription_requests_approved": False, "data_approved": True, "reference": "Pending approval of this concrete experiment plan; repository submission authorization retained."}
    m["execution"]["guideline_cost"] = "unknown-development-overhead-retained"
    m["cost_experiment"] = {"source_manifest_sha256": identity(previous), "catalog_sha256": identity(catalog),
                            "freeze_sha256": identity(read(ROOT / "benchmarks/corpus/freeze.json")),
                            "assessment_mode": "Two distinct models, one fresh source-excerpt packet per candidate; no in-task reviewer overlap; 32KB packet limit, 4096 output tokens, no retry.",
                            "development_overhead": "Retain all synthetic failures, build/test/review evidence and unknown orchestration usage separately; unknown development cost cannot certify total-cost savings.",
                            "decision_rule": "Keep only for further development validation if both suites retain executable and assessor quality and measured full task cost improves by at least 20% against qualified configured upstream. Unknown usage/pricing/overhead or incomplete schedule is inconclusive. No held-out claim."}
    validate_manifest(m, output)
    write(output / "manifest.json", m)
    reservation = Decimal("3.10") + 19 * sum(Decimal(routes[ASSESSOR_ROUTES[model]]["request_exposure_usd"]) for model in MODELS)
    require(reservation <= 15, "complete paid schedule exceeds proposed allowance")
    plan = {"schema": 1, "manifest_sha256": identity(m), "roles": {"lead": "gpt-5.6-sol/high", "reviewer": "gpt-6-astra/high", "worker": "muse-spark-1.3-contributor/low", "assessors": list(MODELS)},
            "scope": "Two development suites, two configured-control qualification runs, three cold repeats of three arms (18 core runs), 36 independent assessments; five synthetic access checks; no whole-task or provider retries.",
            "maximum_paid_reservation_usd": str(reservation), "paid_cap_usd": "15", "active_seconds": 28800,
            "core_schedule": schedule(m), "allowance_approved": False,
            "controller_sha256": {p.name: digest(p.read_bytes()) for p in Path(__file__).parent.glob("*.py")},
            "pricing_assumptions": {"unit": "USD per one million tokens", "contributor_input": "0.10", "contributor_cached_input": "0.002", "contributor_output": "0.20", "contributor_cache_write": "ordinary input rate; no separate price displayed"}}
    write(output / "plan.json", plan)
    return plan


def load_credentials():
    credentials()
    for line in (ROOT / ".env").read_text().splitlines():
        name, separator, value = line.strip().removeprefix("export ").partition("=")
        target = {"museapi": "OMD_CONTRIBUTOR_KEY", "OPENAI_API_KEY": "OPENAI_API_KEY"}.get(name.strip())
        if separator and target:
            os.environ[target] = value.strip().strip("\"'")
    require(all(os.environ.get(key) for key in ("OMD_CONTRIBUTOR_KEY", "OPENAI_API_KEY")), "required provider credentials unavailable")


def assessment_runs(m, root, budget):
    for path in sorted((root / "blinded/packets").glob("*.json")):
        packet = read(path)
        for model in MODELS:
            uid = packet["candidate_id"] + "-" + model
            target = root / "assessments" / uid
            route = m["execution"]["routes"][ASSESSOR_ROUTES[model]]
            started = time.monotonic()
            result, scores, error = {}, {}, None
            with Gateway({"review": route}, budget, target, scope="evaluation") as gateway:
                try:
                    body = {"model": model, "input": review_prompt(packet, path.parent, 32000), "reasoning": {"effort": "high"},
                            "store": False, "stream": False, "max_output_tokens": 4096, "service_tier": "default"}
                    bounded_request(body, route)
                    conn = http.client.HTTPConnection("127.0.0.1", gateway.port, timeout=min(115, budget.remaining_seconds()))
                    try:
                        with request_deadline(min(110, budget.remaining_seconds())):
                            conn.request("POST", "/review/responses", json.dumps(body), {"Authorization": "Bearer " + gateway.token, "thread-id": uid})
                            response = conn.getresponse()
                            result = json.loads(response.read())
                            require(response.status == 200 and result.get("status") == "completed", "assessment did not complete")
                            require(result.get("model") == model, "returned assessor differs")
                            scores = parse_assessment(result)
                    finally:
                        conn.close()
                except Exception as failure:
                    error = type(failure).__name__ + ": " + str(failure)
            ledger = gateway.ledger()
            for event in ledger:
                event["evidence"]["path"] = uid + "/" + event["evidence"]["path"]
            write(root / "assessments" / (uid + ".json"), {"candidate_id": packet["candidate_id"], "packet_sha256": identity(packet),
                  "model": model, "returned_model": result.get("model"), "independent_session": uid,
                  "wall_seconds": time.monotonic() - started, "evidence": put(root / "assessments", uid + "/response.json", json.dumps(result)),
                  "ledger": ledger, "status": "failed" if error else "completed", "error": error, **scores})
            print(json.dumps({"assessment": uid, "status": "failed" if error else "completed"}), flush=True)


def controlled_attribution(folder):
    native_records = {}
    for path in sorted((folder / "native/controlled-evidence").glob("0*.json")):
        record = read(path)["record"]
        attempt = record.get("attempt")
        if attempt:
            native_records[attempt["request"]] = attempt
    wire = sorted((read(p) for p in (folder / "requests").glob("*.json")), key=lambda r: r.get("started", 0))
    native = list(native_records.values())
    by_id = {str(record.get("native_request_id")): record for record in wire}
    matches = len(native) == len(wire) == len(by_id)
    role_routes = {"lead": ("openai", "subscription"), "contributor": ("meta", "contributor"), "reviewer": ("openai", "subscription")}
    for attempt in native:
        record = by_id.get(str(attempt["request"]), {})
        provider, route = role_routes.get(attempt["owner"], (None, None))
        matches &= (attempt["owner"] == record.get("native_owner") and attempt["provider"] == provider and record.get("route") == route
                    and attempt["model"] == record.get("requested_model") and attempt.get("raw_usage") == record.get("raw_usage")
                    and (attempt["status"] == "completed") == (record.get("status") == "completed"))
    value = {"schema": 1, "matched": matches, "native_attempts": native,
             "gateway_requests": [{k: r.get(k) for k in ("id", "native_request_id", "native_owner", "thread_id", "route", "requested_model", "returned_model", "raw_usage", "status", "sent")} for r in wire]}
    write(folder / "native-attribution.json", value)
    return matches


def fixed_roles(records, lead_threads, arm):
    if len(lead_threads) != 1 or not records:
        return False
    children = {}
    root_seen = False
    for record in records:
        model = record.get("requested_model")
        if record.get("status") != "completed" or model != record.get("returned_model") or not isinstance(record.get("raw_usage"), dict):
            return False
        if record.get("request", {}).get("reasoning", {}).get("effort") != ("low" if model == "muse-spark-1.3-contributor" else "high"):
            return False
        thread = record.get("thread_id")
        if thread in lead_threads:
            if model != "gpt-5.6-sol" or record.get("role"):
                return False
            root_seen = True
        else:
            if not thread or not record.get("role"):
                return False
            children.setdefault(thread, set()).add(model)
    expected = ["gpt-6-astra"] + ([] if arm == "default-upstream" else ["gpt-5.6-sol" if arm == "configured-upstream" else "muse-spark-1.3-contributor"])
    return root_seen and all(len(models) == 1 for models in children.values()) and sorted(next(iter(models)) for models in children.values()) == sorted(expected)


def fresh_spawns(records, lead_threads, arm):
    calls = []
    for record in sorted(records, key=lambda r: r.get("started", 0)):
        for event in record.get("events", []):
            item = event.get("item", {})
            if event.get("type") != "response.output_item.done" or item.get("name") != "spawn_agent":
                continue
            if record.get("thread_id") not in lead_threads:
                return False
            try:
                args = json.loads(item["arguments"])
            except (KeyError, TypeError, ValueError):
                return False
            if args.get("fork_context", False) is not False or args.get("reasoning_effort") != "high":
                return False
            calls.append(args.get("model"))
    return calls == (["gpt-5.6-sol"] if arm == "configured-upstream" else []) + ["gpt-6-astra"]


def final_candidate_matches(folder, results):
    integrated = [r for r in results if r.get("status") == "integrated"]
    if len(results) != 1 or len(integrated) != 1:
        return False
    result = integrated[0]
    candidate = folder / "native/controlled-evidence/candidate.json"
    raw = candidate.read_bytes()
    if digest(raw) != result["candidate"]["sha256"] or digest(raw) != result["candidate_sha256"]:
        return False
    files = read(folder / "candidate-tree.json")["files"]
    if any("symlink" in entry for entry in files.values()):
        return False
    final = {name: {"bytes": list(base64.b64decode(entry["base64"], validate=True)), "executable": entry["mode"] == 0o755} for name, entry in files.items()}
    return final == json.loads(raw)["files"]


def scored_run(m, root, spec, folder, budget):
    run = execute_run(m, root, spec, folder, budget)
    task = next(t for t in m["tasks"] if t["id"] == spec["task"])
    log = folder / "evaluator/stdout"
    exact = score(log.read_text(errors="replace") if log.exists() else "", read(artifact(root, task["qualification_record"])), task["suite"])
    run["checks"][0]["passed"] &= exact["all_expected_passed"]
    run["checks"][0]["exact_test_evidence"] = put(folder, "exact-tests.json", json.dumps(exact))
    records = [read(p) for p in (folder / "requests").glob("*.json")]
    lead_threads = set(read(folder / "trace.json").get("thread_ids", []))
    roles_ok = fixed_roles(records, lead_threads, spec["arm"])
    if spec["arm"] != "omd":
        roles_ok &= fresh_spawns(records, lead_threads, spec["arm"])
    if spec["arm"] == "omd":
        results = [read(p) for p in (folder / "native/controlled-evidence").glob("worker-result-*.json")]
        roles_ok &= final_candidate_matches(folder, results)
        run["coverage"]["task_api"] &= controlled_attribution(folder)
    if not roles_ok:
        run["status"] = "failed"
    run["fixed_roles_observed"] = roles_ok
    (folder / "run.json").write_text(json.dumps(run, indent=2) + "\n")
    return run


def run(plan_path, approved_sha256):
    root = plan_path.parent
    plan = read(plan_path)
    require(identity(plan) == approved_sha256, "approval must bind the exact experiment plan")
    m = validate_manifest(read(root / "manifest.json"), root)
    require(identity(m) == plan["manifest_sha256"], "manifest changed after approval")
    require(not (root / "started.json").exists(), "experiment already started; no reset or automatic retry")
    require(plan["controller_sha256"] == {p.name: digest(p.read_bytes()) for p in Path(__file__).parent.glob("*.py")}, "controller changed after plan approval")
    overall_started = time.monotonic()
    validated = copy.deepcopy(m)
    validated["execution"]["authorization"].update(paid_requests_approved=True, subscription_requests_approved=True)
    write(root / "started.json", {"unix": time.time(), "approved_plan_sha256": approved_sha256, "scope": plan["scope"], "pricing_assumptions": plan["pricing_assumptions"]})
    write(root / "controller-sources.json", {p.name: put(root, "controller/" + p.name, p.read_bytes()) for p in Path(__file__).parent.glob("*.py")})
    budget = Budget(m["execution"]["limits"], root / "budget")
    budget.started = overall_started
    failure = None
    try:
        load_credentials()
        validate_execution(validated, root)
        write(root / "quota-start.json", quota())
        for model, provider in (("gpt-5.6-sol", "subscription"), ("gpt-6-astra", "subscription"), ("muse-spark-1.3-contributor", "contributor")):
            runtime = copy.deepcopy(m["arms"]["default-upstream"])
            runtime.update(requested_model=model, provider=provider, reasoning="low" if provider == "contributor" else "high", instructions=put(root, "access/" + model + ".txt", "Run printf ACCESS_OK exactly once with exec_command, then return ACCESS_OK. Do not delegate."))
            with tempfile.TemporaryDirectory(prefix="omd-controlled-access-") as tmp:
                workspace, home = Path(tmp) / "source", Path(tmp) / "state"
                workspace.mkdir(); home.mkdir()
                (workspace / "access.txt").write_text("Synthetic access fixture\n")
                folder = root / "access" / model
                access_route = copy.deepcopy(m["execution"]["routes"][provider])
                access_route.setdefault("bounds", {}).update(requests_per_session=2)
                with Gateway({provider: access_route}, budget, folder) as gateway:
                    result = native(root, runtime, "Perform the synthetic access check.", workspace, home, folder / "native", gateway, m["execution"]["limits"], min(120, budget.remaining_seconds()))
                write(folder / "result.json", {"native": result, "ledger": gateway.ledger()})
                calls = [e["item"] for r in gateway.records for e in r.get("events", []) if e.get("type") == "response.output_item.done" and e.get("item", {}).get("type") == "function_call"]
                called = len(calls) == 1 and calls[0].get("name") == "exec_command" and json.loads(calls[0]["arguments"]).get("cmd") == "printf ACCESS_OK"
                require(called and result["exit_code"] == 0 and result["turn_completed"] and "ACCESS_OK" in result["answer"] and all(r.get("status") == "completed" for r in gateway.records), "provider access qualification failed")
        for model in MODELS:
            folder = root / "access" / (model + "-assessor")
            route = m["execution"]["routes"][ASSESSOR_ROUTES[model]]
            with Gateway({"review": route}, budget, folder, scope="evaluation") as gateway:
                conn = http.client.HTTPConnection("127.0.0.1", gateway.port, timeout=min(115, budget.remaining_seconds()))
                try:
                    with request_deadline(min(110, budget.remaining_seconds())):
                        body = {"model": model, "input": "Synthetic account access check. Return exactly ACCESS_OK.", "reasoning": {"effort": "high"}, "store": False, "stream": False, "max_output_tokens": 4096, "service_tier": "default"}
                        conn.request("POST", "/review/responses", json.dumps(body), {"Authorization": "Bearer " + gateway.token, "thread-id": model + "-access"})
                        response = conn.getresponse()
                        result = json.loads(response.read())
                finally:
                    conn.close()
            write(folder / "result.json", {"response": result, "ledger": gateway.ledger()})
            require(response.status == 200 and result.get("status") == "completed" and result.get("model") == model and "ACCESS_OK" in json.dumps(result.get("output")), "assessor access qualification failed")
        for index, task in enumerate(m["tasks"]):
            spec = {"id": "configured-qualification-" + str(index), "arm": "configured-upstream", "task": task["id"], "suite": task["suite"], "state": "cold", "trial": -1}
            qualified = scored_run(m, root, spec, root / "qualification" / spec["id"], budget)
            require(qualified["status"] == "completed" and qualified["checks"][0]["passed"], "configured native delegation did not qualify; do not run a weak comparator")
        for spec in plan["core_schedule"]:
            quota()
            result = scored_run(m, root, spec, root / "runs" / spec["id"], budget)
            print(json.dumps({"run": spec["id"], "arm": spec["arm"], "status": result["status"], "passed": result["checks"][0]["passed"]}), flush=True)
        runs, missing = load_runs(m, root, root / "runs")
        blind(m, root, runs, root / "blinded")
        assessment_runs(m, root, budget)
        reviews, overhead = assessments(m, runs, root / "blinded/private/key.json", root / "assessments")
        write(root / "report.json", report(m, runs, missing, reviews, overhead))
    except (Exception, KeyboardInterrupt, SystemExit) as error:
        budget.stopped = True
        failure = type(error).__name__ + ": " + str(error)
        write(root / "experiment-failure.json", {"error": failure, "remaining_seconds": budget.remaining_seconds(), "paid_exposure_usd": str(budget.reserved)})
    finally:
        write(root / "budget-summary.json", {"requests": budget.count, "reserved_or_settled_upper_usd": str(budget.reserved), "scope_usd": {k: str(v) for k, v in budget.by_scope.items()}, "active_seconds": time.monotonic() - budget.started, "failure": failure,
              "development_overhead": m["cost_experiment"]["development_overhead"], "invoice_reconciled": False})
        reconcile(root, plan, budget, failure)
    return read(root / "decision.json")


def reconcile(root, plan, budget, failure):
    attempts = []
    for path in sorted(root.glob("**/requests/*.json")):
        record = read(path)
        attempts.append({"evidence": {"path": str(path.relative_to(root)), "sha256": digest(path.read_bytes())},
                         "stage": path.relative_to(root).parts[0],
                         **{key: record.get(key) for key in ("id", "admission", "route", "requested_model", "returned_model", "status", "sent", "raw_usage", "started", "finished")}})
    ids = [attempt["id"] for attempt in attempts]
    require(len(ids) == len(set(ids)), "duplicate raw request evidence in experiment accounting")
    stages = {}
    for attempt in attempts:
        stage = stages.setdefault(attempt["stage"], {"attempts": 0, "sent": 0, "failed_or_incomplete": 0, "missing_raw_usage": 0})
        stage["attempts"] += 1
        stage["sent"] += bool(attempt["sent"])
        stage["failed_or_incomplete"] += attempt["status"] != "completed"
        stage["missing_raw_usage"] += bool(attempt["sent"]) and not isinstance(attempt["raw_usage"], dict)
    observed_admissions = {a["admission"] for a in attempts if a.get("admission") is not None}
    missing_admissions = sorted(set(range(1, budget.count + 1)) - observed_admissions)
    assessment_wall = sum(read(p).get("wall_seconds", 0) for p in (root / "assessments").glob("*.json"))
    write(root / "all-overhead.json", {"schema": 1, "attempts": attempts, "stages": stages,
          "admissions": budget.count, "missing_request_evidence_for_admissions": missing_admissions, "unsettled_admissions": sorted(budget.open_reservations),
          "reserved_or_settled_upper_usd": str(budget.reserved), "active_wall_seconds_including_setup_and_failures": time.monotonic() - budget.started,
          "assessment_wall_seconds_including_failures": assessment_wall,
          "development": {"evidence": ".docs/audits/evidence/controlled-contributor-20260914/validation/index.json", "raw_orchestrator_usage": None, "cost": None,
                          "status": "unknown; all retained build, fixture, test and separate-model review attempts count as development overhead"},
          "included_subscription_cost": None, "invoice_reconciled": False})
    result = read(root / "report.json") if (root / "report.json").exists() else {}
    reasons = ["Development orchestration usage and included subscription allocation are unknown; total-cost savings cannot be certified."]
    if missing_admissions:
        reasons.append("Admitted requests lack raw evidence: " + str(missing_admissions))
    if failure:
        reasons.append(failure)
    if not result.get("schedule_complete") or not result.get("assessment_complete"):
        reasons.append("The complete controlled schedule and independent assessments did not finish.")
    write(root / "decision.json", {"schema": 1, "decision": "reject-promotion", "cost_result": "inconclusive", "reasons": reasons,
          "plan_sha256": identity(plan), "claim": "Development experiment only; no verified savings or held-out quality claim.",
          "evidence": ["all-overhead.json", "budget-summary.json"] + (["report.json"] if result else [])})


def main():
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    setup = commands.add_parser("prepare")
    setup.add_argument("source", type=Path)
    setup.add_argument("binary", type=Path)
    setup.add_argument("destination", type=Path)
    execute = commands.add_parser("run")
    execute.add_argument("plan", type=Path)
    execute.add_argument("--approved-plan-sha256", required=True)
    args = parser.parse_args()
    if args.command == "prepare":
        result = prepare(args.source.resolve(), args.binary.resolve(), args.destination.resolve())
    else:
        result = run(args.plan.resolve(), args.approved_plan_sha256)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
