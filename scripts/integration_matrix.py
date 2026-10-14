#!/usr/bin/env python3
"""Check the integration source inventory; optionally require release execution receipts."""
import argparse
import json
import re
import sys
from pathlib import Path

from scripts import lean_profiles, install_support, execution_evidence
from scripts.execution_evidence import resolve

ROOT = Path(__file__).resolve().parents[1]
MATRIX = ROOT / "integration/matrix.json"
DOCUMENT = ROOT / "INTEGRATION.md"
AREAS = {
    "host": "Host and public API",
    "first_party_mod": "First-party mods",
    "native": "Native Codex plugins, hooks and resources",
    "lsp": "Language server adapters",
    "optional": "Optional integrations",
}
STATUSES = {"supported", "default_off", "opt_in", "removed"}
COMPONENT_FIELDS = ("id", "area", "name", "owner", "version", "status", "fixtures", "limitations", "removal")


def sources():
    host = (ROOT / "runtime/omd/src/mods.rs").read_text()
    lsp = (ROOT / "mods/first-party/omd_lsp_sync/protocol.ts").read_text()
    coverage = (ROOT / "mods/COVERAGE.md").read_text()

    def constant(name):
        return re.search(rf"{name}: &\[[^]]*\] =\s*&\[(.*?)\];", host, re.S).group(1)

    servers = {language: re.findall(r"name: '([\w-]+)'", block)
               for language, block in re.findall(r"^  (\w+): \{ candidates: \[(.*?)\] \},$", lsp, re.M)}
    servers["javascript"] = servers["typescript"]
    api = re.search(r'MOD_API_VERSION: &str = "([^"]+)"', host).group(1)
    preview = json.loads((ROOT / "runtime/preview-v1.lock.json").read_text())
    packages = {**preview["packages"], **json.loads((ROOT / "runtime/full-mods.lock.json").read_text())["packages"]}
    plugin = install_support.plugin_lock()
    plugins = sorted(plugin["plugins"])
    view = (ROOT / "runtime/omd/src/mods/view.rs").read_text()
    site_validation = view[view.index("fn valid_site("):view.index("fn valid_action(")]
    return {
        "upstream": json.loads((ROOT / "upstream.lock.json").read_text()),
        "compatibility": json.loads((ROOT / "mods/compatibility.json").read_text()),
        "preview": preview,
        "plugin": plugin,
        "api": api,
        "omd": json.loads((ROOT / "mods/package.json").read_text())["version"],
        "capabilities": set(re.findall(r'"([a-z_.]+)"', constant("MOD_CAPABILITIES"))),
        "operations": set(re.findall(r'"([a-z_.]+)"', constant("MOD_HOST_OPERATIONS"))),
        "features": re.findall(r'"([a-z0-9_]+)"', constant("MOD_HOST_FEATURES")),
        "sites": re.findall(r'"([a-z_]+)"', re.search(r'\[([^\]]*)\]\s*\.contains\(&name\)', site_validation).group(1)),
        "schemas": {key: int(re.search(rf'{name}: u32 = (\d+);', host).group(1))
                    for key, name in (("package", "MOD_PACKAGE_SCHEMA_VERSION"),
                                      ("state_storage", "MOD_STATE_STORAGE_SCHEMA_VERSION"),
                                      ("installed_contract_types", "INSTALLED_CONTRACT_TYPES_VERSION"))},
        "terminal_operations": [name for name in re.findall(r'"([a-z_.]+)"', constant("MOD_HOST_OPERATIONS"))
                                if name.startswith(("terminal.", "composer.", "builtins."))],
        "first_party_packages": {name: {key: packages[name][key] for key in ("version", "source")}
                                 for name in lean_profiles.PACKAGES},
        "profiles": {name: {"label": label, "first_party_installed": list(lean_profiles.profile_packages(name)),
                            "first_party_default_active": sorted(set(lean_profiles.profile_packages(name))
                                                                 & set(lean_profiles.DEFAULT_ACTIVE)),
                            "plugin_sources": plugins if name == "full" else []}
                     for name, label in lean_profiles.PROFILE_LABELS.items()},
        "apis": [
            api if row == "MOD_API_VERSION" else row.strip('"')
            for row, _, _ in re.findall(r'\(([^,]+), "([a-z]+)", "([\d-]+)"\)', constant("SUPPORTED_MOD_APIS"))
        ],
        "languages": servers,
        "hooks": re.findall(r"`([a-z_]+)`", re.search(r"and hooks for (.*?)\.\nA hook", coverage, re.S).group(1)),
    }


def release_evidence(matrix):
    return {reference for entry in matrix["combinations"] + matrix["regression"]
            for reference in entry["evidence"]}


