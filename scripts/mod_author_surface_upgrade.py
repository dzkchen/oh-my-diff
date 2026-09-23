#!/usr/bin/env python3
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[1]
BINARY = Path(os.environ.get("OMD_MOD_BIN", ROOT / "runtime/omd/target/debug/omd-mod"))
NODE = Path(os.environ.get("OMD_MOD_NODE", subprocess.check_output(["mise", "which", "node"], text=True).strip()))


def call(*args):
    run = subprocess.run([str(BINARY), *map(str, args)], capture_output=True, text=True)
    if run.returncode:
        raise RuntimeError((run.stderr or run.stdout).strip())
    return json.loads(run.stdout)


def install(store, source):
    request = json.dumps({"source": {"kind": "local", "path": str(source)}, "activate": True,
                          "trust": {"packages": {"counter": {"capabilities": ["tools", "commands", "state"]}}}})
    plan = call("package-plan", store, request)
    lock = call("package-apply", store, request, plan["confirmation"])
    return {"confirmation": plan["confirmation"], "lock": lock}


def main():
    with tempfile.TemporaryDirectory(prefix="omd-author-upgrade-") as directory:
        base = Path(directory)
        source = base / "counter"
        shutil.copytree(ROOT / "mods/examples/counter", source)
        store = base / "store"
        scenario = base / "scenario.json"
        scenario.write_text(json.dumps({"schema": 1, "steps": [{"type": "invoke", "mod": "counter", "event": "tool", "name": "count", "payload": {}, "expect": {"count": 1}}]}))
        call("init", store, NODE)
        first = install(store, source)
        exercised = call("test", store, scenario)
        before = call("command", store, "counter", "show", "null")
        manifest = source / "mod.json"
        record = json.loads(manifest.read_text())
        record["version"] = "1.0.1"
        record["api"] = "0.1.0-experimental.8"
        manifest.write_text(json.dumps(record, indent=2) + "\n")
        second = install(store, source)
        after = call("command", store, "counter", "show", "null")
        status = call("status", store)
    if before != {"display": "Counter is 1"} or after != before:
        raise RuntimeError("counter state changed across compatible upgrade")
    if status["rejected"] or any(mod["error"] is not None for mod in status["mods"]):
        raise RuntimeError("compatible upgrade was rejected")
    if len(first["lock"].get("packages", [])) != 1 or len(second["lock"].get("packages", [])) != 1:
        raise RuntimeError("package upgrade changed the installed count")
    output = {"schema": 1, "from_api": "0.1.0-experimental.7", "to_api": "0.1.0-experimental.8",
              "from_version": "1.0.0", "to_version": "1.0.1", "state_version": 1,
              "offline": exercised["offline"], "paid_requests": exercised["paid_requests"],
              "before": before, "after": after,
              "status_api": status["api"], "rejected": status["rejected"],
              "errors": [{"id": mod["id"], "error": mod["error"]} for mod in status["mods"]],
              "first_installed": len(first["lock"].get("packages", [])),
              "second_installed": len(second["lock"].get("packages", []))}
    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    main()
