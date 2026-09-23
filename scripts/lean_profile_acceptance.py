#!/usr/bin/env python3
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import tomllib

try:
    from scripts import private_lean_v1 as private
except ModuleNotFoundError:
    import private_lean_v1 as private


ROOT = Path(__file__).resolve().parents[1]
TOOLS = ("omd-graph", "omd-health", "omd-lsp")


def call(arguments, env, parse=True):
    result = subprocess.run([str(item) for item in arguments], cwd=ROOT, env=env,
                            capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(f"command failed: {arguments[:4]}: {(result.stderr or result.stdout)[-1200:]}")
    return json.loads(result.stdout) if parse else result.stdout.strip()


def run(artifact_dir, output):
    if output.exists():
        raise ValueError("evidence output already exists")
    started = time.monotonic()
    node = Path(call(["mise", "which", "node"], os.environ.copy(), False)).resolve()
    with tempfile.TemporaryDirectory(prefix="omd-lean-acceptance-", dir="/private/tmp") as temporary:
        base = Path(temporary)
        home = base / "codex-home"
        home.mkdir()
        sentinel = home / "config.toml"
        sentinel.write_text('model = "preserve-user-choice"\n')
        env = os.environ.copy()
        env.update(CODEX_HOME=str(home), CODEX_SQLITE_HOME=str(home))
        observations = {}

        def command(profile, *args):
            prefix = base / f"{profile}-prefix"
            bin_dir = base / f"{profile}-bin"
            return call(["python3", "-m", "scripts.lean_profiles", "--prefix", prefix,
                         "--bin-dir", bin_dir, *args], env)

        platform_store = base / "platform-store"
        platform = command("platform", "install", "--profile", "platform", "--binary", artifact_dir / "codex",
                           "--manager", artifact_dir / "omd-mod", "--node", node, "--store", platform_store)
        assert platform["host_mode"] == "platform" and not any(item["installed"] for item in platform["packages"])
        assert platform["installed_tools"] == [] and platform["plugin_bundle"] is None
        assert "export OMD_INSTALL_PROFILE=platform_only" in (base / "platform-bin/codex").read_text()
        assert call([base / "platform-bin/codex", "--version"], env, False) == "codex-cli 0.155.1"
        package = base / "user-counter"
        shutil.copytree(ROOT / "mods/examples/counter", package)
        declared = json.loads((package / "mod.json").read_text())
        declared["api"] = platform["mod_api"]
        (package / "mod.json").write_text(json.dumps(declared))
        manager = base / "platform-prefix/artifacts/omd-mod"
        inspected = call([manager, "inspect", package], env)
        call([manager, "trust", platform_store, package, inspected["sha256"],
              ",".join(declared["capabilities"])], env)
        call([manager, "enable", platform_store, package], env)
        author = command("platform", "status")
        assert [item["id"] for item in author["other_active_mods"]] == ["counter"]
        scenario = base / "author-scenario.json"
        scenario.write_text(json.dumps({"schema": 1, "steps": [
            {"type": "invoke", "mod": "counter", "event": "tool", "name": "count",
             "payload": {}, "expect": {"count": 1}}]}))
        offline = call([manager, "test", platform_store, scenario], env)
        assert offline["steps"][0]["value"] == {"count": 1}
        call([manager, "disable", platform_store, package], env)
        assert command("platform", "status")["other_active_mods"] == []
        command("platform", "activate", "direct")
        assert command("platform", "status")["host_mode"] == "upstream_direct"
        command("platform", "activate", "platform")
        command("platform", "uninstall")
        assert platform_store.is_dir()
        observations["platform"] = {"empty_first_party": True, "user_mod_tool": offline["steps"][0]["value"],
                                    "disable": True, "direct_switch": True, "store_preserved": True}

        full_store = base / "full-store"
        install = ["install", "--profile", "full", "--binary", artifact_dir / "codex",
                   "--manager", artifact_dir / "omd-mod", "--node", node, "--store", full_store]
        for name in TOOLS:
            install += [f"--{name}", artifact_dir / name]
        full = command("full", *install)
        active = [item["id"] for item in full["packages"] if item["loaded_by_profile"]]
        assert active == ["omd_workspace"]
        assert all(item["installed"] and item["pinned_source_current"] and not item["error"]
                   for item in full["packages"])
        assert set(full["installed_tools"]) == set(TOOLS)
        assert "export OMD_INSTALL_PROFILE=full" in (base / "full-bin/codex").read_text()
        for name in TOOLS:
            probe = subprocess.run([base / "full-bin" / name, "--help"], cwd=ROOT, env=env,
                                   capture_output=True, text=True)
            assert probe.returncode == 1 and f"usage: {name}" in probe.stdout + probe.stderr
        bundle = Path(full["plugin_bundle"]["marketplace"])
        assert len(full["plugin_bundle"]["plugins"]) == 6
        assert not (bundle / "plugins/omd-code-execution").exists()
        assert not (base / "full-prefix/browser").exists()
        assert not (base / "full-prefix/artifacts/codex-code-mode-host").exists()
        assert not (base / "full-prefix/artifacts/omd-browser").exists()
        staged_skills = {}
        inert_hooks = []
        for identifier in full["plugin_bundle"]["plugins"]:
            plugin_root = bundle / "plugins" / identifier
            plugin = json.loads((plugin_root / ".codex-plugin/plugin.json").read_text())
            skill_root = plugin_root / plugin["skills"] if "skills" in plugin else None
            skills = sorted(skill_root.glob("*/SKILL.md")) if skill_root else []
            if skill_root:
                assert skills
            staged_skills[identifier] = len(skills)
            hooks = plugin_root / "hooks/hooks.json"
            if hooks.is_file():
                declared_hooks = json.loads(hooks.read_text())["hooks"]
                scripts = sorted({item["command"].split("${PLUGIN_ROOT}/")[1].split('"')[0]
                                  for groups in declared_hooks.values() for group in groups
                                  for item in group["hooks"]})
                for script in scripts:
                    inactive_env = env.copy()
                    inactive_env.pop("OMD_CONTROLLED_MANIFEST", None)
                    inactive_env["OMD_MODE"] = "platform"
                    probe = subprocess.run(["python3", plugin_root / script], input="{}", text=True,
                                           capture_output=True, env=inactive_env, cwd=ROOT)
                    assert probe.returncode == 0 and not probe.stdout and not probe.stderr
                    inert_hooks.append(f"{identifier}/{script}")
        plugin_list = call([base / "full-bin/codex", "plugin", "list", "--json"], env)
        assert plugin_list["installed"] == []
        call([base / "full-bin/codex", "plugin", "marketplace", "add", bundle, "--json"], env)
        for identifier in full["plugin_bundle"]["plugins"]:
            plugin = call([base / "full-bin/codex", "plugin", "add", f"{identifier}@oh-my-diff", "--json"], env)
            assert plugin["name"] == identifier
            listed = call([base / "full-bin/codex", "plugin", "list", "--json"], env)
            assert any(item.get("name") == identifier for item in listed["installed"])
            call([base / "full-bin/codex", "plugin", "remove", f"{identifier}@oh-my-diff"], env, False)
        assert call([base / "full-bin/codex", "plugin", "list", "--json"], env)["installed"] == []
        disabled = command("full", "mod", "disable", "omd_workspace")
        assert not next(item for item in disabled["packages"] if item["id"] == "omd_workspace")["enabled_in_store"]
        side_by_side = command("full-upgrade", *(install + ["--attach-store"]))
        assert not next(item for item in side_by_side["packages"] if item["id"] == "omd_workspace")["enabled_in_store"]
        command("full-upgrade", "uninstall")
        assert (base / "full-bin/codex").is_file()
        assert not next(item for item in command("full", "status")["packages"]
                        if item["id"] == "omd_workspace")["enabled_in_store"]
        controlled_manifest = base / "controlled-manifest.json"
        controlled_manifest.write_text(json.dumps({"mods": str(full_store)}))
        controlled = command("full", "activate", "controlled", "--manifest", controlled_manifest)
        assert controlled["host_mode"] == "enabled"
        assert controlled["controlled_manifest"] == str(controlled_manifest)
        direct = command("full", "activate", "direct")
        assert not any(item["loaded_by_profile"] for item in direct["packages"])
        try:
            command("full", "uninstall")
        except RuntimeError as error:
            assert "marketplace" in str(error) and "references the installation" in str(error)
        else:
            raise AssertionError("uninstall removed an installed marketplace source")
        call([base / "full-bin/codex", "plugin", "marketplace", "remove", "oh-my-diff"], env, False)
        note = base / "full-prefix/personal-note.txt"
        note.write_text("User file to preserve\n")
        try:
            command("full", "uninstall")
        except RuntimeError as error:
            assert "unmanaged files" in str(error) and note.is_file()
        else:
            raise AssertionError("uninstall removed an unmanaged user file")
        note.unlink()
        command("full", "uninstall")
        assert full_store.is_dir() and tomllib.loads(sentinel.read_text())["model"] == "preserve-user-choice"
        attached = command("full", *(install + ["--attach-store"]))
        assert not any(item["loaded_by_profile"] for item in attached["packages"])
        enabled = command("full", "mod", "enable", "omd_workspace")
        assert next(item for item in enabled["packages"] if item["id"] == "omd_workspace")["loaded_by_profile"]
        command("full", "uninstall")
        observations["full"] = {"installed_mods": [item["id"] for item in full["packages"]],
                                "default_active": active, "staged_plugins": full["plugin_bundle"]["plugins"],
                                "inert_tool_binaries": full["installed_tools"],
                                "plugin_explicit_install_remove": full["plugin_bundle"]["plugins"], "disable": True,
                                "staged_skills": staged_skills, "inactive_hook_noops": inert_hooks,
                                "controlled_manifest_selection": True, "direct_switch": True,
                                "marketplace_reference_protected": True,
                                "unmanaged_user_file_protected": True,
                                "attach_preserved_disable": True,
                                "side_by_side_attach_preserved_disable": True,
                                "state_preserved": True}
    result = {"status": "pass", "candidate_lock_sha256": private.digest(ROOT / "runtime/lean-candidate.lock.json"),
              "artifact_sha256": {name: private.digest(artifact_dir / name) for name in ("codex", "omd-mod", *TOOLS)},
              "elapsed_seconds": time.monotonic() - started, "checks": observations,
              "scope": "isolated local profile, package and author operations; no provider request or independent author"}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    print(json.dumps(result))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifact-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    run(args.artifact_dir.resolve(), args.output.resolve())


if __name__ == "__main__":
    main()
