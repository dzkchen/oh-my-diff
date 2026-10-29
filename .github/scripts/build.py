#!/usr/bin/env python3
import argparse
import functools
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
import tomllib
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
TMP = Path(os.environ.get("OMD_WORK_ROOT", "/private/tmp"))
SCRATCH = Path(os.environ.get("OMD_SCRATCH_REPO", TMP / "omd-cache/codex"))
V8 = Path(os.environ.get("OMD_V8_DIR", TMP / "omd-cache/v8"))
BUILD = ["build", "--locked", "--release", "-p", "codex-cli", "--bin", "codex", "-p", "codex-code-mode-host", "-p", "codex-omd",
         "-p", "codex-omd-extension", "-p", "codex-omd-runner", "--bins"]
CHECK = ["check", "--locked", "-p", "codex-cli", "-p", "codex-exec", "-p", "codex-omd", "-p", "codex-omd-runner",
         "-p", "codex-omd-extension", "-p", "codex-tui", "-p", "codex-core", "-p", "codex-core-plugins", "-p", "codex-git-utils",
         "--tests"]
SUMMARY = re.compile(r"^test result|^\s+Summary \[|^\s+(FAIL|TIMEOUT) \[|^error|FAILED|panicked|^warning: unused")
MIRRORS = (("codex-rs/omd", "runtime/omd"), ("codex-rs/ext/omd", "runtime/native"))
OBSERVER = "codex-rs/codex-api/src/request_observer.rs"
GENERATORS = ("plugin_lock", "mods_lock")


def pin():
    return json.loads((ROOT / "upstream.lock.json").read_text())


def base_tag():
    return "normalized" + pin()["tag"].removeprefix("rust-v").replace(".", "").lstrip("0")


def work_dir(name):
    return TMP / f"omd-b{name}"


def run(*args, cwd=None, allowed=(0,)):
    result = subprocess.run([str(arg) for arg in args], cwd=cwd, capture_output=True)
    if result.returncode not in allowed:
        raise SystemExit(f"{' '.join(map(str, args))} failed:\n{result.stderr.decode()}")
    return result.stdout


def git(tree, *args, allowed=(0,)):
    return run("git", *args, cwd=tree, allowed=allowed)


@functools.cache
def node():
    return run("mise", "which", "node", cwd=ROOT).decode().strip()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def scratch_repo():
    lock = pin()
    if not SCRATCH.exists():
        run("git", "clone", "--quiet", "--depth", "1", "--branch", lock["tag"], "--no-checkout", lock["repository"], SCRATCH)
    if not git(SCRATCH, "tag", "-l", lock["tag"]).strip():
        git(SCRATCH, "fetch", "--quiet", "origin", "tag", lock["tag"])
    return lock["commit"]


def prepare(tree, commit):
    git(tree, "checkout", "--quiet", "--detach", commit)
    run(sys.executable, ROOT / "scripts/normalize_upstream_lock.py", tree)


def setup(args):
    work = work_dir(args.name)
    tree = work / "codex"
    if not tree.exists():
        commit = scratch_repo()
        work.mkdir(parents=True, exist_ok=True)
        git(SCRATCH, "worktree", "add", "--quiet", "--detach", tree, commit)
        prepare(tree, commit)
        if not git(SCRATCH, "tag", "-l", base_tag()).strip():
            git(tree, "-c", "user.name=omd", "-c", "user.email=omd@localhost", "commit", "--quiet", "-am",
                f"normalize {pin()['tag']} lock")
            git(tree, "tag", base_tag())
            prepare(tree, commit)
        print(run(sys.executable, ROOT / "scripts/apply_runtime_patch.py", tree).decode().strip())
    if not (tree / "mods").exists():
        (tree / "mods").symlink_to(ROOT / "mods")
    print(tree)


