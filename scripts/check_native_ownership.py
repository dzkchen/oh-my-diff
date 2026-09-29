import argparse
import json
from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[1]
IDENTIFIERS = {"git", "lsp", "graph", "health", "knowledge", "guideline", "workflow",
               "review", "recovery", "checkpoint", "contributor", "controlled", "pi"}
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
