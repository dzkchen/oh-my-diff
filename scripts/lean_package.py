#!/usr/bin/env python3
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile

try:
    from scripts import lean_release_lock as release
    from scripts import private_lean_v1 as private
except ModuleNotFoundError:
    import lean_release_lock as release
    import private_lean_v1 as private


ROOT = Path(__file__).resolve().parents[1]


def run(*arguments, cwd=None, env=None):
    subprocess.run([str(item) for item in arguments], cwd=cwd, env=env, check=True)


def copy_sources(destination):
    plugin = private.plugin_sources()
    preview = private.preview_sources(private.preview_lock())
    index = json.loads((ROOT / "extensions/index.json").read_text())
    selected = {package["id"] for package in index["packages"]
                if package["extension_type"] == "plugin"
                and package["support_status"] in ("reviewed_candidate", "supported")}
    listed = set(release.SOURCES)
    listed.update(("runtime/lean-release.lock.json", plugin["guide"]["path"],
                   json.loads((ROOT / "runtime/patches/manifest.json").read_text())["patch"]["path"]))
    listed.update(f"{plugin['source']}/{name}" for name in plugin["files"]
                  if name.startswith("plugins/") and name.split("/")[1] in selected)
    for package in preview["packages"].values():
        listed.update(f"{package['source']}/{name}" for name in package["files"])
    for name in sorted(listed):
        source = ROOT / name
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
    marketplace = json.loads((ROOT / plugin["source"] / ".agents/plugins/marketplace.json").read_text())
    marketplace["plugins"] = [entry for entry in marketplace["plugins"] if entry["name"] in selected]
    private.atomic_text(destination / plugin["source"] / ".agents/plugins/marketplace.json",
                        json.dumps(marketplace, indent=2) + "\n")


def archive_payload(artifact_dir, destination, source_rebuild=False):
    record = release.build(artifact_dir)
    frozen = json.loads(release.OUTPUT.read_text())
    if source_rebuild:
        for name in set(record) | set(frozen):
            if name != "artifacts" and record.get(name) != frozen.get(name):
                raise ValueError("source package differs from the prebuilt source and profile manifest")
    elif record != frozen:
        raise ValueError("release lock differs from exact artifacts and sources")
    expected = json.dumps(record, indent=2, sort_keys=True) + "\n"
    destination = destination.resolve()
    if destination.exists():
        raise ValueError("package archive already exists")
    with tempfile.TemporaryDirectory(prefix="omd-package-stage-", dir="/private/tmp") as temporary:
        payload = Path(temporary) / "payload"
        payload.mkdir()
        copy_sources(payload)
        if source_rebuild:
            private.atomic_text(payload / "runtime/lean-release.lock.json", expected)
        binaries = payload / "artifacts"
        binaries.mkdir()
        for name in release.BINARIES + (release.AUTHOR_ARCHIVE,):
            shutil.copy2(artifact_dir / name, binaries / name)
        files = {path.relative_to(payload).as_posix():
                 {"sha256": private.digest(path), "bytes": path.stat().st_size}
                 for path in payload.rglob("*") if path.is_file()}
        private.atomic_text(payload / "package-manifest.json",
                            json.dumps({"schema": 1, "files": files}, indent=2, sort_keys=True) + "\n")
        destination.parent.mkdir(parents=True, exist_ok=True)
        with tarfile.open(destination, "w:xz") as archive:
            for path in sorted(path for path in payload.rglob("*") if path.is_file()):
                info = archive.gettarinfo(str(path), f"payload/{path.relative_to(payload).as_posix()}")
                info.uid = info.gid = 0
                info.uname = info.gname = ""
                info.mtime = 0
                with path.open("rb") as source:
                    archive.addfile(info, source)
    return {"archive": str(destination), "sha256": private.digest(destination),
            "bytes": destination.stat().st_size, "files": len(files)}


def checked_extract(archive_path, expected, destination):
    if private.digest(archive_path) != expected:
        raise ValueError("prebuilt package SHA-256 mismatch")
    with tarfile.open(archive_path, "r:xz") as archive:
        members = archive.getmembers()
        if not members or len(members) > 1000 or sum(item.size for item in members) > 600_000_000:
            raise ValueError("unrecognized package file count")
        if any(not item.isfile() or not item.name.startswith("payload/")
               or any(part in ("", ".", "..") for part in Path(item.name).parts)
               or item.size > 500_000_000 for item in members):
            raise ValueError("unsafe package member")
        archive.extractall(destination, filter="data")
    payload = destination / "payload"
    manifest = json.loads((payload / "package-manifest.json").read_text())
    actual = {path.relative_to(payload).as_posix() for path in payload.rglob("*") if path.is_file()}
    expected_files = manifest["files"]
    if manifest.get("schema") != 1 or actual != set(expected_files) | {"package-manifest.json"}:
        raise ValueError("prebuilt package inventory mismatch")
    for name, details in expected_files.items():
        path = payload / name
        if path.stat().st_size != details["bytes"] or private.digest(path) != details["sha256"]:
            raise ValueError(f"prebuilt package file changed: {name}")
    return payload