def check(matrix):
    source = sources()
    problems = []
    release = matrix["release"]
    if not matrix.get("qualification"):
        raise ValueError("integration matrix needs an explicit release qualification")
    expected = {
        "codex": source["compatibility"]["host"]["codex"],
        "omd": source["compatibility"]["host"]["omd"],
        "mod_api": source["api"],
        "package_schema": source["compatibility"]["host"]["package_schemas"][0],
        "upstream_tag": source["upstream"]["tag"],
        "upstream_commit": source["upstream"]["commit"],
        "target": source["upstream"]["verified_target"],
        "node": source["preview"]["node"],
    }
    for key, value in expected.items():
        if release.get(key) != value:
            problems.append(f"release.{key} is {release.get(key)!r}; the shipped source says {value!r}")
    if source["api"] != source["omd"]:
        problems.append(f"mods/package.json {source['omd']} does not match the host API {source['api']}")
    for key in ("profiles", "first_party_packages"):
        if matrix.get(key) != source[key]:
            problems.append(f"{key} differs from the selected package source inventory")

    components = {}
    for component in matrix["components"]:
        identifier = component["id"]
        if identifier in components:
            problems.append(f"duplicate component id {identifier}")
        components[identifier] = component
        for field in COMPONENT_FIELDS:
            if not component.get(field) and not (field == "fixtures" and component.get("status") == "removed"):
                problems.append(f"{identifier}: missing {field}")
        if component.get("area") not in AREAS:
            problems.append(f"{identifier}: unknown area {component.get('area')}")
        if component.get("status") not in STATUSES:
            problems.append(f"{identifier}: unknown status {component.get('status')}")
    for area in AREAS:
        if not any(component["area"] == area for component in matrix["components"]):
            problems.append(f"no component covers the {area} area")

    def claim(identifier, key, actual):
        declared = components.get(identifier, {}).get(key)
        if declared != actual:
            problems.append(f"{identifier}.{key} is {declared!r}; the shipped source says {actual!r}")

    claim("mod_api", "version", source["api"])
    claim("mod_api", "supported_versions", source["apis"])
    claim("mod_api", "sites", source["sites"])
    claim("mod_api", "terminal_operations", source["terminal_operations"])
    claim("omd_host", "version", f"{source['compatibility']['host']['omd']} on Codex {source['compatibility']['host']['codex']}")
    claim("omd_host", "features", source["features"])
    claim("omd_host", "schemas", source["schemas"])
    claim("upstream_hooks", "hooks", source["hooks"])
    for plugin_id, plugin in source["plugin"]["plugins"].items():
        component = plugin_id.replace("-", "_")
        claim(component, "version", plugin["version"])
        claim(component, "extension_type", plugin["extension_types"])
    for name, package in source["preview"]["packages"].items():
        claim(name, "version", package["version"])
        claim(name, "extension_type", package["extension_type"])
        claim(name, "capabilities", sorted(package["capabilities"]))
        if not set(package["capabilities"]) <= source["capabilities"]:
            problems.append(f"{name}: capabilities outside the published API")
    for language, servers in source["languages"].items():
        claim(f"lsp_{language}", "version", servers)
    for component in matrix["components"]:
        for operation in component.get("operations", []):
            if operation not in source["operations"]:
                problems.append(f"{component['id']}: {operation} is not a host operation")
        capability = component.get("capability")
        if capability and capability not in source["capabilities"]:
            problems.append(f"{component['id']}: {capability} is not a mod capability")

    boundaries = {boundary["id"] for boundary in matrix["boundaries"]}
    for boundary in matrix["boundaries"]:
        if not boundary.get("title") or not boundary.get("shared_resource"):
            problems.append(f"boundary {boundary['id']}: missing title or shared resource")
    exercised = set()
    identifiers = set()
    for entry in matrix["combinations"]:
        identifier = entry["id"]
        if identifier in identifiers:
            problems.append(f"duplicate combination id {identifier}")
        identifiers.add(identifier)
        if len(entry["components"]) < 2:
            problems.append(f"{identifier}: a combination needs at least two components")
        for component in entry["components"]:
            if component not in components:
                problems.append(f"{identifier}: unknown component {component}")
        for boundary in entry["boundaries"]:
            if boundary not in boundaries:
                problems.append(f"{identifier}: unknown boundary {boundary}")
        if not entry["evidence"]:
            problems.append(f"{identifier}: no executable evidence")
        if not entry.get("result"):
            problems.append(f"{identifier}: no recorded result")
        exercised |= set(entry["boundaries"])
    for boundary in sorted(boundaries - exercised):
        problems.append(f"boundary {boundary} has no exercised combination")

    for entry in matrix["regression"]:
        if not entry.get("retained_for") or not entry.get("evidence"):
            problems.append(f"regression case {entry['id']}: missing retained versions or evidence")
        for version in entry.get("retained_for", []):
            known = source["apis"] + [source["compatibility"]["host"]["codex"], source["compatibility"]["host"]["omd"], source["preview"]["node"]]
            if version not in known:
                problems.append(f"regression case {entry['id']}: {version} is not a supported version row")

    for entry in matrix["combinations"] + matrix["regression"]:
        for reference in entry["evidence"]:
            if not resolve(reference):
                problems.append(f"{entry['id']}: unresolved evidence {reference}")

    problems += launch_problems(matrix.get("launch"), source)

    untested = set()
    for entry in matrix["untested"]:
        if entry["id"] in identifiers:
            problems.append(f"{entry['id']} is reported as both tested and untested")
        if entry["id"] in untested:
            problems.append(f"duplicate untested id {entry['id']}")
        untested.add(entry["id"])
        if not entry.get("reason") or not entry.get("combination"):
            problems.append(f"untested {entry['id']}: missing combination or reason")
    return problems


