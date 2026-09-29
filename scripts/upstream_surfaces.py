#!/usr/bin/env python3
import argparse
import fnmatch
import json
from pathlib import Path
import re
import sys


ROOT = Path(__file__).resolve().parents[1]
TABLE = ROOT / "scripts/upstream_routes.json"
IDENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
PROTOCOL = "codex-rs/app-server-protocol/src/protocol/common.rs"
PROTOCOL_TYPES = "codex-rs/protocol/src/protocol.rs"
MACROS = {
    "client_request_definitions": "app_request",
    "server_request_definitions": "app_server_request",
    "server_notification_definitions": "app_notification",
}
SINGLE_ENUMS = [
    ("event", PROTOCOL_TYPES, "EventMsg"),
    ("op", PROTOCOL_TYPES, "Op"),
    ("hook_event", PROTOCOL_TYPES, "HookEventName"),
    ("approval_policy", PROTOCOL_TYPES, "AskForApproval"),
    ("review_decision", PROTOCOL_TYPES, "ReviewDecision"),
    ("sandbox_mode", "codex-rs/protocol/src/config_types.rs", "SandboxMode"),
    ("approval_action", "codex-rs/core/src/tools/approvals.rs", "ApprovalAction"),
    ("tui_view", "codex-rs/tui/src/pager_overlay.rs", "Overlay"),
    ("tui_view", "codex-rs/tui/src/onboarding/onboarding_screen.rs", "Step"),
]
APPROVAL_REQUESTS = ["codex-rs/core/src/session/mod.rs", "codex-rs/core/src/session/mcp.rs", "codex-rs/core/src/mcp_tool_call.rs"]
APPROVAL_REQUEST = re.compile(r"^\s*pub(?:\(crate\))?\s+async\s+fn\s+(request_[a-z_]+)\s*\(", re.M)


def skip_string(text, i):
    if text[i] == "r" and text[i + 1] in '#"':
        hashes = 0
        j = i + 1
        while text[j] == "#":
            hashes += 1
            j += 1
        end = text.index('"' + "#" * hashes, j + 1)
        return end + 1 + hashes
    j = i + 1
    while text[j] != '"':
        j += 2 if text[j] == "\\" else 1
    return j + 1


def block(text, start):
    depth = 0
    i = start
    while i < len(text):
        c = text[i]
        if text.startswith("//", i):
            i = text.find("\n", i)
            continue
        if c == '"' or (c == "r" and text[i + 1:i + 2] in ('"', "#") and not text[i - 1].isalnum()):
            i = skip_string(text, i)
            continue
        if c in "{[(":
            depth += 1
        elif c in "}])":
            depth -= 1
            if depth == 0:
                return text[start + 1:i]
        i += 1
    raise ValueError("unbalanced block")


def items(body):
    depth = 0
    current = []
    i = 0
    while i < len(body):
        c = body[i]
        if body.startswith("//", i):
            end = body.find("\n", i)
            i = len(body) if end < 0 else end
            continue
        if c == '"':
            end = skip_string(body, i)
            current.append(body[i:end])
            i = end
            continue
        if c in "{[(":
            depth += 1
        elif c in "}])":
            depth -= 1
        if c == "," and depth == 0:
            yield "".join(current)
            current = []
        else:
            current.append(c)
        i += 1
    if "".join(current).strip():
        yield "".join(current)


def strip_attributes(item):
    attributes = []
    item = item.strip()
    while item.startswith("#["):
        end = len(block(item, 1)) + 3
        attributes.append(item[:end])
        item = item[end:].strip()
    return attributes, item


def enum_variants(text, name):
    match = re.search(r"\benum\s+" + re.escape(name) + r"\b[^{;]*\{", text)
    if not match:
        return None
    out = []
    for item in items(block(text, match.end() - 1)):
        attributes, rest = strip_attributes(item)
        found = IDENT.match(rest)
        if found:
            out.append((found.group(0), attributes))
    return out


def kebab(name):
    return re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "-", name).lower()


def slash_name(variant, attributes):
    for attribute in attributes:
        found = re.search(r'to_string\s*=\s*"([^"]+)"', attribute) or re.search(r'serialize\s*=\s*"([^"]+)"', attribute)
        if found:
            return found.group(1)
    return kebab(variant)


def macro_entries(text, macro):
    match = re.search(re.escape(macro) + r"!\s*\{", text)
    if not match:
        return []
    out = []
    for found in re.finditer(r'((?:\s*#\[[^\]]*\]\s*|\s*///[^\n]*\n|\s*//[^\n]*\n)*)\s*([A-Z]\w*)\s*=>\s*"([^"]+)"', block(text, match.end() - 1)):
        out.append((found.group(3), found.group(2), "#[experimental" in found.group(1)))
    return out