def cargo_env(work):
    env = {key: value for key, value in os.environ.items()
           if key not in ("CODEX_SQLITE_HOME", "FORCE_COLOR", "COLORTERM", "NO_COLOR")}
    env.update({
        "CARGO_TARGET_DIR": str(work / "target"),
        "CARGO_INCREMENTAL": os.environ.get("CARGO_INCREMENTAL", "1"),
        "CARGO_PROFILE_DEV_DEBUG": os.environ.get("CARGO_PROFILE_DEV_DEBUG", "0"),
        "CARGO_PROFILE_RELEASE_LTO": os.environ.get("CARGO_PROFILE_RELEASE_LTO", "off"),
        "CARGO_PROFILE_RELEASE_CODEGEN_UNITS": os.environ.get("CARGO_PROFILE_RELEASE_CODEGEN_UNITS", "16"),
        "CARGO_PROFILE_RELEASE_DEBUG": os.environ.get("CARGO_PROFILE_RELEASE_DEBUG", "0"),
        "RUST_MIN_STACK": "16777216",
    })
    if os.environ.get("OMD_SCCACHE"):
        env["RUSTC_WRAPPER"] = "sccache"
    target = run("rustc", "-vV").decode().split("host: ", 1)[1].splitlines()[0]
    env.setdefault("RUSTY_V8_ARCHIVE", str(V8 / f"librusty_v8_ptrcomp_sandbox_release_{target}.a.gz"))
    env.setdefault("RUSTY_V8_SRC_BINDING_PATH", str(V8 / f"src_binding_ptrcomp_sandbox_release_{target}.rs"))
    return env


def test_runner(work, cargo_args, env, output):
    """Mod hosts start the runner beside their executable; test binaries run from the target's deps directory."""
    if not cargo_args or cargo_args[0] not in ("test", "nextest"):
        return 0
    release = "--release" in cargo_args or "-r" in cargo_args
    profile = "release" if release else "debug"
    flags = ["--locked"] * ("--locked" in cargo_args) + ["--release"] * release
    scope = [arg for index, arg in enumerate(cargo_args) if arg == "-p" or cargo_args[index - 1] == "-p"]
    if "codex-omd-runner" not in scope:
        scope += ["-p", "codex-omd-runner"]
    status = subprocess.run(["cargo", "build", *flags, *scope, "--bin", "omd-runner"], cwd=work / "codex/codex-rs", env=env,
                            stdout=output, stderr=subprocess.STDOUT).returncode
    link = work / "target" / profile / "deps/omd-runner"
    if status == 0 and not link.exists():
        link.parent.mkdir(parents=True, exist_ok=True)
        link.unlink(missing_ok=True)
        link.symlink_to("../omd-runner")
    return status


def cargo_run(work, log, cargo_args):
    log = Path(log)
    log.parent.mkdir(parents=True, exist_ok=True)
    with log.open("w") as output:
        env = cargo_env(work)
        status = test_runner(work, cargo_args, env, output) or subprocess.run(
            ["cargo", *cargo_args], cwd=work / "codex/codex-rs", env=env, stdout=output, stderr=subprocess.STDOUT).returncode
        output.write(f"exit={status}\n")
    text = log.read_text(errors="replace").splitlines()
    # A panic's assertion message follows on the next lines.
    lines = [line for index, line in enumerate(text)
             if SUMMARY.search(line) or any("panicked" in previous for previous in text[max(0, index - 3):index])]
    print("\n".join(lines[:40]))
    print(f"exit={status} log={log}")
    return status


def v8(args):
    if os.environ.get("V8_FROM_SOURCE") or os.environ.get("RUSTY_V8_ARCHIVE"):
        return
    checkout = work_dir(args.name) / "codex"
    lock = tomllib.loads((checkout / "codex-rs/Cargo.lock").read_text())
    (version,) = {package["version"] for package in lock["package"] if package["name"] == "v8"}
    target = run("rustc", "-vV", cwd=checkout / "codex-rs").decode().split("host: ", 1)[1].split()[0]
    url = f"https://github.com/openai/codex/releases/download/rusty-v8-v{version}"
    manifest = f"rusty_v8_ptrcomp_sandbox_release_{target}.sha256"
    names = (f"librusty_v8_ptrcomp_sandbox_release_{target}.a.gz", f"src_binding_ptrcomp_sandbox_release_{target}.rs")
    V8.mkdir(parents=True, exist_ok=True)

    def checksums(path):
        return dict(reversed(line.split()) for line in path.read_text().splitlines() if line.strip())

    def download(name):
        for delay in (5, 15, 45, None):
            try:
                with urllib.request.urlopen(f"{url}/{name}", timeout=120) as response:
                    return response.read()
            except (OSError, http.client.HTTPException) as error:
                if delay is None or (isinstance(error, urllib.error.HTTPError) and error.code < 500):
                    raise
                print(f"V8 download of {name} failed ({error}); retrying in {delay} s", file=sys.stderr)
                time.sleep(delay)

    expected = checksums(checkout / f"third_party/v8/rusty_v8_{version.replace('.', '_')}_release_manifests.sha256")
    for name in (manifest, *names):
        cached = V8 / name
        if not (cached.is_file() and expected.get(name) == sha(cached.read_bytes())):
            data = download(name)
            if expected.get(name) != sha(data):
                raise SystemExit(f"V8 prebuilt checksum mismatch: {name}")
            cached.write_bytes(data)
        if name == manifest:
            expected = checksums(V8 / manifest)


