#!/usr/bin/env python3
"""Check the maintained integration coverage matrix against the shipped sources and its evidence."""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from scripts import mod_conformance  # noqa: E402

MATRIX = ROOT / "integration/matrix.json"
DOCUMENT = ROOT / "INTEGRATION.md"
AREAS = {
    "host": "Host and public API",
    "first_party_mod": "First-party mods",
    "native": "Native Codex plugins, hooks and resources",
    "browser": "Bundled browser tooling",
    "lsp": "Language server adapters",
    "bridge": "Application bridge adapters",
    "optional": "Optional integrations",
}
STATUSES = {"supported", "default_off", "opt_in", "removed"}
COMPONENT_FIELDS = ("id", "area", "name", "owner", "version", "status", "fixtures", "limitations", "removal")


def sources():
    host = (ROOT / "runtime/omd/src/mods.rs").read_text()
    lsp = (ROOT / "runtime/omd/src/lsp.rs").read_text()
    coverage = (ROOT / "mods/COVERAGE.md").read_text()

    def constant(name):
        return re.search(rf"{name}: &\[[^]]*\] = &\[(.*?)\];", host, re.S).group(1)

    language_ids = re.search(r"pub fn language_id\(self\).*?\n    \}", lsp, re.S).group(0)
    languages = re.findall(r"Self::(\w+) => \"([a-z]+)\"", language_ids)
    candidates = re.search(r"fn candidates\(self\).*?\n    \}", lsp, re.S).group(0)
    servers = {}
    for arm, block in re.findall(r"((?:Self::\w+ \| )*Self::\w+) =>\s*&\[(.*?)\],\n", candidates, re.S):
        for variant in re.findall(r"Self::(\w+)", arm):
            servers[variant] = re.findall(r'\("([\w-]+)"', block)
    api = re.search(r'MOD_API_VERSION: &str = "([^"]+)"', host).group(1)
    return {
        "upstream": json.loads((ROOT / "upstream.lock.json").read_text()),
        "compatibility": json.loads((ROOT / "mods/compatibility.json").read_text()),
        "browser": json.loads((ROOT / "browser/browser.lock.json").read_text()),
        "preview": json.loads((ROOT / "runtime/preview-v1.lock.json").read_text()),
        "lean": json.loads((ROOT / "runtime/lean-v1.lock.json").read_text()),
        "plugin": json.loads((ROOT / "runtime/plugin-v1.lock.json").read_text()),
        "api": api,
        "omd": json.loads((ROOT / "mods/package.json").read_text())["version"],
        "capabilities": set(re.findall(r'"([a-z_]+)"', constant("MOD_CAPABILITIES"))),
        "operations": set(re.findall(r'"([a-z_.]+)"', constant("MOD_HOST_OPERATIONS"))),
        "features": re.findall(r'"([a-z0-9_]+)"', constant("MOD_HOST_FEATURES")),
        "apis": [
            api if row == "MOD_API_VERSION" else row.strip('"')
            for row, _, _ in re.findall(r'\(([^,]+), "([a-z]+)", "([\d-]+)"\)', constant("SUPPORTED_MOD_APIS"))
        ],
        "languages": {language: servers[variant] for variant, language in languages},
        "hooks": re.findall(r"`([a-z_]+)`", re.search(r"and hooks for (.*?)\.\nA hook", coverage, re.S).group(1)),
        "pi_adapter": re.search(r'"adapter":"([\w.-]+)"', (ROOT / "runtime/omd/src/mods/pi.rs").read_text()).group(1),
    }


def resolve(reference, profiles, scenarios):
    kind, _, name = reference.partition(":")
    if kind == "rust":
        path, _, function = name.partition("::")
        source = ROOT / "runtime" / path
        return source.exists() and re.search(rf"fn {re.escape(function)}\(", source.read_text()) is not None
    if kind == "patch":
        return re.search(rf"^\+\s*(async )?fn {re.escape(name)}\(", (ROOT / "runtime/patches/controlled-contributor.patch").read_text(), re.M) is not None
    if kind == "node":
        return f"test('{name}'" in (ROOT / "mods/runner.test.mjs").read_text()
    if kind == "python":
        return any(f"def {name}(" in path.read_text() for path in (ROOT / "tests").glob("test_*.py"))
    if kind == "fixture":
        profile, _, scenario = name.partition("/")
        return profile in profiles and scenario in scenarios
    if kind == "script":
        return (ROOT / name).exists()
    return False


