import json
from pathlib import Path
import sys

try:
    from scripts import preview_lock
except ModuleNotFoundError:
    import preview_lock


ROOT = Path(__file__).resolve().parents[1]
LOCK = ROOT / "runtime/batch2-full.lock.json"
PACKAGES = ("omd_advisor", "omd_research")
FILES = ("mod.json", "index.ts", "README.md")
SOURCES = tuple(f"mods/first-party/{identifier}/{name}" for identifier in PACKAGES for name in FILES)


def build():
    packages = {}
    for identifier in PACKAGES:
        base = ROOT / "mods/first-party" / identifier
        manifest = json.loads((base / "mod.json").read_text())
        preview_lock.validate_manifest(manifest, identifier)
        packages[identifier] = {
            "id": identifier, "version": manifest["version"], "api": manifest["api"],
            "extension_type": "mod", "capabilities": manifest["capabilities"],
            "source": base.relative_to(ROOT).as_posix(),
            "files": {name: preview_lock.digest(base / name) for name in FILES},
            "package_sha256": preview_lock.package_digest(base),
        }
    return {"schema": 1, "mod_api": json.loads((ROOT / "mods/package.json").read_text())["version"], "packages": packages}


def load():
    return json.loads(LOCK.read_text())


if __name__ == "__main__":
    expected = json.dumps(build(), indent=2, sort_keys=True) + "\n"
    if "--write" in sys.argv[1:]:
        LOCK.write_text(expected)
        print("wrote runtime/batch2-full.lock.json")
    elif LOCK.read_text() != expected:
        raise SystemExit("Batch 2 Full lock differs from exact sources")
    else:
        print("Batch 2 Full lock matches exact sources")