def cargo(args):
    raise SystemExit(cargo_run(work_dir(args.name), args.log, args.cargo_args))


def check(args):
    work = work_dir(args.name)
    raise SystemExit(cargo_run(work, work / "logs/check.log", CHECK))


def tracked(tree, *paths):
    return {name for name in git(tree, "ls-files", "--cached", "--others", "--exclude-standard", "--",
                                 *paths).decode().splitlines() if (tree / name).is_file()}


def skipped(relative):
    return any(part in ("target", "examples") for part in relative.parts) or relative.name in ("Cargo.lock", ".DS_Store")


def sync(args):
    work = work_dir(args.name)
    source = work / "codex"
    base = base_tag()
    patch = git(source, "diff", "--binary", "--full-index", "--no-renames", base, "--", "codex-rs")
    changed = set(git(source, "diff", "--name-only", "--no-renames", base, "--", "codex-rs").decode().splitlines())
    for name in git(source, "ls-files", "--others", "--exclude-standard", "--", "codex-rs").decode().splitlines():
        patch += git(source, "diff", "--no-index", "--binary", "--full-index", "--", "/dev/null", name, allowed=(0, 1))
        changed.add(name)
    # Git accepts an empty patch context line; omit its otherwise trailing marker space.
    patch = b"".join(b"\n" if line == b" \n" else line for line in patch.splitlines(keepends=True))
    manifest_path = ROOT / "runtime/patches/manifest.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["files"] = {}
    for name in sorted(changed):
        prior = subprocess.run(["git", "show", f"{base}:{name}"], cwd=source, capture_output=True)
        current = source / name
        manifest["files"][name] = {"before": sha(prior.stdout) if prior.returncode == 0 else None,
                                   "after": sha(current.read_bytes()) if current.is_file() else None}
    (ROOT / manifest["patch"]["path"]).write_bytes(patch)
    manifest["patch"]["sha256"] = sha(patch)
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    mirrors = 0
    for src, dst in MIRRORS:
        names = git(source, "ls-files", "--cached", "--others", "--exclude-standard", "--", src).decode().splitlines()
        mirrored = {Path(name).relative_to(src) for name in names}
        for stale in sorted((ROOT / dst).rglob("*")):
            relative = stale.relative_to(ROOT / dst)
            if (stale.is_file() and relative not in mirrored and not skipped(relative)
                    and relative != Path("src/request_observer.rs")):
                stale.unlink()
                mirrors += 1
        for name in names:
            relative = Path(name).relative_to(src)
            if skipped(relative):
                continue
            target = ROOT / dst / relative
            if (source / name).is_file():
                data = (source / name).read_bytes()
                if not target.exists() or target.read_bytes() != data:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(data)
                    mirrors += 1
            elif target.exists():
                target.unlink()
                mirrors += 1
    shutil.copyfile(source / OBSERVER, ROOT / "runtime/native/src/request_observer.rs")
    run(sys.executable, ROOT / "scripts/crate_notices.py", source, cwd=ROOT)
    checks = {}
    with tempfile.TemporaryDirectory(dir=work, prefix="replay-") as temporary:
        replay = Path(temporary) / "codex"
        run("git", "clone", "--quiet", "--shared", "--no-checkout", source, replay)
        git(replay, "checkout", "--quiet", "--detach", pin()["commit"])
        for label, script in (("normalize", "normalize_upstream_lock.py"), ("first_apply", "apply_runtime_patch.py"),
                              ("second_apply", "apply_runtime_patch.py")):
            checks[label] = run(sys.executable, ROOT / "scripts" / script, replay, cwd=ROOT).decode().strip()
        names = tracked(source, "codex-rs")
        if names != tracked(replay, "codex-rs"):
            raise SystemExit("replayed file inventory differs")
        for name in sorted(names):
            if (source / name).read_bytes() != (replay / name).read_bytes():
                raise SystemExit(f"replayed file differs: {name}")
    report = {"patch_sha256": sha(patch), "patch_bytes": len(patch), "patch_files": len(changed),
              "mirrors_updated": mirrors, **checks, "tree_parity": True, "files_compared": len(names)}
    print(json.dumps(report))


