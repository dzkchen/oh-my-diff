#!/usr/bin/env python3
import json
import os
from pathlib import Path
import shutil
import subprocess
import threading
import time


ROOT = Path(__file__).resolve().parents[1]
SOURCES = ROOT / "mods/first-party"
DEFAULT_ON = ("omd_logo", "omd_mods", "omd_statusline", "omd_tool_lines")


def invoke(manager, *arguments):
    result = subprocess.run([str(manager), *map(str, arguments)], capture_output=True, text=True)
    if result.returncode:
        raise ValueError((result.stderr or result.stdout).strip()[-400:])
    return json.loads(result.stdout) if result.stdout.strip() else None


def packages():
    return [path for path in sorted(SOURCES.iterdir()) if (path / "mod.json").is_file()]


def fingerprint(path):
    return sorted((str(file), file.stat().st_mtime_ns, file.stat().st_size) for file in path.rglob("*") if file.is_file())


def shipped(path):
    manifest = json.loads((path / "mod.json").read_text())
    return ("mod.json", manifest.get("entrypoint", "index.ts"), *manifest.get("assets", []))


def sync(manager, store, paths, enable=()):
    selections = {item["path"]: item for item in invoke(manager, "selection-status", store)["selections"]}
    changed, refused = [], {}
    for path in paths:
        target = store / "sources" / path.name
        try:
            names = shipped(path)
            copied = {file.relative_to(target).as_posix() for file in target.rglob("*") if file.is_file()}
            current = copied == set(names) and all((target / name).read_bytes() == (path / name).read_bytes() for name in names)
            known = selections.get(str(target))
            on = path.name in enable or (known["selected"] if known else path.name in DEFAULT_ON)
            if current and known and known["selected"] == on:
                continue
            if not current or not known:
                invoke(manager, "inspect", path)
                staged = target.with_name(f".{path.name}.new")
                shutil.rmtree(staged, ignore_errors=True)
                for name in names:
                    (staged / name).parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(path / name, staged / name)
                shutil.rmtree(target, ignore_errors=True)
                staged.rename(target)
                inspected = invoke(manager, "inspect", target)
                invoke(manager, "trust-all", store, json.dumps([{"path": str(target), "sha256": inspected["sha256"],
                                                                 "capabilities": inspected["manifest"]["capabilities"]}]))
            if on:
                invoke(manager, "enable", store, target)
            changed.append(path.name)
        except (OSError, ValueError) as error:
            refused[path.name] = str(error)
    if changed:
        invoke(manager, "reload", store)
    return changed, refused


def watch(manager, store, stop, log):
    seen = {path: fingerprint(path) for path in packages()}
    while not stop.wait(1):
        try:
            current = {path: fingerprint(path) for path in packages()}
            edited = [path for path, files in current.items() if seen.get(path) != files]
            seen = current
            if edited:
                changed, refused = sync(manager, store, edited)
                with log.open("a") as output:
                    output.write(json.dumps({"at": int(time.time()), "reloaded": changed, "refused": refused}) + "\n")
        except (OSError, ValueError) as error:
            with log.open("a") as output:
                output.write(json.dumps({"at": int(time.time()), "error": str(error)}) + "\n")


def run(binaries, store, enable, arguments, log):
    manager = binaries / "omd-mod"
    unknown = sorted(set(enable) - {path.name for path in packages()})
    if unknown:
        raise SystemExit(f"not a first-party mod: {', '.join(unknown)}")
    invoke(manager, "authorize-runner" if store.exists() else "init", store)
    changed, refused = sync(manager, store, packages(), enable)
    selected = sorted(item["id"] for item in invoke(manager, "selection-status", store)["selections"] if item["selected"])
    print(f"store  {store}\non     {', '.join(selected)}\nedits  reload at the next turn; log {log}", flush=True)
    for identifier, reason in refused.items():
        print(f"refused {identifier}: {reason}", flush=True)
    log.parent.mkdir(parents=True, exist_ok=True)
    stop = threading.Event()
    watcher = threading.Thread(target=watch, args=(manager, store, stop, log), daemon=True)
    watcher.start()
    environment = {key: value for key, value in os.environ.items() if not key.startswith("OMD_")}
    environment.update(OMD_MODE="omd", OMD_INSTALL_PROFILE="full", OMD_MOD_STORE=str(store))
    try:
        return subprocess.run([binaries / "codex", "-c", "features.daemon_auto_start=false", *arguments], env=environment).returncode
    finally:
        stop.set()
        watcher.join()
