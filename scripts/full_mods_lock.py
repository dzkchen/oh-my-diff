#!/usr/bin/env python3
import json
from pathlib import Path
import sys

try:
    from scripts import preview_lock
except ModuleNotFoundError:
    import preview_lock


ROOT = Path(__file__).resolve().parents[1]
LOCK = ROOT / "runtime/full-mods.lock.json"
PACKAGES = ("omd_advisor", "omd_checks", "omd_claude_cli", "omd_git", "omd_graph_navigator", "omd_guideline_governance",
            "omd_inspector", "omd_logo", "omd_lsp_sync", "omd_model_picker", "omd_project_pi_prompts",
            "omd_repository_analysis", "omd_research", "omd_selection_copy", "omd_source_knowledge", "omd_task_tools",
            "omd_typed_tasks")


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
        preview_lock.validate_manifest(manifest, identifier)
        packages[identifier] = {
            "id": identifier, "version": manifest["version"], "api": manifest["api"],
            "extension_type": "mod", "capabilities": manifest["capabilities"],
            "source": base.relative_to(ROOT).as_posix(),
            "files": {name: preview_lock.digest(base / name) for name in source_files(identifier)},
            "package_sha256": preview_lock.package_digest(base),
        }
    return {"schema": 1, "mod_api": json.loads((ROOT / "mods/package.json").read_text())["version"], "packages": packages}


def load():
    return json.loads(LOCK.read_text())


def main():
    expected = json.dumps(build(), indent=2, sort_keys=True) + "\n"
    if "--write" in sys.argv[1:]:
        LOCK.write_text(expected)
        print(f"wrote {LOCK.relative_to(ROOT)}")
    elif not LOCK.is_file() or LOCK.read_text() != expected:
        raise SystemExit("Full mod lock differs from pinned sources")
    else:
        print("Full mod lock matches pinned sources")


if __name__ == "__main__":
    main()