def check(matrix):
    source = sources()
    problems = []
    release = matrix["release"]
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
    claim("omd_host", "version", f"{source['compatibility']['host']['omd']} on Codex {source['compatibility']['host']['codex']}")
    claim("omd_host", "features", source["features"])
    claim("upstream_hooks", "hooks", source["hooks"])
    bundled_plugin = source["plugin"]["plugins"]["omd-guidance-hooks"]
    claim("omd_guidance_hooks", "version", bundled_plugin["version"])
    claim("omd_guidance_hooks", "extension_type", bundled_plugin["extension_types"])
    repository_plugin = source["plugin"]["plugins"]["omd-repository-tools"]
    claim("omd_repository_tools", "version", repository_plugin["version"])
    claim("omd_repository_tools", "extension_type", repository_plugin["extension_types"])
    lsp_plugin = source["plugin"]["plugins"]["omd-lsp-adapters"]
    claim("omd_lsp_adapters", "version", lsp_plugin["version"])
    claim("omd_lsp_adapters", "extension_type", lsp_plugin["extension_types"])
    review_plugin = source["plugin"]["plugins"]["omd-review-policy"]
    claim("omd_review_policy", "version", review_plugin["version"])
    claim("omd_review_policy", "extension_type", review_plugin["extension_types"])
    bridge_plugin = source["plugin"]["plugins"]["omd-application-bridges"]
    claim("omd_application_bridges", "version", bridge_plugin["version"])
    claim("omd_application_bridges", "extension_type", bridge_plugin["extension_types"])
    claim("pi_resources", "version", source["pi_adapter"])
    browser = source["browser"]
    claim("browser_bundle", "versions", {
        "node": browser["node"]["version"],
        "pnpm": browser["package_manager"]["version"],
        "@playwright/mcp": browser["mcp"]["package"] and browser["mcp"]["version"],
        "playwright": browser["mcp"]["playwright"],
        "chromium": browser["browser"]["browser_version"],
    })
    for name, package in source["preview"]["packages"].items():
        claim(name, "version", package["version"])
        claim(name, "extension_type", package["extension_type"])
        claim(name, "capabilities", sorted(package["capabilities"]))
        if not set(package["capabilities"]) <= source["capabilities"]:
            problems.append(f"{name}: capabilities outside the published API")
    for language, servers in source["languages"].items():
        claim(f"lsp_{language}", "version", servers)
    for component in matrix["components"]:
        if component["area"] == "bridge" and not (ROOT / component.get("source", "")).exists():
            problems.append(f"{component['id']}: missing adapter source {component.get('source')}")
        for operation in component.get("operations", []):
            if operation not in source["operations"]:
                problems.append(f"{component['id']}: {operation} is not a host operation")
        capability = component.get("capability")
        if capability and capability not in source["capabilities"] and capability not in source["lean"]["profiles"]["omd_enabled"]["capabilities"]:
            problems.append(f"{component['id']}: {capability} is neither a mod capability nor a host capability")

    profiles, scenarios = mod_conformance.fixture_profiles()
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
            if not resolve(reference, profiles, scenarios):
                problems.append(f"{entry['id']}: unresolved evidence {reference}")

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


def table(rows, headers):
    lines = ["| " + " | ".join(headers) + " |", "| " + " | ".join("---" for _ in headers) + " |"]
    lines += ["| " + " | ".join(cell.replace("|", "\\|") for cell in row) + " |" for row in rows]
    return "\n".join(lines)


DETAILS = ("extension_type", "versions", "supported_versions", "capabilities", "features", "hooks", "operations")


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
        "<!-- Generated from integration/matrix.json by scripts/integration_matrix.py --write. -->",
        "",
        f"Accumulated integration coverage for the {release['upstream_tag']} pinned runtime as of",
        f"{matrix['as_of']}. Every component below is maintained with this release: it names its",
        "owner, the exact version it is supported against, the fixtures that exercise it, what it",
        "does not cover, and how it is removed or migrated. The matrix is checked against the",
        "shipped sources by `scripts/integration_matrix.py`: a version, capability, hook, language",
        "or evidence reference that disagrees with the runtime fails the check.",
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
        "## Exercised combinations",
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
            ["Combination", "Components", "Boundaries", "Result", "Executable evidence"],
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
            ["Case", "Retained for", "What stays covered", "Executable evidence"],
        ),
        "",
        "## Tested versus untested",
        "",
        f"Tested: {len(matrix['combinations'])} combinations across {len(matrix['boundaries'])} shared boundaries and "
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
        "patch · `node:` `mods/runner.test.mjs` · `python:` `tests/` · `fixture:` profile/scenario of",
        "`benchmarks.controlled_fixture` · `script:` a repository checker.",
        "",
        "```sh",
    ]
    out += matrix["commands"] + ["```", ""]
    return "\n".join(out)


def main():
    matrix = json.loads(MATRIX.read_text())
    problems = check(matrix)
    rendered = render(matrix)
    if "--write" in sys.argv[1:]:
        DOCUMENT.write_text(rendered)
        print(f"wrote {DOCUMENT.relative_to(ROOT)}")
    elif DOCUMENT.read_text() != rendered:
        problems.append("INTEGRATION.md is stale; rerun scripts/integration_matrix.py --write")
    if problems:
        raise SystemExit("\n".join(problems))
    print(
        f"integration matrix {matrix['as_of']}: {len(matrix['components'])} maintained components, "
        f"{len(matrix['combinations'])} exercised combinations over {len(matrix['boundaries'])} shared "
        f"boundaries, {len(matrix['regression'])} retained regression cases, "
        f"{len(matrix['untested'])} recorded untested combinations"
    )


if __name__ == "__main__":
    main()
