import argparse
import base64
import copy
import io
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import tarfile
import tempfile
import time
import urllib.request

from . import pilot
from .compare import artifact, assessments, blind, digest, identity, load_runs, put, read, report, require, schedule, validate_manifest, write
from .curate import export_task
from .gateway import Budget, Gateway
from .isolation import restore, snapshot
from .runner import dispatch_assessors, evaluate, execute_run, native, validate_execution

REPO = Path(__file__).resolve().parents[1]
MODELS = ("gpt-5.6-sol", "gpt-6-astra")


def credentials():
    auth = read(Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))) / "auth.json")
    require(auth.get("tokens") and not auth.get("OPENAI_API_KEY"), "native ChatGPT login required")
    os.environ["OMD_SUBSCRIPTION_ACCESS"] = auth["tokens"]["access_token"]
    os.environ["OMD_SUBSCRIPTION_ACCOUNT"] = auth["tokens"]["account_id"]


def quota(require_available=True):
    request = urllib.request.Request("https://chatgpt.com/backend-api/wham/usage", headers={
        "Authorization": "Bearer " + os.environ["OMD_SUBSCRIPTION_ACCESS"],
        "ChatGPT-Account-Id": os.environ["OMD_SUBSCRIPTION_ACCOUNT"]})
    with urllib.request.urlopen(request, timeout=20) as response:
        body = json.load(response)
    selected = {k: v for k, v in body.items() if k in ("plan_type", "rate_limit", "credits", "additional_rate_limits")}
    if require_available:
        require(selected.get("rate_limit", {}).get("allowed") is True, "included quota unavailable")
        require(selected.get("rate_limit", {}).get("limit_reached") is False, "subscription limit reached")
        require(selected.get("credits", {}).get("has_credits") is False, "purchased-credit exposure is not authorized")
    return selected


