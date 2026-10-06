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
import tarfile
import tempfile
import urllib.request
from datetime import datetime, timezone


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "browser"
BRIDGE_SOURCE = ROOT / "bridge"
LOCK_PATH = SOURCE / "browser.lock.json"
PRODUCT = "oh-my-diff-browser-bundle"
SCHEMA = 1
BRIDGE_GENERATED_NAMES = {"__pycache__", "target", "out", "connection.json", ".DS_Store"}


def digest(path):
    value = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


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


def validate_destination(destination):
    destination = resolved(destination)
    if destination == Path(destination.anchor):
        raise ValueError("browser bundle destination must not be a filesystem root")
    return destination


def load_lock():
    lock = json.loads(LOCK_PATH.read_text())
    package = json.loads((SOURCE / "package.json").read_text())
    if lock.get("schema") != SCHEMA:
        raise ValueError("unsupported browser lock schema")
    if package["dependencies"][lock["mcp"]["package"]] != lock["mcp"]["version"]:
        raise ValueError("browser package and lock disagree")
    lock_hash = digest(SOURCE / "pnpm-lock.yaml")
    return lock, lock_hash


def download(url, destination):
    request = urllib.request.Request(url, headers={"User-Agent": "oh-my-diff-browser-installer"})
    with urllib.request.urlopen(request, timeout=60) as response, destination.open("wb") as stream:
        shutil.copyfileobj(response, stream)


def safe_extract(archive, destination):
    destination = resolved(destination)
    with tarfile.open(archive, "r:*") as source:
        for member in source.getmembers():
            if not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
                raise ValueError("browser archive contains an unsupported entry type")
            member_path = destination / member.name
            if not member.name or Path(member.name).is_absolute():
                raise ValueError("browser archive contains an absolute or empty path")
            try:
                member_path.resolve().relative_to(destination)
            except ValueError as error:
                raise ValueError("browser archive escapes its destination") from error
            if member.issym() or member.islnk():
                target = (member_path.parent / member.linkname).resolve()
                try:
                    target.relative_to(destination)
                except ValueError as error:
                    raise ValueError("browser archive link escapes its destination") from error
        source.extractall(destination)


def tree_identity(root):
    value = hashlib.sha256()
    size = 0
    files = 0
    for path in sorted(root.rglob("*"), key=lambda item: item.relative_to(root).as_posix()):
        relative = path.relative_to(root).as_posix()
        if relative == "bundle.json" or relative == "artifacts" or relative.startswith("artifacts/"):
            continue
        if path.is_symlink():
            kind = "link"
            body = os.readlink(path).encode()
            length = len(body)
        elif path.is_file():
            kind = "file"
            body = None
            length = path.stat().st_size
            size += length
            files += 1
        elif path.is_dir():
            kind = "dir"
            body = b""
            length = 0
        else:
            raise ValueError(f"unsupported browser bundle entry: {relative}")
        mode = stat.S_IMODE(path.lstat().st_mode)
        value.update(f"{kind}\0{relative}\0{mode:o}\0{length}\0".encode())
        if body is None:
            with path.open("rb") as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    value.update(chunk)
        else:
            value.update(body)
    return {"sha256": value.hexdigest(), "files": files, "bytes": size}


def write_json(path, value):
    directory = path.parent.parent if path.name == "bundle.json" else path.parent
    with tempfile.NamedTemporaryFile(mode="w", dir=directory, delete=False) as stream:
        temporary = Path(stream.name)
        try:
            stream.write(json.dumps(value, indent=2, sort_keys=True) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)


def browser_metadata(package_dir, lock):
    script = (
        "const fs=require('fs'),path=require('path');"
        "const m=require.resolve('@playwright/mcp/package.json');"
        "const c=require.resolve('playwright-core/package.json',{paths:[path.dirname(m)]});"
        "const p=path.join(path.dirname(c),'browsers.json');"
        "const b=JSON.parse(fs.readFileSync(p)).browsers.find(x=>x.name==='chromium');"
        "process.stdout.write(JSON.stringify(b));"
    )
    node = package_dir.parent / "runtime/bin/node"
    metadata = json.loads(output([str(node), "-e", script], cwd=package_dir))
    expected = lock["browser"]
    if metadata["revision"] != expected["revision"] or metadata["browserVersion"] != expected["browser_version"]:
        raise ValueError("installed Playwright Chromium revision differs from the browser lock")
    return metadata


