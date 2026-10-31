#!/usr/bin/env python3
import argparse
import datetime
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHANGELOG = ROOT / "release/changelog.json"
MARKDOWN = ROOT / "CHANGELOG.md"
LOCK = ROOT / "runtime/release.lock.json"
CATALOG = ROOT / "extensions/index.json"
REFERENCE = ROOT / "mods/REFERENCE.md"
HOST_CRATES = ("runtime/omd/Cargo.toml", "runtime/omd/runner/Cargo.toml")
REPOSITORY = "dzkchen/oh-my-diff"
VERSION = re.compile(r"\d+\.\d+\.\d+(?:-rc\.\d+)?")
LABELS = ("New", "Changed", "Fixed")
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
             "Generated from [`release/changelog.json`](release/changelog.json) by `mise run release`; the Oh My Diff site and "
             "GitHub Releases use the same entries. Entries before the first release are daily development notes.", ""]
    for entry in entries:
        lines += [heading(entry), "", entry["summary"], "", *sections(entry)]
    return "\n".join(lines).rstrip() + "\n"


def notes(entries, version):
    entry = next((item for item in entries if item.get("version") == version), None)
    if entry is None:
        raise SystemExit(f"release/changelog.json has no {version} entry")
    channel = " --channel prerelease" if "-" in version else ""
    return "\n".join([entry["summary"], "", *sections(entry),
                      f"Install or update to the newest {'prerelease' if channel else 'stable release'}:", "", "```sh",
                      f"curl --proto '=https' --tlsv1.2 -fsSL https://github.com/{REPOSITORY}/releases/download/v{version}"
                      f"/install.sh | sh -s --{channel} --profile full", "```", "",
                      f"Full history: [CHANGELOG.md](https://github.com/{REPOSITORY}/blob/v{version}/CHANGELOG.md)"]) + "\n"


def pinned(catalog, version):
    text = re.sub(r"\bOMD \d+\.\d+\.\d+(?:-rc\.\d+)?", f"OMD {version}", json.dumps(catalog))
    catalog = json.loads(re.sub(r"\bCodex \d+\.\d+\.\d+", f"Codex {catalog['release_pin']['codex']}", text))
    catalog["release_pin"]["omd"] = version
    return catalog


def lock_version():
    return json.loads(LOCK.read_text())["version"]


# The host reports its crate version as the OMD release (`host.omd`), so both OMD crates carry the release version.
def host_versions(revision=None):
    manifests = [run("git", "show", f"{revision}:{name}") if revision else (ROOT / name).read_text() for name in HOST_CRATES]
    return {re.search(r'^version = "([^"]+)"$', manifest, re.M).group(1) for manifest in manifests}


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


def reference_drift():
    def normalized(line):
        return re.sub(r"^#+ ", "# ", re.sub(r"\]\([^)]*\)", "]", line))

    index = (REFERENCE.parent / "reference/README.md").read_text()
    pages = [REFERENCE.parent / "reference" / name for name in re.findall(r"^\| \[[^\]]+\]\(([\w-]+\.md)\)", index, re.M)]
    if unlisted := sorted({page.name for page in (REFERENCE.parent / "reference").glob("*.md")} - {page.name for page in pages} - {"README.md"}):
        return f"mods/reference/README.md does not list {', '.join(unlisted)}"
    expected = [(page.name, normalized(line)) for page in pages for line in page.read_text().splitlines() if line.strip()]
    lines = [normalized(line) for line in REFERENCE.read_text().splitlines() if line.strip()]
    titles = {normalized(page.read_text().split("\n", 1)[0]) for page in pages}
    actual = lines[next((index for index, line in enumerate(lines) if line in titles), len(lines)):]
    for (name, line), found in zip(expected, actual):
        if line != found:
            return f"mods/REFERENCE.md has {found!r} where mods/reference/{name} has {line!r}"
    if len(actual) != len(expected):
        return f"mods/REFERENCE.md has {len(actual)} lines after the topic pages begin, the pages in reference/README.md order have {len(expected)}"
    return None


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
        problems.append("CHANGELOG.md is stale; regenerate it from release/changelog.json with `python3 scripts/release.py render`")
    if version is not None:
        if not VERSION.fullmatch(version):
            problems.append(f"{version} is not vMAJOR.MINOR.PATCH or -rc.N")
        if lock_version() != version:
            problems.append(f"runtime/release.lock.json is {lock_version()}, not {version}")
        if host_versions() != {version}:
            problems.append(f"the OMD host crates are {', '.join(sorted(host_versions()))}, not {version}")
        if not entries or entries[0].get("version") != version:
            problems.append(f"the newest changelog entry is not {version}")
        if (catalog := json.loads(CATALOG.read_text())) != pinned(catalog, version):
            problems.append(f"extensions/index.json must pin and name OMD {version} and Codex {catalog['release_pin']['codex']} throughout")
        problems += history(entries, version)
    problems += [f"broken link {item}" for item in broken_links()]
    if drift := reference_drift():
        problems.append(drift)
    if problems:
        raise SystemExit("\n".join(problems))
    print(f"release metadata consistent{f' for {version}' if version else ''}")


