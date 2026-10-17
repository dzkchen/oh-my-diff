#!/usr/bin/env python3
import datetime
import json
import os
import re
import resource
import shutil
import subprocess
import time
from pathlib import Path

import build

ROOT = Path(__file__).resolve().parents[2]
WORK = Path(os.environ.get("OMD_NIGHTLY_ROOT", "/private/tmp/omd-nightly"))
BATCH = "nightly"
CRATES = ["-p", "codex-omd", "-p", "codex-omd-extension", "-p", "codex-tui",
          "-p", "codex-core-plugins", "-p", "codex-git-utils"]
SOURCE_PATH = re.compile(r"--> ([^:\s]+):\d")


def cargo(log, *args):
    if args[0] in ("build", "test", "clippy"):
        args = (args[0], "--locked", *args[1:])
    return ["python3", ".github/scripts/build.py", "cargo", BATCH, str(WORK / "logs" / f"{log}.cargo.log"), *args]


def drift(*paths):
    return ["git", "diff", "--exit-code", "--stat", "--", *paths]


def hosted_steps():
    artifact_dir = build.batch_dir(BATCH) / "artifacts"
    return [
        ("setup", ["python3", ".github/scripts/build.py", "setup", BATCH]),
        ("verified V8", ["python3", ".github/scripts/nightly_ci.py", "v8"]),
        ("patch sync", ["python3", ".github/scripts/build.py", "sync", BATCH]),
        ("patch matches checkout", drift("runtime", "upstream.lock.json")),
        ("cargo test native crates", ["python3", ".github/scripts/nightly_ci.py", "tests", "--suite", "native"]),
        ("core test helpers", cargo("core-helpers", "build", "-p", "codex-rmcp-client", "--bins")),
        ("cargo test core", ["python3", ".github/scripts/nightly_ci.py", "tests", "--suite", "core"]),
        ("clippy omd paths", cargo("clippy", "clippy", *CRATES, "--tests")),
        ("rustfmt", cargo("fmt", "fmt", *CRATES, "-p", "codex-core", "--", "--check")),
        ("native ownership", ["mise", "run", "native:ownership"]),
        ("host binaries", ["python3", ".github/scripts/build.py", "artifacts", BATCH]),
        ("locks", ["python3", ".github/scripts/build.py", "locks"]),
        ("locks match checkout", drift(".", ":(exclude)runtime/release.lock.json")),
        ("mods install", ["pnpm", "--dir", "mods", "install", "--frozen-lockfile", "--prefer-offline"]),
        ("mods typecheck", ["mise", "run", "mods:check"]),
        ("mods tests", ["env", f"OMD_MOD_BIN={artifact_dir / 'omd-mod'}", "mise", "run", "mods:test"]),
        ("python tests", ["python3", "-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py"]),
        ("host check with scenarios", ["python3", "scripts/mod_host_check.py", "--omd-mod", str(artifact_dir / "omd-mod"), "--scenarios"]),
        ("client acceptance", ["python3", "-m", "scripts.client_acceptance", "--binaries", str(artifact_dir)]),
    ]


def raise_file_limit():
    soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
    target = 8192 if hard == resource.RLIM_INFINITY else min(8192, hard)
    if soft != resource.RLIM_INFINITY and soft < target:
        resource.setrlimit(resource.RLIMIT_NOFILE, (target, hard))


def node():
    return subprocess.check_output(["mise", "which", "node"], cwd=ROOT, text=True).strip()


def run(name, argv):
    log = WORK / "logs" / (re.sub(r"\W+", "-", name) + ".log")
    started = time.monotonic()
    environment = os.environ | {"TMPDIR": "/private/tmp/"}
    if name == "cargo test core":
        home = WORK / "core-test-home"
        home.mkdir(exist_ok=True)
        environment.update(OMD_TEST_NODE=node(), HOME=str(home),
                           CARGO_HOME=os.environ.get("CARGO_HOME", str(Path.home() / ".cargo")),
                           RUSTUP_HOME=os.environ.get("RUSTUP_HOME", str(Path.home() / ".rustup")),
                           MISE_DATA_DIR=os.environ.get("MISE_DATA_DIR", str(Path.home() / ".local/share/mise")))
    with log.open("w") as output:
        status = subprocess.run(argv, cwd=ROOT, env=environment, stdout=output, stderr=subprocess.STDOUT).returncode
    text = log.read_text(errors="replace")
    if name == "clippy omd paths":
        cargo_log = WORK / "logs" / "clippy.cargo.log"
        files = json.loads((ROOT / "runtime/patches/manifest.json").read_text())["files"]
        paths = {path.removeprefix("codex-rs/") for path in files if path.endswith(".rs")}
        warnings = [line for line in (cargo_log.read_text(errors="replace") if cargo_log.is_file() else text).splitlines()
                    if (match := SOURCE_PATH.search(line)) and match[1] in paths]
        status = status or (1 if warnings else 0)
        text += "\n" + "\n".join(warnings)
    tail = [line for line in text.splitlines() if line.strip()][-6:]
    return {"name": name, "status": status, "seconds": round(time.monotonic() - started), "log": str(log), "tail": tail}


def main():
    raise_file_limit()
    shutil.rmtree(WORK / "logs", ignore_errors=True)
    (WORK / "logs").mkdir(parents=True)
    commit = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip()
    subprocess.run(["mise", "trust", ROOT / "mise.toml"], cwd=ROOT, capture_output=True)
    steps = hosted_steps()
    results = []
    for name, argv in steps:
        results.append(run(name, argv))
        if name == "host binaries" and not results[-1]["status"]:
            manager = str(build.batch_dir(BATCH) / "artifacts/omd-mod")
            os.environ.update(OMD_TEST_MOD_BIN=manager, OMD_TEST_MANAGER=manager, OMD_TEST_NODE=node())
        if name in ("setup", "verified V8") and results[-1]["status"]:
            break
    failed = [result["name"] for result in results if result["status"]]
    skipped = [name for name, _ in steps[len(results):]]
    stamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    lines = [f"# OMD nightly: {stamp} at `{commit}`", "",
             f"{len(results) - len(failed)}/{len(steps)} steps passed."
             + (f" Failed: {', '.join(failed)}." if failed else "") + (f" Skipped: {', '.join(skipped)}." if skipped else ""), "",
             "| Step | Result | Time | Log |", "| --- | --- | --- | --- |"]
    lines += [f"| {result['name']} | {'FAIL' if result['status'] else 'pass'} | {result['seconds']} s | `{result['log']}` |" for result in results]
    lines += [f"| {name} | skipped | | |" for name in skipped]
    for result in results:
        if result["status"]:
            lines += ["", f"## {result['name']}", "", "```", *result["tail"], "```"]
    lines += ["", "Known upstream baseline excluded: `filtered_host_additional_permissions`."]
    report = "\n".join(lines) + "\n"
    (WORK / "report.md").write_text(report)
    print(report)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