def launcher_text(lock):
    revision = lock["browser"]["revision"]
    executable = f"$bundle_dir/browsers/chromium_headless_shell-{revision}/chrome-headless-shell-mac-arm64/chrome-headless-shell"
    return f"""#!/bin/sh
set -eu
bundle_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
artifacts_dir=${{OMD_BROWSER_ARTIFACTS_DIR:-"$bundle_dir/artifacts"}}
mkdir -p "$artifacts_dir"
cd "$artifacts_dir"
export PLAYWRIGHT_BROWSERS_PATH="$bundle_dir/browsers"
export PLAYWRIGHT_SKIP_BROWSER_GC=1
exec "$bundle_dir/runtime/bin/node" "$bundle_dir/package/node_modules/@playwright/mcp/cli.js" \\
  --headless \\
  --isolated \\
  --sandbox \\
  --executable-path="{executable}" \\
  --idle-timeout=60000 \\
  --console-level=debug \\
  --output-dir="$artifacts_dir" \\
  --output-max-size=20971520 \\
  "$@"
"""


def bridge_launcher_text():
    return """#!/bin/sh
set -eu
bundle_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec "$bundle_dir/runtime/bin/node" "$bundle_dir/bridge/host.mjs"
"""


def bridge_copy_ignore(_directory, names):
    return {name for name in names if name in BRIDGE_GENERATED_NAMES or name.endswith((".pyc", ".pyo"))}


def build_bundle(destination, node_archive=None):
    lock, pnpm_lock_sha256 = load_lock()
    destination = validate_destination(destination)
    if destination.exists():
        raise ValueError(f"browser bundle destination exists: {destination}")
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        raise ValueError("the pinned browser bundle is supported only on Apple Silicon macOS")
    parent = destination.parent
    parent.mkdir(parents=True, exist_ok=True)
    staging = parent / f".{destination.name}.staging"
    if staging.exists():
        raise ValueError(f"browser staging path exists: {staging}")
    staging.mkdir(mode=0o700)
    try:
        node = lock["node"]
        if node_archive is None:
            temporary = Path(tempfile.mkstemp(prefix="omd-node-", suffix=".tar.xz", dir=parent)[1])
            try:
                download(node["url"], temporary)
                archive = temporary
                if digest(archive) != node["sha256"]:
                    raise ValueError("downloaded Node archive hash mismatch")
                safe_extract(archive, staging / "node-extract")
            finally:
                temporary.unlink(missing_ok=True)
        else:
            archive = resolved(node_archive)
            if digest(archive) != node["sha256"]:
                raise ValueError("provided Node archive hash mismatch")
            safe_extract(archive, staging / "node-extract")
        extracted = staging / "node-extract" / f"node-v{node['version']}-{node['platform']}"
        if not extracted.is_dir():
            raise ValueError("Node archive does not contain the pinned directory")
        extracted.rename(staging / "runtime")
        shutil.rmtree(staging / "node-extract")
        if output(["pnpm", "--version"]) != lock["package_manager"]["version"]:
            raise ValueError("pnpm version differs from the browser lock")
        package = staging / "package"
        package.mkdir()
        for name in ("package.json", "pnpm-lock.yaml"):
            shutil.copy2(SOURCE / name, package / name)
        environment = os.environ.copy()
        environment["PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD"] = "1"
        run(["pnpm", "install", "--prod", "--frozen-lockfile", "--ignore-scripts"], cwd=package, env=environment)
        browser_metadata(package, lock)
        environment["PLAYWRIGHT_BROWSERS_PATH"] = str(staging / "browsers")
        environment["PLAYWRIGHT_SKIP_BROWSER_GC"] = "1"
        mcp_package = (package / "node_modules/@playwright/mcp").resolve()
        playwright_cli = mcp_package.parents[1] / "playwright-core/cli.js"
        if not playwright_cli.is_file():
            raise ValueError("locked Playwright CLI is absent from the pnpm installation")
        run([str(staging / "runtime/bin/node"), str(playwright_cli), "install", "--only-shell", "chromium"], cwd=package, env=environment, capture=False)
        launcher = staging / "bin/omd-browser-mcp"
        launcher.parent.mkdir()
        launcher.write_text(launcher_text(lock))
        launcher.chmod(0o755)
        shutil.copytree(BRIDGE_SOURCE, staging / "bridge", ignore=bridge_copy_ignore)
        bridge_launcher = staging / "bin/omd-bridge-mcp"
        bridge_launcher.write_text(bridge_launcher_text())
        bridge_launcher.chmod(0o755)
        (staging / "artifacts").mkdir(mode=0o700)
        manifest = {
            "schema": SCHEMA,
            "product": PRODUCT,
            "installed_at": datetime.now(timezone.utc).isoformat(),
            "destination": str(destination),
            "provisioning": "source",
            "node": lock["node"],
            "pnpm_lock_sha256": pnpm_lock_sha256,
            "mcp": lock["mcp"],
            "browser": lock["browser"],
            "launcher": "bin/omd-browser-mcp",
            "bridge": {
                "launcher": "bin/omd-bridge-mcp",
                "protocol": 1,
                "transport": "loopback HTTP with MCP stdio control",
                "adapters": ["browser", "node", "rust", "python", "java"],
            },
            "approval": "Codex default_tools_approval_mode=prompt",
            "profile": "isolated in memory",
            "sandbox": "Chromium sandbox explicitly enabled; MCP/browser network and remote side effects remain outside the shell filesystem sandbox",
            "cleanup": "Codex owns the MCP child; browser idle timeout is 60000ms; uninstall removes the owned bundle and bounded artifacts",
        }
        manifest["tree"] = tree_identity(staging)
        write_json(staging / "bundle.json", manifest)
        staging.rename(destination)
        return verify(destination)
    except BaseException:
        if staging.exists():
            shutil.rmtree(staging)
        raise


