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
OPERATIONS = "runtime/omd/src/mods/operation_schema.json"
FREE_FORM = {"settings_schema", "codex_config", "mcp_servers", "lifecycle"}


def git(*arguments):
    return subprocess.run(["git", *arguments], cwd=ROOT, capture_output=True, text=True, check=True).stdout


def at(ref, path):
    return json.loads(git("show", f"{ref}:{path}"))


def published(tag):
    manifest = subprocess.run(["gh", "release", "download", tag, "-p", "omd-mods.json", "-O", "-"], cwd=ROOT,
                              capture_output=True, text=True, check=True).stdout
    return json.loads(manifest)["packages"]


def required_features(identifier):
    manifest = json.loads((ROOT / "mods/first-party" / identifier / "mod.json").read_text())
    return set(manifest.get("compatibility", {}).get("required_features", []))


def manifest_keys(manifest):
    return {key for name, value in manifest.items()
            for key in [name, *(f"{name}.{inner}" for inner in (value if isinstance(value, dict) and name not in FREE_FORM else ()))]}


def released_manifests(version):
    return [at(f"v{version}", path) for path in git("ls-tree", "-r", "--name-only", f"v{version}", "mods/first-party").split()
            if path.endswith("/mod.json") and path.count("/") == 3]


def calls(identifier, names):
    sources = " ".join(path.read_text(errors="ignore") for path in (ROOT / "mods/first-party" / identifier).rglob("*")
                       if path.is_file() and path.suffix in {".ts", ".mjs", ".js", ".json"} and ".test." not in path.name)
    return sorted(name for name in names if f"'{name}'" in sources or f'"{name}"' in sources)


def operations(document):
    def resolve(node, seen=()):
        if isinstance(node, list):
            return [resolve(value, seen) for value in node]
        if not isinstance(node, dict):
            return node
        resolved = {key: resolve(value, seen) for key, value in node.items() if key != "$ref"}
        if "$ref" not in node:
            return resolved
        key = node["$ref"].rsplit("/", 1)[1]
        return resolved | ({"$cycle": seen.index(key)} if key in seen else resolve(document["$defs"][key], (*seen, key)))
    return {name: resolve(operation) for name, operation in document["operations"].items()}


def pinned():
    return json.loads((ROOT / "extensions/index.json").read_text())["release_pin"]["omd"]


def plan(exclude=()):
    version = pinned()
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
        shipped |= {identifier: sha256 for identifier, sha256 in published(tag).items()
                    if identifier in released and (identifier in shipped or sha256 != released[identifier]["package_sha256"])}
    current = {identifier: package["package_sha256"] for identifier, package in lock["packages"].items() if identifier in released}
    changed = sorted(identifier for identifier, sha256 in current.items() if sha256 != released[identifier]["package_sha256"])
    if unchanged := sorted(set(exclude) - set(changed)):
        raise ValueError(f"only mods changed since OMD {version} can be excluded: {', '.join(unchanged)}")
    if shipped_excluded := sorted(set(exclude) & shipped.keys()):
        raise ValueError(f"mods shipped in an earlier bundle cannot be excluded; revert them instead: {', '.join(shipped_excluded)}")
    if removed := sorted(shipped.keys() - current.keys()):
        raise ValueError(f"mods shipped in an earlier bundle were removed from main; cut a release instead: {', '.join(removed)}")
    bundle = sorted((set(changed) | shipped.keys()) - set(exclude))
    released_operations, operations_now = operations(at(f"v{version}", OPERATIONS)), operations(json.loads((ROOT / OPERATIONS).read_text()))
    api_changed = sorted(name for name in released_operations.keys() | operations_now.keys()
                         if released_operations.get(name) != operations_now.get(name))
    api_changed += git("diff", "--name-only", f"v{version}", "--", "mods/api.d.ts").splitlines()
    features = set(at(f"v{version}", "mods/conformance/compatibility.json")["host"]["features"])
    accepted = set().union(*map(manifest_keys, released_manifests(version)))
    changed_operations = [name for name in api_changed if "/" not in name]
    return {"omd": version, "serial": (bundles[-1][0] if bundles else 0) + 1, "changed": changed, "bundle": bundle,
            "new": sorted(identifier for identifier in bundle
                          if current[identifier] != shipped.get(identifier, released[identifier]["package_sha256"])),
            "needs_host": {identifier: sorted(missing) for identifier in bundle if (missing := required_features(identifier) - features)},
            "needs_manifest": {identifier: sorted(unknown) for identifier in bundle if (unknown := manifest_keys(json.loads(
                (ROOT / "mods/first-party" / identifier / "mod.json").read_text())) - accepted)},
            "needs_api": {identifier: used for identifier in bundle if (used := calls(identifier, changed_operations))},
            "needs_release": sorted(lock["packages"].keys() - released.keys()), "excluded": sorted(exclude), "api_changed": api_changed,
            "host_changed": git("diff", "--name-only", f"v{version}..HEAD", "--", "mods/api.d.ts", "runtime/").splitlines(),
            "commits": git("log", "--no-merges", "--format=%h %s", f"v{version}..HEAD", "--",
                           *(f"mods/first-party/{identifier}" for identifier in bundle)).splitlines() if bundle else []}