def read(checkout, relative):
    path = checkout / relative
    return path.read_text() if path.is_file() else None


def surface(kind, name, source, **extra):
    return {"id": f"{kind}:{name}", "kind": kind, "name": name, "source": source, **extra}


def rust_sources(root):
    for path in sorted(root.rglob("*.rs")):
        relative = path.relative_to(root).as_posix()
        if "/tests/" in f"/{relative}" or path.name.endswith("_tests.rs") or path.name == "tests.rs":
            continue
        yield path


def without_test_module(text):
    found = re.search(r"#\[cfg\(test\)\]\s*mod\s+\w+\s*\{", text)
    return text[:found.start()] if found else text


def schema_keys(schema):
    definitions = schema.get("definitions", {})

    def resolve(node):
        seen = 0
        while isinstance(node, dict) and seen < 8:
            ref = node.get("$ref") or next((n.get("$ref") for n in node.get("allOf", []) if isinstance(n, dict) and "$ref" in n), None)
            if not ref:
                return node
            node = definitions.get(ref.rsplit("/", 1)[-1], {})
            seen += 1
        return node

    out = []
    for key, node in schema.get("properties", {}).items():
        out.append(key)
        child = resolve(node)
        for sub in (child.get("properties") or {}) if isinstance(child, dict) else {}:
            out.append(f"{key}.{sub}")
    return out


def extract(checkout):
    checkout = Path(checkout)
    found = []
    missing = []
    protocol = read(checkout, PROTOCOL)
    if protocol is None:
        missing.append(PROTOCOL)
    else:
        for macro, kind in MACROS.items():
            for method, variant, experimental in macro_entries(protocol, macro):
                found.append(surface(kind, method, PROTOCOL, variant=variant, experimental=experimental))
        match = re.search(r"client_notification_definitions!\s*\{", protocol)
        if match:
            for item in items(block(protocol, match.end() - 1)):
                _, rest = strip_attributes(item)
                if IDENT.match(rest):
                    found.append(surface("app_client_notification", IDENT.match(rest).group(0), PROTOCOL))
    for kind, relative, name in SINGLE_ENUMS:
        text = read(checkout, relative)
        variants = enum_variants(text, name) if text else None
        if variants is None:
            missing.append(f"{relative}::{name}")
            continue
        for variant, _ in variants:
            label = f"{name}::{variant}" if kind == "tui_view" else variant
            found.append(surface(kind, label, relative))
    slash = "codex-rs/tui/src/slash_command.rs"
    text = read(checkout, slash)
    variants = enum_variants(text, "SlashCommand") if text else None
    if variants is None:
        missing.append(f"{slash}::SlashCommand")
    else:
        for variant, attributes in variants:
            found.append(surface("slash_command", slash_name(variant, attributes), slash, variant=variant))
    bindings = "codex-rs/tui/src/keymap/bindings.rs"
    text = read(checkout, bindings)
    match = re.search(r"^define_runtime_action_bindings!\s*\{", text or "", re.M)
    if not match:
        missing.append(f"{bindings}::define_runtime_action_bindings")
    else:
        for group in re.finditer(r'"(\w+)"\s*=>\s*\w+\s*,\s*\w+\s*,\s*\w+\s*\[([^\]]*)\]', block(text, match.end() - 1)):
            for action in group.group(2).split(","):
                action = action.split("=>")[0].strip()
                if action:
                    found.append(surface("keybinding", f"{group.group(1)}.{action}", bindings))
    tui = checkout / "codex-rs/tui/src"
    views = re.compile(r"impl(?:<[^>]*>)?\s+BottomPaneView\s+for\s+(\w+)")
    list_ids = re.compile(r'const\s+\w+_VIEW_ID\s*:\s*&str\s*=\s*"([^"]+)"')
    if tui.is_dir():
        for path in rust_sources(tui):
            text = without_test_module(path.read_text())
            relative = path.relative_to(checkout).as_posix()
            for name in views.findall(text):
                found.append(surface("tui_view", name, relative))
            for name in list_ids.findall(text):
                found.append(surface("tui_list", name, relative))
    else:
        missing.append("codex-rs/tui/src")
    api = checkout / "codex-rs/ext/extension-api/src"
    if api.is_dir():
        for path in rust_sources(api):
            for name in re.findall(r"^pub trait (\w+)", path.read_text(), re.M):
                found.append(surface("extension_trait", name, path.relative_to(checkout).as_posix()))
    else:
        missing.append("codex-rs/ext/extension-api/src")
    for relative in APPROVAL_REQUESTS:
        text = read(checkout, relative)
        if text is None:
            missing.append(relative)
            continue
        for name in APPROVAL_REQUEST.findall(without_test_module(text)):
            if name.endswith("_response"):
                continue
            found.append(surface("approval_request", name, relative))
    config = "codex-rs/core/config.schema.json"
    text = read(checkout, config)
    if text is None:
        missing.append(config)
    else:
        for key in schema_keys(json.loads(text)):
            found.append(surface("config_key", key, config))
    unique = {}
    for entry in found:
        unique.setdefault(entry["id"], entry)
    return sorted(unique.values(), key=lambda s: s["id"]), missing


