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
BOOTSTRAP = "runtime/omd/runner/src/bootstrap.js"
FREE_FORM = {"settings_schema", "codex_config", "mcp_servers", "lifecycle", "services.exports[].methods"}
ENUMS = {"capabilities[]", "state_scope", "subscriptions.app[]", "http_access.credentials[]", "environment[]"}
GENERATED = re.compile(r"runtime/[^/]+\.(?:lock\.json|txt|md)")


class Postponed(ValueError):
    pass


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


def manifest_keys(value, path=""):
    if path in FREE_FORM:
        return {path}
    if isinstance(value, dict):
        return {path} - {""} | set().union(*(manifest_keys(inner, f"{path}.{name}" if path else name) for name, inner in value.items()))
    if isinstance(value, list):
        return {path} | set().union(*(manifest_keys(inner, f"{path}[]") for inner in value))
    return {f"{path}={json.dumps(value)}" if path in ENUMS else path}


def released_manifests(version):
    return [at(f"v{version}", path) for path in git("ls-tree", "-r", "--name-only", f"v{version}", "mods/first-party").split()
            if path.endswith("/mod.json") and path.count("/") == 3]


def helpers(source):
    functions = dict(re.findall(r"^function (\w+)(\(.*?)(?=^\S)", source, re.M | re.S))

    def reached(body, seen=frozenset()):
        found = set(re.findall(r"host(?:Try)?Call\('([\w.]+)'", body))
        for name in set(re.findall(r"\b(\w+)\(", body)) & functions.keys() - seen:
            found |= reached(functions[name], seen | {name})
        return found
    region = found[1] if (found := re.search(r"^const api = Object\.freeze\(\{\n(.*?)^\}\);", source, re.M | re.S)) else ""
    members = {name: found for name, body in re.findall(r"^  (\w+)(.*?)(?=^  \w|\Z)", region, re.M | re.S) if (found := reached(body))}
    return members | {"": reached(source) - set().union(*members.values())}


def calls(identifier, names, wrapped):
    sources = " ".join(path.read_text(errors="ignore") for path in (ROOT / "mods/first-party" / identifier).rglob("*")
                       if path.is_file() and path.suffix in {".ts", ".mjs", ".js", ".json"} and ".test." not in path.name)
    through = set().union(*(found for member, found in wrapped.items() if not member or re.search(rf"\.{member}\b", sources)))
    return sorted(name for name in names if f"'{name}'" in sources or f'"{name}"' in sources or name in through)


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


def host_changes(version):
    tied, ranges = {}, [["HEAD", f"^v{version}"]]
    while ranges:
        tip, *stops = ranges.pop()
        for entry in git("log", "--first-parent", "--diff-merges=first-parent", "--format=%x00%h %p%x01%s", "--name-only",
                         tip, *stops).split("\0")[1:]:
            header, _, body = entry.partition("\x01")
            commit, *parents = header.split()
            subject, *paths = body.split("\n")
            if len(parents) > 1 and not subject.startswith("Merge pull request #"):
                ranges.append([parents[1], f"^{parents[0]}", *stops])
                continue
            if any(path == "mods/api.d.ts" or path.startswith("runtime/") and not GENERATED.fullmatch(path) for path in paths):
                for identifier in {path.split("/")[2] for path in paths if path.startswith("mods/first-party/") and path.count("/") > 2}:
                    tied.setdefault(identifier, []).append(commit)
    return tied


def history(version, bundle):
    return git("log", "--no-merges", "--format=%h %s", f"v{version}..HEAD", "--",
               *(f"mods/first-party/{identifier}" for identifier in bundle)).splitlines() if bundle else []


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
        raise Postponed(f"main hosts a different mod API than OMD {version}; cut a release instead")
    bundles = sorted((int(found[1]), tag) for tag in git("tag", "-l", f"mods-{version}-*").split()
                     if (found := re.fullmatch(rf"mods-{re.escape(version)}-([1-9][0-9]*)", tag)))
    shipped = {}
    for _, tag in bundles:
        shipped |= {identifier: sha256 for identifier, sha256 in published(tag).items()
                    if identifier not in released or identifier in shipped or sha256 != released[identifier]["package_sha256"]}
    current = {identifier: package["package_sha256"] for identifier, package in lock["packages"].items()}
    features = set(at(f"v{version}", "mods/conformance/compatibility.json")["host"]["features"])
    curated, _ = support.catalog(json.loads((ROOT / "extensions/index.json").read_text()))
    arrived = sorted(current.keys() - released.keys())
    waiting = [identifier for identifier in arrived
               if identifier not in shipped and (identifier not in curated or required_features(identifier) - features)]
    changed = sorted(identifier for identifier in released.keys() & current.keys() if current[identifier] != released[identifier]["package_sha256"])
    if unchanged := sorted(set(exclude) - set(changed) - set(arrived)):
        raise ValueError(f"only mods changed since OMD {version} can be excluded: {', '.join(unchanged)}")
    if shipped_excluded := sorted(set(exclude) & shipped.keys()):
        raise ValueError(f"mods shipped in an earlier bundle cannot be excluded; revert them instead: {', '.join(shipped_excluded)}")
    if removed := sorted(shipped.keys() - current.keys()):
        raise ValueError(f"mods shipped in an earlier bundle were removed from main; cut a release instead: {', '.join(removed)}")
    bundle = sorted((set(changed) | shipped.keys() | set(arrived)) - set(exclude) - set(waiting))
    released_operations, operations_now = operations(at(f"v{version}", OPERATIONS)), operations(json.loads((ROOT / OPERATIONS).read_text()))
    api_changed = sorted(name for name in released_operations.keys() | operations_now.keys()
                         if released_operations.get(name) != operations_now.get(name))
    api_changed += git("diff", "--name-only", f"v{version}", "--", "mods/api.d.ts").splitlines()
    accepted = set().union(*map(manifest_keys, released_manifests(version)))
    changed_operations = [name for name in api_changed if "/" not in name]
    wrapped = {}
    for source in (git("show", f"v{version}:{BOOTSTRAP}"), (ROOT / BOOTSTRAP).read_text()):
        for member, found in helpers(source).items():
            wrapped[member] = wrapped.get(member, set()) | found
    tied = host_changes(version)
    return {"omd": version, "serial": (bundles[-1][0] if bundles else 0) + 1, "changed": changed, "shipped": sorted(shipped),
            "bundle": bundle, "features": sorted(features),
            "new": sorted(identifier for identifier in bundle
                          if current[identifier] != shipped.get(identifier, released.get(identifier, {}).get("package_sha256"))),
            "needs_host": {identifier: sorted(missing) for identifier in bundle if (missing := required_features(identifier) - features)},
            "needs_manifest": {identifier: sorted(unknown) for identifier in bundle if (unknown := manifest_keys(json.loads(
                (ROOT / "mods/first-party" / identifier / "mod.json").read_text())) - accepted)},
            "needs_api": {identifier: used for identifier in bundle if (used := calls(identifier, changed_operations, wrapped))},
            "needs_runtime": {identifier: sorted(tied[identifier]) for identifier in bundle if identifier in tied},
            "added": sorted((set(arrived) - shipped.keys()) & set(bundle)), "needs_release": waiting, "excluded": sorted(exclude),
            "api_changed": api_changed, "commits": history(version, bundle)}


