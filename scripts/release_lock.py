#!/usr/bin/env python3
import argparse
import json
from pathlib import Path
import re
import subprocess
import tarfile

from scripts import install_support as support
from scripts import mods_lock, profiles, build_provenance
from scripts.build_provenance import BINARIES


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "runtime/release.lock.json"
TARGET = "aarch64-apple-darwin"
HARDENED = ("codex", "omd-mod", "omd", "omd-contract", "omd-broker")
ENTITLEMENTS = ROOT / "runtime/hardened-entitlements.plist"
AUTHOR_ARCHIVE = "mod-api.tgz"
SOURCES = (
    "scripts/build_provenance.py",
    "plugins/release-files.json",
    "scripts/profiles.py", "scripts/release_lock.py",
    "scripts/package.py", "scripts/install_support.py",
    "scripts/authority_broker.py", "runtime/hardened-entitlements.plist",
    "upstream.lock.json", "runtime/patches/manifest.json", "runtime/plugins.lock.json",
    "extensions/index.json", "mods/package.json", "mods/api.d.ts", "mods/compatibility.json",
    "mods/author/cli.mjs",
    "docs/install.md", "install.sh",
    "LICENSE", "LICENSE-APACHE", "NOTICE", "THIRD_PARTY_NOTICES.md",
    "scripts/mods_lock.py", "runtime/mods.lock.json",
) + mods_lock.sources()


def sign(path):
    subprocess.run(["/usr/bin/codesign", "--force", "--sign", "-", "--options", "runtime",
                    "--entitlements", str(ENTITLEMENTS), str(path)], check=True, capture_output=True)


def hardened(path):
    details = subprocess.run(["/usr/bin/codesign", "-d", "--verbose=4", str(path)],
                             capture_output=True, text=True).stderr
    return re.search(r"^CodeDirectory .*flags=0x[0-9a-f]+\([^)]*runtime", details, re.M) is not None


def sdk_sources():
    names = set()
    for name in json.loads((ROOT / "mods/package.json").read_text())["files"]:
        path = ROOT / "mods" / name
        if path.is_file():
            names.add(path.relative_to(ROOT).as_posix())
        elif path.is_dir():
            names.update(item.relative_to(ROOT).as_posix() for item in path.rglob("*") if item.is_file())
        else:
            raise ValueError(f"declared SDK source is absent: {name}")
    return tuple(sorted(names))


SOURCES = tuple(sorted(set(SOURCES) | set(sdk_sources())))


def build(artifact_dir, package_mode=False, version=None):
    product_version = json.loads(OUTPUT.read_text())["version"] if version is None else version
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?", product_version):
        raise ValueError("invalid release version")
    provenance = build_provenance.verify(artifact_dir)
    upstream = json.loads((ROOT / "upstream.lock.json").read_text())
    patch = json.loads((ROOT / "runtime/patches/manifest.json").read_text())
    mods = support.mods_lock()
    if not package_mode and mods != mods_lock.build():
        raise ValueError("first-party mod lock differs from pinned sources")
    index = json.loads((ROOT / "extensions/index.json").read_text())
    codex_version = upstream["tag"].removeprefix("rust-v")
    if (index["release_pin"]["codex"] != codex_version
            or index["release_pin"]["mod_api"] != mods["mod_api"]
            or index["release_pin"]["node"] != mods["node"]):
        raise ValueError("curated catalog does not match the active release pin")
    plugins = sorted(support.plugin_sources()["plugins"])
    artifacts = {}
    for name in BINARIES:
        path = artifact_dir / name
        if not path.is_file() or "arm64" not in subprocess.check_output(
                ["file", "-b", str(path)], text=True):
            raise ValueError(f"missing Apple Silicon release artifact: {name}")
        if name in HARDENED and not hardened(path):
            raise ValueError(f"release artifact lacks the hardened runtime signature: {name}")
        artifacts[name] = {"sha256": support.digest(path), "bytes": path.stat().st_size}
    archive = artifact_dir / AUTHOR_ARCHIVE
    if not archive.is_file():
        raise ValueError("missing packed mod author SDK")
    with tarfile.open(archive, "r:gz") as packed:
        files = {item.name: packed.extractfile(item).read() for item in packed.getmembers()
                 if item.isfile()}
    source_package = json.loads((ROOT / "mods/package.json").read_text())
    source_package.pop("packageManager", None)
    if json.loads(files.get("package/package.json", b"null")) != source_package:
        raise ValueError("packed mod author package metadata differs")
    expected_sdk = {"package/" + name.removeprefix("mods/"): ROOT / name for name in sdk_sources()}
    if set(files) != set(expected_sdk) | {"package/package.json"}:
        raise ValueError("packed mod author file inventory differs")
    for name, source in expected_sdk.items():
        if files[name] != source.read_bytes():
            raise ValueError(f"packed mod author source differs: {name}")
    artifacts[AUTHOR_ARCHIVE] = {"sha256": support.digest(archive), "bytes": archive.stat().st_size}
    if support.binary_identity(artifact_dir / "codex")["version"] != f"codex-cli {codex_version}":
        raise ValueError("release binary does not match the active upstream pin")
    return {
        "schema": 1,
        "product": profiles.PRODUCT,
        "version": product_version,
        "upstream_tag": upstream["tag"],
        "upstream_commit": upstream["commit"],
        "target": TARGET,
        "rust_toolchain": upstream["rust_toolchain"],
        "normalized_cargo_lock_sha256": upstream["normalized_cargo_lock_sha256"],
        "runtime_patch_sha256": patch["patch"]["sha256"],
        "mod_api": mods["mod_api"],
        "node": mods["node"],
        "artifacts": artifacts,
        "build_provenance": provenance,
        "platform_tools": list(profiles.HOST_TOOLS),
        "profiles": {
            "platform": {"label": profiles.PROFILE_LABELS["platform"],
                         "first_party_installed": list(profiles.PLATFORM_PACKAGES),
                         "first_party_default_active": list(profiles.PLATFORM_PACKAGES), "plugin_sources": []},
            "full": {"label": profiles.PROFILE_LABELS["full"], "first_party_installed": sorted(mods["packages"]),
                     "first_party_default_active": sorted(profiles.DEFAULT_ACTIVE),
                     "plugin_sources": plugins},
        },
        "qualification": "development package; supported collection and default pending",
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifact-dir", type=Path, required=True)
    parser.add_argument("--write", action="store_true")
    parser.add_argument("--package-mode", action="store_true")
    parser.add_argument("--version", help="version recorded in the release manifest")
    args = parser.parse_args()
    support.check_or_write(OUTPUT, json.dumps(build(args.artifact_dir.resolve(), args.package_mode, args.version), indent=2, sort_keys=True) + "\n",
                           args.write, "release lock differs from exact artifacts and sources")


if __name__ == "__main__":
    main()
