#!/usr/bin/env python3
"""Check the public mod API contract against the host source and its executable evidence."""
import json
from functools import cache
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONTRACT = ROOT / "mods/conformance/contract.json"
CLASSIC = ROOT / "mods/conformance/classic-hooks.json"
RUNNER = ROOT / "runtime/omd/src/mods/runner.mjs"
COVERAGE = ROOT / "mods/COVERAGE.md"
HOST = ROOT / "runtime/omd/src/mods.rs"
BRIDGE = ROOT / "runtime/omd/src/mods/bridge.rs"
RUST_TESTS = ROOT / "runtime/omd/tests"
PATCH = ROOT / json.loads((ROOT / "upstream.lock.json").read_text())["runtime_patches"][0]["path"]
RUNNER_TESTS = ROOT / "mods/runner.test.mjs"
PYTHON_TESTS = ROOT / "tests"
GROUPS = {
    "coordination": "Coordination decisions",
    "context_recovery": "Context and recovery decisions",
    "tool": "Tool decisions",
    "terminal": "Terminal decisions",
}


def codex_release():
    return re.search(r'CODEX_HOST_RELEASE: &str = "([^"]+)"', HOST.read_text()).group(1)


def host_sets():
    source = HOST.read_text()

    def constant(name):
        body = re.search(rf"{name}: &\[[^]]*\] = &\[(.*?)\];", source, re.S)
        if not body:
            raise ValueError(f"{name} not found in {HOST}")
        return body.group(1)

    capabilities = re.findall(r'"([a-z_.]+)"', constant("MOD_CAPABILITIES"))
    events = re.findall(r'\("([a-z_]+)", "[a-z_.]+"\)', constant("MOD_EVENTS"))
    replacements = re.findall(r'"([a-z_]+)"', constant("MOD_REPLACEMENT_POINTS"))
    intercepts = re.findall(r'\("([a-z_]+)", "[a-z_.]+"\)', constant("MOD_INTERCEPT_SURFACES"))
    capability_match = re.search(r"match operation \{(.*?)\n            _ if", BRIDGE.read_text(), re.S)
    operations = re.findall(r'"([a-z_]+\.[a-z_]+)"', constant("MOD_HOST_OPERATIONS"))
    arms = re.findall(r'"([a-z_]+\.[a-z_]+)"\s*(?=\||=>)', capability_match.group(1))
    operations += [name for name in arms if name not in operations]
    version = re.search(r'MOD_API_VERSION: &str = "([^"]+)"', source).group(1)
    return version, {
        "capabilities": set(capabilities),
        "events": set(events),
        "replacements": set(replacements),
        "intercepts": set(intercepts),
        "operations": set(operations),
    }


@cache
def resolve(reference):
    kind, _, name = reference.partition(":")
    if kind == "rust":
        return any(f"fn {name}(" in path.read_text() for path in RUST_TESTS.glob("*.rs"))
    if kind == "patch":
        return re.search(rf"^\+\s*(async )?fn {re.escape(name)}\(", PATCH.read_text(), re.M) is not None
    if kind == "node":
        if ":" in name:
            file, name = name.split(":", 1)
            path = (ROOT / file).resolve()
            return path.is_relative_to(ROOT / "tests") and path.suffix == ".mjs" and path.is_file() and f"test('{name}'" in path.read_text()
        return f"test('{name}'" in RUNNER_TESTS.read_text()
    if kind == "python":
        return any(f"def {name}(" in path.read_text() for path in PYTHON_TESTS.glob("test_*.py"))
    return False


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


