#!/usr/bin/env python3
import argparse
import json
from pathlib import Path
import subprocess
import tarfile

try:
    from scripts import private_lean_v1 as private
except ModuleNotFoundError:
    import private_lean_v1 as private


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "runtime/lean-release.lock.json"
BINARIES = ("codex", "omd-mod", "omd-graph", "omd-health", "omd-lsp")
AUTHOR_ARCHIVE = "mod-api.tgz"
SOURCES = (
    "scripts/lean_profiles.py", "scripts/lean_release_lock.py",
    "scripts/lean_package.py", "scripts/private_lean_v1.py",
    "scripts/preview_lock.py", "scripts/browser_bundle.py",
    "upstream.lock.json", "runtime/patches/manifest.json",
    "runtime/preview-v1.lock.json", "runtime/plugin-v1.lock.json",
    "extensions/index.json", "mods/package.json", "mods/api.d.ts",
    "mods/author/cli.mjs",
    "LEAN_PROFILES.md",
)


def selected_plugins(index, package_mode):
    lock = private.plugin_lock()
    source = ROOT / lock["source"]
    if private.digest(ROOT / lock["guide"]["path"]) != lock["guide"]["sha256"]:
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
        if private.digest(source / name) != lock["files"][name]:
            raise ValueError(f"selected plugin source changed: {name}")
    marketplace = json.loads((source / ".agents/plugins/marketplace.json").read_text())
    listed = {entry["name"] for entry in marketplace["plugins"]}
    if marketplace.get("name") != lock["marketplace"] or not set(selected) <= listed:
        raise ValueError("selected plugin marketplace changed")
    if not package_mode and private.digest(source / ".agents/plugins/marketplace.json") != lock["files"][".agents/plugins/marketplace.json"]:
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


def build(artifact_dir, package_mode=False):
    upstream = json.loads((ROOT / "upstream.lock.json").read_text())
    patch = json.loads((ROOT / "runtime/patches/manifest.json").read_text())
    if private.digest(ROOT / patch["patch"]["path"]) != patch["patch"]["sha256"]:
        raise ValueError("active runtime patch hash mismatch")
    preview = private.preview_sources(private.preview_lock())
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
        artifacts[name] = {"sha256": private.digest(path), "bytes": path.stat().st_size}
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
    for name in ("api.d.ts", "author/cli.mjs"):
        if files.get(f"package/{name}") != (ROOT / "mods" / name).read_bytes():
            raise ValueError(f"packed mod author source differs: {name}")
    artifacts[AUTHOR_ARCHIVE] = {"sha256": private.digest(archive), "bytes": archive.stat().st_size}
    if private.binary_identity(artifact_dir / "codex")["version"] != f"codex-cli {version}":
        raise ValueError("release binary does not match the active upstream pin")
    return {
        "schema": 1,
        "product": "oh-my-diff-lean-package-candidate-v1",
        "upstream_tag": upstream["tag"],
        "upstream_commit": upstream["commit"],
        "target": "aarch64-apple-darwin",
        "rust_toolchain": upstream["rust_toolchain"],
        "normalized_cargo_lock_sha256": upstream["normalized_cargo_lock_sha256"],
        "runtime_patch_sha256": patch["patch"]["sha256"],
        "mod_api": preview["mod_api"],
        "node": preview["node"],
        "source_sha256": {name: private.digest(ROOT / name) for name in SOURCES},
        "artifacts": artifacts,
        "profiles": {
            "platform": {"first_party_installed": [], "first_party_default_active": [],
                         "plugin_sources": [], "optional_tool_binaries": []},
            "full": {"first_party_installed": sorted(preview["packages"]),
                     "first_party_default_active": ["omd_workspace"],
                     "plugin_sources": selected,
                     "optional_tool_binaries": ["omd-graph", "omd-health", "omd-lsp"]},
        },
        "qualification": "development package candidate; supported collection and default pending",
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifact-dir", type=Path, required=True)
    parser.add_argument("--write", action="store_true")
    parser.add_argument("--package-mode", action="store_true")
    args = parser.parse_args()
    result = json.dumps(build(args.artifact_dir.resolve(), args.package_mode), indent=2, sort_keys=True) + "\n"
    if args.write:
        OUTPUT.write_text(result)
        print(f"wrote {OUTPUT.relative_to(ROOT)}")
    elif OUTPUT.read_text() != result:
        raise SystemExit("lean release lock differs from exact artifacts and sources")
    else:
        print("lean release lock matches exact artifacts and sources")


if __name__ == "__main__":
    main()
