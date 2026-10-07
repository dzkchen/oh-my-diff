#!/usr/bin/env python3
import json
import os
from pathlib import Path
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[1]
SOURCES = ROOT / "mods/exercise/atlas_policy"
BINARY = Path(os.environ.get("OMD_MOD_BIN", ROOT / "runtime/omd/target/debug/omd-mod"))


def call(*args):
    result = subprocess.run([str(BINARY), *map(str, args)], capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError((result.stderr or result.stdout).strip())
    return json.loads(result.stdout)


def package(lock):
    selected = lock["packages"].get("atlas_policy")
    if selected is None:
        raise RuntimeError("atlas_policy is missing or duplicated in package lock")
    return selected


def main():
    node = subprocess.check_output(["mise", "which", "node"], text=True).strip()
    with tempfile.TemporaryDirectory(prefix="omd-extension-index-") as directory:
        store = Path(directory) / "store"
        call("init", store, node)
        observed = []
        for version, action in (("1.0.0", "install"), ("2.0.0", "update")):
            source = (SOURCES / version).resolve(strict=True)
            manifest = json.loads((source / "mod.json").read_text())
            request = json.dumps({
                "source": {"kind": "local", "path": str(source)},
                "trust": {"packages": {"atlas_policy": {"capabilities": manifest["capabilities"]}}},
            })
            plan = call("package-plan", store, request)
            if plan["action"] != action or not plan["confirmation"]:
                raise RuntimeError(f"unexpected {version} package plan")
            lock = call("package-apply", store, request, plan["confirmation"])
            selected = package(lock)
            if selected["version"] != version or selected["enabled"]:
                raise RuntimeError(f"unexpected {version} installed selection")
            observed.append({"action": action, "version": version, "enabled": selected["enabled"]})
        removal = call("package-uninstall-plan", store, "atlas_policy")
        lock = call("package-uninstall", store, "atlas_policy", removal["confirmation"])
        if "atlas_policy" in lock["packages"]:
            raise RuntimeError("uninstall retained the managed selection")
        if not all((SOURCES / version / "mod.json").is_file() for version in ("1.0.0", "2.0.0")):
            raise RuntimeError("uninstall removed an editable source")
    print(json.dumps({
        "fixture": "atlas_policy",
        "source_kind": "local",
        "index_required": False,
        "observed": observed,
        "removed": True,
        "source_preserved": True,
        "independent_author": False,
        "paid_requests": 0,
    }, indent=2))


if __name__ == "__main__":
    main()
