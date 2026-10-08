#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
TMP = Path(os.environ.get("OMD_BATCH_ROOT", "/private/tmp"))
SCRATCH = Path(os.environ.get("OMD_SCRATCH_REPO", TMP / "omd-cache/codex"))
V8 = Path(os.environ.get("OMD_V8_DIR", TMP / "omd-cache/v8"))
WARM = Path(os.environ.get("OMD_WARM_TARGET", TMP / "omd-cache/warm-target"))
MIN_FREE_GIB = 100
PROFILES = ("debug", "release")
BINARIES = ("codex", "codex-code-mode-host", "omd-mod", "omd", "omd-contract", "omd-broker")
BUILD = ["build", "--locked", "-p", "codex-cli", "--bin", "codex", "-p", "codex-code-mode-host", "-p", "codex-omd", "--bins"]
SUMMARY = re.compile(r"^test result|^error|FAILED|panicked|^warning: unused")
MIRRORS = (("codex-rs/omd", "runtime/omd"), ("codex-rs/ext/omd", "runtime/native"))
OBSERVER = "codex-rs/codex-api/src/request_observer.rs"
GENERATED = ("mods/COVERAGE.md", "mods/EXTENSION_TYPES.md", "INTEGRATION.md")
GENERATORS = ("plugin_lock.py", "preview_lock.py", "full_mods_lock.py", "mod_conformance.py", "mod_extension_types.py",
              "integration_matrix.py")


def pin():
    return json.loads((ROOT / "upstream.lock.json").read_text())


def base_tag():
    return "normalized" + pin()["tag"].removeprefix("rust-v").replace(".", "").lstrip("0")


def batch_dir(batch):
    name = batch.lower().removeprefix("batch").strip().removeprefix("omd-").removeprefix("b")
    return TMP / f"omd-b{name}"


def run(*args, cwd=None, allowed=(0,)):
    result = subprocess.run([str(arg) for arg in args], cwd=cwd, capture_output=True)
    if result.returncode not in allowed:
        raise SystemExit(f"{' '.join(map(str, args))} failed:\n{result.stderr.decode()}")
    return result.stdout


def git(tree, *args, allowed=(0,)):
    return run("git", *args, cwd=tree, allowed=allowed)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def free_gib():
    stats = os.statvfs(TMP)
    return stats.f_bavail * stats.f_frsize / 2**30


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
    batch = batch_dir(args.batch)
    tree = batch / "codex"
    if not tree.exists():
        if free_gib() < MIN_FREE_GIB and not args.force:
            raise SystemExit(f"only {free_gib():.0f} GiB free; free space or pass --force")
        commit = scratch_repo()
        batch.mkdir(parents=True, exist_ok=True)
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
    target = batch / "target"
    if not target.exists() and not args.cold:
        for profile in PROFILES:
            if (WARM / profile).is_dir():
                target.mkdir(exist_ok=True)
                run("cp", "-cR", WARM / profile, target / profile)
                for pattern in ("codex-*", "v8-*"):
                    for stale in (target / profile / ".fingerprint").glob(pattern):
                        shutil.rmtree(stale)
    if not V8.is_dir():
        print(f"missing {V8}: download the rusty-v8 assets from the openai/codex rusty-v8 release before building")
    print(json.dumps({"tree": str(tree), "target": str(target), "warm": target.exists(),
                      "free_gib": round(free_gib())}))


def cargo_env(batch):
    env = {key: value for key, value in os.environ.items()
           if key not in ("CODEX_SQLITE_HOME", "FORCE_COLOR", "COLORTERM", "NO_COLOR")}
    env.update({
        "CARGO_TARGET_DIR": str(batch / "target"),
        "CARGO_INCREMENTAL": os.environ.get("CARGO_INCREMENTAL", "1"),
        "CARGO_PROFILE_DEV_DEBUG": os.environ.get("CARGO_PROFILE_DEV_DEBUG", "0"),
        "CARGO_PROFILE_RELEASE_LTO": os.environ.get("CARGO_PROFILE_RELEASE_LTO", "off"),
        "CARGO_PROFILE_RELEASE_CODEGEN_UNITS": os.environ.get("CARGO_PROFILE_RELEASE_CODEGEN_UNITS", "16"),
        "CARGO_PROFILE_RELEASE_DEBUG": os.environ.get("CARGO_PROFILE_RELEASE_DEBUG", "0"),
        "OMD_TEST_NODE": run("mise", "which", "node", cwd=ROOT).decode().strip(),
        "RUST_MIN_STACK": "16777216",
    })
    target = run("rustc", "-vV").decode().split("host: ", 1)[1].splitlines()[0]
    env.setdefault("RUSTY_V8_ARCHIVE", str(V8 / f"librusty_v8_ptrcomp_sandbox_release_{target}.a.gz"))
    env.setdefault("RUSTY_V8_SRC_BINDING_PATH", str(V8 / f"src_binding_ptrcomp_sandbox_release_{target}.rs"))
    return env