def pack_sdk(output):
    with tempfile.TemporaryDirectory() as packed:
        run("pnpm", "pack", "--pack-destination", packed, cwd=ROOT / "mods")
        shutil.move(next(Path(packed).glob("*.tgz")), output / "mod-api.tgz")


def artifacts(args):
    work = work_dir(args.name)
    sys.path.insert(0, str(ROOT))
    from scripts import build_provenance, release_lock
    built = work / "target/release"
    output = work / "artifacts"
    log = work / "logs/build-artifacts.log"
    tree, environment = work / "codex", cargo_env(work)
    before = build_provenance.inputs(tree, BUILD, environment)
    (built / build_provenance.RECORD).unlink(missing_ok=True)
    if cargo_run(work, log, BUILD):
        raise SystemExit(1)
    build_provenance.record_build(built, before, build_provenance.inputs(tree, BUILD, environment))
    unsigned = build_provenance.verify(built, signed=False, expected_inputs=before)
    shutil.rmtree(output, ignore_errors=True)
    output.mkdir()
    for name in build_provenance.BINARIES:
        shutil.copy2(built / name, output / name)
    if build_provenance.hashes(output) != unsigned["unsigned"]:
        raise SystemExit("release artifacts changed during copying")
    for name in release_lock.HARDENED:
        release_lock.sign(output / name)
    build_provenance.record_signing(output, unsigned)
    pack_sdk(output)
    print(output)


def locks(args):
    outputs = list(ROOT.glob("runtime/*.lock.json"))
    before = {path: sha(path.read_bytes()) for path in outputs if path.is_file()}
    failed = False
    for script in GENERATORS:
        result = subprocess.run([sys.executable, "-m", f"scripts.{script}", "--write"], cwd=ROOT, capture_output=True, text=True)
        failed |= result.returncode != 0
        print(f"{script}: {((result.stdout + result.stderr).strip().splitlines() or ['ok'])[-1]}")
    changed = [str(path.relative_to(ROOT)) for path in outputs if path.is_file() and before.get(path) != sha(path.read_bytes())]
    print("changed: " + (", ".join(changed) or "none"))
    raise SystemExit(1 if failed else 0)


def main():
    parser = argparse.ArgumentParser(description="Hosted build tree for the pinned Codex runtime patch")
    commands = parser.add_subparsers(dest="command", required=True)
    command = commands.add_parser("setup", help="worktree at the pin, normalized and patched")
    command.add_argument("name")
    command.set_defaults(handler=setup)
    command = commands.add_parser("cargo", help="cargo in the scratch tree; full log to a file, summary to stdout")
    command.add_argument("name")
    command.add_argument("log", help="log file path")
    command.add_argument("cargo_args", nargs=argparse.REMAINDER)
    command.set_defaults(handler=cargo)
    command = commands.add_parser("check", help="cargo check --tests of the crates a pull request compiles")
    command.add_argument("name")
    command.set_defaults(handler=check)
    command = commands.add_parser("v8", help="download and verify the V8 prebuilt that codex-cli builds link")
    command.add_argument("name")
    command.set_defaults(handler=v8)
    command = commands.add_parser("sync", help="regenerate patch, manifest, pin hash and runtime mirrors; verify replay")
    command.add_argument("name")
    command.set_defaults(handler=sync)
    command = commands.add_parser("artifacts", help="build, copy, sign and pack release lock inputs")
    command.add_argument("name")
    command.set_defaults(handler=artifacts)
    command = commands.add_parser("locks", help="rewrite every generated source lock and document in dependency order")
    command.set_defaults(handler=locks)
    args = parser.parse_args()
    args.handler(args)


if __name__ == "__main__":
    main()
