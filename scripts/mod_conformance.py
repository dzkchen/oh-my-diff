"""Check the conformance registry and classic-hook ledger against the host and public types."""
import json
import re
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.mod_compatibility import array_constant, host_contract

ROOT = Path(__file__).resolve().parents[1]
CONTRACT = ROOT / "mods/conformance/contract.json"
CLASSIC = ROOT / "mods/conformance/classic-hooks.json"
RUNNER = ROOT / "runtime/omd/runner/src/bootstrap.js"
HOST = ROOT / "runtime/omd/src/mods.rs"
BRIDGE = ROOT / "runtime/omd/src/mods/bridge.rs"
GROUPS = {
    "coordination": "Coordination decisions",
    "context_recovery": "Context and recovery decisions",
    "tool": "Tool decisions",
    "terminal": "Terminal decisions",
}


def host_sets():
    source = HOST.read_text()

    def constant(name):
        return array_constant(source, name)

    capabilities = re.findall(r'"([a-z_.]+)"', constant("MOD_CAPABILITIES"))
    events = re.findall(r'\("([a-z_]+)", "[a-z_.]+"\)', constant("MOD_EVENTS"))
    replacements = re.findall(r'"([a-z_]+)"', constant("MOD_REPLACEMENT_POINTS"))
    intercepts = re.findall(r'\("([a-z_]+)", "[a-z_.]+"\)', constant("MOD_INTERCEPT_SURFACES"))
    capability_match = re.search(r"match operation \{(.*?)\n            _ if", BRIDGE.read_text(), re.S)
    operations = re.findall(r'"([a-z_]+\.[a-z_]+)"', constant("MOD_HOST_OPERATIONS"))
    arms = re.findall(r'"([a-z_]+\.[a-z_]+)"\s*(?=\||=>)', capability_match.group(1))
    operations += [name for name in arms if name not in operations]
    return host_contract()["current_api"], {
        "capabilities": set(capabilities),
        "events": set(events),
        "replacements": set(replacements),
        "intercepts": set(intercepts),
        "operations": set(operations),
    }


def declaration(source, name):
    match = re.search(rf"export (?:type|interface) {name}\b(.*?)(?=\nexport |\Z)", source, re.S)
    if not match:
        raise ValueError(f"missing declaration {name}")
    return match.group(1)


def fields(source, name):
    body = declaration(source, name).split("{", 1)[1].rsplit("}", 1)[0]
    tokens = re.findall(r"/\*.*?\*/|//[^\n]*|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[\w.]+|[^\s]", body, re.S)
    result, depth, start = set(), 0, True
    for index, token in enumerate(tokens):
        if token.startswith(("/*", "//")):
            continue
        if start and depth == 0:
            if token == "readonly":
                continue
            if index + 1 < len(tokens) and tokens[index + 1] in ("?", ":"):
                result.add(token.strip("'"))
            start = False
        if token in ("{", "[", "("):
            depth += 1
        elif token in ("}", "]", ")"):
            depth -= 1
        elif token == ";" and depth == 0:
            start = True
    return result


def public_sets(sets):
    source = (ROOT / "mods/api.d.ts").read_text()
    return {**sets,
        "components": set(re.findall(r"\btype: '([^']+)'", declaration(source, "TerminalComponent"))),
        "render_sites": fields(source, "RenderProps"),
        "view_fields": fields(source, "TerminalView"),
        "view_sites": set(re.findall(r"'([^']+)'", declaration(source, "TerminalSiteName"))) | {"owner/name"},
        "classic_hooks": set(re.findall(r"'([^']+)'", declaration(source, "ClassicHook"))),
        "author_commands": set(re.findall(r"case '([^']+)':", (ROOT / "mods/author/cli.mjs").read_text())),
    }