def load_manifest(destination):
    destination = validate_destination(destination)
    path = destination / "bundle.json"
    if not path.is_file():
        raise ValueError(f"no managed browser bundle at {destination}")
    manifest = json.loads(path.read_text())
    if manifest.get("schema") != SCHEMA or manifest.get("product") != PRODUCT:
        raise ValueError("refusing an unrecognized browser bundle")
    if resolved(manifest["destination"]) != destination:
        raise ValueError("browser bundle destination mismatch")
    return manifest


def verify(destination):
    destination = validate_destination(destination)
    manifest = load_manifest(destination)
    identity = tree_identity(destination)
    if identity != manifest["tree"]:
        raise ValueError("browser bundle tree hash mismatch")
    node_version = output([str(destination / "runtime/bin/node"), "--version"])
    mcp_version = output([str(destination / "bin/omd-browser-mcp"), "--version"])
    if node_version != f"v{manifest['node']['version']}":
        raise ValueError("browser bundle Node version mismatch")
    if mcp_version != f"Version {manifest['mcp']['version']}":
        raise ValueError("browser bundle MCP version mismatch")
    bridge = manifest.get("bridge", {})
    bridge_launcher = destination / bridge.get("launcher", "")
    if bridge.get("protocol") != 1 or not bridge_launcher.is_file() or not os.access(bridge_launcher, os.X_OK):
        raise ValueError("browser bundle bridge launcher is invalid")
    if not (destination / "bridge/host.mjs").is_file():
        raise ValueError("browser bundle bridge host is absent")
    return {**manifest, "verified": True, "node_version": node_version, "mcp_version": mcp_version}


def archive_filter(info):
    info.uid = 0
    info.gid = 0
    info.uname = ""
    info.gname = ""
    info.mtime = 0
    return info


def create_archive(source, archive):
    source = validate_destination(source)
    verify(source)
    archive = resolved(archive)
    if archive.exists():
        raise ValueError(f"browser archive exists: {archive}")
    archive.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive, "w:xz") as target:
        target.add(source, arcname="browser", recursive=True, filter=archive_filter)
    return {"archive": str(archive), "sha256": digest(archive), "bytes": archive.stat().st_size}


def install_archive(archive, expected_sha256, destination):
    archive = resolved(archive)
    destination = validate_destination(destination)
    if digest(archive) != expected_sha256:
        raise ValueError("prebuilt browser archive hash mismatch")
    if destination.exists():
        raise ValueError(f"browser bundle destination exists: {destination}")
    staging = destination.parent / f".{destination.name}.staging"
    if staging.exists():
        raise ValueError(f"browser staging path exists: {staging}")
    staging.mkdir(parents=True, mode=0o700)
    try:
        safe_extract(archive, staging)
        extracted = staging / "browser"
        manifest = json.loads((extracted / "bundle.json").read_text())
        if manifest.get("schema") != SCHEMA or manifest.get("product") != PRODUCT:
            raise ValueError("refusing an unrecognized browser bundle archive")
        if manifest["tree"] != tree_identity(extracted):
            raise ValueError("prebuilt browser archive tree hash mismatch")
        manifest["destination"] = str(destination)
        manifest["provisioning"] = "prebuilt-archive"
        write_json(extracted / "bundle.json", manifest)
        extracted.rename(destination)
        staging.rmdir()
        return verify(destination)
    except BaseException:
        if staging.exists():
            shutil.rmtree(staging)
        raise


