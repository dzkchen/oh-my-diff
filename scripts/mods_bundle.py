#!/usr/bin/env python3
import argparse
import io
import json
from pathlib import Path
import re
import subprocess
import tarfile

from scripts import install_support as support
from scripts import mods_lock


ROOT = Path(__file__).resolve().parents[1]


def git(*arguments):
    return subprocess.run(["git", *arguments], cwd=ROOT, capture_output=True, text=True, check=True).stdout


def at(ref, path):
    return json.loads(git("show", f"{ref}:{path}"))


def required_features(identifier):
    manifest = json.loads((ROOT / "mods/first-party" / identifier / "mod.json").read_text())
    return set(manifest.get("compatibility", {}).get("required_features", []))


def plan():
    version = json.loads((ROOT / "extensions/index.json").read_text())["release_pin"]["omd"]
    lock = support.mods_lock()
    if lock != mods_lock.build():
        raise ValueError("runtime/mods.lock.json differs from mods/first-party; run python3 .github/scripts/build.py locks")
    release_lock = at(f"v{version}", "runtime/mods.lock.json")
    released = release_lock["packages"]
    if release_lock["mod_api"] != lock["mod_api"]:
        raise ValueError(f"main hosts a different mod API than OMD {version}; cut a release instead")
    bundles = sorted((int(found[1]), tag) for tag in git("tag", "-l", f"mods-{version}-*").split()
                     if (found := re.fullmatch(rf"mods-{re.escape(version)}-([1-9][0-9]*)", tag)))
    shipped = {}
    for _, tag in bundles:
        shipped |= {identifier: package["package_sha256"] for identifier, package in at(tag, "runtime/mods.lock.json")["packages"].items()
                    if identifier in released and (identifier in shipped
                                                   or package["package_sha256"] != released[identifier]["package_sha256"])}
    current = {identifier: package["package_sha256"] for identifier, package in lock["packages"].items() if identifier in released}
    if removed := sorted(shipped.keys() - current.keys()):
        raise ValueError(f"mods shipped in an earlier bundle were removed from main; cut a release instead: {', '.join(removed)}")
    changed = sorted(identifier for identifier, sha256 in current.items() if sha256 != released[identifier]["package_sha256"])
    bundle = sorted(set(changed) | shipped.keys())
    features = set(at(f"v{version}", "mods/conformance/compatibility.json")["host"]["features"])
    return {"omd": version, "serial": (bundles[-1][0] if bundles else 0) + 1, "changed": changed, "bundle": bundle,
            "new": sorted(identifier for identifier in bundle
                          if current[identifier] != shipped.get(identifier, released[identifier]["package_sha256"])),
            "needs_host": {identifier: sorted(missing) for identifier in bundle if (missing := required_features(identifier) - features)},
            "needs_release": sorted(lock["packages"].keys() - released.keys()),
            "host_changed": git("diff", "--name-only", f"v{version}..HEAD", "--", "mods/api.d.ts", "runtime/").splitlines(),
            "commits": git("log", "--no-merges", "--format=%h %s", f"v{version}..HEAD", "--", "mods/first-party").splitlines()}


def build(output, commit):
    planned = plan()
    if not planned["new"]:
        raise ValueError(f"no first-party mod changed since OMD {planned['omd']} or its last mod bundle")
    if planned["needs_host"]:
        raise ValueError(f"these mods need host features OMD {planned['omd']} lacks; they wait for a release: {planned['needs_host']}")
    lock = support.mods_lock()
    lock = lock | {"packages": {identifier: lock["packages"][identifier] for identifier in planned["bundle"]}}
    output.mkdir(parents=True, exist_ok=True)
    archive = output / f"omd-mods-{planned['omd']}-{planned['serial']}.tar.xz"

    def add(packed, name, data):
        info = tarfile.TarInfo(f"payload/{name}")
        info.size, info.mode = len(data), 0o644
        packed.addfile(info, io.BytesIO(data))

    with tarfile.open(archive, "w:xz") as packed:
        add(packed, "mods.lock.json", (json.dumps(lock, indent=2, sort_keys=True) + "\n").encode())
        for identifier, package in sorted(lock["packages"].items()):
            for name in sorted(package["files"]):
                add(packed, f"sources/{identifier}/{name}", (ROOT / package["source"] / name).read_bytes())
    manifest = {"schema": 1, "omd": planned["omd"], "serial": planned["serial"], "commit": commit, "mod_api": lock["mod_api"],
                "archive": archive.name, "sha256": support.digest(archive),
                "packages": {identifier: package["package_sha256"] for identifier, package in lock["packages"].items()}}
    (output / "omd-mods.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    lines = [f"First-party mod updates for Oh My Diff {planned['omd']}: {', '.join(planned['new'])}.", "",
             "Installed by `omd update` or **Update mods** in `/update`, and automatically when automatic updates are on.",
             "`omd update rollback` undoes it.", "", *(f"- {line}" for line in planned["commits"][:30])]
    (output / "notes.md").write_text("\n".join(lines) + "\n")
    return manifest | {"new": planned["new"], "needs_release": planned["needs_release"]}


def main():
    parser = argparse.ArgumentParser(description="Plan or build the first-party mod bundle for the current release")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("plan", help="show the target release, next serial and the mods that changed since it")
    build_parser = commands.add_parser("build", help="write the bundle archive, omd-mods.json and notes.md")
    build_parser.add_argument("--output", type=Path, required=True)
    build_parser.add_argument("--commit", required=True)
    args = parser.parse_args()
    result = plan() if args.command == "plan" else build(args.output.resolve(), args.commit)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        raise SystemExit(str(getattr(error, "stderr", None) or error).strip())
