#!/usr/bin/env python3
"""Check the public mod API contract against the host source and its executable evidence."""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONTRACT = ROOT / "mods/conformance/contract.json"
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
    capability_match = re.search(r"match operation \{(.*?)\n            _ if", BRIDGE.read_text(), re.S)
    operations = re.findall(r'"([a-z_]+\.[a-z_]+)"', constant("MOD_HOST_OPERATIONS"))
    arms = re.findall(r'"([a-z_]+\.[a-z_]+)"\s*(?=\||=>)', capability_match.group(1))
    operations += [name for name in arms if name not in operations]
    version = re.search(r'MOD_API_VERSION: &str = "([^"]+)"', source).group(1)
    return version, {
        "capabilities": set(capabilities),
        "events": set(events),
        "replacements": set(replacements),
        "operations": set(operations),
    }


def resolve(reference):
    kind, _, name = reference.partition(":")
    if kind == "rust":
        return any(f"fn {name}(" in path.read_text() for path in RUST_TESTS.glob("*.rs"))
    if kind == "patch":
        return re.search(rf"^\+\s*(async )?fn {re.escape(name)}\(", PATCH.read_text(), re.M) is not None
    if kind == "node":
        return f"test('{name}'" in RUNNER_TESTS.read_text()
    if kind == "python":
        return any(f"def {name}(" in path.read_text() for path in PYTHON_TESTS.glob("test_*.py"))
    return False


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
            covered[key] |= set(decision["covers"][key])
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
    return problems


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
        "(`api.replace`): one mod per point, claimed before activation.",
        "",
    ]
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
        f"replacement points and host operations documented with resolved evidence"
    )


if __name__ == "__main__":
    main()
