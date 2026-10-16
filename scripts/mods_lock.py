#!/usr/bin/env python3
import json
from pathlib import Path
import sys

from scripts import install_support as support


ROOT = Path(__file__).resolve().parents[1]
LOCK = ROOT / "runtime/mods.lock.json"
NODE = "24.18.0"
PACKAGES = ("omd_advisor", "omd_auto_continue", "omd_claude_cli", "omd_continue", "omd_frecency", "omd_idle_compact",
            "omd_inspector", "omd_logo", "omd_lsp_sync", "omd_lsp_view", "omd_model_picker", "omd_mods", "omd_plan_panel",
            "omd_plan_removal", "omd_preview", "omd_privacy", "omd_profiles", "omd_statusline", "omd_tool_lines",
            "omd_update", "omd_usage", "omd_workflow")


def source_files(identifier):
    manifest = json.loads((ROOT / "mods/first-party" / identifier / "mod.json").read_text())
    return ("mod.json", manifest.get("entrypoint", "index.ts"), *manifest.get("assets", []))


def sources():
    return tuple(f"mods/first-party/{identifier}/{name}" for identifier in PACKAGES for name in source_files(identifier))


def build():
    packages = {}
    for identifier in PACKAGES:
        base = ROOT / "mods/first-party" / identifier
        manifest = json.loads((base / "mod.json").read_text())
        support.validate_manifest(manifest, identifier)
        packages[identifier] = {
            "id": identifier, "version": manifest["version"], "api": manifest["api"],
            "extension_type": "mod", "capabilities": manifest["capabilities"],
            "source": base.relative_to(ROOT).as_posix(),
            "files": {name: support.digest(base / name) for name in source_files(identifier)},
            "package_sha256": support.package_digest(base),
        }
    return {"schema": support.MODS_SCHEMA, "product": support.MODS_PRODUCT, "node": NODE,
            "mod_api": json.loads((ROOT / "mods/package.json").read_text())["version"], "packages": packages}


def main():
    support.check_or_write(LOCK, json.dumps(build(), indent=2, sort_keys=True) + "\n", "--write" in sys.argv[1:],
                           "first-party mod lock differs from pinned sources")


if __name__ == "__main__":
    main()
