#!/usr/bin/env python3
import argparse
import datetime
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHANGELOG = ROOT / "changelog.json"
MARKDOWN = ROOT / "CHANGELOG.md"
LOCK = ROOT / "runtime/release.lock.json"
REPOSITORY = "dzkchen/oh-my-diff"
VERSION = re.compile(r"\d+\.\d+\.\d+(?:-rc\.\d+)?")
LABELS = ("New", "Changed", "Fixed", "Decided")
LINK = re.compile(r"\[[^\]]*\]\(([^)\s]+)\)|(?:href|src)=\"([^\"]+)\"")


def run(*args, capture=True):
    result = subprocess.run([str(arg) for arg in args], cwd=ROOT, text=True,
                            stdout=subprocess.PIPE if capture else None, stderr=subprocess.PIPE if capture else None)
    if result.returncode:
        raise SystemExit(f"{' '.join(map(str, args[:3]))} failed:\n{(result.stderr or result.stdout or '')[-3000:]}")
    return (result.stdout or "").strip()


def heading(entry):
    if "version" in entry:
        return f"## [{entry['version']}](https://github.com/{REPOSITORY}/releases/tag/v{entry['version']}) — {entry['date']}"
    return f"## {entry['date']} — {entry['title']}"


def sections(entry):
    lines = []
    for section in entry["sections"]:
        lines += [f"### {section['label']}", "", *(f"- {item}" for item in section["items"]), ""]
    return lines


def render(entries):
    lines = ["# Changelog", "",
             "Generated from [`changelog.json`](changelog.json) by `mise run release`; the Oh My Diff site and "
             "GitHub Releases use the same entries. Entries before the first release are daily development notes.", ""]
    for entry in entries:
        lines += [heading(entry), "", entry["summary"], "", *sections(entry)]
    return "\n".join(lines).rstrip() + "\n"


def notes(entries, version):
    entry = next((item for item in entries if item.get("version") == version), None)
    if entry is None:
        raise SystemExit(f"changelog.json has no {version} entry")
    return "\n".join([entry["summary"], "", *sections(entry),
                      f"Full history: [CHANGELOG.md](https://github.com/{REPOSITORY}/blob/v{version}/CHANGELOG.md)"]) + "\n"


def lock_version():
    return json.loads(LOCK.read_text())["version"]


def broken_links():
    broken = []
    for name in run("git", "ls-files", "--cached", "--others", "--exclude-standard", "*.md").splitlines():
        path = ROOT / name
        if not path.exists():
            continue
        text = re.sub(r"```.*?```", "", path.read_text(), flags=re.S)
        for link in (markdown or html for markdown, html in LINK.findall(text)):
            target, _, anchor = link.partition("#")
            if re.match(r"[a-z]+:", target):
                continue
            resolved = path.parent / target if target else path
            if not resolved.exists() or (anchor and resolved.suffix == ".md" and anchor not in anchors(resolved)):
                broken.append(f"{name}: {link}")
    return broken


