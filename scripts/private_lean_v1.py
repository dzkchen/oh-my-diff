#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
from datetime import datetime, timezone


ROOT = Path(__file__).resolve().parents[1]
SCHEMA = 1
PRODUCT = "oh-my-diff-private-lean-v1"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(arguments, cwd=None, env=None, capture=True):
    streams = {"stdout": subprocess.PIPE, "stderr": subprocess.PIPE} if capture else {}
    result = subprocess.run(arguments, cwd=cwd, env=env, text=True, **streams)
    if result.returncode:
        detail = ((result.stderr or result.stdout)[-12000:] if capture else "").rstrip()
        raise RuntimeError(f"command failed ({result.returncode}): {shlex.join(arguments)}\n{detail}")
    return result


def output(arguments, cwd=None, env=None):
    return run(arguments, cwd=cwd, env=env).stdout.strip()


def resolved(path):
    return Path(path).expanduser().resolve()


def within(path, parent):
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def state_roots():
    home = resolved(os.environ.get("CODEX_HOME", Path.home() / ".codex"))
    sqlite = resolved(os.environ.get("CODEX_SQLITE_HOME", home))
    return home, sqlite


def path_without(bin_dir):
    return os.pathsep.join(item for item in os.environ.get("PATH", "").split(os.pathsep)
                           if item and resolved(item) != bin_dir)


def validate_locations(prefix, bin_dir):
    prefix = resolved(prefix)
    bin_dir = resolved(bin_dir)
    if prefix == Path(prefix.anchor) or bin_dir == Path(bin_dir.anchor):
        raise ValueError("installation paths must not be filesystem roots")
    for state in set(state_roots()):
        if within(prefix, state) or within(bin_dir, state):
            raise ValueError("installation paths must not be inside shared Codex state")
        if within(state, prefix):
            raise ValueError("installation prefix must not contain shared Codex state")
    if within(bin_dir, prefix):
        raise ValueError("bin directory must be outside the removable installation prefix")
    return prefix, bin_dir


def lock_inputs():
    upstream = json.loads((ROOT / "upstream.lock.json").read_text())
    lean = json.loads((ROOT / "runtime/lean-v1.lock.json").read_text())
    patch = ROOT / lean["runtime_patch"]["path"]
    if digest(patch) != lean["runtime_patch"]["sha256"]:
        raise ValueError("frozen runtime patch hash mismatch")
    if lean["upstream"]["commit"] != upstream["commit"]:
        raise ValueError("lean-v1 and upstream locks disagree")
    return upstream, lean


def binary_identity(path):
    path = resolved(path)
    if not path.is_file() or not os.access(path, os.X_OK):
        raise ValueError(f"not an executable file: {path}")
    version = output([str(path), "--version"])
    return {"path": str(path), "sha256": digest(path), "version": version}


def atomic_text(path, text, mode=0o644):
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def write_manifest(prefix, manifest):
    atomic_text(prefix / "install.json", json.dumps(manifest, indent=2, sort_keys=True) + "\n")


def load_manifest(prefix):
    prefix = resolved(prefix)
    path = prefix / "install.json"
    if not path.is_file():
        raise ValueError(f"no managed private lean-v1 installation at {prefix}")
    manifest = json.loads(path.read_text())
    if manifest.get("schema") != SCHEMA or manifest.get("product") != PRODUCT:
        raise ValueError("refusing an unrecognized installation manifest")
    if resolved(manifest["prefix"]) != prefix:
        raise ValueError("installation manifest prefix mismatch")
    return manifest


def wrapper_text(binary, selection, mode=None, controlled_manifest=None):
    lines = ["#!/bin/sh"]
    if selection == "omd":
        lines.append(f"export OMD_MODE={shlex.quote(mode)}")
        if controlled_manifest:
            lines.append(f"export OMD_CONTROLLED_MANIFEST={shlex.quote(str(controlled_manifest))}")
        else:
            lines.append("unset OMD_CONTROLLED_MANIFEST")
    else:
        lines.extend(["unset OMD_MODE", "unset OMD_CONTROLLED_MANIFEST"])
    lines.append(f"exec {shlex.quote(str(binary))} \"$@\"")
    return "\n".join(lines) + "\n"


