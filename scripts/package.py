#!/usr/bin/env python3
import argparse
import json
import os
from pathlib import Path
import shutil
import sys
import tarfile
import tempfile

from scripts import release_lock as release
from scripts import install_support as support


ROOT = Path(__file__).resolve().parents[1]
MAX_UNPACKED_BYTES = 1_200_000_000
MAX_MEMBER_BYTES = 1_000_000_000
RELEASE_MANIFEST = "omd-release.json"


def copy_sources(destination):
    plugin = support.plugin_sources()
    listed = set(release.SOURCES)
    listed.update(("runtime/release.lock.json", plugin["guide"]["path"],
                   json.loads((ROOT / "runtime/patches/manifest.json").read_text())["patch"]["path"]))
    listed.update(f"{plugin['source']}/{name}" for name in plugin["files"])
    for name in sorted(listed):
        source = ROOT / name
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)


def archive_payload(artifact_dir, destination, source_rebuild=False):
    record = release.build(artifact_dir)
    frozen = json.loads(release.OUTPUT.read_text())
    if source_rebuild:
        for name in set(record) | set(frozen):
            if name not in ("artifacts", "build_provenance") and record.get(name) != frozen.get(name):
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
            support.atomic_text(payload / "runtime/release.lock.json", expected)
        binaries = payload / "artifacts"
        binaries.mkdir()
        for name in release.BINARIES + (release.AUTHOR_ARCHIVE, release.build_provenance.RECORD):
            shutil.copy2(artifact_dir / name, binaries / name)
        files = {path.relative_to(payload).as_posix():
                 {"sha256": support.digest(path), "bytes": path.stat().st_size}
                 for path in payload.rglob("*") if path.is_file()}
        support.atomic_text(payload / "package-manifest.json",
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
    packed = {"archive": str(destination), "sha256": support.digest(destination),
              "bytes": destination.stat().st_size, "files": len(files)}
    support.atomic_text(destination.with_name(RELEASE_MANIFEST), json.dumps(
        {"schema": 1, "version": record["version"], "target": record["target"], "upstream_tag": record["upstream_tag"],
         "mod_api": record["mod_api"], "node": record["node"], "archive": destination.name,
         "sha256": packed["sha256"], "bytes": packed["bytes"]}, indent=2, sort_keys=True) + "\n")
    return {**packed, "manifest": str(destination.with_name(RELEASE_MANIFEST))}


def checked_extract(archive_path, expected, destination):
    if support.digest(archive_path) != expected:
        raise ValueError("prebuilt package SHA-256 mismatch")
    with tarfile.open(archive_path, "r:xz") as archive:
        members = archive.getmembers()
        if not members or len(members) > 1000:
            raise ValueError("unrecognized package file count")
        if sum(item.size for item in members) > MAX_UNPACKED_BYTES:
            raise ValueError("prebuilt package exceeds unpacked byte limit")
        if any(not item.isfile() or not item.name.startswith("payload/")
               or any(part in ("", ".", "..") for part in item.name.split("/")) for item in members):
            raise ValueError("unsafe package member")
        if any(item.size > MAX_MEMBER_BYTES for item in members):
            raise ValueError("prebuilt package member exceeds byte limit")
        archive.extractall(destination, filter="data")
    return verified_payload(destination / "payload")


def verified_payload(payload):
    manifest = json.loads((payload / "package-manifest.json").read_text())
    actual = {path.relative_to(payload).as_posix() for path in payload.rglob("*") if path.is_file()}
    expected_files = manifest["files"]
    if manifest.get("schema") != 1 or actual != set(expected_files) | {"package-manifest.json"}:
        raise ValueError("prebuilt package inventory mismatch")
    for name, details in expected_files.items():
        path = payload / name
        if path.stat().st_size != details["bytes"] or support.digest(path) != details["sha256"]:
            raise ValueError(f"prebuilt package file changed: {name}")
    return payload


def install_archive(args):
    if getattr(args, "payload", None):
        return install_payload(verified_payload(Path(args.payload).resolve()), args)
    with tempfile.TemporaryDirectory(prefix="omd-package-install-", dir="/private/tmp") as temporary:
        install_payload(checked_extract(Path(args.archive).resolve(), args.sha256, Path(temporary)), args)


def install_payload(payload, args):
    upstream = support.binary_identity(args.upstream)
    expected_version = json.loads((ROOT / "upstream.lock.json").read_text())["tag"].removeprefix("rust-v")
    if not support.compatible_upstream(upstream["version"], expected_version):
        raise ValueError("upstream fallback does not match the package's Codex minor version")
    support.run([sys.executable, "-m", "scripts.release_lock", "--artifact-dir", payload / "artifacts",
                 "--package-mode"], cwd=payload, capture=False)
    command = [sys.executable, "-m", "scripts.profiles", "--prefix", args.prefix,
               "--bin-dir", args.bin_dir, "install", "--profile", args.profile,
               "--binary", payload / "artifacts/codex", "--manager", payload / "artifacts/omd-mod", "--omd", payload / "artifacts/omd", "--omd-contract", payload / "artifacts/omd-contract",
               "--author-archive", payload / "artifacts/mod-api.tgz", "--node", args.node,
               "--store", args.store]
    if args.attach_store:
        command.append("--attach-store")
    if getattr(args, "previous", None):
        command += ["--previous", args.previous]
    environment = os.environ.copy()
    environment["PATH"] = str(Path(upstream["path"]).parent) + os.pathsep + environment.get("PATH", "")
    support.run(command, cwd=payload, env=environment, capture=False)


def source_build(args):
    upstream = json.loads((ROOT / "upstream.lock.json").read_text())
    if args.output_archive and args.output_archive.resolve().exists():
        raise ValueError("source package archive already exists")
    with tempfile.TemporaryDirectory(prefix="omd-package-source-", dir="/private/tmp") as temporary:
        checkout = Path(temporary) / "upstream"
        support.run(["git", "clone", "--no-checkout", args.repository, checkout], capture=False)
        support.run(["git", "checkout", upstream["commit"]], cwd=checkout, capture=False)
        support.run([sys.executable, ROOT / "scripts/normalize_upstream_lock.py", checkout], capture=False)
        support.run([sys.executable, ROOT / "scripts/apply_runtime_patch.py", checkout], capture=False)
        target = Path(args.target_dir).resolve() if args.target_dir else Path(temporary) / "target"
        environment = os.environ.copy()
        environment["CARGO_TARGET_DIR"] = str(target)
        arguments = ["build", "--locked", "--release",
            "-j", "4", "-p", "codex-cli", "--bin", "codex", "-p", "codex-code-mode-host", "--bin", "codex-code-mode-host", "-p", "codex-omd",
            "--bin", "omd-mod", "--bin", "omd", "--bin", "omd-contract", "--bin", "omd-broker"]
        before = release.build_provenance.inputs(checkout, arguments, environment)
        (target / "release" / release.build_provenance.RECORD).unlink(missing_ok=True)
        support.run(["cargo", f"+{upstream['rust_toolchain']}", *arguments], cwd=checkout / "codex-rs", env=environment,
                    capture=False)
        release.build_provenance.record_build(target / "release", before,
            release.build_provenance.inputs(checkout, arguments, environment))
        unsigned = release.build_provenance.verify(target / "release", signed=False, expected_inputs=before)
        artifacts = Path(temporary) / "artifacts"
        artifacts.mkdir()
        for name in release.BINARIES:
            shutil.copy2(target / "release" / name, artifacts / name)
        if release.build_provenance.hashes(artifacts) != unsigned["unsigned"]:
            raise ValueError("release artifacts changed during copying")
        for name in release.BINARIES:
            if name in release.HARDENED:
                release.sign(artifacts / name)
        release.build_provenance.record_signing(artifacts, unsigned)
        shutil.copy2(args.author_archive, artifacts / release.AUTHOR_ARCHIVE)
        archive = args.output_archive.resolve() if args.output_archive else Path(temporary) / "package.tar.xz"
        packed = archive_payload(artifacts, archive, source_rebuild=True)
        install_args = argparse.Namespace(**{**vars(args), "archive": archive, "sha256": packed["sha256"]})
        install_archive(install_args)
        print(json.dumps({"source_package": packed,
                          "artifact_sha256": {name: support.digest(artifacts / name)
                                              for name in release.BINARIES}}, indent=2))


def main():
    parser = argparse.ArgumentParser(description="Build, package and install OMD Core and OMD+")
    commands = parser.add_subparsers(dest="command", required=True)
    pack = commands.add_parser("pack")
    pack.add_argument("--artifact-dir", type=Path, required=True)
    pack.add_argument("--output", type=Path, required=True)
    install = commands.add_parser("install")
    source_group = install.add_mutually_exclusive_group(required=True)
    source_group.add_argument("--archive", type=Path)
    source_group.add_argument("--payload", type=Path, help=argparse.SUPPRESS)
    install.add_argument("--sha256")
    install.add_argument("--previous", type=Path, help="prefix of the installation this one replaces")
    source = commands.add_parser("source-install")
    source.add_argument("--repository", required=True)
    source.add_argument("--target-dir", type=Path)
    source.add_argument("--output-archive", type=Path)
    source.add_argument("--author-archive", type=Path, required=True)
    for command in (install, source):
        command.add_argument("--upstream", type=Path, required=True)
        command.add_argument("--profile", choices=("platform", "full"), required=True,
                             help="platform: OMD Core; full: OMD+")
        command.add_argument("--prefix", type=Path, required=True)
        command.add_argument("--bin-dir", type=Path, required=True)
        command.add_argument("--store", type=Path, required=True)
        command.add_argument("--node", type=Path, required=True)
        command.add_argument("--attach-store", action="store_true")
    args = parser.parse_args()
    if args.command == "install" and args.archive and not args.sha256:
        parser.error("--archive needs --sha256")
    if args.command == "pack":
        print(json.dumps(archive_payload(args.artifact_dir.resolve(), args.output), indent=2))
    elif args.command == "install":
        install_archive(args)
    else:
        source_build(args)


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, ValueError, tarfile.TarError) as error:
        raise SystemExit(str(error)) from error
