#!/usr/bin/env python3
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile

from scripts import install_support as support


ROOT = Path(__file__).resolve().parents[1]
LOCK = ROOT / "runtime/mods.lock.json"
NODE = "24.22.1"


def identifiers():
    return tuple(sorted(path.name for path in (ROOT / "mods/first-party").iterdir() if path.is_dir()))


def source_files(identifier):
    manifest = json.loads((ROOT / "mods/first-party" / identifier / "mod.json").read_text())
    return ("mod.json", manifest.get("entrypoint", "index.ts"), *manifest.get("assets", []))


def sources():
    return tuple(f"mods/first-party/{identifier}/{name}" for identifier in identifiers() for name in source_files(identifier))


def build():
    packages = {}
    for identifier in identifiers():
        base = ROOT / "mods/first-party" / identifier
        manifest = json.loads((base / "mod.json").read_text())
        support.validate_manifest(manifest, identifier)
        packages[identifier] = {
            "id": identifier, "version": manifest["version"], "api": manifest["api"],
            "extension_type": "mod", "capabilities": manifest["capabilities"],
            "source": base.relative_to(ROOT).as_posix(),
            "files": {name: support.digest(base / name) for name in source_files(identifier)},
            "package_sha256": support.package_digest(base),
        }
    return {"schema": support.MODS_SCHEMA, "product": support.MODS_PRODUCT, "node": NODE,
            "mod_api": json.loads((ROOT / "mods/package.json").read_text())["version"], "packages": packages}


def published_digest(revision, subdirectory):
    archive = subprocess.run(["git", "-C", ROOT, "archive", revision, subdirectory], capture_output=True)
    if archive.returncode:
        raise ValueError(f"{subdirectory} at {revision}: {archive.stderr.decode().strip()}")
    with tempfile.TemporaryDirectory(prefix="omd-published-") as temporary:
        with tarfile.open(fileobj=io.BytesIO(archive.stdout)) as files:
            files.extractall(temporary, filter="data")
        base = Path(temporary) / subdirectory
        return support.package_digest(base), json.loads((base / "mod.json").read_text()).get("version")


def published_drift():
    problems = []
    for entry in json.loads((ROOT / "extensions/index.json").read_text())["packages"]:
        if published := entry.get("published"):
            actual, version = published_digest(published["revision"], entry["source"])
            if actual != published["sha256"]:
                problems.append(f"{entry['id']}: published.sha256 is {published['sha256']}, "
                                f"{entry['source']} at {published['revision']} is {actual}")
            if version != entry["version"]:
                problems.append(f"{entry['id']}: version is {entry['version']}, {entry['source']} at {published['revision']} is {version}")
    return problems


def main():
    if "--published" not in sys.argv[1:]:
        return support.check_or_write(LOCK, json.dumps(build(), indent=2, sort_keys=True) + "\n", "--write" in sys.argv[1:],
                                      "first-party mod lock differs from pinned sources")
    try:
        problems = published_drift()
    except ValueError as error:
        problems = [str(error)]
    if problems:
        raise SystemExit("extensions/index.json published entries differ from their revisions:\n" + "\n".join(problems))


if __name__ == "__main__":
    main()
