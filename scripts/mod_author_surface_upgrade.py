#!/usr/bin/env python3
import json
import os
from pathlib import Path
import re
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
    manifest = json.loads((source / "mod.json").read_text())
    request = json.dumps({"source": {"kind": "local", "path": str(source)},
                          "trust": {"packages": {manifest["id"]: {"capabilities": manifest["capabilities"]}}}})
    plan = call("package-plan", store, request)
    call("package-apply", store, request, plan["confirmation"])
    lock = call("package-enable", store, manifest["id"])
    return {"confirmation": plan["confirmation"], "lock": lock}


def compatible_upgrade(record):
    current_api = json.loads((ROOT / "mods/package.json").read_text())["version"]
    if record["api"] != current_api:
        raise RuntimeError(f"counter fixture API {record['api']} differs from current SDK {current_api}")
    version = record["version"]
    match = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)", version)
    if match is None:
        raise RuntimeError(f"counter fixture version is not a stable semver: {version}")
    upgraded = dict(record)
    upgraded["version"] = f"{match.group(1)}.{match.group(2)}.{int(match.group(3)) + 1}"
    return upgraded


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
        upgraded = compatible_upgrade(record)
        manifest.write_text(json.dumps(upgraded, indent=2) + "\n")
        second = install(store, source)
        after = call("command", store, "counter", "show", "null")
        status = call("status", store)
    if before != {"display": "Counter is 1"} or after != before:
        raise RuntimeError("counter state changed across compatible upgrade")
    if status["rejected"] or any(mod["error"] is not None for mod in status["mods"]):
        raise RuntimeError("compatible upgrade was rejected")
    if len(first["lock"].get("packages", [])) != 1 or len(second["lock"].get("packages", [])) != 1:
        raise RuntimeError("package upgrade changed the installed count")
    output = {"schema": 1, "from_api": record["api"], "to_api": upgraded["api"],
              "from_version": record["version"], "to_version": upgraded["version"], "state_version": record["state_version"],
              "offline": exercised["offline"], "paid_requests": exercised["paid_requests"],
              "before": before, "after": after,
              "status_api": status["api"], "rejected": status["rejected"],
              "errors": [{"id": mod["id"], "error": mod["error"]} for mod in status["mods"]],
              "first_installed": len(first["lock"].get("packages", [])),
              "second_installed": len(second["lock"].get("packages", []))}
    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    main()