def directory(version, features, listed, first_party):
    _, released = support.catalog(at(f"v{version}", "extensions/index.json"))

    def suits(entry):
        source = entry["source"]
        manifest = json.loads(git("show", f"{source['revision']}:{source['subdirectory']}/mod.json"))
        return not set(manifest.get("compatibility", {}).get("required_features", [])) - features
    chosen = {}
    for identifier in sorted(listed.keys() - first_party):
        for entries in (listed[identifier], released.get(identifier)):
            if entries and suits(entries[0]):
                chosen[identifier] = entries
                break
    return chosen


NEEDS = ("needs_host", "needs_manifest", "needs_api", "needs_runtime")


def automatic(exclude=()):
    planned = plan(exclude)
    held = set().union(*(planned[need].keys() for need in NEEDS))
    if not held:
        return planned
    if shipped := sorted(held & set(planned["shipped"])):
        raise ValueError(f"mods shipped in an earlier bundle no longer suit OMD {planned['omd']}; cut a release instead: {', '.join(shipped)}")
    bundle = [identifier for identifier in planned["bundle"] if identifier not in held]
    return planned | {need: {} for need in NEEDS} | {
        "bundle": bundle, "new": [identifier for identifier in planned["new"] if identifier not in held],
        "added": [identifier for identifier in planned["added"] if identifier not in held],
        "excluded": sorted({*planned["excluded"], *held}), "commits": history(planned["omd"], bundle)}


def build(output, commit, exclude=(), api_reviewed=False, auto=False):
    if auto and not git("tag", "-l", f"v{pinned()}").strip():
        return {"published": False, "omd": pinned(), "reason": "the release is not tagged yet"}
    try:
        planned = automatic(exclude) if auto else plan(exclude)
    except Postponed as reason:
        if not auto:
            raise
        return {"published": False, "omd": pinned(), "reason": str(reason)}
    if auto and "mods/api.d.ts" in planned["api_changed"] and not api_reviewed:
        return {"published": False, "omd": planned["omd"], "reason": "mods/api.d.ts changed since the release; run the Mods workflow "
                "by hand with api_reviewed after checking no bundled mod uses the change, or cut a release"}
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
    if planned["needs_runtime"] and not api_reviewed:
        raise ValueError(f"these mods changed with the host since OMD {planned['omd']}; review them and pass --api-reviewed, "
                         f"exclude them or cut a release: {planned['needs_runtime']}")
    operations_only = auto and "mods/api.d.ts" not in planned["api_changed"]
    if planned["api_changed"] and not (api_reviewed or operations_only):
        raise ValueError(f"the mod host API changed since OMD {planned['omd']}: {', '.join(planned['api_changed'])}; cut a release, "
                         "or exclude the mods that depend on it and pass --api-reviewed")
    lock = support.mods_lock()
    curated, listed = support.catalog(json.loads((ROOT / "extensions/index.json").read_text()))
    lock = lock | {"packages": {identifier: lock["packages"][identifier] for identifier in planned["bundle"]},
                   "catalog": {identifier: {"description": curated[identifier]["capability"], "support": curated[identifier]["support_status"]}
                               for identifier in planned["bundle"] if identifier in curated},
                   "index": directory(planned["omd"], set(planned["features"]), listed, lock["packages"].keys())}
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
    lines = [f"First-party mod updates for Oh My Diff {planned['omd']}: {', '.join(planned['new'])}.",
             *([f"New mods, off until you install them: {', '.join(planned['added'])}."] if planned["added"] else []), "",
             "Installed by `omd update` or **Update mods** in `/update`, and automatically when automatic updates are on.",
             "`omd update rollback` undoes it.", "", *(f"- {line}" for line in planned["commits"][:30])]
    (output / "notes.md").write_text("\n".join(lines) + "\n")
    return manifest | {"new": planned["new"], "added": planned["added"], "needs_release": planned["needs_release"]}


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
