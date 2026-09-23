import json
from pathlib import Path
import shutil
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[1]
BIN = ROOT / "runtime/omd/target/debug/omd-mod"
NAMES = ("omd_task_tools", "omd_session_anchor", "omd_verification_gate")


def call(*args):
    result = subprocess.run((str(BIN), *map(str, args)), check=True, capture_output=True, text=True)
    return json.loads(result.stdout)


def main():
    node = subprocess.run(("mise", "which", "node"), check=True, capture_output=True, text=True).stdout.strip()
    with tempfile.TemporaryDirectory(prefix="omd-first-party-", dir="/private/tmp") as temporary:
        base = Path(temporary)
        store = base / "store"
        call("init", store, node)
        scenario = base / "scenario.json"
        scenario.write_text(json.dumps({"schema": 1, "steps": [{"type": "status"}]}))
        sources = {}
        for name in NAMES:
            source = base / name
            source.mkdir()
            for filename in ("mod.json", "index.ts"):
                shutil.copyfile(ROOT / "mods/first-party" / name / filename, source / filename)
            manifest = json.loads((source / "mod.json").read_text())
            inspected = call("inspect", source)
            call("trust", store, source, inspected["sha256"], ",".join(manifest["capabilities"]))
            call("enable", store, source)
            sources[name] = source
        def entries(status):
            return {mod["id"]: {"sha256": mod["sha256"], "error": mod.get("error")} for mod in status["mods"]}
        def activate(name, text):
            source = sources[name]
            (source / "index.ts").write_text(text)
            manifest = json.loads((source / "mod.json").read_text())
            inspected = call("inspect", source)
            call("trust", store, source, inspected["sha256"], ",".join(manifest["capabilities"]))
            call("enable", store, source)
            status = call("test", store, scenario)["status"]
            assert not status["rejected"] and not status["reload_error"]
            return entries(status)
        stages = {"initial": entries(call("test", store, scenario)["status"])}
        assert set(stages["initial"]) == set(NAMES)
        assert all(not mod["error"] for mod in stages["initial"].values())
        for name in NAMES:
            source = sources[name]
            original = (source / "index.ts").read_text()
            edited = activate(name, original + "\n")
            assert set(edited) == set(NAMES) and all(not mod["error"] for mod in edited.values())
            assert edited[name]["sha256"] != stages["initial"][name]["sha256"]
            stages[f"{name}_edited"] = edited
            broken = activate(name, original + "\nthrow new Error('broken candidate');\n")
            assert "broken candidate" in broken[name]["error"]
            assert all(not broken[other]["error"] for other in NAMES if other != name)
            stages[f"{name}_broken"] = broken
            restored = activate(name, original + "\n")
            assert all(not mod["error"] for mod in restored.values())
            call("disable", store, source)
            disabled = entries(call("test", store, scenario)["status"])
            assert name not in disabled and all(not mod["error"] for mod in disabled.values())
            stages[f"{name}_disabled"] = disabled
            activate(name, original + "\n")
        compact = base / "compact.json"
        compact.write_text(json.dumps({"schema": 1, "steps": [{"type": "event", "event": "compaction_end", "payload": {"turn_id": "one", "trigger": "auto"}}]}))
        call("test", store, compact)
        anchor = sources["omd_session_anchor"]
        manifest = json.loads((anchor / "mod.json").read_text())
        manifest["version"] = "0.1.0-candidate.2"
        (anchor / "mod.json").write_text(json.dumps(manifest))
        upgraded = activate("omd_session_anchor", (anchor / "index.ts").read_text())
        assert upgraded["omd_session_anchor"]["sha256"] != stages["omd_session_anchor_edited"]["omd_session_anchor"]["sha256"]
        read = base / "read.json"
        read.write_text(json.dumps({"schema": 1, "steps": [{"type": "event", "event": "context", "payload": {"thread_id": "task", "turn_id": "two", "checkpoint": {"remaining_work": ["verify"]}}}]}))
        read_result = call("test", store, read)
        assert "Checkpoint 1 compactions" in json.dumps(read_result["steps"])
        duplicate = base / "omd_anchor_duplicate"
        duplicate.mkdir()
        shutil.copyfile(sources["omd_session_anchor"] / "index.ts", duplicate / "index.ts")
        manifest = json.loads((sources["omd_session_anchor"] / "mod.json").read_text())
        manifest["id"] = "omd_anchor_duplicate"
        (duplicate / "mod.json").write_text(json.dumps(manifest))
        inspected = call("inspect", duplicate)
        call("trust", store, duplicate, inspected["sha256"], ",".join(manifest["capabilities"]))
        call("enable", store, duplicate)
        conflict = call("test", store, scenario)["status"]
        conflicting = entries(conflict)
        assert all("replacement_conflict: compaction" in conflicting[name]["error"] for name in ("omd_anchor_duplicate", "omd_session_anchor"))
        assert all(not conflicting[name]["error"] for name in ("omd_task_tools", "omd_verification_gate"))
        call("disable", store, duplicate)
        restored = call("test", store, scenario)["status"]
        assert set(entries(restored)) == set(NAMES) and not restored["rejected"]
        print(json.dumps({"stages": stages, "upgrade": {"anchor": upgraded["omd_session_anchor"], "state_retained": True}, "conflict": conflicting, "paid_requests": 0}, indent=2))


if __name__ == "__main__":
    main()