def activate(prefix, bin_dir, selection, mode=None, controlled_manifest=None):
    prefix, bin_dir = validate_locations(prefix, bin_dir)
    manifest = load_manifest(prefix)
    if resolved(manifest["bin_dir"]) != bin_dir:
        raise ValueError("bin directory does not match the installed manifest")
    if selection == "omd":
        if mode not in ("upstream_direct", "enabled"):
            raise ValueError("OMD activation requires upstream_direct or enabled mode")
        if mode == "enabled":
            if controlled_manifest is None:
                raise ValueError("enabled mode requires --manifest")
            controlled_manifest = resolved(controlled_manifest)
            if not controlled_manifest.is_file():
                raise ValueError("controlled manifest is not a file")
        elif controlled_manifest is not None:
            raise ValueError("--manifest is only valid with enabled mode")
        binary = prefix / "artifacts/omd/codex"
    else:
        if mode is not None or controlled_manifest is not None:
            raise ValueError("upstream activation does not accept OMD settings")
        binary = prefix / "artifacts/upstream/codex"
    expected = manifest["artifacts"][selection]["sha256"]
    if digest(binary) != expected:
        raise ValueError(f"refusing to activate modified {selection} artifact")
    wrapper = bin_dir / "codex"
    current = manifest.get("activation")
    if wrapper.is_symlink() or (wrapper.exists()
                                and (not current or digest(wrapper) != current.get("wrapper_sha256"))):
        raise ValueError(f"refusing to replace unmanaged or modified launcher: {wrapper}")
    text = wrapper_text(binary, selection, mode, controlled_manifest)
    atomic_text(wrapper, text, 0o755)
    manifest["activation"] = {
        "selection": selection,
        "mode": mode,
        "controlled_manifest": str(controlled_manifest) if controlled_manifest else None,
        "wrapper": str(wrapper),
        "wrapper_sha256": digest(wrapper),
    }
    write_manifest(prefix, manifest)
    return manifest


def verify_platform():
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        raise ValueError("private lean-v1 installation is supported only on Apple Silicon macOS")


def clone_pinned(repository, checkout, commit):
    run(["git", "clone", "--no-checkout", str(repository), str(checkout)])
    run(["git", "checkout", "--detach", commit], cwd=checkout)
    if output(["git", "rev-parse", "HEAD"], cwd=checkout) != commit:
        raise ValueError("source checkout did not resolve to the pinned commit")


