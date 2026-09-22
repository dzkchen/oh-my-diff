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


def sample(binary, mode, manifest_source):
    with tempfile.TemporaryDirectory(prefix="lean-startup-", dir="/private/tmp") as directory:
        root = Path(directory)
        home = root / "home"
        home.mkdir()
        environment = os.environ.copy()
        environment.update({"CODEX_HOME": str(home), "CODEX_SQLITE_HOME": str(home), "OMD_MODE": mode})
        if manifest_source:
            manifest = json.loads(manifest_source.read_text())
            manifest["evidence"] = str(root / "evidence")
            manifest_path = root / "manifest.json"
            manifest_path.write_text(json.dumps(manifest))
            environment["OMD_CONTROLLED_MANIFEST"] = str(manifest_path)
        started = time.monotonic()
        process = subprocess.Popen([str(binary), "app-server"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=environment, bufsize=0)
        try:
            request = {"id": 1, "method": "initialize", "params": {"clientInfo": {"name": "lean-inventory", "version": "1"}}}
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
                    return round((time.monotonic() - started) * 1000, 3)
            raise TimeoutError("app-server did not initialize within 10 seconds")
        finally:
            process.terminate()
            process.communicate(timeout=3)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--upstream", type=Path, required=True)
    parser.add_argument("--omd", type=Path, required=True)
    parser.add_argument("--enabled-manifest", type=Path, required=True)
    parser.add_argument("--repeats", type=int, default=15)
    args = parser.parse_args()
    if args.repeats < 1:
        parser.error("--repeats must be positive")
    arms = {
        "upstream": (args.upstream, "upstream_direct", None),
        "omd_direct": (args.omd, "upstream_direct", None),
        "workspace_only": (args.omd, "enabled", args.enabled_manifest),
    }
    order = list(arms) * args.repeats
    random.Random(7).shuffle(order)
    results = {name: [] for name in arms}
    for name in order:
        results[name].append(sample(*arms[name]))
    summary = {name: {"median_ms": round(statistics.median(values), 3), "max_ms": max(values), "samples_ms": values} for name, values in results.items()}
    print(json.dumps({"schema": 1, "method": "app-server initialize JSON-RPC response in an isolated home; debug binaries; no model request", "seed": 7, "repeats": args.repeats, "summary": summary}, indent=2))


if __name__ == "__main__":
    main()