def check_launch(contract, sets):
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
    entries = contract.get("launch", {})
    for name in sorted(expected - entries.keys()):
        problems.append(f"unclassified launch surface: {name}")
    for name in sorted(entries.keys() - expected):
        problems.append(f"unknown launch surface: {name}")
    decisions = {decision["id"]: decision for decision in contract["decisions"]}
    for name, entry in entries.items():
        if entry.get("status") == "experimental":
            if not entry.get("reason"):
                problems.append(f"{name}: experimental surface needs a reason")
            continue
        if entry.get("status") != "frozen":
            problems.append(f"{name}: invalid launch status")
            continue
        evidence = entry.get("evidence", decisions.get(entry.get("decision"), {}).get("evidence", []))
        if not evidence or not all(resolve(reference) for reference in evidence):
            problems.append(f"{name}: missing or unresolved launch evidence")
        consumer = entry.get("consumer", {})
        path = (ROOT / consumer.get("path", "")).resolve()
        allowed = any(path.is_relative_to(ROOT / directory) for directory in ("mods/first-party", "mods/examples"))
        if name.startswith("author_commands:"):
            allowed |= path in (ROOT / "mods/README.md", ROOT / "mods/REFERENCE.md")
        if not allowed or not path.is_file() or not consumer.get("snippet") or consumer["snippet"] not in path.read_text():
            problems.append(f"{name}: missing launch/example consumer")
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
        if not decision["evidence"]:
            problems.append(f"{decision['id']}: no executable evidence")
    for key, authoritative in sets.items():
        for missing in sorted(authoritative - covered[key]):
            problems.append(f"undocumented {key[:-1]}: {missing}")
        for unknown in sorted(covered[key] - authoritative):
            problems.append(f"documented {key[:-1]} does not exist in the host: {unknown}")
    for rule in contract["composition"]:
        if not rule["evidence"]:
            problems.append(f"composition rule {rule['id']}: no executable evidence")
    for entry in contract["decisions"] + contract["composition"]:
        for reference in entry["evidence"]:
            if not resolve(reference):
                problems.append(f"{entry['id']}: unresolved evidence {reference}")
    classic = json.loads(CLASSIC.read_text())["hooks"]
    adapter = re.search(r"const CLASSIC = \{(.*?)\n\};", RUNNER.read_text(), re.S).group(1)
    mapped = dict(re.findall(r"^\s+(\w+): \['(\w+)'", adapter, re.M))
    typed = set(re.findall(r"'(\w+)'", re.search(r"export type ClassicHook = (.*?);", (ROOT / "mods/api.d.ts").read_text(), re.S).group(1)))
    names = [entry["hook"] for entry in classic]
    if len(names) != 33 or set(names) != set(mapped) or set(names) != typed:
        problems.append("classic hooks disagree between classic-hooks.json, runner.mjs and api.d.ts")
    for entry in classic:
        if mapped.get(entry["hook"]) != entry["native"]:
            problems.append(f"classic hook {entry['hook']}: ledger maps {entry['native']}, runner maps {mapped.get(entry['hook'])}")
        if entry["native"] not in sets["events"] | sets["intercepts"]:
            problems.append(f"classic hook {entry['hook']}: {entry['native']} is not a host event or interceptor")
        if not entry["check"] or not resolve(entry["check"]):
            problems.append(f"classic hook {entry['hook']}: unresolved check {entry['check']}")
    return problems + check_launch(contract, sets)


def replacement(decision):
    point, note = decision["replace"], decision.get("replace_note")
    if not point:
        return note or "no"
    return f"`{point}`" + (f" ({note})" if note else "")


def table(rows, headers):
    lines = ["| " + " | ".join(headers) + " |", "| " + " | ".join("---" for _ in headers) + " |"]
    lines += ["| " + " | ".join(cell.replace("|", "\\|") for cell in row) + " |" for row in rows]
    return "\n".join(lines)


