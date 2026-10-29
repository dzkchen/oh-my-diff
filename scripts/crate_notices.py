#!/usr/bin/env python3
import argparse
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "runtime/crate-notices.txt"
TARGET = "aarch64-apple-darwin"
SHIPPED = {"codex-cli", "codex-code-mode-host", "codex-omd", "codex-omd-extension", "codex-omd-runner"}
LICENSE_FILE = re.compile(r"(?i)^(licen[cs]e|copying|notice|copyright)")
COPYRIGHT = re.compile(r"^\s*Copyright\s*(\([cC]\)|©|\d|[A-Z])|^\s*(\([cC]\)|©)\s*\d")
TEMPLATE = re.compile(r"[\[{<](yyyy|year)[\]}>]", re.I)


def shipped_crates(tree):
    metadata = json.loads(subprocess.run(
        ["cargo", "metadata", "--locked", "--format-version", "1", "--filter-platform", TARGET],
        cwd=tree / "codex-rs", capture_output=True, check=True).stdout)
    packages = {package["id"]: package for package in metadata["packages"]}
    nodes = {node["id"]: node for node in metadata["resolve"]["nodes"]}
    members = set(metadata["workspace_members"])
    pending = [identifier for identifier in members if packages[identifier]["name"] in SHIPPED]
    linked = set()
    while pending:
        identifier = pending.pop()
        if identifier not in linked:
            linked.add(identifier)
            pending += [dep["pkg"] for dep in nodes[identifier]["deps"]
                        if any(kind["kind"] is None for kind in dep["dep_kinds"])]
    return sorted((packages[identifier] for identifier in linked - members), key=lambda p: (p["name"], p["version"]))


def render(tree):
    texts, entries = {}, []
    for package in shipped_crates(tree):
        directory = Path(package["manifest_path"]).parent
        files = sorted(path for path in directory.iterdir() if path.is_file() and LICENSE_FILE.match(path.name))
        copyrights, numbers = [], []
        for path in files:
            body = []
            raw = path.read_text(encoding="utf-8", errors="replace")
            if len(raw.strip()) < 100:
                continue
            for line in raw.splitlines():
                line = line.rstrip()
                if not COPYRIGHT.match(line):
                    body.append(line)
                elif not TEMPLATE.search(line) and line.strip() not in copyrights:
                    copyrights.append(line.strip())
            text = "\n".join(body).strip()
            number = texts.setdefault(" ".join(text.split()), (len(texts) + 1, text))[0]
            if number not in numbers:
                numbers.append(number)
        header = f"{package['name']} {package['version']} | {package['license'] or 'no declared license'} | "
        header += f"texts {', '.join(map(str, numbers))}" if numbers else (
            "no license file in the crate; authors: " + ("; ".join(package["authors"]) or "not declared"))
        entries.append("\n".join([header, *(f"  {line}" for line in copyrights)]))
    lines = ["Rust crates built into the Oh My Diff binaries for " + TARGET + ".",
             "Generated from the patched Codex workspace. Each crate lists its declared",
             "license and copyright lines, then the numbered license and notice texts its crate files contain.",
             "A crate that publishes no license file is under the standard text of its declared license",
             "(https://spdx.org/licenses/).", "",
             *entries]
    for number, text in sorted(texts.values()):
        lines += ["", f"=== Text {number}", "", text]
    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser(description="Write the license notices of the Rust crates in the shipped binaries")
    parser.add_argument("tree", type=Path, help="patched Codex checkout")
    parser.add_argument("--check", action="store_true", help="fail if the checked-in notices differ")
    args = parser.parse_args()
    text = render(args.tree)
    if args.check:
        raise SystemExit(0 if OUTPUT.is_file() and OUTPUT.read_text(encoding="utf-8") == text else f"{OUTPUT} is stale")
    OUTPUT.write_text(text, encoding="utf-8")


if __name__ == "__main__":
    main()