def anchors(path):
    return {re.sub(r"[^\w\- ]", "", re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", line.lstrip("#").strip()).lower()).replace(" ", "-")
            for line in re.sub(r"```.*?```", "", path.read_text(), flags=re.S).splitlines() if line.startswith("#")}


def check(version=None):
    entries = json.loads(CHANGELOG.read_text())
    problems, seen, versions = [], set(), set()
    for entry in entries:
        name = entry.get("version") or entry.get("date")
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", entry["date"]) or not entry["title"] or not entry["summary"]:
            problems.append(f"{name}: date, title and summary are required")
        labels = [section["label"] for section in entry["sections"]]
        if labels != sorted(labels, key=LABELS.index) or len(set(labels)) != len(labels):
            problems.append(f"{name}: sections must be unique and ordered {', '.join(LABELS)}")
        if any(not section["items"] for section in entry["sections"]):
            problems.append(f"{name}: empty section")
        for commit in entry["commits"]:
            if not re.fullmatch(r"[0-9a-f]{7}", commit) or commit in seen:
                problems.append(f"{name}: invalid or repeated commit {commit}")
            seen.add(commit)
        if "version" in entry:
            if not VERSION.fullmatch(entry["version"]) or entry["version"] in versions:
                problems.append(f"{name}: invalid or repeated version")
            versions.add(entry["version"])
    if [entry["date"] for entry in entries] != sorted((entry["date"] for entry in entries), reverse=True):
        problems.append("entries must be newest first")
    if MARKDOWN.read_text() != render(entries):
        problems.append("CHANGELOG.md is stale; regenerate it from changelog.json with `python3 scripts/release.py render`")
    if version is not None:
        if not VERSION.fullmatch(version):
            problems.append(f"{version} is not vMAJOR.MINOR.PATCH or -rc.N")
        if lock_version() != version:
            problems.append(f"runtime/release.lock.json is {lock_version()}, not {version}")
        if not entries or entries[0].get("version") != version:
            problems.append(f"the newest changelog entry is not {version}")
    problems += [f"broken link {item}" for item in broken_links()]
    if problems:
        raise SystemExit("\n".join(problems))
    print(f"release metadata consistent{f' for {version}' if version else ''}")


def uncovered(entries):
    covered = {commit for entry in entries for commit in entry["commits"]}
    return [commit[:7] for commit in run("git", "rev-list", "--reverse", "origin/main").split() if commit[:7] not in covered]


def changes(commits, existing=()):
    grouped = {label: [] for label in LABELS}
    for section in existing:
        grouped[section["label"]] += section["items"]
    context = json.loads(run("git", "cliff", "--context", "--config", ROOT / "cliff.toml"))
    for item in (commit for release in context for commit in release["commits"]):
        line = item["message"].splitlines()[0]
        text = line[:1].upper() + line[1:]
        if item["id"][:7] in commits and item.get("group") in grouped and text not in grouped[item["group"]]:
            grouped[item["group"]].append(text)
    return [{"label": label, "items": items} for label, items in grouped.items() if items]


def release_entry(entries, version, summary):
    commits = uncovered(entries)
    if not commits:
        raise SystemExit("no commits since the last changelog entry")
    return {"version": version, "date": f"{datetime.datetime.now(datetime.UTC):%Y-%m-%d}",
            "title": f"Oh My Diff {version}", "summary": summary, "sections": changes(commits), "commits": commits}


def prepare(version, summary):
    if not VERSION.fullmatch(version):
        raise SystemExit(f"{version} is not MAJOR.MINOR.PATCH or MAJOR.MINOR.PATCH-rc.N")
    tag = f"v{version}"
    run("git", "fetch", "--tags", "origin", "main")
    if run("git", "tag", "--list", tag):
        raise SystemExit(f"{tag} already exists")
    merged = json.loads(run("git", "show", "origin/main:runtime/release.lock.json"))["version"] == version
    if merged:
        run("git", "tag", "--annotate", tag, "--message", f"Oh My Diff {version}", "origin/main")
        run("git", "push", "origin", tag)
        print(f"pushed {tag}; https://github.com/{REPOSITORY}/actions/workflows/release.yml builds, verifies and publishes it")
        return
    if run("git", "status", "--porcelain"):
        raise SystemExit("commit or set aside local changes first")
    branch = f"release/{tag}"
    if run("git", "ls-remote", "origin", f"refs/heads/{branch}"):
        refresh(version, branch)
        return
    if summary is None:
        raise SystemExit("--summary is required to open the release pull request")
    run("git", "switch", "--create", branch, "origin/main")
    lock = json.loads(LOCK.read_text())
    lock["version"] = version
    LOCK.write_text(json.dumps(lock, indent=2, sort_keys=True) + "\n")
    entries = json.loads(CHANGELOG.read_text())
    entries.insert(0, release_entry(entries, version, summary))
    CHANGELOG.write_text(json.dumps(entries, indent=2, ensure_ascii=False) + "\n")
    MARKDOWN.write_text(render(entries))
    check(version)
    run("git", "add", LOCK, CHANGELOG, MARKDOWN)
    run("git", "commit", "--message", f"chore(release): {version}")
    run("git", "push", "--set-upstream", "origin", branch)
    run("gh", "pr", "create", "--repo", REPOSITORY, "--base", "main", "--head", branch,
        "--title", f"chore(release): {version}",
        "--body", "Review and edit the generated `changelog.json` entry, then run `python3 scripts/release.py render`. "
                  f"Run `mise run release -- {version}` again to cover changes merged to main since, and once more after "
                  "this merges to tag it.", capture=False)


def refresh(version, branch):
    run("git", "fetch", "origin", branch)
    run("git", "switch", branch)
    run("git", "merge", "--no-edit", "origin/main")
    entries = json.loads(CHANGELOG.read_text())
    if commits := uncovered(entries):
        entries[0]["sections"] = changes(commits, entries[0]["sections"])
        entries[0]["commits"] += commits
        CHANGELOG.write_text(json.dumps(entries, indent=2, ensure_ascii=False) + "\n")
        MARKDOWN.write_text(render(entries))
        check(version)
        run("git", "add", CHANGELOG, MARKDOWN)
        run("git", "commit", "--message", f"chore(release): add changes merged since {version} was prepared")
    run("git", "push", "origin", branch)


def rollback(version):
    tag = f"v{version}"
    run("gh", "release", "edit", tag, "--repo", REPOSITORY, "--draft=true")
    previous = json.loads(run("gh", "release", "list", "--repo", REPOSITORY, "--exclude-drafts",
                              "--exclude-pre-releases", "--limit", "1", "--json", "tagName"))
    if previous and "-" not in version:
        run("gh", "release", "edit", previous[0]["tagName"], "--repo", REPOSITORY, "--latest")
    print(f"{tag} is a draft again; installers and `omd update` no longer offer it")


def main():
    parser = argparse.ArgumentParser(description="Prepare, check and publish Oh My Diff releases")
    commands = parser.add_subparsers(dest="command", required=True)
    prepare_parser = commands.add_parser("prepare", help="open the release pull request, refresh it from main, or tag it once merged")
    prepare_parser.add_argument("version")
    prepare_parser.add_argument("--summary", help="one-sentence release summary")
    check_parser = commands.add_parser("check", help="verify changelog, links and, with VERSION, release versions")
    check_parser.add_argument("version", nargs="?")
    commands.add_parser("render", help="regenerate CHANGELOG.md from changelog.json")
    commands.add_parser("notes").add_argument("version")
    commands.add_parser("rollback", help="withdraw a published release").add_argument("version")
    args = parser.parse_args()
    if args.command == "prepare":
        prepare(args.version, args.summary)
    elif args.command == "check":
        check(args.version)
    elif args.command == "render":
        MARKDOWN.write_text(render(json.loads(CHANGELOG.read_text())))
    elif args.command == "notes":
        sys.stdout.write(notes(json.loads(CHANGELOG.read_text()), args.version))
    else:
        rollback(args.version)


if __name__ == "__main__":
    main()