def load_table(path):
    table = json.loads(Path(path).read_text())
    for key in ("routes", "exclusions", "surfaces"):
        table.setdefault(key, {})
    return table


def resolve(table, surface_id):
    entry = table["surfaces"].get(surface_id)
    if entry is not None:
        return entry
    for pattern, entry in table.get("patterns", {}).items():
        if fnmatch.fnmatchcase(surface_id, pattern):
            return entry
    return None


def check(checkout, table):
    surfaces, missing = extract(checkout)
    ids = {s["id"] for s in surfaces}
    unrouted = []
    invalid = []
    counts = {}
    for entry in surfaces:
        decision = resolve(table, entry["id"])
        if decision is None:
            unrouted.append(entry)
            continue
        route, reason = decision.get("route"), decision.get("exclude")
        if bool(route) == bool(reason) or (route and route not in table["routes"]) or (reason and reason not in table["exclusions"]):
            invalid.append(entry["id"])
            continue
        bucket = counts.setdefault(entry["kind"], {"surfaces": 0, "routed": 0, "excluded": 0})
        bucket["surfaces"] += 1
        bucket["routed" if route else "excluded"] += 1
    for entry in unrouted:
        counts.setdefault(entry["kind"], {"surfaces": 0, "routed": 0, "excluded": 0})["surfaces"] += 1
    removed = sorted(name for name in table["surfaces"] if name not in ids)
    return {
        "surfaces": len(surfaces),
        "by_kind": dict(sorted(counts.items())),
        "unrouted": [{"id": e["id"], "source": e["source"]} for e in unrouted],
        "invalid": invalid,
        "removed_upstream": removed,
        "missing_sources": missing,
        "gap": len(unrouted) + len(invalid) + len(missing),
    }


def host_table(table):
    requests, notifications, server_requests, authority, writable = {}, [], [], [], []
    for surface_id, entry in sorted(table["surfaces"].items()):
        kind, name = surface_id.split(":", 1)
        route = entry.get("route")
        if kind == "app_request" and route == "app.request":
            requests[name] = {k: entry[k] for k in ("class", "contexts", "confirm", "scope", "refuse", "root", "route_fields", "keys") if k in entry}
        elif kind == "app_notification" and route == "app.notification":
            notifications.append(name)
        elif kind == "app_server_request" and route in ("approval", "app.server_request"):
            server_requests.append(name)
        elif kind == "config_key":
            (authority if entry.get("exclude") == "authority_config" else writable).append(name)
    return {"schema": 1, "upstream": table.get("upstream"), "requests": requests, "notifications": notifications,
            "server_requests": server_requests, "authority_config": authority, "writable_config": writable}


def main(argv=None):
    parser = argparse.ArgumentParser(description="Map pinned upstream Codex surfaces to public OMD mod routes or recorded exclusions.")
    sub = parser.add_subparsers(dest="command", required=True)
    listing = sub.add_parser("list", help="print every extracted upstream surface as JSON")
    listing.add_argument("checkout")
    checking = sub.add_parser("check", help="fail when an upstream surface has no route or exclusion")
    checking.add_argument("checkout")
    checking.add_argument("--table", default=str(TABLE))
    hosting = sub.add_parser("host-table", help="write the compact app-server route table the OMD host embeds")
    hosting.add_argument("output")
    hosting.add_argument("--table", default=str(TABLE))
    args = parser.parse_args(argv)
    if args.command == "host-table":
        Path(args.output).write_text(json.dumps(host_table(load_table(args.table)), indent=1) + "\n")
        return 0
    if args.command == "list":
        surfaces, missing = extract(args.checkout)
        print(json.dumps({"surfaces": surfaces, "missing_sources": missing}, indent=2))
        return 1 if missing else 0
    report = check(args.checkout, load_table(args.table))
    print(json.dumps(report, indent=2))
    return 1 if report["gap"] else 0


if __name__ == "__main__":
    sys.exit(main())
