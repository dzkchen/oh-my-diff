#!/usr/bin/env python3
import argparse
import datetime
import json
import os
import re
import resource
import shutil
import subprocess
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORK = Path("/private/tmp/omd-nightly")
REPO = WORK / "repo"
BATCH = "nightly"
CRATES = ["-p", "codex-omd", "-p", "codex-omd-extension", "-p", "codex-tui",
          "-p", "codex-core-plugins", "-p", "codex-git-utils"]
SOURCE_PATH = re.compile(r"--> ([^:\s]+):\d")


def cargo(log, *args):
    return ["python3", "scripts/batch_tree.py", "cargo", BATCH, str(WORK / "logs" / f"{log}.cargo.log"), *args]


def drift(*paths):
    return ["git", "diff", "--exit-code", "--stat", "--", *paths]


STEPS = [
    ("setup", ["python3", "scripts/batch_tree.py", "setup", BATCH]),
    ("patch sync", ["python3", "scripts/batch_tree.py", "sync", BATCH]),
    ("patch matches checkout", drift("runtime", "upstream.lock.json")),
    ("cargo test native crates", cargo("test", "test", *CRATES, "--", "--test-threads=1")),
    ("cargo test core lib", cargo("core", "test", "-p", "codex-core", "--lib", "--", "--test-threads=1")),
    ("clippy omd paths", cargo("clippy", "clippy", *CRATES, "--tests")),
    ("rustfmt", cargo("fmt", "fmt", *CRATES, "-p", "codex-core", "--", "--check")),
    ("native ownership", ["mise", "run", "native:ownership"]),
    ("artifacts", ["python3", "scripts/batch_tree.py", "artifacts", BATCH, "--build"]),
    ("locks", ["python3", "scripts/batch_tree.py", "locks", BATCH]),
    ("locks match checkout", drift(".", ":(exclude)runtime/lean-release.lock.json")),
    ("mods install", ["pnpm", "--dir", "mods", "install", "--frozen-lockfile", "--prefer-offline"]),
    ("mods typecheck", ["mise", "run", "mods:check"]),
    ("mods tests", ["env", f"OMD_MOD_BIN=/private/tmp/omd-b{BATCH}/artifacts/omd-mod", "mise", "run", "mods:test"]),
    ("python tests", ["python3", "-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py"]),
    ("host check with scenarios", ["python3", "scripts/mod_host_check.py", "--omd-mod",
                                   f"/private/tmp/omd-b{BATCH}/artifacts/omd-mod", "--scenarios"]),
    ("client acceptance", ["python3", "scripts/client_acceptance.py", "--binaries", f"/private/tmp/omd-b{BATCH}/artifacts"]),
]


def prepare_resources():
    soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
    target = 8192 if hard == resource.RLIM_INFINITY else min(8192, hard)
    if soft != resource.RLIM_INFINITY and soft < target:
        resource.setrlimit(resource.RLIMIT_NOFILE, (target, hard))
        soft = target
    print(f"Nightly open-file limit: {soft}; Rust tests run serially with TMPDIR=/private/tmp/")


def run(name, argv):
    log = WORK / "logs" / (re.sub(r"\W+", "-", name) + ".log")
    started = time.monotonic()
    with log.open("w") as output:
        status = subprocess.run(argv, cwd=REPO, env=os.environ | {"TMPDIR": "/private/tmp/"}, stdout=output, stderr=subprocess.STDOUT).returncode
    text = log.read_text(errors="replace")
    if name == "clippy omd paths":
        cargo_log = WORK / "logs" / "clippy.cargo.log"
        files = json.loads((REPO / "runtime/patches/manifest.json").read_text())["files"]
        paths = {path.removeprefix("codex-rs/") for path in files if path.endswith(".rs")}
        warnings = [line for line in cargo_log.read_text(errors="replace").splitlines()
                    if (match := SOURCE_PATH.search(line)) and match[1] in paths]
        status = status or (1 if warnings else 0)
        text += "\n" + "\n".join(warnings)
    tail = [line for line in text.splitlines() if line.strip()][-6:]
    return {"name": name, "status": status, "seconds": round(time.monotonic() - started), "log": str(log), "tail": tail}


