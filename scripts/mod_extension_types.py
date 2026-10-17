#!/usr/bin/env python3
import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REGISTRY = ROOT / "mods/extension-types.json"
ROLES = {"bundled", "candidate", "author_example", "conformance_fixture"}
EXTENSION_TYPES = {"hook", "mod", "plugin", "skill"}
PACKAGE_ROOTS = (ROOT / "mods/examples", ROOT / "mods/first-party")


def package_paths():
    return {
        str(path.parent.relative_to(ROOT))
        for base in PACKAGE_ROOTS
        for path in base.rglob("mod.json")
    }


def author_examples():
    source = (ROOT / "mods/author/cli.mjs").read_text()
    match = re.search(r"const publicExamples = \[(.*?)\];", source, re.S)
    return re.findall(r"'([^']+)'", match.group(1)) if match else []


def identified(registry):
    packages = []
    for package in registry.get("packages", []):
        manifest = ROOT / package["path"] / "mod.json"
        identity = json.loads(manifest.read_text()) if manifest.is_file() else {}
        packages.append({**package, "id": identity.get("id"), "version": identity.get("version")})
    return packages


def check(registry):
    problems = []
    packages = identified(registry)
    paths = [package.get("path") for package in packages]
    if len(paths) != len(set(paths)):
        problems.append("duplicate classified package path")
    actual = package_paths()
    if set(paths) != actual:
        problems.append(f"classified package paths differ: missing={sorted(actual - set(paths))}, extra={sorted(set(paths) - actual)}")

    for raw in registry.get("packages", []):
        if {"id", "version"} & set(raw):
            problems.append(f"{raw['path']}: id and version come from mod.json; remove them from the registry")
    for package in packages:
        label = package["path"]
        if package.get("extension_type") not in EXTENSION_TYPES:
            problems.append(f"{label}: unknown extension type {package.get('extension_type')!r}")
        if package.get("role") not in ROLES:
            problems.append(f"{label}: unknown role {package.get('role')!r}")
        if not package.get("why_mod"):
            problems.append(f"{label}: missing mod rationale")

    bundled = {package["path"]: package for package in packages if package["role"] == "bundled"}
    preview = json.loads((ROOT / "runtime/preview-v1.lock.json").read_text())
    locked = {package["source"]: package for package in preview["packages"].values()}
    if set(bundled) != set(locked):
        problems.append("bundled classifications differ from runtime/preview-v1.lock.json")
    for path, package in bundled.items():
        if locked.get(path, {}).get("extension_type") != package["extension_type"]:
            problems.append(f"{path}: preview lock extension type differs")

    published = {
        Path(package["path"]).name
        for package in packages
        if package["role"] == "author_example"
    }
    if set(author_examples()) != published:
        problems.append(f"author CLI examples differ: declared={author_examples()}, classified={sorted(published)}")
    files = json.loads((ROOT / "mods/package.json").read_text())["files"]
    shipped = {value.removeprefix("examples/") for value in files if value.startswith("examples/")}
    if shipped != published:
        problems.append(f"packed examples differ: packed={sorted(shipped)}, classified={sorted(published)}")

    required_fixtures = {"context", "counter", "guard", "interception", "service_consumer", "service_provider"}
    fixtures = {package["id"] for package in packages if package["role"] == "conformance_fixture"}
    if not required_fixtures <= fixtures:
        problems.append(f"small examples are not fixture-only: {sorted(required_fixtures - fixtures)}")
    synthetic = {fixture.get("name") for fixture in registry.get("synthetic_fixtures", [])}
    if not {"reader", "tool"} <= synthetic:
        problems.append("reader and tool synthetic fixtures are not classified")
    return problems


def main():
    registry = json.loads(REGISTRY.read_text())
    problems = check(registry)
    if problems:
        raise SystemExit("\n".join(problems))
    print(f"extension types: {len(registry['packages'])} packages and {len(registry['synthetic_fixtures'])} synthetic fixtures")


if __name__ == "__main__":
    main()