def unsafe(planned):
    return sorted(planned["needs_host"].keys() | planned["needs_manifest"].keys() | planned["needs_api"].keys())


def automatic(exclude=()):
    planned = plan(exclude)
    held = sorted(set(unsafe(planned)) - set(exclude))
    if not held:
        return planned
    if shipped := sorted(set(held) - set(planned["changed"])):
        raise ValueError(f"mods shipped in an earlier bundle no longer suit OMD {planned['omd']}; cut a release instead: {', '.join(shipped)}")
    return plan([*exclude, *held])


def build(output, commit, exclude=(), api_reviewed=False, auto=False):
    if auto and not git("tag", "-l", f"v{pinned()}").strip():
        return {"published": False, "omd": pinned(), "reason": "the release is not tagged yet"}
    planned = automatic(exclude) if auto else plan(exclude)
    if not planned["new"]:
        if auto:
            return {"published": False, "omd": planned["omd"], "reason": "nothing new to ship", "excluded": planned["excluded"]}
        raise ValueError(f"no first-party mod changed since OMD {planned['omd']} or its last mod bundle")
    if planned["needs_host"]:
        raise ValueError(f"these mods need host features OMD {planned['omd']} lacks; they wait for a release: {planned['needs_host']}")
    if planned["needs_manifest"]:
        raise ValueError(f"these mods use manifest fields OMD {planned['omd']} rejects; they wait for a release: {planned['needs_manifest']}")
    if planned["needs_api"]:
        raise ValueError(f"these mods call operations that changed since OMD {planned['omd']}; they wait for a release: {planned['needs_api']}")
    api_reviewed = api_reviewed or auto
    if planned["api_changed"] and not api_reviewed:
        raise ValueError(f"the mod host API changed since OMD {planned['omd']}: {', '.join(planned['api_changed'])}; cut a release, "
                         "or exclude the mods that depend on it and pass --api-reviewed")
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
    plan_parser = commands.add_parser("plan", help="show the target release, next serial and the mods that changed since it")
    build_parser = commands.add_parser("build", help="write the bundle archive, omd-mods.json and notes.md")
    for command in (plan_parser, build_parser):
        command.add_argument("--exclude", nargs="+", default=[], metavar="ID", help="leave these changed mods for the next release")
    build_parser.add_argument("--output", type=Path, required=True)
    build_parser.add_argument("--commit", required=True)
    build_parser.add_argument("--api-reviewed", action="store_true",
                              help="build although the mod host API changed: no bundled mod depends on the change")
    build_parser.add_argument("--auto", action="store_true",
                              help="leave out every mod the release can't run and succeed without a bundle when nothing is new")
    args = parser.parse_args()
    result = plan(args.exclude) if args.command == "plan" else build(args.output.resolve(), args.commit, args.exclude,
                                                                      args.api_reviewed, args.auto)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        raise SystemExit(str(getattr(error, "stderr", None) or error).strip())
