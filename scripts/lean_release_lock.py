#!/usr/bin/env python3
import argparse
import json
from pathlib import Path
import re
import subprocess
import tarfile

try:
    from scripts import install_support as support
    from scripts import full_mods_lock
except ModuleNotFoundError:
    import install_support as support
    import full_mods_lock


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "runtime/lean-release.lock.json"
VERSION = "0.1.0-alpha.1"
TARGET = "aarch64-apple-darwin"
BINARIES = ("codex", "codex-code-mode-host", "omd-mod", "omd", "omd-contract", "omd-broker")
HARDENED = ("codex", "omd-mod", "omd", "omd-contract", "omd-broker")
ENTITLEMENTS = ROOT / "runtime/hardened-entitlements.plist"
AUTHOR_ARCHIVE = "mod-api.tgz"
SOURCES = (
    "scripts/lean_profiles.py", "scripts/lean_release_lock.py",
    "scripts/lean_package.py", "scripts/install_support.py",
    "scripts/preview_lock.py", "scripts/authority_broker.py", "runtime/hardened-entitlements.plist",
    "upstream.lock.json", "runtime/patches/manifest.json",
    "runtime/preview-v1.lock.json", "runtime/plugin-v1.lock.json",
    "extensions/index.json", "mods/package.json", "mods/api.d.ts", "mods/compatibility.json",
    "mods/author/cli.mjs",
    "LEAN_PROFILES.md", "install.sh",
    "scripts/full_mods_lock.py", "runtime/full-mods.lock.json",
) + full_mods_lock.sources() + support.optional_plugin_sources()


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


def selected_plugins(index, package_mode):
    lock = support.plugin_lock()
    source = ROOT / lock["source"]
    if support.digest(ROOT / lock["guide"]["path"]) != lock["guide"]["sha256"]:
        raise ValueError("pinned bundled plugin guide changed")
    selected = sorted(package["id"] for package in index["packages"]
                      if package["extension_type"] == "plugin"
                      and package["support_status"] in ("reviewed_candidate", "supported"))
    if not selected or not set(selected) <= set(lock["plugins"]):
        raise ValueError("curated plugin selection disagrees with pinned sources")
    expected = {name for name in lock["files"]
                if name.startswith("plugins/") and name.split("/")[1] in selected}
    actual = {path.relative_to(source).as_posix() for path in source.rglob("*")
              if path.is_file() and "__pycache__" not in path.parts and path.suffix != ".pyc"
              and path.relative_to(source).parts[:2] in
              {("plugins", identifier) for identifier in selected}}
    if actual != expected:
        raise ValueError("selected plugin source inventory changed")
    for name in expected:
        if support.digest(source / name) != lock["files"][name]:
            raise ValueError(f"selected plugin source changed: {name}")
    marketplace = json.loads((source / ".agents/plugins/marketplace.json").read_text())
    listed = {entry["name"] for entry in marketplace["plugins"]}
    if marketplace.get("name") != lock["marketplace"] or not set(selected) <= listed:
        raise ValueError("selected plugin marketplace changed")
    if not package_mode and support.digest(source / ".agents/plugins/marketplace.json") != lock["files"][".agents/plugins/marketplace.json"]:
        raise ValueError("pinned bundled plugin marketplace changed")
    if package_mode and (listed != set(selected) or any(
            name.startswith("plugins/") and name.split("/")[1] not in selected for name in
            (path.relative_to(source).as_posix() for path in source.rglob("*") if path.is_file()))):
        raise ValueError("unselected plugin source leaked into the package")
    for identifier in selected:
        manifest = json.loads((source / f"plugins/{identifier}/.codex-plugin/plugin.json").read_text())
        if manifest.get("name") != identifier or manifest.get("version") != lock["plugins"][identifier]["version"]:
            raise ValueError(f"selected plugin identity changed: {identifier}")
    return lock, selected


def build(artifact_dir, package_mode=False, version=None):
    product_version = version or (json.loads(OUTPUT.read_text())["version"] if OUTPUT.is_file() else VERSION)
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?", product_version):
        raise ValueError("invalid release version")
    upstream = json.loads((ROOT / "upstream.lock.json").read_text())
    patch = json.loads((ROOT / "runtime/patches/manifest.json").read_text())
    if support.digest(ROOT / patch["patch"]["path"]) != patch["patch"]["sha256"]:
        raise ValueError("active runtime patch hash mismatch")
    preview = support.preview_sources(support.preview_lock())
    full = full_mods_lock.load()
    if not package_mode and full != full_mods_lock.build():
        raise ValueError("OMD+ mod lock differs from pinned sources")
    index = json.loads((ROOT / "extensions/index.json").read_text())
    version = upstream["tag"].removeprefix("rust-v")
    if (index["release_pin"]["codex"] != version
            or index["release_pin"]["mod_api"] != preview["mod_api"]
            or index["release_pin"]["node"] != preview["node"]):
        raise ValueError("curated catalog does not match the active release pin")
    _, selected = selected_plugins(index, package_mode)
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
    if support.binary_identity(artifact_dir / "codex")["version"] != f"codex-cli {version}":
        raise ValueError("release binary does not match the active upstream pin")
    return {
        "schema": 1,
        "product": "oh-my-diff-lean-package-candidate-v1",
        "version": product_version,
        "upstream_tag": upstream["tag"],
        "upstream_commit": upstream["commit"],
        "target": TARGET,
        "rust_toolchain": upstream["rust_toolchain"],
        "normalized_cargo_lock_sha256": upstream["normalized_cargo_lock_sha256"],
        "runtime_patch_sha256": patch["patch"]["sha256"],
        "mod_api": preview["mod_api"],
        "node": preview["node"],
        "source_sha256": {name: support.digest(ROOT / name) for name in SOURCES},
        "artifacts": artifacts,
        "platform_tools": ["omd", "omd-contract"],
        "profiles": {
            "platform": {"label": "OMD Core", "first_party_installed": ["omd_logo", "omd_mods", "omd_update"], "first_party_default_active": ["omd_logo", "omd_mods", "omd_update"],
                         "plugin_sources": []},
            "full": {"label": "OMD+", "first_party_installed": sorted((*preview["packages"], *full["packages"])),
                     "first_party_default_active": ["omd_inspector", "omd_logo", "omd_model_picker", "omd_mods", "omd_update", "omd_workspace"],
                     "plugin_sources": sorted((*selected, *support.SELECTED_OPTIONAL_PLUGINS))},
        },
        "qualification": "development package candidate; supported collection and default pending",
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifact-dir", type=Path, required=True)
    parser.add_argument("--write", action="store_true")
    parser.add_argument("--package-mode", action="store_true")
    parser.add_argument("--version", help="version recorded in the release manifest")
    args = parser.parse_args()
    result = json.dumps(build(args.artifact_dir.resolve(), args.package_mode, args.version), indent=2, sort_keys=True) + "\n"
    if args.write:
        OUTPUT.write_text(result)
        print(f"wrote {OUTPUT.relative_to(ROOT)}")
    elif OUTPUT.read_text() != result:
        raise SystemExit("lean release lock differs from exact artifacts and sources")
    else:
        print("lean release lock matches exact artifacts and sources")


if __name__ == "__main__":
    main()
