#!/usr/bin/env python3
import json
import sys
from pathlib import Path

from scripts import install_support as support

ROOT = Path(__file__).resolve().parents[1]
REGISTRY = ROOT / "mods/extension-types.json"
DOCUMENT = ROOT / "mods/EXTENSION_TYPES.md"
ROLES = {"bundled", "author_example", "conformance_fixture"}
EXTENSION_TYPES = {"hook", "mod", "plugin", "skill"}
PACKAGE_ROOTS = (ROOT / "mods/examples", ROOT / "mods/first-party")


def package_paths():
    return {
        str(path.parent.relative_to(ROOT))
        for base in PACKAGE_ROOTS
        for path in base.rglob("mod.json")
    }


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
    locked = {package["source"]: package for package in support.mods_lock()["packages"].values()}
    if set(bundled) != set(locked):
        problems.append("bundled classifications differ from runtime/mods.lock.json")
    for path, package in bundled.items():
        if locked.get(path, {}).get("extension_type") != package["extension_type"]:
            problems.append(f"{path}: mods lock extension type differs")

    published = {
        Path(package["path"]).name
        for package in packages
        if package["role"] == "author_example"
    }
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


def table(rows, headers):
    lines = ["| " + " | ".join(headers) + " |", "| " + " | ".join("---" for _ in headers) + " |"]
    lines.extend("| " + " | ".join(value.replace("|", "\\|") for value in row) + " |" for row in rows)
    return "\n".join(lines)


def render(registry):
    packages = identified(registry)
    out = [
        "# Extension types",
        "",
        "<!-- Generated from mods/extension-types.json by python3 -m scripts.mod_extension_types --write. -->",
        "",
        registry["rule"],
        "",
        "A conformance fixture is retained source and executable coverage, not a package offered",
        "to users. The author SDK packs only author examples. The first-party mod lock",
        "(`runtime/mods.lock.json`) pins only the packages labeled `bundled` below.",
        "",
    ]
    sections = (
        ("Bundled packages", "bundled"),
        ("Author examples", "author_example"),
        ("Conformance fixtures", "conformance_fixture"),
    )
    for title, role in sections:
        rows = [
            (f"`{package['id']}@{package['version']}`", f"`{package['extension_type']}`", f"`{package['path']}`", package["why_mod"])
            for package in packages
            if package["role"] == role
        ]
        out.extend([f"## {title}", "", table(rows, ["Package", "Extension type", "Source", "Why a mod is required for this behavior"]), ""])
    out.extend([
        "## Synthetic conformance fixtures",
        "",
        table(
            [
                (f"`{fixture['name']}`", f"`{fixture['extension_type']}`", f"`{fixture['location']}`", fixture["reason"])
                for fixture in registry["synthetic_fixtures"]
            ],
            ["Fixture", "Extension type", "Location", "Boundary"],
        ),
        "",
        "The small context, counter, guard, interception, service, reader, and tool cases remain",
        "available to repository conformance checks. They are not copied by `omd-mod-author examples`,",
        "not packed as SDK examples, and not part of the first-party mod lock.",
        "",
    ])
    return "\n".join(out)


def main():
    registry = json.loads(REGISTRY.read_text())
    problems = check(registry)
    if problems:
        raise SystemExit("\n".join(problems))
    support.check_or_write(DOCUMENT, render(registry), "--write" in sys.argv[1:],
                           "mods/EXTENSION_TYPES.md is stale; rerun python3 -m scripts.mod_extension_types --write")
    print(f"extension types: {len(registry['packages'])} packages and {len(registry['synthetic_fixtures'])} synthetic fixtures")


if __name__ == "__main__":
    main()