def install(args):
    verify_platform()
    prefix, bin_dir = validate_locations(args.prefix, args.bin_dir)
    if prefix.exists():
        raise ValueError(f"installation prefix already exists: {prefix}")
    wrapper = bin_dir / "codex"
    if wrapper.exists() or wrapper.is_symlink():
        raise ValueError(f"activation path already exists: {wrapper}")
    upstream_lock, lean_lock = lock_inputs()
    upstream = binary_identity(args.upstream)
    if upstream["version"] != "codex-cli 0.154.0":
        raise ValueError("supported upstream executable must report codex-cli 0.154.0")
    if within(resolved(upstream["path"]), prefix):
        raise ValueError("supported upstream executable must be outside the installation prefix")
    fallback = shutil.which("codex", path=path_without(bin_dir))
    if not fallback or resolved(fallback) != resolved(upstream["path"]):
        raise ValueError("supported upstream executable must resolve on PATH without the managed bin directory")
    if args.target_dir:
        target = resolved(args.target_dir)
        if target == Path(target.anchor):
            raise ValueError("build target must not be a filesystem root")
        for protected in (*state_roots(), prefix, bin_dir):
            if within(target, protected) or within(protected, target):
                raise ValueError("build target must be separate from state, install and launcher paths")
    toolchain = output(["rustc", f"+{upstream_lock['rust_toolchain']}", "--version"])
    parent = prefix.parent
    parent.mkdir(parents=True, exist_ok=True)
    staging = parent / f".{prefix.name}.staging"
    staging.mkdir(mode=0o700)
    moved = False
    try:
        checkout = staging / "source"
        clone_pinned(args.repository, checkout, upstream_lock["commit"])
        output([sys.executable, str(ROOT / "scripts/normalize_upstream_lock.py"), str(checkout)])
        output([sys.executable, str(ROOT / "scripts/apply_runtime_patch.py"), str(checkout)])
        cargo_target = resolved(args.target_dir) if args.target_dir else staging / "target"
        environment = os.environ.copy()
        environment["CARGO_TARGET_DIR"] = str(cargo_target)
        build = ["cargo", f"+{upstream_lock['rust_toolchain']}", "build", "--locked",
                 "--release", "-p", "codex-cli", "--bin", "codex"]
        run(build, cwd=checkout / "codex-rs", env=environment, capture=False)
        candidate_source = cargo_target / "release/codex"
        candidate = binary_identity(candidate_source)
        if candidate["version"] != upstream["version"]:
            raise ValueError("candidate and supported upstream versions differ")
        machine = output(["file", "-b", str(candidate_source)])
        if "arm64" not in machine:
            raise ValueError("candidate is not an arm64 executable")
        for name, source in (("upstream", Path(upstream["path"])), ("omd", candidate_source)):
            destination = staging / f"artifacts/{name}/codex"
            destination.parent.mkdir(parents=True)
            shutil.copy2(source, destination)
            destination.chmod(destination.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        if not args.target_dir:
            shutil.rmtree(cargo_target)
        home, sqlite = state_roots()
        manifest = {
            "schema": SCHEMA,
            "product": PRODUCT,
            "installed_at": datetime.now(timezone.utc).isoformat(),
            "prefix": str(prefix),
            "bin_dir": str(bin_dir),
            "host": {"system": platform.system(), "machine": platform.machine()},
            "shared_state": {"codex_home": str(home), "codex_sqlite_home": str(sqlite),
                             "policy": "inherited unchanged; never removed by uninstall"},
            "inputs": {
                "repository": str(args.repository),
                "commit": upstream_lock["commit"],
                "tag": upstream_lock["tag"],
                "rust_toolchain": upstream_lock["rust_toolchain"],
                "rustc": toolchain,
                "normalized_cargo_lock_sha256": upstream_lock["normalized_cargo_lock_sha256"],
                "runtime_patch_sha256": lean_lock["runtime_patch"]["sha256"],
                "build": build,
            },
            "artifacts": {
                "upstream": {**upstream, "installed_path": str(staging / "artifacts/upstream/codex")},
                "omd": {**candidate, "installed_path": str(staging / "artifacts/omd/codex")},
            },
            "activation": None,
            "linux_benchmark": {"retained": True, "runtime_install_target": False,
                                "guide": "benchmarks/README.md"},
        }
        for artifact in manifest["artifacts"].values():
            artifact["installed_path"] = artifact["installed_path"].replace(str(staging), str(prefix), 1)
        write_manifest(staging, manifest)
        staging.rename(prefix)
        moved = True
        activate(prefix, bin_dir, "omd", "upstream_direct")
        return load_manifest(prefix)
    except BaseException:
        if staging.exists():
            shutil.rmtree(staging)
        if moved and prefix.exists():
            activation = json.loads((prefix / "install.json").read_text()).get("activation")
            wrapper = bin_dir / "codex"
            expected_wrapper = hashlib.sha256(wrapper_text(
                prefix / "artifacts/omd/codex", "omd", "upstream_direct").encode()).hexdigest()
            recorded_wrapper = activation.get("wrapper_sha256") if activation else expected_wrapper
            if not wrapper.is_symlink() and wrapper.is_file() and digest(wrapper) == recorded_wrapper:
                wrapper.unlink()
            shutil.rmtree(prefix)
        raise


def status(prefix, bin_dir):
    prefix, bin_dir = validate_locations(prefix, bin_dir)
    manifest = load_manifest(prefix)
    if resolved(manifest["bin_dir"]) != bin_dir:
        raise ValueError("bin directory does not match the installed manifest")
    activation = manifest.get("activation")
    wrapper = bin_dir / "codex"
    if (not activation or wrapper.is_symlink() or not wrapper.is_file()
            or digest(wrapper) != activation["wrapper_sha256"]):
        raise ValueError("managed launcher is absent or modified")
    selected = activation["selection"]
    artifact = prefix / f"artifacts/{selected}/codex"
    if digest(artifact) != manifest["artifacts"][selected]["sha256"]:
        raise ValueError("active artifact is modified")
    return manifest


def uninstall(prefix, bin_dir):
    prefix, bin_dir = validate_locations(prefix, bin_dir)
    manifest = status(prefix, bin_dir)
    upstream = manifest["artifacts"]["upstream"]
    original = binary_identity(upstream["path"])
    if original["sha256"] != upstream["sha256"] or original["version"] != upstream["version"]:
        raise ValueError("supported upstream executable changed; refusing automatic uninstall")
    located = shutil.which("codex", path=path_without(bin_dir))
    if not located or resolved(located) != resolved(upstream["path"]):
        raise ValueError("supported upstream executable would not be restored on PATH")
    wrapper = bin_dir / "codex"
    wrapper.unlink()
    shutil.rmtree(prefix)
    return {"uninstalled": True, "upstream": upstream["path"], "upstream_restore": "resolved",
            "shared_state": manifest["shared_state"]}


def parser():
    result = argparse.ArgumentParser(description="Build and manage the private Apple Silicon lean-v1 installation")
    result.add_argument("--prefix", type=Path, required=True)
    result.add_argument("--bin-dir", type=Path, required=True)
    commands = result.add_subparsers(dest="command", required=True)
    install_parser = commands.add_parser("install")
    install_parser.add_argument("--upstream", type=Path, required=True)
    install_parser.add_argument("--repository", default="https://github.com/openai/codex.git")
    install_parser.add_argument("--target-dir", type=Path)
    activate_parser = commands.add_parser("activate")
    activate_parser.add_argument("selection", choices=("omd", "upstream"))
    activate_parser.add_argument("--mode", choices=("upstream_direct", "enabled"))
    activate_parser.add_argument("--manifest", type=Path)
    commands.add_parser("status")
    commands.add_parser("uninstall")
    return result


def main():
    args = parser().parse_args()
    prefix, bin_dir = validate_locations(args.prefix, args.bin_dir)
    if args.command == "install":
        result = install(args)
    elif args.command == "activate":
        result = activate(prefix, bin_dir, args.selection, args.mode, args.manifest)
    elif args.command == "status":
        result = status(prefix, bin_dir)
    else:
        result = uninstall(prefix, bin_dir)
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, ValueError) as error:
        raise SystemExit(str(error)) from error
