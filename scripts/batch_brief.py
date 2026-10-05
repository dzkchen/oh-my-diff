#!/usr/bin/env python3
import argparse
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / ".docs"
HEADING = re.compile(r"^(#{2,4}) (.*)$")
BATCH = re.compile(r"^(.*?)\bBatch (\S+) —")


def sections(path):
    lines = path.read_text().splitlines()
    marks = [(index, len(match.group(1)), match.group(2)) for index, line in enumerate(lines)
             if (match := HEADING.match(line))]
    for position, (start, level, title) in enumerate(marks):
        end = next((other for other, other_level, _ in marks[position + 1:] if other_level <= level), len(lines))
        intro = next((other for other, _, _ in marks[position + 1:]), len(lines))
        yield start, level, title, lines[start:end], lines[start:intro]


def ids(title):
    match = BATCH.search(title)
    return " ".join((match.group(1) + match.group(2)).lower().split()) if match else None


def find(path, batch):
    found = list(sections(path))
    for position, (start, level, title, body, _) in enumerate(found):
        if ids(title) == batch:
            parents = []
            for _, other_level, _, _, intro in reversed(found[:position]):
                if other_level < level and (not parents or other_level < parents[-1][0]):
                    parents.append((other_level, intro))
            return [intro for other_level, intro in reversed(parents) if other_level > 2 or path.name == "TODO.md"], body
    return [], []


def checkboxes(openings):
    lines = (DOCS / "ROADMAP.md").read_text().splitlines()
    found = []
    for index, line in enumerate(lines):
        if any(re.match(r"\s*- \[[ x]\] " + re.escape(opening), line) for opening in openings):
            end = index + 1
            while end < len(lines) and (lines[end].startswith("  ") or not lines[end]) and not HEADING.match(lines[end]):
                end += 1
            found.extend(lines[index:end])
    return found


def progress():
    status = {batch: f"{batch} closed (archived)" for _, _, title, _, _ in sections(DOCS / "archive" / "ROADMAP-completed.md")
              if (batch := ids(title))}
    for _, _, title, body, _ in sections(DOCS / "ROADMAP.md"):
        if batch := ids(title):
            done = sum(bool(re.match(r"\s*- \[x\]", line)) for line in body)
            total = done + sum(bool(re.match(r"\s*- \[ \]", line)) for line in body)
            status[batch] = f"{batch} {'closed' if total and done == total else 'open'} {done}/{total}"
    return status


def main():
    parser = argparse.ArgumentParser(description="Print one batch's TODO and ROADMAP sections and its referenced batches")
    parser.add_argument("batch", nargs="+", help="for example 4ec, 4.1a or post-launch 1a")
    batch = " ".join(" ".join(parser.parse_args().batch).lower().replace("batch", " ").split())
    text = next((["=== Standing decisions (ROADMAP.md)"] + body[1:] for _, _, title, body, _ in sections(DOCS / "ROADMAP.md")
                 if title == "Standing decisions"), [])
    for name in ("TODO.md", "ROADMAP.md"):
        parents, body = find(DOCS / name, batch)
        if not body and name == "ROADMAP.md":
            body = checkboxes(re.findall(r'^\s*- \[[ x]\] `"([^"]+)"', "\n".join(text), re.M))
        if not body:
            text.append(f"=== {name}: no batch heading for {batch}")
            continue
        text.append(f"=== {name}")
        for intro in parents:
            text.extend(intro)
        text.extend(body)
    print("\n".join(text))
    status = progress()
    mentioned = sorted({token.lower() for token in re.findall(r"\b\d+(?:\.\d+)?[a-z]{1,3}\d?\b", "\n".join(text))}
                       & set(status) - {batch})
    if mentioned:
        print("\n=== Referenced batches\n" + "\n".join(status[name] for name in mentioned))


if __name__ == "__main__":
    main()