def render(contract):
    out = [
        "# Public API coverage and composition contract",
        "",
        f"<!-- Generated from conformance/contract.json by scripts/mod_conformance.py --write. -->",
        "",
        f"Mod API `{contract['api']}`. Every decision a mod can reach through the published",
        "API is listed below with the support it has, when it takes effect, who owns the",
        "outcome, and its limits. Capabilities not granted to a package fail before native",
        "dispatch. Arbitrary host internals are not exposed, and the table is checked",
        "against the host source: an event, capability, replacement point or host",
        "operation that is not documented here fails `scripts/mod_conformance.py`.",
        "",
        "`observe` is middleware (`api.on`): several mods compose. `replace` is exclusive",
        "(`api.replace`): one mod per point, claimed before activation. Interceptors",
        "(`api.intercept`) wrap an operation and compose as an ordered continuation chain.",
        "",
    ]
    out += ["## Launch surface status", "",
        "Frozen means held for the launch candidate; the API version remains experimental until the release freeze.", "",
        table([(name, entry["status"], entry.get("reason", "") or
                f"`{entry['consumer']['path']}`; " + ", ".join(entry.get("evidence", [entry.get("decision", "")])) )
               for name, entry in sorted(contract.get("launch", {}).items())],
              ["Surface", "Launch status", "Consumer and evidence, or experimental reason"]), ""]
    for group, title in GROUPS.items():
        rows = [
            (
                f"**{d['decision']}**",
                d["observe"],
                d["alter"],
                replacement(d),
                d["timing"],
                d["ownership"],
                d["limits"],
            )
            for d in contract["decisions"]
            if d["group"] == group
        ]
        out += [f"## {title}", "", table(rows, ["Decision", "Observe", "Alter", "Replace", "Timing", "Ownership", "Limits"]), ""]
    rows = [
        (
            d["decision"],
            d["native"],
            (f"exclusive `{d['replace']}` replacement; " if d["replace"] else "") + d["alter"],
        )
        for d in contract["decisions"]
    ]
    out += [
        "## What this adds over the native plugins and hooks",
        "",
        f"Pinned Codex {codex_release()} ships plugins (`plugin.json`: skills, prompts, MCP servers,",
        "hook files) and hooks for `pre_tool_use`, `permission_request`, `post_tool_use`,",
        "`pre_compact`, `post_compact`, `session_start`, `session_end`,",
        "`user_prompt_submit`, `subagent_start`, `subagent_stop`, `stop` and `interrupt`.",
        "A hook is an external command or MCP tool that returns a decision document: it can",
        "block a call, add context, or rewrite a tool's input. It cannot hold state, stream,",
        "render, route a model, run an agent, or take part in delegation, review, recovery",
        "or workflow enforcement, and competing `pre_tool_use` rewrites are resolved by",
        "whichever hook finishes last. The mod API is in-process, capability-scoped,",
        "deterministic and composable; the added control per decision is:",
        "",
        table(rows, ["Decision", "Native plugins and hooks today", "Added by the mod API"]),
        "",
        "## Composition rules",
        "",
    ]
    for rule in contract["composition"]:
        out += [f"- **{rule['id']}** — {rule['rule']}", ""]
    classic = json.loads(CLASSIC.read_text())
    out += ["## Classic hook coverage", "", classic["note"], "",
            table([(f"`{entry['hook']}`", f"`{entry['native']}`", entry["owner"], f"`{entry['check']}`") for entry in classic["hooks"]],
                  ["Classic hook", "Native event or interceptor", "Owner", "Check"]), ""]
    out += ["## Not supported and not replaceable", ""]
    out += [f"- {item}" for item in contract["unsupported"]] + [""]
    out += [
        "## Conformance evidence",
        "",
        "`rust:` `runtime/omd/tests/*.rs` · `patch:` patched native/TUI tests ·",
        "`node:` `mods/runner.test.mjs` · `python:` `tests/`.",
        "Each reference is resolved by `scripts/mod_conformance.py`.",
        "",
        table(
            [(entry["id"], " · ".join(f"`{reference}`" for reference in entry["evidence"]))
             for entry in contract["decisions"] + contract["composition"]],
            ["Decision or rule", "Executable evidence"],
        ),
        "",
    ]
    return "\n".join(out)


def main():
    contract = json.loads(CONTRACT.read_text())
    version, sets = host_sets()
    problems = check(contract, version, sets)
    rendered = render(contract)
    if "--write" in sys.argv[1:]:
        COVERAGE.write_text(rendered)
        print(f"wrote {COVERAGE.relative_to(ROOT)}")
    elif COVERAGE.read_text() != rendered:
        problems.append("mods/COVERAGE.md is stale; rerun scripts/mod_conformance.py --write")
    if problems:
        raise SystemExit("\n".join(problems))
    print(
        f"contract {contract['api']}: {len(contract['decisions'])} decisions, "
        f"{len(contract['composition'])} composition rules, all capabilities, events, "
        f"replacement points, intercept surfaces and host operations documented with resolved evidence"
    )


if __name__ == "__main__":
    main()
