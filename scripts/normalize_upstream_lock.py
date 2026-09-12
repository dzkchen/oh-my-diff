#!/usr/bin/env python3
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tomllib


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: python3 scripts/normalize_upstream_lock.py UPSTREAM_CHECKOUT")
    pin = json.loads((Path(__file__).resolve().parents[1] / "upstream.lock.json").read_text())
    checkout = Path(sys.argv[1]).resolve()
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=checkout, text=True).strip()
    if commit != pin["commit"]:
        raise SystemExit("Refusing to normalize a checkout at a different commit")
    path = checkout / "codex-rs/Cargo.lock"
    original = path.read_bytes()
    digest = hashlib.sha256(original).hexdigest()
    if digest == pin["normalized_cargo_lock_sha256"]:
        print("Pinned workspace-version normalization already applied")
        return
    if digest != pin["cargo_lock_sha256"]:
        raise SystemExit("Refusing to overwrite an unrecognized or modified Cargo.lock")
    sections = original.decode().split("[[package]]")
    count = 0
    for index in range(1, len(sections)):
        package = tomllib.loads("[[package]]" + sections[index])["package"][0]
        if "source" not in package and package["version"] == "0.0.0":
            sections[index] = sections[index].replace('version = "0.0.0"', 'version = "0.154.0"', 1)
            count += 1
    normalized = "[[package]]".join(sections).encode()
    if count != 150 or hashlib.sha256(normalized).hexdigest() != pin["normalized_cargo_lock_sha256"]:
        raise SystemExit("Normalization did not match the reviewed 150-version-only change")
    path.write_bytes(normalized)
    print("Normalized 150 workspace package versions; all external dependencies unchanged")


if __name__ == "__main__":
    main()
