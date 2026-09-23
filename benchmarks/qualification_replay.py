import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import shutil
import time

from .compare import artifact, assessments, digest, identity, load_runs, put, read, report, require, schedule, validate_manifest, write
from .qualification import protected_tests, score
from .runner import evaluate


def replay(source, output):
    require(source.resolve()!=output.resolve() and not output.resolve().is_relative_to(source.resolve()), "replay must be separate from original evidence")
    original=read(source/"manifest.json")
    original_report=read(source/"report.json")
    require(original_report["schedule_complete"], "complete original schedule required")
    require(not output.exists(), "replay already exists; preserve original attempts")
    shutil.copytree(source,output,ignore=shutil.ignore_patterns("workspace", "state", "tmp", "controls", "verified-controls", "access", "access-retest", "access-retest-local-admission-failure", "subscription-fixture"))
    m=read(output/"manifest.json")
    write(output/"original-manifest.json",original)
    write(output/"original-report.json",original_report)
    write(output/"replay-controller-sources.json",{p.name:put(output,"replay-controller/"+p.name,p.read_bytes()) for p in Path(__file__).parent.glob("*.py")})
    control_equivalence={}
    for task in m["tasks"]:
        base=read(artifact(output,task["source"]))
        row=read(artifact(output,task["qualification_record"]))
        check=read(artifact(output,task["checks"]))
        check["protected_tests"]=protected_tests(base,row)
        require(all(base["files"].get(name)==value for name,value in check["protected_tests"].items()), "base control overlay changed")
        gold_paths={line[6:].split("\t",1)[0] for line in row["fix_patch"].splitlines() if line.startswith(("--- a/","+++ b/"))}
        require(not gold_paths.intersection(check["protected_tests"]), "gold control changes protected inputs; new controls required")
        control_equivalence[task["id"]]={"base_test_only_gold_wrong_overlays_unchanged":True,"protected_paths":sorted(check["protected_tests"]),"source_sha256":task["source"]["sha256"],"test_patch_sha256":digest(row["test_patch"].encode())}
        task["checks"]=put(output,"private/protected-"+task["suite"]+".json",json.dumps(check))
    m["evaluation_replay"]={"original_manifest_sha256":identity(original),"original_report_sha256":identity(original_report),
        "reason":"Candidate edits to test-patch paths prevented private test application. Restore only those test inputs from the pinned base before applying the identical private test patch. Replay every arm/trial symmetrically; preserve original candidates, assessments, failures, task costs and timings. No model requests or task-input changes.",
        "scope":"development-only evaluator infrastructure correction; original evaluator outcomes are retained, not relabeled as original passes"}
    (output/"manifest.json").write_text(json.dumps(m,indent=2)+"\n")
    validate_manifest(m,output)
    write(output/"protected-inputs.json",control_equivalence)
    id_map={old["id"]:new["id"] for old,new in zip(schedule(original),schedule(m))}
    key=read(output/"blinded/private/key.json")
    write(output/"blinded/private/original-key.json",key)
    key["manifest_sha256"]=identity(m)
    for entry in key["candidates"].values():entry["run_id"]=id_map[entry["run_id"]]
    (output/"blinded/private/key.json").write_text(json.dumps(key,indent=2)+"\n")
    write(output/"original-plan.json",read(output/"plan.json"))
    (output/"plan.json").write_text(json.dumps({"manifest_sha256":identity(m),"schedule":schedule(m)},indent=2)+"\n")
    for old_path in sorted((output/"runs").glob("*/run.json")):
        new_parent=old_path.parent.with_name(id_map[old_path.parent.name])
        old_path.parent.rename(new_parent)
        path=new_parent/"run.json"
        run=read(path)
        task=next(t for t in m["tasks"] if t["id"]==run["task"])
        remaining=28800-(time.time()-read(source/"allowance.json")["started_unix"])
        require(remaining>0,"original eight-hour allowance exhausted")
        candidate=read(path.parent/"candidate-tree.json")
        check=read(artifact(output,task["checks"]))
        evaluated=evaluate(check,candidate,path.parent/"replayed-evaluator",m["execution"]["limits"],min(600,remaining))
        exact=score((path.parent/"replayed-evaluator/stdout").read_text(errors="replace"),read(artifact(output,task["qualification_record"])),task["suite"])
        write(path.parent/"original-run.json",run)
        original_check=run["checks"][0]
        original_id=run["id"]
        run["id"]=id_map[original_id]
        run["manifest_sha256"]=identity(m)
        run["check_definition_sha256"]=task["checks"]["sha256"]
        run["evaluation_wall_seconds"]+=evaluated["wall_seconds"]
        run["finished_at"]=datetime.now(timezone.utc).isoformat()
        run["evaluator_replay"]={"original_id":original_id,"original_check":original_check,"original_run_sha256":digest((path.parent/"original-run.json").read_bytes()),"additional_seconds":evaluated["wall_seconds"],"model_requests":0}
        run["checks"]=[{"command":evaluated["command"],"passed":evaluated["exit_code"]==0 and not evaluated["stop_reason"] and exact["all_expected_passed"],"candidate_sha256":run["candidate"]["sha256"],"evidence":put(path.parent,"replayed-check.json",json.dumps(evaluated)),"exact_test_evidence":put(path.parent,"replayed-exact-tests.json",json.dumps(exact))}]
        path.write_text(json.dumps(run,indent=2)+"\n")
        print(json.dumps({"task":task["id"],"arm":run["arm"],"trial":run["trial"],"accepted":run["checks"][0]["passed"],"missing":len(exact["missing"])}),flush=True)
    runs,missing=load_runs(m,output,output/"runs")
    reviews,overhead=assessments(m,runs,output/"blinded/private/key.json",output/"assessments")
    result=report(m,runs,missing,reviews,overhead)
    (output/"report.json").write_text(json.dumps(result,indent=2)+"\n")
    write(output/"replay-summary.json",{"model_requests":0,"original_task_costs_preserved":True,"original_assessments_preserved":True,"original_evaluation_costs_preserved":True,"all_arms_and_trials_replayed":True,"active_seconds_since_allowance_start":time.time()-read(source/"allowance.json")["started_unix"]})


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("source",type=Path)
    parser.add_argument("output",type=Path)
    args=parser.parse_args()
    replay(args.source.resolve(),args.output.resolve())


if __name__=="__main__":main()
