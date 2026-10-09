#!/usr/bin/env python3
import hashlib
import json
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
LOCK = ROOT / "runtime/preview-v1.lock.json"
SCHEMA = 1
PRODUCT = "oh-my-diff-private-preview-v1"
NODE = "24.18.0"
FILES = ("mod.json", "index.ts")
PACKAGES = ("omd_workflow", "omd_workspace")


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def package_digest(base):
    manifest = (base / "mod.json").read_bytes()
    declared = json.loads(manifest)
    if declared.get("lifecycle"):
        raise ValueError(f"{base.name} declares lifecycle scripts; install it through the package manager")
    entrypoint = declared.get("entrypoint", "index.ts")
    payload = manifest + b"\x00" + entrypoint.encode() + b"\x00" + (base / entrypoint).read_bytes()
    for name in declared.get('assets', []):
        payload += b"\x00" + name.encode() + b"\x00" + (base / name).read_bytes()
    return hashlib.sha256(payload).hexdigest()


def validate_manifest(manifest, identifier):
    supported = {row["version"] for row in json.loads((ROOT / "mods/compatibility.json").read_text())["apis"]}
    if manifest["id"] != identifier or manifest["api"] not in supported:
        raise ValueError(f"{identifier} has an incompatible package identity or mod API")


def build():
    api = json.loads((ROOT / "mods/package.json").read_text())["version"]
    packages = {}
    for name in PACKAGES:
        base = ROOT / "mods/first-party" / name
        manifest = json.loads((base / "mod.json").read_text())
        validate_manifest(manifest, base.name)
        packages[manifest["id"]] = {
            "version": manifest["version"],
            "api": manifest["api"],
            "extension_type": "mod",
            "capabilities": manifest["capabilities"],
            "source": str(base.relative_to(ROOT)),
            "files": {name: digest(base / name) for name in FILES},
            "package_sha256": package_digest(base),
        }
    if not packages:
        raise ValueError("no first-party preview packages found")
    return {
        "schema": SCHEMA,
        "product": PRODUCT,
        "mod_api": api,
        "node": NODE,
        "types": {"path": "mods/api.d.ts", "sha256": digest(ROOT / "mods/api.d.ts")},
        "packages": packages,
    }


def main():
    text = json.dumps(build(), indent=2, sort_keys=True) + "\n"
    if "--write" in sys.argv[1:]:
        LOCK.write_text(text)
        print(f"wrote {LOCK.relative_to(ROOT)}")
        return
    if LOCK.read_text() != text:
        raise SystemExit("preview lock is stale; rerun with --write after reviewing the sources")
    print("preview lock matches the pinned sources")


if __name__ == "__main__":
    main()
