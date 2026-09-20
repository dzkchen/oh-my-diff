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


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build():
    api = json.loads((ROOT / "mods/package.json").read_text())["version"]
    packages = {}
    for base in sorted((ROOT / "mods/first-party").iterdir()):
        if not base.is_dir():
            continue
        manifest = json.loads((base / "mod.json").read_text())
        if manifest["id"] != base.name or manifest["api"] != api:
            raise ValueError(f"{base.name} must declare its directory name and mod API {api}")
        packages[manifest["id"]] = {
            "version": manifest["version"],
            "capabilities": manifest["capabilities"],
            "source": str(base.relative_to(ROOT)),
            "files": {name: digest(base / name) for name in FILES},
            "package_sha256": hashlib.sha256(
                (base / "mod.json").read_bytes() + b"\x00" + (base / "index.ts").read_bytes()
            ).hexdigest(),
        }
    if not packages:
        raise ValueError("no first-party preview packages found")
    return {
        "schema": SCHEMA,
        "product": PRODUCT,
        "mod_api": api,
        "node": NODE,
        "types": {"path": "mods/api.d.ts", "sha256": digest(ROOT / "mods/api.d.ts")},
        "guide": {"path": "mods/PREVIEW.md"},
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