def check_surfaces(contract, sets):
    problems = []
    source = (ROOT / "mods/api.d.ts").read_text()
    for category, name in {"operations": "HostOperations", "events": "Events", "intercepts": "InterceptSurfaces"}.items():
        expected = sets[category] - ({"mods.service"} if category == "operations" else set())
        if fields(source, name) != expected:
            problems.append(f"{category}: public types disagree with host: {sorted(fields(source, name) ^ expected)}")
    declared = set(re.findall(r"'([^']+)'", declaration(source, "Capability")))
    if declared != sets["capabilities"]:
        problems.append(f"capabilities: public types disagree with host: {sorted(declared ^ sets['capabilities'])}")
    expected = {f"{category}:{name}" for category, names in public_sets(sets).items() for name in names}
    entries = contract.get("surfaces", {})
    for name in sorted(expected - entries.keys()):
        problems.append(f"unclassified surface: {name}")
    for name in sorted(entries.keys() - expected):
        problems.append(f"unknown surface: {name}")
    decisions = {decision["id"] for decision in contract["decisions"]}
    for name, entry in entries.items():
        if entry.get("status") == "experimental":
            if not entry.get("reason"):
                problems.append(f"{name}: experimental surface needs a reason")
            continue
        if entry.get("status") != "frozen":
            problems.append(f"{name}: invalid surface status")
            continue
        extra = entry.get("experimental_fields")
        if extra is not None and (not extra or not entry.get("reason")
                                  or any(not re.search(rf"\b{re.escape(field)}\??:", source) for field in extra)):
            problems.append(f"{name}: experimental_fields need a reason and fields declared in api.d.ts")
        if "decision" in entry and entry["decision"] not in decisions:
            problems.append(f"{name}: unknown decision {entry['decision']}")
        consumer = entry.get("consumer", {})
        path = (ROOT / consumer.get("path", "")).resolve()
        allowed = any(path.is_relative_to(ROOT / directory) for directory in ("mods/first-party", "mods/examples"))
        if name.startswith("author_commands:"):
            allowed |= path in (ROOT / "mods/README.md", ROOT / "mods/REFERENCE.md")
        if not allowed or not path.is_file() or not consumer.get("snippet") or consumer["snippet"] not in path.read_text():
            problems.append(f"{name}: missing first-party or example consumer")
    return problems


def check(contract, version, sets):
    problems = []
    declared = json.loads((ROOT / "mods/package.json").read_text())["version"]
    types = re.search(r"readonly version: '([^']+)'", (ROOT / "mods/api.d.ts").read_text()).group(1)
    if not contract["api"] == version == declared == types:
        problems.append(f"api version disagreement: contract={contract['api']} host={version} package={declared} types={types}")
    covered = {key: set() for key in sets}
    identifiers = set()
    for decision in contract["decisions"]:
        if decision["id"] in identifiers:
            problems.append(f"duplicate decision id {decision['id']}")
        identifiers.add(decision["id"])
        if decision["group"] not in GROUPS:
            problems.append(f"{decision['id']}: unknown group {decision['group']}")
        for key in sets:
            covered[key] |= set(decision["covers"].get(key, []))
    for key, authoritative in sets.items():
        for missing in sorted(authoritative - covered[key]):
            problems.append(f"undocumented {key[:-1]}: {missing}")
        for unknown in sorted(covered[key] - authoritative):
            problems.append(f"documented {key[:-1]} does not exist in the host: {unknown}")
    classic = json.loads(CLASSIC.read_text())["hooks"]
    adapter = re.search(r"const CLASSIC = \{(.*?)\n\};", RUNNER.read_text(), re.S).group(1)
    mapped = dict(re.findall(r"^\s+(\w+): \['(\w+)'", adapter, re.M))
    typed = set(re.findall(r"'(\w+)'", re.search(r"export type ClassicHook = (.*?);", (ROOT / "mods/api.d.ts").read_text(), re.S).group(1)))
    names = [entry["hook"] for entry in classic]
    if len(names) != 33 or set(names) != set(mapped) or set(names) != typed:
        problems.append("classic hooks disagree between classic-hooks.json, the runner bootstrap and api.d.ts")
    for entry in classic:
        if mapped.get(entry["hook"]) != entry["native"]:
            problems.append(f"classic hook {entry['hook']}: ledger maps {entry['native']}, runner maps {mapped.get(entry['hook'])}")
        if entry["native"] not in sets["events"] | sets["intercepts"]:
            problems.append(f"classic hook {entry['hook']}: {entry['native']} is not a host event or interceptor")
    return problems + check_surfaces(contract, sets)


if __name__ == "__main__":
    raise SystemExit("\n".join(check(json.loads(CONTRACT.read_text()), *host_sets())) or None)
