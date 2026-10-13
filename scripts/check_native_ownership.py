import argparse
import json
from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[1]
IDENTIFIERS = {"git", "lsp", "graph", "health", "knowledge", "guideline", "workflow",
               "review", "recovery", "checkpoint", "contributor", "controlled", "pi", "preset", "presets"}
GENERIC_LITERALS = {
    "git": "Git executable used for tracked-path discovery",
    "recovery": "package rollback directory",
    "session_review": "upstream Codex session metadata field",
}
NATIVE_SOURCES = ("runtime/omd/src", "runtime/native/src")
PACKAGE_MANIFESTS = ("mods/first-party/*/mod.json", "plugins/**/mod.json")
PLUGIN_MANIFESTS = "plugins/bundled/**/.codex-plugin/plugin.json"
PATCH_DIRECTORY = "runtime/patches"
PATCH_MIRRORS = ("codex-rs/omd/", "codex-rs/ext/omd/")
SURFACES = ("MOD_HOST_FEATURES", "MOD_HOST_OPERATIONS", "MOD_CAPABILITIES", "MOD_EVENTS",
            "MOD_REPLACEMENT_POINTS", "MOD_MIDDLEWARE_EVENTS")


def feature(name):
    words = set(re.split(r"[^a-z0-9]+", name.lower()))
    return sorted(words & IDENTIFIERS)


def inspect(root):
    findings = []
    source = root / "runtime/omd/src/mods.rs"
    text = source.read_text()
    for surface in SURFACES:
        match = re.search(rf"pub const {surface}:[^=]*= &\[(.*?)\];", text, re.DOTALL)
        if not match:
            raise ValueError(f"native_surface_missing:{surface}")
        for token in re.finditer(r'"([^"\n]+)"', match.group(1)):
            name = token.group(1)
            for identifier in feature(name):
                offset = match.start(1) + token.start()
                findings.append({"path": str(source.relative_to(root)), "line": text.count("\n", 0, offset) + 1,
                                 "surface": surface, "name": name, "feature": identifier})
    config = root / "runtime/native/src/config.rs"
    text = config.read_text()
    blocks = list(re.finditer(r"(?:struct|enum) (\w+Config|HostConfig|Route|Grant) \{(.*?)\n\}", text, re.DOTALL))
    if not any(block.group(1) == "HostConfig" for block in blocks):
        raise ValueError("native_host_config_missing")
    for block in blocks:
        for field in re.finditer(r"pub ([a-z_]+):", block.group(2)):
            name = field.group(1)
            for identifier in feature(name):
                offset = block.start(2) + field.start()
                findings.append({"path": str(config.relative_to(root)), "line": text.count("\n", 0, offset) + 1,
                                 "surface": block.group(1), "name": name, "feature": identifier})
    findings.extend(literals(root))
    findings.extend(runner(root))
    findings.extend(first_party(root))
    return findings


def production(path):
    text = path.read_text()
    if path.suffix != ".rs":
        return text
    masked = list(text)
    token = re.compile(r'//[^\n]*|/\*|(?:br|r)(\#*)"|b?"(?:\\.|[^"\\])*"|b?\'(?:\\.|[^\'\\])\'', re.S)
    cursor = 0
    while match := token.search(text, cursor):
        end = match.end()
        if match.group() == "/*":
            depth = 1
            while depth and end < len(text):
                nested = re.search(r"/\*|\*/", text[end:])
                if not nested:
                    end = len(text)
                    break
                depth += 1 if nested.group() == "/*" else -1
                end += nested.end()
        elif match.group(1) is not None:
            close = '"' + match.group(1)
            stop = text.find(close, end)
            end = len(text) if stop < 0 else stop + len(close)
        masked[match.start():end] = ['\n' if c == '\n' else ' ' for c in text[match.start():end]]
        cursor = end
    syntax = ''.join(masked)
    result = list(text)
    cursor = 0
    cfg = re.compile(r'#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]')
    while match := cfg.search(syntax, cursor):
        stack = []
        opened = False
        end = match.end()
        for end in range(end, len(syntax)):
            char = syntax[end]
            if char in '([{':
                stack.append(char)
                opened |= char == '{' and len(stack) == 1
            elif char in ')]}':
                if not stack or stack.pop() != {')': '(', ']': '[', '}': '{'}[char]:
                    raise ValueError(f"unbalanced test item in {path}")
                if opened and not stack:
                    break
            elif char == ';' and not stack:
                break
        else:
            raise ValueError(f"unterminated test item in {path}")
        cursor = end + 1
        result[match.start():cursor] = ['\n' if c == '\n' else ' ' for c in text[match.start():cursor]]
    return ''.join(result)


