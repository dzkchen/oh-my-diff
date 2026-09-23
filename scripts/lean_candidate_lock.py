#!/usr/bin/env python3
import argparse
import json
from pathlib import Path
import subprocess

try:
    from scripts import private_lean_v1 as private
except ModuleNotFoundError:
    import private_lean_v1 as private


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "runtime/lean-candidate.lock.json"
ARTIFACTS = ("codex", "omd-mod", "omd-graph", "omd-health", "omd-lsp")
SOURCES = ("scripts/lean_profiles.py", "scripts/lean_candidate_lock.py",
           "scripts/lean_profile_acceptance.py", "scripts/lean_terminal_acceptance.py",
           "README.md", "LEAN_PROFILES.md",
           "benchmarks/first_run_live_smoke.py", "benchmarks/controlled_live_smoke.py",
           "benchmarks/controlled_subscription_smoke.py",
           "benchmarks/mod_fixture.py",
           "benchmarks/controlled_fixture.py", "runtime/preview-v1.lock.json",
           "runtime/plugin-v1.lock.json", "runtime/lean-v1.lock.json",
           "runtime/lean-release-selection.json", "upstream.lock.json", "extensions/index.json")


def build(artifact_dir):
    upstream, lean = private.lock_inputs()
    preview = private.preview_sources(private.preview_lock())
    plugin = private.plugin_sources()
    index = json.loads((ROOT / "extensions/index.json").read_text())
    selected_plugins = sorted(package["id"] for package in index["packages"]
                              if package["extension_type"] == "plugin"
                              and package["support_status"] == "reviewed_candidate")
    if not selected_plugins or not set(selected_plugins) <= set(plugin["plugins"]):
        raise ValueError("plugin selection is not pinned")
    if sorted(preview["packages"]) != ["omd_coordination", "omd_recovery", "omd_workspace"]:
        raise ValueError("Full OMD mod candidate set changed")
    artifacts = {}
    for name in ARTIFACTS:
        path = artifact_dir / name
        if not path.is_file():
            raise ValueError(f"missing release artifact: {path}")
        description = subprocess.check_output(["file", "-b", str(path)], text=True).strip()
        if "arm64" not in description:
            raise ValueError(f"not an Apple Silicon artifact: {name}")
        artifacts[name] = {"sha256": private.digest(path), "bytes": path.stat().st_size}
    codex = private.binary_identity(artifact_dir / "codex")
    if codex["version"] != "codex-cli 0.155.1":
        raise ValueError("Codex artifact does not match the pinned version")
    return {
        "schema": 1,
        "product": "oh-my-diff-lean-candidate-v1",
        "upstream_commit": upstream["commit"],
        "upstream_tag": upstream["tag"],
        "target": "aarch64-apple-darwin",
        "rust_toolchain": upstream["rust_toolchain"],
        "normalized_cargo_lock_sha256": upstream["normalized_cargo_lock_sha256"],
        "runtime_patch_sha256": lean["runtime_patch"]["sha256"],
        "mod_api": preview["mod_api"],
        "node": preview["node"],
        "source_sha256": {name: private.digest(ROOT / name) for name in SOURCES},
        "artifacts": artifacts,
        "profiles": {
            "platform": {"host_mode": "platform", "first_party_installed": [], "first_party_default_active": [],
                         "plugin_sources": [], "optional_tool_binaries": []},
            "full": {"host_mode": "platform", "first_party_installed": sorted(preview["packages"]),
                     "first_party_default_active": ["omd_workspace"], "plugin_sources": selected_plugins,
                     "optional_tool_binaries": ["omd-graph", "omd-health", "omd-lsp"]},
        },
        "build": "cargo +1.95.0 build --locked --release -p codex-cli --bin codex -p codex-omd --bin omd-mod --bin omd-graph --bin omd-health --bin omd-lsp",
        "qualification": "integration_candidate_only; first-party value and default benefit remain unqualified",
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifact-dir", type=Path, required=True)
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args()
    result = json.dumps(build(args.artifact_dir.resolve()), indent=2, sort_keys=True) + "\n"
    if args.write:
        OUTPUT.write_text(result)
        print(f"wrote {OUTPUT.relative_to(ROOT)}")
    elif OUTPUT.read_text() != result:
        raise SystemExit("lean candidate lock differs from the exact build and sources")
    else:
        print("lean candidate lock matches the exact build and sources")


if __name__ == "__main__":
    main()
