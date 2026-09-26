#!/usr/bin/env python3
import json
from pathlib import Path
import sys

try:
    from scripts import preview_lock
except ModuleNotFoundError:
    import preview_lock


ROOT = Path(__file__).resolve().parents[1]
LOCK = ROOT / "runtime/terminal-mods-full.lock.json"
MODS = ("omd_git", "omd_logo", "omd_model_picker", "omd_selection_copy")
FILES = ("mod.json", "index.ts", "mod.test.json")
SOURCES = tuple(f"mods/first-party/{mod}/{name}" for mod in MODS for name in FILES)


def build():
    api = json.loads((ROOT / "mods/package.json").read_text())["version"]
    packages = {}
    for mod in MODS:
        base = ROOT / "mods/first-party" / mod
        manifest = json.loads((base / "mod.json").read_text())
        if manifest["id"] != base.name or manifest["api"] != api:
            raise ValueError(f"{mod} identity or API differs from release pin")
        packages[mod] = {
            "id": manifest["id"], "version": manifest["version"],
            "extension_type": "mod", "capabilities": manifest["capabilities"],
            "source": f"mods/first-party/{mod}",
            "files": {name: preview_lock.digest(base / name) for name in FILES},
            "package_sha256": preview_lock.package_digest(base),
        }
    return {"schema": 1, "mod_api": api, "packages": packages}


def load():
    return json.loads(LOCK.read_text())


def main():
    expected = json.dumps(build(), indent=2, sort_keys=True) + "\n"
    if "--write" in sys.argv[1:]:
        LOCK.write_text(expected)
        print(f"wrote {LOCK.relative_to(ROOT)}")
    elif not LOCK.is_file() or LOCK.read_text() != expected:
        raise SystemExit("terminal mod Full lock differs from pinned sources")
    else:
        print("terminal mod Full lock matches pinned sources")


if __name__ == "__main__":
    main()