LAUNCH_TIERS = ("default-active", "opt-in", "staged")


def launch_problems(entries, source):
    if not entries:
        return ["launch is missing"]
    problems = []
    seen = set()
    launched = {"mod": set(), "plugin": set()}
    active = set()
    for entry in entries:
        name = entry.get("id")
        if not entry.get("path"):
            problems.append(f"launch {name}: missing path")
            continue
        if name in seen:
            problems.append(f"launch: duplicate entry {name}")
        seen.add(name)
        if entry.get("tier") not in LAUNCH_TIERS or not set(entry.get("profiles", [])) <= set(lean_profiles.PROFILE_LABELS) or not entry.get("profiles"):
            problems.append(f"launch {name}: needs a launch tier and profiles")
        if not (ROOT / entry["path"]).exists():
            problems.append(f"launch {name}: path {entry['path']} is missing")
        if entry.get("kind") in launched:
            launched[entry["kind"]].add(name)
        if entry.get("tier") == "default-active":
            active.add(name)
    if launched["mod"] != set(lean_profiles.PACKAGES):
        problems.append("launch mods differ from the selected package source inventory")
    if active != set(lean_profiles.DEFAULT_ACTIVE):
        problems.append("launch default-active mods differ from the fresh-install default selection")
    if launched["plugin"] != set(source["plugin"]["plugins"]):
        problems.append("launch plugins differ from the plugin lock")
    return problems


def table(rows, headers):
    lines = ["| " + " | ".join(headers) + " |", "| " + " | ".join("---" for _ in headers) + " |"]
    lines += ["| " + " | ".join(cell.replace("|", "\\|") for cell in row) + " |" for row in rows]
    return "\n".join(lines)


DETAILS = ("extension_type", "versions", "supported_versions", "capabilities", "features", "hooks", "operations", "terminal_operations", "sites", "schemas")


def listed(value):
    if isinstance(value, dict):
        return ", ".join(f"{key} {item}" for key, item in value.items())
    if isinstance(value, list):
        return ", ".join(str(item) for item in value)
    return str(value)


def version(component):
    detail = [f"{key.replace('_', ' ')}: {listed(component[key])}" for key in DETAILS if key in component]
    return " — ".join([listed(component["version"]), *detail])


def references(values):
    return " · ".join(f"`{value}`" for value in values)