def prepare(root):
    root = root.resolve()
    manifest = pilot.prepare(root)
    m = read(manifest)
    config = artifact(root, m["arms"]["default-upstream"]["configuration"]).read_text()
    config = config.replace("openai_pilot", "subscription")
    config = 'model_context_window=272000\nmodel_auto_compact_token_limit=240000\n' + config.replace('[features]\n', '[features]\nenable_request_compression=false\n')
    configuration = put(root, "inputs/subscription.toml", config)
    routes = {"subscription": {"url": "https://chatgpt.com/backend-api/codex", "credential_env": "OMD_SUBSCRIPTION_ACCESS",
        "account_env": "OMD_SUBSCRIPTION_ACCOUNT", "models": list(MODELS), "account_alias": "user-chatgpt-subscription",
        "billing": "subscription", "native_subscription": True, "included_usage_verified": True,
        "request_exposure_usd": "0", "timeout_seconds": 120,
        "bounds": {"input_accounting": "observed-prefix-v1", "input_token_ceiling": 240000,
                   "output_tokens": 32000, "requests_per_session": 60, "input_items": 512}}}
    model_path = artifact(root, m["arms"]["default-upstream"]["helpers"][0])
    models = read(model_path)
    for model in models["models"]:
        if model["slug"] in MODELS:
            require(model["context_window"] == 272000, "pinned model context changed")
            model["tool_mode"] = "direct"
    model_path.write_text(json.dumps(models))
    model_ref = {"path": str(model_path.relative_to(root)), "sha256": digest(model_path.read_bytes())}
    for arm in m["arms"].values():
        arm.update(provider="subscription", configuration=configuration, helpers=[model_ref])
        arm["configuration_note"] = "Pinned unmodified Codex; common native ChatGPT transport, high effort, direct tools, isolated source/state, bundled ripgrep. Configured upstream adds general inspection/reuse/check guidance. No solution hints."
    m["configuration_review"] = "Compare the same pinned upstream, lead, tools, authentication, context window and resources. General targeted inspection and verification guidance is the configured alternative; no Oh My Diff policies or benchmark-answer hints. This development qualification does not assert a globally optimal configuration."
    m["trials"] = 3
    limits = m["execution"]["limits"]
    limits.update(seconds=28800, requests=1000, usd_exposure="0", scope_usd={"task_api":"0", "evaluation":"0"},
                  max_output_tokens=32000, max_request_bytes=8000000, snapshot_bytes=32000000)
    m["controls"]["resource_limits"] = limits
    for assessor in m["execution"]["assessors"]:
        assessor.update(provider="subscription", configuration=configuration, helpers=[model_ref], path_helpers=m["arms"]["default-upstream"]["path_helpers"])
    m["execution"]["assessor_seconds"] = 120
    m["execution"].update(routes=routes, authorization={"manifest_purpose":"development", "subscription_requests_approved":True,
        "paid_requests_approved":False, "data_approved":True, "reference":"User approved included OpenAI subscription benchmarking and USD15/8h bounds, then instructed make Phase2 exit complete. This batch uses no paid fallback or credits."})
    task = m["tasks"][0]
    raw = read("/private/tmp/omd-mswe-data/instance.json")
    task["qualification_record"] = put(root, "private/serde-record.json", json.dumps(raw))
    prompt = artifact(root, task["prompt"]).read_text().replace("40 model requests within a shared spending cap", "60 model requests within shared time and subscription limits")
    task["prompt"] = put(root, "inputs/serde-task.txt", prompt)
    catalog = read(REPO / "benchmarks/corpus/catalog.json")
    selected = next(t for t in catalog["tasks"] if t["id"] == "psf/requests#6028")
    row_path = root / "private/requests-record.json"
    export_task(REPO / "benchmarks/corpus/catalog.json", selected["id"], Path("/private/tmp/omd-curation-private"), row_path, True)
    row = read(row_path)
    image_info = json.loads(subprocess.check_output(["docker", "image", "inspect", "omd-requests-6028-qualified"]))[0]
    image = image_info["RepoDigests"][0]
    raw_source = subprocess.check_output(["docker", "run", "--rm", "--pull=never", "--platform", "linux/amd64", "--network", "none", image, "git", "-C", "/testbed", "archive", selected["source_revision"]], timeout=60)
    with tempfile.TemporaryDirectory(prefix="omd-requests-source-") as tmp:
        with tarfile.open(fileobj=io.BytesIO(raw_source)) as archive:
            archive.extractall(tmp, filter="data")
        tree = snapshot(Path(tmp), limits["snapshot_bytes"])
    encoded = base64.b64encode(row["test_patch"].encode()).decode()
    apply = "printf %s " + shlex.quote(encoded) + " | base64 -d | git apply; "
    check = {"backend":"docker", "image":image, "cpus":4, "seconds":600, "tmpfs_mb":2048, "tmpfs_exec":True,
             "argv":["bash", "-ec", "source /opt/miniconda3/bin/activate testbed; export PYTHONPATH=/workspace; " + apply + "python -m pytest -rA --tb=short tests/test_utils.py"], "test_patch_command":apply}
    prompt = row["problem_statement"] + "\n\nImplement this task in the provided source. Only local shell, ripgrep and native patch tools are available; Python/pytest dependencies are unavailable in the agent sandbox. Do not install tools. Official tests run separately. Keep command output bounded to 2000 tokens; at most 60 model requests and 900 seconds. Preserve unrelated behavior and report checks actually run."
    m["tasks"].append({"id":selected["id"], "suite":selected["suite"], "family":selected["family"], "split":"development",
        "source_revision":selected["source_revision"], "source":put(root,"inputs/requests-source.json",json.dumps(tree)),
        "prompt":put(root,"inputs/requests-task.txt",prompt), "checks":put(root,"private/requests-checks.json",json.dumps(check)),
        "qualification_record":{"path":str(row_path.relative_to(root)),"sha256":digest(row_path.read_bytes())}})
    for task in m["tasks"]:
        check=read(artifact(root,task["checks"]))
        check["protected_tests"]=protected_tests(read(artifact(root,task["source"])),read(artifact(root,task["qualification_record"])))
        task["checks"]=put(root,"private/protected-"+task["suite"]+".json",json.dumps(check))
    m["qualification"] = {"catalog_sha256":identity(catalog), "freeze_sha256":identity(read(REPO/"benchmarks/corpus/freeze.json")),
        "selection":"One development task per suite: previously validated Serde; Requests 6028 uses the current development Requests version and official evaluator. No held-out selection or outcome-based task replacement.",
        "paid_usd":0, "request_limit":1000, "active_seconds":28800,
        "input_accounting":"Reuses exact provider input_tokens only for unchanged serialized request context prefixes and identical non-input fields; new serialized content gets conservative UTF8-byte and framing bounds. Falls back to full-content bound on mismatch. Every completed request verifies bounds; violation stops all admission. Native 272k window, 240k input admission, 32k output observation limit; subscription output is observed, not a hard monetary cap."}
    m.pop("pilot", None)
    manifest.write_text(json.dumps(m,indent=2)+"\n")
    (root/"plan.json").write_text(json.dumps({"manifest_sha256":identity(m),"schedule":schedule(m)},indent=2)+"\n")
    validate_manifest(m,root)
    return manifest