def uncovered(entries, *revisions):
    covered = {commit for entry in entries for commit in entry["commits"]}
    # One line per change on main: a merge commit stands for its pull request, not the branch commits it brings in.
    return [commit[:7] for commit in run("git", "rev-list", "--reverse", "--first-parent", *(revisions or ["origin/main"])).split()
            if commit[:7] not in covered]


def released(version, subject):
    return re.fullmatch(rf"chore\(release\): {re.escape(version)}(?: \(#\d+\))?", subject)


def history(entries, version, revision="HEAD"):
    tag, commit = f"v{version}", run("git", "rev-parse", f"{revision}^{{commit}}")
    if run("git", "tag", "--list", tag) and (tagged := run("git", "rev-parse", f"{tag}^{{commit}}")) != commit:
        return [f"{tag} already tags {tagged[:7]}, not {commit[:7]}"]
    previous = next((entry["version"] for entry in entries if entry.get("version") not in (None, version)), None)
    since = [f"^v{previous}"] if previous and run("git", "tag", "--list", f"v{previous}") else []
    missing = [item for item in uncovered(entries, run("git", "merge-base", commit, "origin/main"), *since)
               if not (item == commit[:7] and released(version, run("git", "log", "-1", "--format=%s", commit)))]
    return [f"no changelog entry covers {', '.join(missing)}"] if missing else []


def changes(commits, existing=()):
    grouped = {label: [] for label in LABELS}
    for section in existing:
        grouped[section["label"]] += section["items"]
    context = json.loads(run("git", "cliff", "--context", "--config", ROOT / "release/cliff.toml"))
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
    if host_versions("origin/main") != {version}:
        raise SystemExit(f"main's OMD host crates are {', '.join(sorted(host_versions('origin/main')))}, not {version}: "
                         "bump codex-omd and codex-omd-runner in the patch and merge that first")
    merged = json.loads(run("git", "show", "origin/main:runtime/release.lock.json"))["version"] == version
    if merged:
        commit = next((commit for commit, _, subject in (line.partition(" ") for line in run(
            "git", "log", "--first-parent", "--format=%H %s", "origin/main").splitlines()) if released(version, subject)), None)
        if commit is None:
            raise SystemExit(f"main has no `chore(release): {version}` commit to tag")
        if problems := history(json.loads(run("git", "show", f"{commit}:release/changelog.json")), version, commit):
            raise SystemExit("\n".join(problems))
        run("git", "tag", "--annotate", tag, "--message", f"Oh My Diff {version}", commit)
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
    CATALOG.write_text(json.dumps(pinned(json.loads(CATALOG.read_text()), version), indent=2, ensure_ascii=False) + "\n")
    entries = json.loads(CHANGELOG.read_text())
    entries.insert(0, release_entry(entries, version, summary))
    CHANGELOG.write_text(json.dumps(entries, indent=2, ensure_ascii=False) + "\n")
    MARKDOWN.write_text(render(entries))
    check(version)
    run("git", "add", LOCK, CATALOG, CHANGELOG, MARKDOWN)
    run("git", "commit", "--message", f"chore(release): {version}")
    run("git", "push", "--set-upstream", "origin", branch)
    run("gh", "pr", "create", "--repo", REPOSITORY, "--base", "main", "--head", branch,
        "--title", f"chore(release): {version}",
        "--body", "Review and edit the generated `release/changelog.json` entry, then run `python3 scripts/release.py render`. "
                  f"Squash merge this pull request: tagging looks for its `chore(release): {version}` commit on main. "
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


def rollback(version, dry_run=False):
    tag = f"v{version}"
    listed = json.loads(run("gh", "release", "list", "--repo", REPOSITORY, "--exclude-drafts",
                            "--exclude-pre-releases", "--limit", "2", "--json", "tagName"))
    previous = next((item["tagName"] for item in listed if item["tagName"] != tag), None)
    edits = [("gh", "release", "edit", tag, "--repo", REPOSITORY, "--draft=true")]
    if previous and "-" not in version:
        edits.append(("gh", "release", "edit", previous, "--repo", REPOSITORY, "--latest"))
    for edit in edits:
        print(" ".join(edit)) if dry_run else run(*edit)
    fallback = "" if "-" in version else (f"; {previous} is the latest" if previous else "; no earlier stable release exists")
    print(f"{tag} {'would be' if dry_run else 'is'} a draft again; installers and `omd update` no longer offer it{fallback}")


def main():
    parser = argparse.ArgumentParser(description="Prepare, check and publish Oh My Diff releases")
    commands = parser.add_subparsers(dest="command", required=True)
    prepare_parser = commands.add_parser("prepare", help="open the release pull request, refresh it from main, or tag it once merged")
    prepare_parser.add_argument("version")
    prepare_parser.add_argument("--summary", help="one-sentence release summary")
    check_parser = commands.add_parser("check", help="verify changelog, links and, with VERSION, release versions")
    check_parser.add_argument("version", nargs="?")
    commands.add_parser("render", help="regenerate CHANGELOG.md from release/changelog.json")
    commands.add_parser("notes").add_argument("version")
    rollback_parser = commands.add_parser("rollback", help="withdraw a published release")
    rollback_parser.add_argument("version")
    rollback_parser.add_argument("--dry-run", action="store_true", help="print the release edits without making them")
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
        rollback(args.version, args.dry_run)


if __name__ == "__main__":
    main()