def render(matrix):
    release = matrix["release"]
    out = [
        "# Integration coverage",
        "",
        "<!-- Generated from integration/matrix.json by python3 -m scripts.integration_matrix --write. -->",
        "",
        f"Accumulated integration coverage for the {release['upstream_tag']} pinned runtime as of",
        f"{matrix['as_of']}. Each component names its owner, version, retained fixtures, limits,",
        "and removal path. Fixture references are cumulative; this source check does not rerun",
        "them or verify test discovery, execution, assertions, or the full release candidate.",
        "Release qualification requires `--release --executed-evidence RECEIPT` for all",
        "combination and regression evidence at the clean validated revision; see `integration/EVIDENCE.md`.",
        "The matrix is checked against the",
        "shipped sources by `scripts/integration_matrix.py`: a version, capability, hook, language",
        "or evidence reference that disagrees with the runtime fails the check.",
        "",
        f"**Qualification:** {matrix['qualification']}",
        "",
        "Combinations below are representative, not exhaustive. Exercising every possible",
        "combination of mods, adapters and optional integrations is not promised; the untested",
        "section names what is deliberately out of scope.",
        "",
        "## Release",
        "",
        table(
            [(key.replace("_", " "), f"`{value}`") for key, value in release.items()],
            ["Field", "Value"],
        ),
        "",
    ]
    out += [
        "## Selected source inventory", "",
        "This is the current package source selection, not proof of an installed or active session.",
        "Opt-in mods remain disabled; plugin sources and their nested skills/hooks require separate installation and activation.", "",
        table([(profile["label"], f"`{selector}`", ", ".join(profile["first_party_installed"]),
                ", ".join(profile["first_party_default_active"]), ", ".join(profile["plugin_sources"]) or "none")
               for selector, profile in matrix["profiles"].items()],
              ["Profile", "Selector", "Installed mod sources", "Fresh-install default selection", "Inactive plugin sources"]), "",
        table([(f"`{name}`", package["version"], f"`{package['source']}`")
               for name, package in matrix["first_party_packages"].items()], ["Selected mod", "Version", "Source"]), "",
    ]
    out += [
        "## Launch collection", "",
        table([(f"`{entry['id']}`", entry["kind"], entry["tier"],
                " + ".join(lean_profiles.PROFILE_LABELS[profile] for profile in entry["profiles"]), f"`{entry['path']}`")
               for entry in matrix["launch"]], ["Package", "Kind", "Tier", "Profiles", "Path"]), "",
    ]
    for area, title in AREAS.items():
        rows = [
            (
                f"**{component['name']}**",
                component["owner"],
                version(component),
                component["status"].replace("_", " "),
                references(component["fixtures"]),
                component["limitations"],
                component["removal"],
            )
            for component in matrix["components"]
            if component["area"] == area
        ]
        out += [
            f"## {title}",
            "",
            table(rows, ["Component", "Owner", "Version", "Status", "Fixtures", "Limitations", "Removal or migration"]),
            "",
        ]
    out += [
        "## Shared resource and event boundaries",
        "",
        table(
            [(f"**{boundary['id']}**", boundary["title"], boundary["shared_resource"]) for boundary in matrix["boundaries"]],
            ["Boundary", "What it covers", "Shared resource or event"],
        ),
        "",
        "## Combination evidence inventory",
        "",
        table(
            [
                (
                    f"**{entry['id']}**",
                    ", ".join(entry["components"]),
                    ", ".join(entry["boundaries"]),
                    entry["result"],
                    references(entry["evidence"]),
                )
                for entry in matrix["combinations"]
            ],
            ["Combination", "Components", "Boundaries", "Recorded result (not verified here)", "Source evidence inventory"],
        ),
        "",
        "## Retained regression cases",
        "",
        table(
            [
                (
                    f"**{entry['id']}**",
                    ", ".join(entry["retained_for"]),
                    entry["case"],
                    references(entry["evidence"]),
                )
                for entry in matrix["regression"]
            ],
            ["Case", "Retained for", "Claimed behavior", "Source evidence inventory"],
        ),
        "",
        "## Inventoried versus untested",
        "",
        f"Inventoried: {len(matrix['combinations'])} combinations across {len(matrix['boundaries'])} shared boundaries and "
        f"{len(matrix['components'])} maintained components, plus {len(matrix['regression'])} regression cases "
        "retained across versions.",
        "",
        "Untested and not claimed:",
        "",
    ]
    out += [f"- **{entry['combination']}** — {entry['reason']}" for entry in matrix["untested"]] + [""]
    out += [
        "## Reproducing the evidence",
        "",
        "`rust:` a test in the pinned runtime crates · `patch:` a test added by the shipped runtime",
        "patch · `node:` `mods/runner.test.mjs` · `python:` `tests/` · `script:` a repository checker.",
        "",
        "```sh",
    ]
    out += matrix["commands"] + ["```", ""]
    return "\n".join(out)


def main(argv=()):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="store_true")
    parser.add_argument("--release", action="store_true")
    parser.add_argument("--executed-evidence", type=Path, action="append", default=[])
    args = parser.parse_args(argv)
    matrix = json.loads(MATRIX.read_text())
    problems = check(matrix)
    if args.release or args.executed_evidence:
        problems += execution_evidence.verify(release_evidence(matrix), args.executed_evidence)
    if problems:
        raise SystemExit("\n".join(problems))
    install_support.check_or_write(DOCUMENT, render(matrix), args.write,
                                   "INTEGRATION.md is stale; rerun python3 -m scripts.integration_matrix --write")
    print(
        f"integration matrix {matrix['as_of']}: {len(matrix['components'])} maintained components, "
        f"{len(matrix['combinations'])} inventoried combinations over {len(matrix['boundaries'])} shared "
        f"boundaries, {len(matrix['regression'])} retained regression cases, "
        f"{len(matrix['untested'])} recorded untested combinations; "
        + ("release execution evidence verified" if args.release or args.executed_evidence else "execution coverage not verified")
    )


if __name__ == "__main__":
    main(sys.argv[1:])