def score(log, row, suite):
    if suite == "external-multi-swe":
        passed = {m.group(1) for line in log.splitlines() if (m := re.match(r"test (\S+) ... ok", line.strip()))}
    else:
        passed = set()
        for line in log.splitlines():
            if not line.startswith("PASSED ") or len(line.split())<2:
                continue
            name=line.split()[1]
            option=re.search(r"(.*?)\[(.*)\]",name)
            if option and option[2].startswith("/") and not option[2].startswith("//") and "*" not in option[2]:
                name=option[1]+"[/"+option[2].split("/")[-1]+"]"
            passed.add(name)
    expected = set().union(*(set(row[k]) for k in ("p2p_tests", "f2p_tests", "s2p_tests", "n2p_tests")))
    return {"expected":len(expected), "passed":len(passed), "missing":sorted(expected-passed), "all_expected_passed":bool(expected) and expected<=passed}


def protected_tests(source, row):
    paths=set()
    for line in row["test_patch"].splitlines():
        if line.startswith(("--- a/", "+++ b/")):
            name=line[6:].split("\t",1)[0]
            require(not Path(name).is_absolute() and ".." not in Path(name).parts and any("test" in part for part in Path(name).parts), "non-test or unsafe protected path")
            paths.add(name)
    require(paths,"test patch has no protected paths")
    return {name:source["files"].get(name) for name in sorted(paths)}


def access(manifest):
    root=manifest.parent
    m=read(manifest)
    credentials()
    if not (root/"allowance.json").exists():
        write(root/"allowance.json", {"started_unix":time.time(), "active_seconds":28800, "paid_usd":0})
    folder=root/("access-retest" if (root/"access").exists() else "access")
    require(not folder.exists(), "access retry exhausted")
    write(folder/"quota.json",quota())
    budget=Budget(m["execution"]["limits"],folder/"budget")
    results=[]
    for model in MODELS:
        runtime=copy.deepcopy(m["arms"]["default-upstream"])
        runtime["requested_model"]=model
        output=folder/model
        with tempfile.TemporaryDirectory(prefix="omd-subscription-access-") as tmp:
            work=Path(tmp)/"source";state=Path(tmp)/"state"
            work.mkdir();state.mkdir()
            with Gateway(m["execution"]["routes"],budget,output) as gateway:
                result=native(root,runtime,'Synthetic subscription transport check. Use exec_command to run printf ACCESS_OK once, then reply ACCESS_OK. No other tools.',work,state,output/"native",gateway,m["execution"]["limits"],120)
            ledger=gateway.ledger()
        write(output/"result.json",{"native":result,"ledger":ledger})
        called=any(e.get("item",{}).get("name")=="exec_command" for r in gateway.records for e in r.get("events",[]) if e.get("type")=="response.output_item.done")
        ok=result["exit_code"]==0 and result["turn_completed"] and "ACCESS_OK" in result["answer"] and called and all(r.get("status")=="completed" for r in gateway.records)
        results.append({"model":model,"passed":ok,"requests":len(ledger),"active_seconds":result["wall_seconds"]})
        print(json.dumps(results[-1]),flush=True)
        require(ok,"native subscription access check failed; preserve evidence before retry")
    prior_requests=sum(1 for p in (root/"access").glob("*/requests/*.json")) if folder.name=="access-retest" else 0
    write(root/"access/summary.json",{"results":results,"requests":budget.count+prior_requests,"active_seconds":time.time()-read(root/"allowance.json")["started_unix"],"paid_usd":str(budget.reserved),"infrastructure_retest":"Initial probe requested unavailable update_plan; corrected to the configured exec_command tool for both models. Original requests retained." if prior_requests else None})


def verify(manifest):
    root = manifest.parent
    m = read(manifest)
    results = {}
    for task in m["tasks"]:
        retained=root/"verified-controls"/(task["suite"]+".json")
        if retained.exists():
            prior=read(retained)
            require(prior["source"]==task["source"] and prior["checks"]==task["checks"], "retained environment controls changed")
            results[task["id"]]=prior
            continue
        controls = {}
        row = read(artifact(root,task["qualification_record"]))
        selected = next(t for t in read(REPO/"benchmarks/corpus/catalog.json")["tasks"] if t["id"]==task["id"])
        require(digest(row["fix_patch"].encode())==selected["gold_sha256"] and digest(row["test_patch"].encode())==selected["test_patch_sha256"], "dataset patch identity changed")
        source = read(artifact(root,task["source"]))
        check = read(artifact(root,task["checks"]))
        for case in ("base", "test-only", "gold", "wrong"):
            current = copy.deepcopy(check)
            with tempfile.TemporaryDirectory(prefix="omd-qualification-control-") as tmp:
                work = Path(tmp)
                restore(source, work, m["execution"]["limits"]["snapshot_bytes"])
                if case == "gold":
                    subprocess.run(["git","apply","-"],input=row["fix_patch"].encode(),cwd=work,check=True,timeout=10)
                if case == "wrong":
                    (work/"qualification-wrong.txt").write_text("Ineffective control change.\n")
                tree = snapshot(work,m["execution"]["limits"]["snapshot_bytes"])
            if case == "base":
                current["argv"][-1] = current["argv"][-1].replace(current.get("test_patch_command", "git apply /home/test.patch; "), "")
            folder = root/"controls"/task["suite"]/case
            result = evaluate(current,tree,folder,m["execution"]["limits"],600)
            result["exact"] = score((folder/"stdout").read_text(errors="replace"),row,task["suite"])
            controls[case] = result
            write(folder/"result.json",result)
            print(json.dumps({"suite":task["suite"],"control":case,"exit":result["exit_code"],"missing":len(result["exact"]["missing"])}),flush=True)
        require(controls["base"]["exit_code"]==0 and controls["gold"]["exit_code"]==0 and controls["gold"]["exact"]["all_expected_passed"] and controls["test-only"]["exit_code"]!=0 and controls["wrong"]["exit_code"]!=0,"evaluator controls failed")
        results[task["id"]] = {"source":task["source"],"checks":task["checks"],"results":controls}
        write(retained,results[task["id"]])
    write(root/"qualification-environments.json",results)


