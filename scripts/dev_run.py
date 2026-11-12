#!/usr/bin/env python3
import json
import os
from pathlib import Path
import shutil
import subprocess
import threading
import time

from scripts import mods_lock
from scripts import profiles


SOURCES = mods_lock.ROOT / "mods/first-party"
DEFAULT_ON = set(profiles.DEFAULT_ACTIVE) - {"omd_update"}


def invoke(manager, *arguments):
    result = subprocess.run([str(manager), *map(str, arguments)], capture_output=True, text=True)
    if result.returncode:
        raise ValueError((result.stderr or result.stdout).strip()[-400:])
    return json.loads(result.stdout) if result.stdout.strip() else None


def packages():
    return [SOURCES / identifier for identifier in mods_lock.identifiers() if (SOURCES / identifier / "mod.json").is_file()]


def fingerprint(path):
    return sorted((str(file), file.stat().st_mtime_ns, file.stat().st_size) for file in path.rglob("*") if file.is_file())


def stage(manager, origin, path):
    names = mods_lock.source_files(path.name)
    staged = origin / f".{path.name}.staged"
    shutil.rmtree(staged, ignore_errors=True)
    for name in names:
        (staged / name).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path / name, staged / name)
    inspected = invoke(manager, "inspect", staged)
    profiles.replace_tree(staged, origin / path.name)
    shutil.rmtree(staged, ignore_errors=True)
    return {"sha256": inspected["sha256"], "capabilities": inspected["manifest"]["capabilities"],
            "files": {name: profiles.support.digest(origin / path.name / name) for name in names}}


def forget(manager, store, keep):
    for item in invoke(manager, "selection-status", store)["selections"]:
        target = Path(item["path"])
        if target.parent == store / "sources" and target.name not in keep:
            if item["selected"]:
                invoke(manager, "disable", store, target)
            shutil.rmtree(target, ignore_errors=True)


def sync(manager, store, origin, paths, enable=()):
    known = {Path(item["path"]).name for item in invoke(manager, "selection-status", store)["selections"]
             if Path(item["path"]).parent == store / "sources"}
    staged, refused = {}, {}
    for path in paths:
        try:
            staged[path.name] = stage(manager, origin, path)
        except (OSError, ValueError, KeyError) as error:
            refused[path.name] = str(error)
    changed = profiles.sync_sources(manager, store, origin, staged)
    wanted = [identifier for identifier in staged if identifier in enable or (identifier not in known and identifier in DEFAULT_ON)]
    for identifier in wanted:
        invoke(manager, "enable", store, store / "sources" / identifier)
    if wanted and not changed:
        invoke(manager, "reload", store)
    return sorted(set(changed) | set(wanted)), refused


def watch(manager, store, origin, stop, log):
    seen = {path: fingerprint(path) for path in packages()}
    while not stop.wait(1):
        try:
            current = {path: fingerprint(path) for path in packages()}
            edited = [path for path, files in current.items() if seen.get(path) != files]
            seen = current
            if edited:
                changed, refused = sync(manager, store, origin, edited)
                with log.open("a") as output:
                    output.write(json.dumps({"at": int(time.time()), "reloaded": changed, "refused": refused}) + "\n")
        except (OSError, ValueError) as error:
            with log.open("a") as output:
                output.write(json.dumps({"at": int(time.time()), "error": str(error)}) + "\n")


def unknown(enable):
    return sorted(set(enable) - {path.name for path in packages()})


def run(binaries, store, enable, arguments, log):
    manager = binaries / "omd-mod"
    if missing := unknown(enable):
        raise SystemExit(f"not a first-party mod: {', '.join(missing)}")
    invoke(manager, "authorize-runner" if store.exists() else "init", store)
    origin = store.parent / "origin"
    origin.mkdir(exist_ok=True)
    current = packages()
    forget(manager, store, {path.name for path in current})
    changed, refused = sync(manager, store, origin, current, enable)
    selected = sorted(item["id"] or Path(item["path"]).name for item in invoke(manager, "selection-status", store)["selections"]
                      if item["selected"])
    print(f"store  {store}\non     {', '.join(selected)}\nedits  reload at the next turn; log {log}", flush=True)
    for identifier, reason in refused.items():
        print(f"refused {identifier}: {reason}", flush=True)
    log.parent.mkdir(parents=True, exist_ok=True)
    stop = threading.Event()
    watcher = threading.Thread(target=watch, args=(manager, store, origin, stop, log), daemon=True)
    watcher.start()
    environment = {**os.environ, "OMD_MODE": "omd", "OMD_INSTALL_PROFILE": "full", "OMD_MOD_STORE": str(store)}
    try:
        return subprocess.run([binaries / "codex", "-c", "features.daemon_auto_start=false", *arguments], env=environment).returncode
    finally:
        stop.set()
        watcher.join()
