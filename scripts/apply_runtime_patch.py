#!/usr/bin/env python3
import hashlib
import json
from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]


def apply(checkout):
    pin = json.loads((ROOT / "upstream.lock.json").read_text())
    manifest = json.loads((ROOT / "runtime/patches/manifest.json").read_text())
    run = lambda *args: subprocess.run(["git", *args], cwd=checkout, check=True, capture_output=True)
    if run("rev-parse", "HEAD").stdout.decode().strip() != pin["commit"]:
        raise ValueError("runtime patch requires the exact pinned upstream commit")
    patch = ROOT / manifest["patch"]["path"]
    if hashlib.sha256(patch.read_bytes()).hexdigest() != manifest["patch"]["sha256"]:
        raise ValueError("runtime patch hash mismatch")
    states = {}
    for name, hashes in manifest["files"].items():
        path = checkout / name
        if path.is_symlink() or any(parent.is_symlink() for parent in path.parents if parent != checkout):
            raise ValueError("symlink in patch destination")
        current = hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None
        states[name] = current
        if current not in (hashes["before"], hashes["after"]):
            raise ValueError("refusing to overwrite modified patch destination: " + name)
    if all(states[name] == hashes["after"] for name, hashes in manifest["files"].items()):
        return "Pinned runtime patch already applied"
    if not all(states[name] == hashes["before"] for name, hashes in manifest["files"].items()):
        raise ValueError("partially applied patch; restore a clean pinned checkout")
    run("apply", "--check", str(patch))
    run("apply", str(patch))
    for name, hashes in manifest["files"].items():
        if hashlib.sha256((checkout / name).read_bytes()).hexdigest() != hashes["after"]:
            raise ValueError("post-apply hash mismatch: " + name)
    return "Applied and verified the pinned controlled-delegation patch"


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: python3 scripts/apply_runtime_patch.py PINNED_UPSTREAM_CHECKOUT")
    print(apply(Path(sys.argv[1]).resolve()))


if __name__ == "__main__":
    main()
