import argparse
import json
import os
from pathlib import Path
import random
import selectors
import statistics
import subprocess
import tempfile
import time


def selected_store(source_store, destination, enabled):
    selection = json.loads(source_store.read_text())
    if selection.get("schema") != 1 or not isinstance(selection.get("mods"), list):
        raise ValueError("source mod store has an unsupported selection schema")
    selection["mods"] = [mod for mod in selection["mods"] if Path(mod["path"]).name == "omd_task_tools"] if enabled else []
    if enabled and len(selection["mods"]) != 1:
        raise ValueError("source mod store must select exactly one omd_task_tools package")
    if enabled and selection["mods"][0].get("enabled") is not True:
        raise ValueError("omd_task_tools must be enabled for the task-tools arm")
    destination.mkdir()
    (destination / "mods.json").write_text(json.dumps(selection))
    return destination


def launch_environment(home, store):
    environment = os.environ.copy()
    environment.pop("OMD_CONTROLLED_MANIFEST", None)
    environment.update({"CODEX_HOME": str(home), "CODEX_SQLITE_HOME": str(home), "OMD_MODE": "omd", "OMD_MOD_STORE": str(store)})
    return environment


def sample(binary, source_store, enabled):
    with tempfile.TemporaryDirectory(prefix="omd-task-tools-idle-", dir="/private/tmp") as directory:
        root = Path(directory)
        home = root / "home"
        home.mkdir()
        store = selected_store(source_store, root / "store", enabled)
        environment = launch_environment(home, store)
        started = time.monotonic()
        process = subprocess.Popen([str(binary), "app-server"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=environment, bufsize=0)
        try:
            request = {"id": 1, "method": "initialize", "params": {"clientInfo": {"name": "task-tools-idle", "version": "1"}}}
            process.stdin.write(json.dumps(request).encode() + b"\n")
            process.stdin.flush()
            selector = selectors.DefaultSelector()
            selector.register(process.stdout, selectors.EVENT_READ)
            deadline = started + 10
            while time.monotonic() < deadline:
                if not selector.select(max(0, deadline - time.monotonic())):
                    break
                response = json.loads(process.stdout.readline())
                if response.get("id") == 1:
                    if "result" not in response:
                        raise RuntimeError(response)
                    elapsed = (time.monotonic() - started) * 1000
                    time.sleep(0.5)
                    rss = int(subprocess.check_output(["/bin/ps", "-o", "rss=", "-p", str(process.pid)], text=True).strip())
                    return {"initialize_ms": elapsed, "idle_rss_kib": rss}
            raise TimeoutError("app-server did not initialize within 10 seconds")
        finally:
            process.terminate()
            process.communicate(timeout=3)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("binary", type=Path)
    parser.add_argument("source_store", type=Path)
    parser.add_argument("--repeats", type=int, default=12)
    args = parser.parse_args()
    arms = ["baseline", "task_tools"] * args.repeats
    random.Random(110226).shuffle(arms)
    results = {"baseline": [], "task_tools": []}
    for arm in arms:
        results[arm].append(sample(args.binary, args.source_store, arm == "task_tools"))
    summary = {arm: {key: statistics.median(value[key] for value in values) for key in ("initialize_ms", "idle_rss_kib")}
               for arm, values in results.items()}
    print(json.dumps({"schema": 1, "repeats": args.repeats, "raw": results, "median": summary, "paid_requests": 0}, indent=2))


if __name__ == "__main__":
    main()