def run(manifest):
    root=manifest.parent
    m=validate_manifest(read(manifest),root)
    require(m["purpose"]=="development" and m["comparison"]=="upstream-pilot", "development upstream pair only")
    require(m["execution"]["limits"]["seconds"]<=28800 and m["execution"]["limits"]["usd_exposure"]=="0", "qualification allowance exceeded")
    verified=read(root/"qualification-environments.json")
    for task in m["tasks"]:
        require(verified[task["id"]]["source"]==task["source"] and verified[task["id"]]["checks"]==task["checks"], "environment evidence drift")
    require(not (root/"started.json").exists(), "qualification already started; no allowance reset")
    access_summary=read(root/"access/summary.json")
    elapsed=time.time()-read(root/"allowance.json")["started_unix"]
    limits=copy.deepcopy(m["execution"]["limits"])
    limits["seconds"]=int(limits["seconds"]-elapsed)
    limits["requests"]-=access_summary["requests"]
    require(limits["seconds"]>0,"original qualification allowance exhausted")
    credentials()
    write(root/"quota-start.json",quota())
    validate_execution(m,root)
    write(root/"controller-sources.json",{p.name:put(root,"controller/"+p.name,p.read_bytes()) for p in (REPO/"benchmarks").glob("*.py")})
    write(root/"started.json",{"unix":time.time(),"manifest_sha256":identity(m),"paid_usd":0,"active_seconds":28800})
    budget=Budget(limits,root/"budget")
    for spec in schedule(m):
        write(root/"quota"/(spec["id"]+".json"),quota())
        task=next(t for t in m["tasks"] if t["id"]==spec["task"])
        result=execute_run(m,root,spec,root/"runs"/spec["id"],budget)
        log=root/"runs"/spec["id"]/"evaluator/stdout"
        exact=score(log.read_text(errors="replace") if log.exists() else "",read(artifact(root,task["qualification_record"])),task["suite"])
        result["checks"][0]["passed"] &= exact["all_expected_passed"]
        result["checks"][0]["exact_test_evidence"]=put(root/"runs"/spec["id"],"exact-tests.json",json.dumps(exact))
        (root/"runs"/spec["id"]/"run.json").write_text(json.dumps(result,indent=2)+"\n")
        print(json.dumps({"task":spec["task"],"arm":spec["arm"],"accepted":result["checks"][0]["passed"],"requests":budget.count}),flush=True)
    runs,missing=load_runs(m,root,root/"runs")
    blind(m,root,runs,root/"blinded")
    dispatch_assessors(m,root,root/"blinded",root/"assessments",budget)
    reviews,overhead=assessments(m,runs,root/"blinded/private/key.json",root/"assessments")
    write(root/"report.json",report(m,runs,missing,reviews,overhead))
    write(root/"budget-summary.json",{"paid_usd":str(budget.reserved),"requests":budget.count+access_summary["requests"],"active_seconds":time.time()-read(root/"allowance.json")["started_unix"],"paid_reserve_remaining_usd":15})
    try:
        write(root/"quota-end.json",quota(require_available=False))
    except Exception as error:
        write(root/"quota-end-error.json",{"type":type(error).__name__,"message":"Final quota read failed; budget and report retained."})


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("command",choices=("prepare","verify","access","run"))
    parser.add_argument("path",type=Path)
    args=parser.parse_args()
    if args.command=="prepare":print(prepare(args.path.resolve()))
    elif args.command=="verify":verify(args.path.resolve())
    elif args.command=="access":access(args.path.resolve())
    else:run(args.path.resolve())


if __name__=="__main__":main()
