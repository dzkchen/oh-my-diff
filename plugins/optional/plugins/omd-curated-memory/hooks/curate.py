#!/usr/bin/env python3
import hashlib
import json
import os
from pathlib import Path
import selectors
import subprocess
import sys
import time


def main():
    if os.environ.get("OMD_MEMORY_CURATION") != "1":
        return
    data = sys.stdin.buffer.read(16385)
    if len(data) > 16384:
        raise ValueError("curation_event_limit")
    event = json.loads(data)
    if event.get("hook_event_name") != "SessionEnd":
        return
    repo = Path(event.get("cwd", ""))
    root = Path(os.environ.get("PLUGIN_DATA", ""))
    executable = Path(os.environ.get("OMD_MEMORY_COMMAND", ""))
    if any(not path.is_absolute() or path.resolve() != path for path in (repo, root, executable)) or not repo.is_dir() or not executable.is_file() or root == repo or repo in root.parents:
        raise ValueError("curation_canonical_external_paths_required")
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    if root.is_symlink() or root.stat().st_mode & 0o077:
        raise ValueError("curation_private_storage_required")
    process = subprocess.Popen([str(executable), "memory", "--repo", str(repo), "curate"], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)
    output = bytearray()
    deadline = time.monotonic() + 8
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            while selector.get_map():
                if time.monotonic() >= deadline:
                    raise ValueError("curation_deadline")
                for key, _ in selector.select(max(0, deadline - time.monotonic())):
                    chunk = os.read(key.fileobj.fileno(), 4096)
                    if not chunk:
                        selector.unregister(key.fileobj)
                    else:
                        output.extend(chunk)
                        if len(output) > 16384:
                            raise ValueError("curation_output_limit")
        if process.wait(timeout=max(0.1, deadline - time.monotonic())):
            raise ValueError("curation_unavailable")
        json.loads(output)
        target = root / (hashlib.sha256(str(repo).encode()).hexdigest() + ".json")
        temporary = root / (target.stem + f".{os.getpid()}.tmp")
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(output)
        os.replace(temporary, target)
    finally:
        if process.poll() is None:
            import signal
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.TimeoutExpired) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1) from error
