import argparse
import json
from pathlib import Path


def developer_text(request):
    return json.dumps([entry for entry in request["body"]["input"] if entry.get("role") == "developer"], sort_keys=True)


def developer_bytes(request):
    return sum(len(json.dumps(entry, sort_keys=True, separators=(",", ":")).encode())
               for entry in request["body"]["input"] if entry.get("role") == "developer" and entry.get("type") == "message")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("baseline", type=Path)
    parser.add_argument("candidate", type=Path)
    parser.add_argument("baseline_checkpoint", type=Path)
    parser.add_argument("candidate_checkpoint", type=Path)
    parser.add_argument("candidate_state", type=Path)
    args = parser.parse_args()
    baseline = json.loads(args.baseline.read_text())
    candidate = json.loads(args.candidate.read_text())
    native = json.loads(args.baseline_checkpoint.read_text())
    selected = json.loads(args.candidate_checkpoint.read_text())
    state = json.loads(args.candidate_state.read_text())["value"]
    assert len(baseline) == len(candidate) == 11
    assert native["remaining_work"] == selected["remaining_work"]
    assert native["candidate_versions"][-1]["sha256"] == selected["candidate_versions"][-1]["sha256"]
    assert state == 2
    marker = "Checkpoint 1 compactions;"
    assert marker not in developer_text(candidate[8])
    assert marker in developer_text(candidate[10])
    for arm, checkpoint in ((baseline, native), (candidate, selected)):
        for index in (8, 10):
            text = developer_text(arm[index])
            assert all(criterion in text for criterion in checkpoint["remaining_work"])
            assert checkpoint["candidate_versions"][-1]["sha256"] in text
            assert checkpoint["check_versions"][-1]["evidence_sha256"] in text
    result = {
        "schema": 1,
        "requests_per_arm": len(baseline),
        "compactions_per_arm": 2,
        "native_checkpoint_exact_after_each_compaction": True,
        "candidate_fragment_after_first_compaction": False,
        "candidate_fragment_after_second_compaction": marker,
        "candidate_final_state_count": state,
        "post_second_compaction_developer_bytes": {
            "baseline": developer_bytes(baseline[10]),
            "candidate": developer_bytes(candidate[10]),
        },
        "paid_requests": 0,
    }
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