def native_files(root):
    for directory in NATIVE_SOURCES:
        for path in sorted((root / directory).rglob("*.rs")):
            if not path.name.endswith("_tests.rs"):
                yield path


def literals(root):
    findings = []
    for path in native_files(root):
        text = production(path)
        for token in re.finditer(r'"([a-z][a-z0-9_.:]*)"', text):
            name = token.group(1)
            if name in GENERIC_LITERALS:
                continue
            for identifier in feature(name):
                findings.append({"path": str(path.relative_to(root)), "line": text.count("\n", 0, token.start()) + 1,
                                 "surface": "literal", "name": name, "feature": identifier})
    return findings


def runner(root):
    path = root / "runtime/omd/src/mods/runner.mjs"
    if not path.exists():
        return []
    text = path.read_text()
    findings = []
    for token in re.finditer(r"'([^'\n]*)'|\"([^\"\n]*)\"|\b([A-Za-z_][A-Za-z0-9_]*)\b", text):
        name = next(group for group in token.groups() if group is not None)
        words = set(re.split(r"[^a-z0-9]+", re.sub(r"([a-z])([A-Z])", r"\1_\2", name).lower()))
        for identifier in sorted(words & IDENTIFIERS):
            findings.append({"path": str(path.relative_to(root)), "line": text.count("\n", 0, token.start()) + 1,
                             "surface": "runner", "name": name, "feature": identifier})
    return findings


def package_identifiers(root):
    identifiers = set()
    for pattern in PACKAGE_MANIFESTS:
        for manifest in root.glob(pattern):
            if "node_modules" not in manifest.parts:
                identifiers.add(json.loads(manifest.read_text())["id"])
    for manifest in root.glob(PLUGIN_MANIFESTS):
        if "node_modules" not in manifest.parts:
            identifiers.add(json.loads(manifest.read_text())["name"])
    return identifiers


def patch_test_path(path):
    name = path.rsplit("/", 1)[-1]
    return name.endswith("_tests.rs") or name == "tests.rs" or "/tests/" in path or ".snap" in name


def patched(root, identifiers):
    pattern = re.compile("|".join(rf"\b{re.escape(identifier)}\b" for identifier in sorted(identifiers)))
    findings = []
    for patch in sorted((root / PATCH_DIRECTORY).glob("*.patch")):
        path, line = None, 0
        for text in patch.read_text(errors="replace").splitlines():
            if text.startswith("diff --git"):
                path = None
            elif text.startswith("+++ b/"):
                path = text[6:]
                if path.startswith(PATCH_MIRRORS) or patch_test_path(path):
                    path = None
            elif text.startswith("@@"):
                line = int(re.search(r"\+(\d+)", text).group(1)) - 1
            elif path and text[:1] in ("+", " "):
                line += 1
                for match in pattern.finditer(text, 1) if text[0] == "+" else ():
                    findings.append({"path": path, "line": line, "surface": "first_party_id",
                                     "name": match.group(), "feature": match.group()})
    return findings


def first_party(root):
    identifiers = package_identifiers(root)
    findings = patched(root, identifiers) if identifiers else []
    paths = list(native_files(root)) + [root / "runtime/omd/src/mods/runner.mjs"]
    for path in paths:
        if not path.exists():
            continue
        text = production(path)
        for identifier in sorted(identifiers):
            for match in re.finditer(rf"\b{re.escape(identifier)}\b", text):
                findings.append({"path": str(path.relative_to(root)), "line": text.count("\n", 0, match.start()) + 1,
                                 "surface": "first_party_id", "name": identifier, "feature": identifier})
    return findings


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", action="store_true")
    args = parser.parse_args()
    findings = inspect(ROOT)
    print(json.dumps({"schema": 1, "violations": findings, "count": len(findings)}, indent=2))
    if findings and not args.report:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
