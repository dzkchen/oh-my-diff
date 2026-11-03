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


def plan():
    version = json.loads((ROOT / "extensions/index.json").read_text())["release_pin"]["omd"]
    lock = support.mods_lock()
    if lock != mods_lock.build():
        raise ValueError("runtime/mods.lock.json differs from mods/first-party; run python3 .github/scripts/build.py locks")
    released = json.loads(git("show", f"v{version}:runtime/mods.lock.json"))
    if released["mod_api"] != lock["mod_api"]:
        raise ValueError(f"main hosts mod API {lock['mod_api']} but OMD {version} hosts {released['mod_api']}; cut a release instead")
    serials = [int(found[1]) for tag in git("tag", "-l", f"mods-{version}-*").split()
               if (found := re.fullmatch(rf"mods-{re.escape(version)}-([1-9][0-9]*)", tag))]
    changed = sorted(identifier for identifier, package in lock["packages"].items()
                     if identifier in released["packages"]
                     and package["package_sha256"] != released["packages"][identifier]["package_sha256"])
    added = sorted(lock["packages"].keys() - released["packages"].keys())
    return {"omd": version, "serial": max(serials, default=0) + 1, "changed": changed, "needs_release": added,
            "host_changed": git("diff", "--name-only", f"v{version}..HEAD", "--", "mods/api.d.ts", "runtime/").splitlines(),
            "commits": git("log", "--no-merges", "--format=%h %s", f"v{version}..HEAD", "--", "mods/first-party").splitlines()}


def build(output, commit):
    planned = plan()
    if not planned["changed"]:
        raise ValueError(f"no first-party mod differs from OMD {planned['omd']}")
    lock = support.mods_lock()
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
    lines = [f"First-party mod updates for Oh My Diff {planned['omd']}: {', '.join(planned['changed'])}.", "",
             "Installed by `omd update` or **Update mods** in `/update`, and automatically when automatic updates are on.",
             "`omd update rollback` undoes it.", "", *(f"- {line}" for line in planned["commits"][:30])]
    (output / "notes.md").write_text("\n".join(lines) + "\n")
    return manifest | {"changed": planned["changed"], "needs_release": planned["needs_release"]}


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