def install_archive(args):
    archive_path = Path(args.archive).resolve()
    upstream = private.binary_identity(args.upstream)
    expected_version = json.loads((ROOT / "upstream.lock.json").read_text())["tag"].removeprefix("rust-v")
    if upstream["version"] != f"codex-cli {expected_version}":
        raise ValueError("upstream fallback does not match package pin")
    with tempfile.TemporaryDirectory(prefix="omd-package-install-", dir="/private/tmp") as temporary:
        payload = checked_extract(archive_path, args.sha256, Path(temporary))
        run(sys.executable, "-m", "scripts.lean_release_lock", "--artifact-dir", payload / "artifacts",
            "--package-mode",
            cwd=payload)
        command = [sys.executable, "-m", "scripts.lean_profiles", "--prefix", args.prefix,
                   "--bin-dir", args.bin_dir, "install", "--profile", args.profile,
                   "--binary", payload / "artifacts/codex", "--manager", payload / "artifacts/omd-mod", "--omd", payload / "artifacts/omd",
                   "--author-archive", payload / "artifacts/mod-api.tgz", "--node", args.node,
                   "--store", args.store]
        if args.profile == "full":
            for name in ("omd-graph", "omd-health", "omd-lsp"):
                command.extend((f"--{name}", payload / "artifacts" / name))
        if args.attach_store:
            command.append("--attach-store")
        environment = os.environ.copy()
        environment["PATH"] = str(Path(upstream["path"]).parent) + os.pathsep + environment.get("PATH", "")
        run(*command, cwd=payload, env=environment)


def source_build(args):
    upstream = json.loads((ROOT / "upstream.lock.json").read_text())
    if args.output_archive and args.output_archive.resolve().exists():
        raise ValueError("source package archive already exists")
    with tempfile.TemporaryDirectory(prefix="omd-package-source-", dir="/private/tmp") as temporary:
        checkout = Path(temporary) / "upstream"
        run("git", "clone", "--no-checkout", args.repository, checkout)
        run("git", "checkout", upstream["commit"], cwd=checkout)
        run(sys.executable, ROOT / "scripts/normalize_upstream_lock.py", checkout)
        run(sys.executable, ROOT / "scripts/apply_runtime_patch.py", checkout)
        target = Path(args.target_dir).resolve() if args.target_dir else Path(temporary) / "target"
        environment = os.environ.copy()
        environment["CARGO_TARGET_DIR"] = str(target)
        run("cargo", f"+{upstream['rust_toolchain']}", "build", "--locked", "--release",
            "-j", "4", "-p", "codex-cli", "--bin", "codex", "-p", "codex-omd",
            "--bin", "omd-mod", "--bin", "omd", "--bin", "omd-graph", "--bin", "omd-health",
            "--bin", "omd-lsp", cwd=checkout / "codex-rs", env=environment)
        artifacts = Path(temporary) / "artifacts"
        artifacts.mkdir()
        for name in release.BINARIES:
            shutil.copy2(target / "release" / name, artifacts / name)
        shutil.copy2(args.author_archive, artifacts / release.AUTHOR_ARCHIVE)
        archive = args.output_archive.resolve() if args.output_archive else Path(temporary) / "package.tar.xz"
        packed = archive_payload(artifacts, archive, source_rebuild=True)
        install_args = argparse.Namespace(**{**vars(args), "archive": archive, "sha256": packed["sha256"]})
        install_archive(install_args)
        print(json.dumps({"source_package": packed,
                          "artifact_sha256": {name: private.digest(artifacts / name)
                                              for name in release.BINARIES}}, indent=2))


def main():
    parser = argparse.ArgumentParser(description="Build, package and install the local lean candidate")
    commands = parser.add_subparsers(dest="command", required=True)
    pack = commands.add_parser("pack")
    pack.add_argument("--artifact-dir", type=Path, required=True)
    pack.add_argument("--output", type=Path, required=True)
    install = commands.add_parser("install")
    install.add_argument("--archive", type=Path, required=True)
    install.add_argument("--sha256", required=True)
    source = commands.add_parser("source-install")
    source.add_argument("--repository", required=True)
    source.add_argument("--target-dir", type=Path)
    source.add_argument("--output-archive", type=Path)
    source.add_argument("--author-archive", type=Path, required=True)
    for command in (install, source):
        command.add_argument("--upstream", type=Path, required=True)
        command.add_argument("--profile", choices=("platform", "full"), required=True)
        command.add_argument("--prefix", type=Path, required=True)
        command.add_argument("--bin-dir", type=Path, required=True)
        command.add_argument("--store", type=Path, required=True)
        command.add_argument("--node", type=Path, required=True)
        command.add_argument("--attach-store", action="store_true")
    args = parser.parse_args()
    if args.command == "pack":
        print(json.dumps(archive_payload(args.artifact_dir.resolve(), args.output), indent=2))
    elif args.command == "install":
        install_archive(args)
    else:
        source_build(args)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, subprocess.CalledProcessError, tarfile.TarError) as error:
        raise SystemExit(str(error)) from error
