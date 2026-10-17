#!/usr/bin/env python3
"""Check the maintained integration coverage matrix against the shipped sources and its evidence."""
import json
import re
from pathlib import Path

try:
    from scripts import lean_profiles, install_support
except ModuleNotFoundError:
    import lean_profiles
    import install_support

ROOT = Path(__file__).resolve().parents[1]
MATRIX = ROOT / "integration/matrix.json"
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
        "sites": re.findall(r'"([a-z_]+)"', re.search(r'\[(.*?)\]\.contains\(&name\)', site_validation).group(1)),
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
    }


def resolve(reference):
    kind, _, name = reference.partition(":")
    if kind == "rust":
        path, _, function = name.partition("::")
        source = ROOT / "runtime" / path
        return source.exists() and re.search(rf"fn {re.escape(function)}\(", source.read_text()) is not None
    if kind == "patch":
        patch = ROOT / json.loads((ROOT / "upstream.lock.json").read_text())["runtime_patches"][0]["path"]
        return re.search(rf"^\+\s*(async )?fn {re.escape(name)}\(", patch.read_text(), re.M) is not None
    if kind == "node":
        return f"test('{name}'" in (ROOT / "mods/runner.test.mjs").read_text()
    if kind == "python":
        return any(f"def {name}(" in path.read_text() for path in (ROOT / "tests").glob("test_*.py"))
    if kind == "script":
        return (ROOT / name).exists()
    return False


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

    problems += launch_problems(matrix.get("launch_cut"), source)

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
DISPOSITIONS = ("launch", "wave_1", "wave_2")


def launch_problems(cut, source):
    if not cut:
        return ["launch_cut is missing"]
    problems = []
    seen = set()
    launched = {"mod": set(), "plugin": set()}
    active = set()
    for entry in cut.get("entries", []):
        name = entry.get("id")
        if not entry.get("path"):
            problems.append(f"launch_cut {name}: missing path")
            continue
        if name in seen:
            problems.append(f"launch_cut: duplicate entry {name}")
        seen.add(name)
        disposition = entry.get("disposition")
        if disposition not in DISPOSITIONS:
            problems.append(f"launch_cut {name}: unknown disposition {disposition!r}")
        elif disposition == "launch":
            if entry.get("tier") not in LAUNCH_TIERS or not set(entry.get("profiles", [])) <= set(lean_profiles.PROFILE_LABELS) or not entry.get("profiles"):
                problems.append(f"launch_cut {name}: needs a launch tier and profiles")
            if not (ROOT / entry["path"]).exists():
                problems.append(f"launch_cut {name}: launch path {entry['path']} is missing")
            if entry.get("kind") in launched:
                launched[entry["kind"]].add(name)
            if entry.get("tier") == "default-active":
                active.add(name)
        elif (ROOT / entry["path"]).exists():
            problems.append(f"launch_cut {name}: deferred path {entry['path']} still exists")
    for path in cut.get("not_restored", []):
        if (ROOT / path).exists():
            problems.append(f"launch_cut: {path} should stay deleted")
    if not cut.get("tag") or "<path>" not in cut.get("restore", ""):
        problems.append("launch_cut: needs the restore tag and a restore command")
    if launched["mod"] != set(lean_profiles.PACKAGES):
        problems.append("launch_cut mods differ from the selected package source inventory")
    if active != set(lean_profiles.DEFAULT_ACTIVE):
        problems.append("launch_cut default-active mods differ from the fresh-install default selection")
    if launched["plugin"] != set(source["plugin"]["plugins"]):
        problems.append("launch_cut plugins differ from the plugin lock")
    return problems


def main():
    matrix = json.loads(MATRIX.read_text())
    problems = check(matrix)
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