def recover_update(destination):
    journal = destination.parent / f".{destination.name}.update.json"
    replacement = destination.parent / f".{destination.name}.replacement"
    backup = destination.parent / f".{destination.name}.rollback"
    if not journal.exists():
        return
    transaction = json.loads(journal.read_text())
    if transaction.get("destination") != str(destination) or transaction.get("phase") not in {"building", "prepared", "committed"}:
        raise ValueError("browser update recovery journal is invalid")
    if transaction["phase"] == "committed":
        if verify(destination)["tree"] != transaction["new_tree"]:
            raise ValueError("browser update recovery tree mismatch")
        if backup.exists():
            shutil.rmtree(backup)
    else:
        if backup.exists():
            manifest = json.loads((backup / "bundle.json").read_text())
            if manifest.get("destination") != str(destination) or tree_identity(backup) != transaction["old_tree"]:
                raise ValueError("browser update rollback tree mismatch")
            if destination.exists():
                if replacement.exists() or tree_identity(destination) != transaction.get("new_tree"):
                    raise ValueError("browser update activation state is invalid")
                destination.rename(replacement)
            backup.rename(destination)
        if verify(destination)["tree"] != transaction["old_tree"]:
            raise ValueError("browser update original tree mismatch")
    if replacement.exists():
        shutil.rmtree(replacement)
    staging = replacement.parent / f".{replacement.name}.staging"
    if staging.exists():
        shutil.rmtree(staging)
    journal.unlink()


def update(destination, node_archive=None, archive=None, expected_sha256=None):
    import fcntl
    destination = validate_destination(destination)
    with (destination.parent / f".{destination.name}.update.lock").open("a+b") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return update_locked(destination, node_archive, archive, expected_sha256)


def update_locked(destination, node_archive=None, archive=None, expected_sha256=None):
    destination = validate_destination(destination)
    recover_update(destination)
    original = verify(destination)
    replacement = destination.parent / f".{destination.name}.replacement"
    backup = destination.parent / f".{destination.name}.rollback"
    journal = destination.parent / f".{destination.name}.update.json"
    staging = replacement.parent / f".{replacement.name}.staging"
    if replacement.exists() or backup.exists() or staging.exists():
        raise ValueError("browser update staging or rollback path exists")
    transaction = {"destination": str(destination), "phase": "building", "old_tree": original["tree"]}
    write_json(journal, transaction)
    try:
        if archive:
            replacement_manifest = install_archive(archive, expected_sha256, replacement)
        else:
            replacement_manifest = build_bundle(replacement, node_archive)
        transaction.update(phase="prepared", new_tree=replacement_manifest["tree"])
        write_json(journal, transaction)
        destination.rename(backup)
        replacement.rename(destination)
        manifest = json.loads((destination / "bundle.json").read_text())
        if manifest.get("schema") != SCHEMA or manifest.get("product") != PRODUCT:
            raise ValueError("updated browser bundle manifest is unrecognized")
        manifest["destination"] = str(destination)
        write_json(destination / "bundle.json", manifest)
        result = verify(destination)
        transaction["phase"] = "committed"
        write_json(journal, transaction)
    except BaseException:
        recover_update(destination)
        raise
    recover_update(destination)
    return result


def remove(destination):
    destination = validate_destination(destination)
    manifest = verify(destination)
    shutil.rmtree(destination)
    return {"removed": True, "destination": str(destination), "tree": manifest["tree"]}


def parser():
    result = argparse.ArgumentParser(description="Provision and verify the pinned Oh My Diff browser bundle")
    commands = result.add_subparsers(dest="command", required=True)
    provision = commands.add_parser("provision")
    provision.add_argument("destination", type=Path)
    provision.add_argument("--node-archive", type=Path)
    package = commands.add_parser("package")
    package.add_argument("source", type=Path)
    package.add_argument("archive", type=Path)
    install = commands.add_parser("install-archive")
    install.add_argument("archive", type=Path)
    install.add_argument("destination", type=Path)
    install.add_argument("--sha256", required=True)
    update_parser = commands.add_parser("update")
    update_parser.add_argument("destination", type=Path)
    update_parser.add_argument("--node-archive", type=Path)
    update_parser.add_argument("--archive", type=Path)
    update_parser.add_argument("--sha256")
    verify_parser = commands.add_parser("verify")
    verify_parser.add_argument("destination", type=Path)
    remove_parser = commands.add_parser("remove")
    remove_parser.add_argument("destination", type=Path)
    return result


def main():
    args = parser().parse_args()
    if args.command == "provision":
        result = build_bundle(args.destination, args.node_archive)
    elif args.command == "package":
        result = create_archive(args.source, args.archive)
    elif args.command == "install-archive":
        result = install_archive(args.archive, args.sha256, args.destination)
    elif args.command == "update":
        if bool(args.archive) != bool(args.sha256):
            raise ValueError("archive updates require both --archive and --sha256")
        result = update(args.destination, args.node_archive, args.archive, args.sha256)
    elif args.command == "verify":
        result = verify(args.destination)
    else:
        result = remove(args.destination)
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, ValueError) as error:
        raise SystemExit(str(error)) from error