def summarize(results, previous_failed):
    ran = [result["name"] for result in results]
    failed = [result["name"] for result in results if result["status"]]
    skipped = [name for name, _ in STEPS if name not in ran]
    return {
        "failed": failed,
        "skipped": skipped,
        "new": [name for name in failed if name not in previous_failed],
        "fixed": [name for name in previous_failed if name in ran and name not in failed],
        "unresolved": failed + [name for name in previous_failed if name in skipped],
    }


def main():
    parser = argparse.ArgumentParser(description="Build a committed ref in a scratch worktree and run the broad checks batches skip")
    parser.add_argument("--ref", default="main")
    args = parser.parse_args()
    prepare_resources()
    previous_file = WORK / "last.json"
    previous = json.loads(previous_file.read_text()) if previous_file.is_file() else {}
    subprocess.run(["git", "worktree", "remove", "--force", REPO], cwd=ROOT, capture_output=True)
    shutil.rmtree(WORK / "logs", ignore_errors=True)
    (WORK / "logs").mkdir(parents=True)
    commit = subprocess.run(["git", "rev-parse", "--short", args.ref], cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip()
    subprocess.run(["git", "worktree", "add", "--detach", REPO, args.ref], cwd=ROOT, capture_output=True, check=True)
    subprocess.run(["mise", "trust", REPO / "mise.toml"], cwd=REPO, capture_output=True)
    results = []
    try:
        for name, argv in STEPS:
            results.append(run(name, argv))
            if name == "setup" and results[-1]["status"]:
                break
    finally:
        subprocess.run(["python3", "scripts/batch_tree.py", "clean", BATCH, "--keep-warm", "--tree"], cwd=REPO, capture_output=True)
        subprocess.run(["git", "worktree", "remove", "--force", REPO], cwd=ROOT, capture_output=True)
    summary = summarize(results, previous.get("failed", []))
    failed, skipped, new, fixed = summary["failed"], summary["skipped"], summary["new"], summary["fixed"]
    unrun = [name for name in summary["unresolved"] if name in skipped]
    stamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    lines = [f"# OMD nightly: {stamp}, {args.ref} at `{commit}`", "",
             f"{len(results) - len(failed)}/{len(STEPS)} steps passed."
             + (f" New failures: {', '.join(new)}." if new else "") + (f" Fixed since last run: {', '.join(fixed)}." if fixed else "")
             + (f" Skipped: {', '.join(skipped)}." if skipped else "") + (f" Still failing from the last run, not rerun: {', '.join(unrun)}." if unrun else ""), "",
             "| Step | Result | Time | Log |", "| --- | --- | --- | --- |"]
    lines += [f"| {result['name']} | {'pass' if not result['status'] else 'FAIL'} | {result['seconds']} s | `{result['log']}` |" for result in results]
    lines += [f"| {name} | skipped | | |" for name in skipped]
    for result in results:
        if result["status"]:
            lines += ["", f"## {result['name']}", "", "```", *result["tail"], "```"]
    report = "\n".join(lines) + "\n"
    (WORK / "report.md").write_text(report)
    if (ROOT / ".docs").is_dir():
        (ROOT / ".docs/nightly.md").write_text(report)
    previous_file.write_text(json.dumps({"commit": commit, "failed": summary["unresolved"]}))
    notice = f"{len(results) - len(failed)}/{len(STEPS)} passed" + (f", new failures: {len(new)}" if new else "") + (f", skipped: {len(skipped)}" if skipped else "")
    subprocess.run(["osascript", "-e", f'display notification "{notice}" with title "OMD nightly"'], capture_output=True)
    print(report)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