def cargo_run(batch, log, cargo_args):
    log = Path(log) if Path(log).is_absolute() else batch / "logs" / f"{log}.log"
    log.parent.mkdir(parents=True, exist_ok=True)
    with log.open("w") as output:
        status = subprocess.run(["cargo", *cargo_args], cwd=batch / "codex/codex-rs", env=cargo_env(batch),
                                stdout=output, stderr=subprocess.STDOUT).returncode
        output.write(f"exit={status}\n")
    lines = [line for line in log.read_text(errors="replace").splitlines() if SUMMARY.search(line)]
    print("\n".join(lines[:30]))
    print(f"exit={status} log={log}")
    return status


def cargo(args):
    raise SystemExit(cargo_run(batch_dir(args.batch), args.log, args.cargo_args))


def tracked(tree, *paths):
    return {name for name in git(tree, "ls-files", "--cached", "--others", "--exclude-standard", "--",
                                 *paths).decode().splitlines() if (tree / name).is_file()}


def skipped(relative):
    return any(part in ("target", "examples") for part in relative.parts) or relative.name in ("Cargo.lock", ".DS_Store")


def sync(args):
    batch = batch_dir(args.batch)
    source = batch / "codex"
    base = base_tag()
    patch = git(source, "diff", "--binary", "--no-renames", base, "--", "codex-rs")
    changed = set(git(source, "diff", "--name-only", "--no-renames", base, "--", "codex-rs").decode().splitlines())
    for name in git(source, "ls-files", "--others", "--exclude-standard", "--", "codex-rs").decode().splitlines():
        patch += git(source, "diff", "--no-index", "--binary", "--", "/dev/null", name, allowed=(0, 1))
        changed.add(name)
    # Git accepts an empty patch context line; omit its otherwise trailing marker space.
    patch = b"".join(b"\n" if line == b" \n" else line for line in patch.splitlines(keepends=True))
    manifest_path = ROOT / "runtime/patches/manifest.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["baseline"] = "Run scripts/normalize_upstream_lock.py before applying the runtime patch."
    manifest["files"] = {}
    for name in sorted(changed):
        prior = subprocess.run(["git", "show", f"{base}:{name}"], cwd=source, capture_output=True)
        current = source / name
        manifest["files"][name] = {"before": sha(prior.stdout) if prior.returncode == 0 else None,
                                   "after": sha(current.read_bytes()) if current.is_file() else None}
    (ROOT / manifest["patch"]["path"]).write_bytes(patch)
    manifest["patch"]["sha256"] = sha(patch)
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    lock_path = ROOT / "upstream.lock.json"
    lock = json.loads(lock_path.read_text())
    lock["runtime_patches"] = [{"path": manifest["patch"]["path"], "sha256": sha(patch)}]
    lock_path.write_text(json.dumps(lock, indent=2) + "\n")
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
    checks = {}
    with tempfile.TemporaryDirectory(dir=batch, prefix="replay-") as temporary:
        replay = Path(temporary) / "codex"
        run("git", "clone", "--quiet", "--shared", "--no-checkout", source, replay)
        git(replay, "checkout", "--quiet", "--detach", manifest["upstream_commit"])
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
    if args.evidence:
        args.evidence.mkdir(parents=True, exist_ok=True)
        (args.evidence / "replay.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report))


def pack_sdk(output):
    with tempfile.TemporaryDirectory() as packed:
        run("pnpm", "pack", "--pack-destination", packed, cwd=ROOT / "mods")
        shutil.move(next(Path(packed).glob("*.tgz")), output / "mod-api.tgz")


def artifacts(args):
    batch = batch_dir(args.batch)
    profile = args.profile
    if args.build and cargo_run(batch, "build-artifacts", BUILD + (["--release"] if profile == "release" else [])):
        raise SystemExit(1)
    sys.path.insert(0, str(ROOT))
    from scripts import lean_release_lock
    built = batch / "target" / profile
    output = batch / "artifacts"
    missing = [name for name in BINARIES if not (built / name).is_file()]
    if missing:
        raise SystemExit(f"missing {', '.join(missing)} in {built}; rerun with --build")
    shutil.rmtree(output, ignore_errors=True)
    output.mkdir()
    for name in BINARIES:
        shutil.copy2(built / name, output / name)
    if sys.platform == "darwin":
        for name in lean_release_lock.HARDENED:
            lean_release_lock.sign(output / name)
    pack_sdk(output)
    print(output)


def locks(args):
    outputs = [*ROOT.glob("runtime/*.lock.json"), *(ROOT / name for name in GENERATED)]
    before = {path: sha(path.read_bytes()) for path in outputs if path.is_file()}
    steps = [[script, "--write"] for script in GENERATORS]
    output = batch_dir(args.batch) / "artifacts" if args.batch else None
    if output and output.is_dir():
        steps.append(["lean_release_lock.py", "--artifact-dir", output, "--write"])
    else:
        print("lean_release_lock.py: skipped; pass a batch with artifacts (batch_tree.py artifacts)")
    failed = False
    for script, *options in steps:
        if script == "lean_release_lock.py":
            pack_sdk(output)
        result = subprocess.run([sys.executable, ROOT / "scripts" / script, *map(str, options)], cwd=ROOT,
                                capture_output=True, text=True)
        failed |= result.returncode != 0
        print(f"{script}: {((result.stdout + result.stderr).strip().splitlines() or ['ok'])[-1]}")
    changed = [str(path.relative_to(ROOT)) for path in outputs if path.is_file() and before.get(path) != sha(path.read_bytes())]
    print("changed: " + (", ".join(changed) or "none"))
    raise SystemExit(1 if failed else 0)


def prune_workspace_artifacts(debug):
    for path in [*debug.glob("deps/codex*"), *debug.glob("deps/libcodex*"), *debug.glob(".fingerprint/codex-*"),
                 *debug.glob("build/codex-*"), debug / "incremental"]:
        if path.is_dir() and not path.is_symlink():
            shutil.rmtree(path)
        else:
            path.unlink(missing_ok=True)


def clean(args):
    batch = batch_dir(args.batch)
    target = batch / "target"
    if target.is_dir():
        if args.keep_warm:
            WARM.mkdir(parents=True, exist_ok=True)
            for profile in PROFILES:
                if (target / profile).is_dir():
                    shutil.rmtree(WARM / profile, ignore_errors=True)
                    (target / profile).rename(WARM / profile)
                    prune_workspace_artifacts(WARM / profile)
            print(f"moved {target} profiles to {WARM} without workspace crate artifacts; {du(WARM)}")
        shutil.rmtree(target)
        print(f"removed {target}")
    if args.tree and (batch / "codex").exists():
        git(SCRATCH, "worktree", "remove", "--force", batch / "codex")
        print(f"removed worktree {batch / 'codex'}")


def du(path):
    return run("du", "-sh", path, allowed=(0, 1)).decode().split()[0] if path.exists() else "-"


def status(args):
    print(f"free {free_gib():.0f} GiB; warm target {du(WARM)}; v8 {'ok' if V8.is_dir() else 'missing'}")
    for tree in git(SCRATCH, "worktree", "list", "--porcelain").decode().splitlines():
        if tree.startswith("worktree ") and Path(tree[9:]) != SCRATCH:
            batch = Path(tree[9:]).parent
            print(f"{batch.name}: tree {Path(tree[9:]).name}, target {du(batch / 'target')}")


def main():
    parser = argparse.ArgumentParser(description="Per-batch scratch tree for the pinned Codex runtime patch")
    commands = parser.add_subparsers(dest="command", required=True)
    command = commands.add_parser("setup", help="worktree at the pin, normalized and patched, with a warm target")
    command.add_argument("batch")
    command.add_argument("--cold", action="store_true", help="skip cloning the warm target")
    command.add_argument("--force", action="store_true", help=f"allow setup under {MIN_FREE_GIB} GiB free")
    command.set_defaults(handler=setup)
    command = commands.add_parser("cargo", help="cargo in the batch tree; full log to a file, summary to stdout")
    command.add_argument("batch")
    command.add_argument("log", help="log name under <batch>/logs or an absolute path")
    command.add_argument("cargo_args", nargs=argparse.REMAINDER)
    command.set_defaults(handler=cargo)
    command = commands.add_parser("sync", help="regenerate patch, manifest, pin hash and runtime mirrors; verify replay")
    command.add_argument("batch")
    command.add_argument("--evidence", type=Path, help="directory for replay.json")
    command.set_defaults(handler=sync)
    command = commands.add_parser("artifacts", help="copy, sign and pack lean-release lock inputs")
    command.add_argument("batch")
    command.add_argument("--build", action="store_true", help="build the selected binaries first")
    command.add_argument("--profile", choices=PROFILES, default="debug")
    command.set_defaults(handler=artifacts)
    command = commands.add_parser("locks", help="rewrite every generated lock and document in dependency order")
    command.add_argument("batch", nargs="?", help="batch whose artifacts feed the lean-release lock")
    command.set_defaults(handler=locks)
    command = commands.add_parser("clean", help="delete the batch target (source tree and evidence stay)")
    command.add_argument("batch")
    command.add_argument("--keep-warm", action="store_true", help=f"move the target's debug and release profiles to {WARM} for the next batch")
    command.add_argument("--tree", action="store_true", help="also remove the scratch worktree")
    command.set_defaults(handler=clean)
    command = commands.add_parser("status", help="free space, warm target and batch trees")
    command.set_defaults(handler=status)
    args = parser.parse_args()
    args.handler(args)


if __name__ == "__main__":
    main()
