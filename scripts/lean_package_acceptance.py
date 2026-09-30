#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile

try:
    from scripts import install_support as support
    from scripts import lean_profiles
except ModuleNotFoundError:
    import install_support as support
    import lean_profiles


ROOT = Path(__file__).resolve().parents[1]


def call(arguments, environment, expect_failure=False, parse=True):
    result = subprocess.run([str(value) for value in arguments], cwd=ROOT, env=environment,
                            capture_output=True, text=True)
    if expect_failure:
        if result.returncode == 0:
            raise AssertionError(f"command unexpectedly passed: {arguments[:4]}")
        return (result.stderr or result.stdout).strip()
    if result.returncode:
        raise RuntimeError(f"command failed: {arguments[:4]}: {(result.stderr or result.stdout)[-1200:]}")
    return json.loads(result.stdout) if parse else result.stdout.strip()


def run(archive, sha256, upstream, output):
    if output.exists():
        raise ValueError("evidence output already exists")
    node = Path(subprocess.check_output(["mise", "which", "node"], cwd=ROOT, text=True).strip())
    with tempfile.TemporaryDirectory(prefix="omd-package-acceptance-", dir="/private/tmp") as temporary:
        base = Path(temporary)
        home = base / "codex-home"
        session = home / "sessions/2026/09/23/package-smoke.jsonl"
        session.parent.mkdir(parents=True)
        files = {home / "config.toml": 'model = "preserve-user-choice"\n',
                 home / "auth.json": "{}\n",
                 session: '{"type":"preserve-session"}\n'}
        for path, content in files.items():
            path.write_text(content)
        initial = {str(path.relative_to(home)): support.digest(path) for path in files}
        environment = os.environ.copy()
        environment.update(CODEX_HOME=str(home), CODEX_SQLITE_HOME=str(home))
        environment["PATH"] = str(upstream.parent) + os.pathsep + environment.get("PATH", "")
        checks = {}
        for profile in ("platform", "full"):
            prefix = base / f"{profile}-prefix"
            bin_dir = base / f"{profile}-bin"
            store = base / f"{profile}-store"
            install = ["python3", "-m", "scripts.lean_package", "install", "--archive", archive,
                       "--sha256", sha256, "--upstream", upstream, "--profile", profile,
                       "--prefix", prefix, "--bin-dir", bin_dir, "--store", store, "--node", node]
            if profile == "platform":
                error = call([*install[:7], "0" * 64, *install[8:]], environment, True)
                assert "SHA-256 mismatch" in error and not prefix.exists()
            call(install, environment, parse=False)
            status = call([bin_dir / "omd-package", "status"], environment)
            assert status["profile"] == profile and status["package_control"] == str(bin_dir / "omd-package")
            assert status["author"]["files"] and (bin_dir / "omd-mod-author").is_file()
            assert {item["id"] for item in status["packages"] if item["installed"]} == set(lean_profiles.profile_packages(profile))
            assert status["installer_configured_optional_services"] == []
            assert not any((prefix / name).exists() for name in
                           ("browser", "bridge", "mcp", "sidecar", "code-mode"))
            if profile == "platform":
                assert set(status["installed_tools"]) == {"omd", "omd-contract"} and status["plugin_bundle"] is None
                assert [item["id"] for item in status["packages"] if item["installed"]] == ["omd_logo"]
                assert [item["id"] for item in status["packages"] if item["loaded_by_profile"]] == ["omd_logo"]
            else:
                assert set(status["installed_tools"]) == {"omd", "omd-contract"}
                assert [item["id"] for item in status["packages"] if item["loaded_by_profile"]] == ["omd_inspector", "omd_logo", "omd_model_picker", "omd_workspace"]
                assert {item["id"] for item in status["packages"] if item["active"]} == set(lean_profiles.DEFAULT_ACTIVE)
                assert len(status["plugin_bundle"]["plugins"]) == 7
                disabled = call([bin_dir / "omd-package", "mod", "disable", "omd_workspace"], environment)
                assert not next(item for item in disabled["packages"]
                                if item["id"] == "omd_workspace")["enabled_in_store"]
                enabled = call([bin_dir / "omd-package", "mod", "enable", "omd_workspace"], environment)
                assert next(item for item in enabled["packages"]
                            if item["id"] == "omd_workspace")["loaded_by_profile"]
            direct = call([bin_dir / "omd-package", "activate", "direct"], environment)
            assert direct["host_mode"] == "upstream_direct"
            removed = call([bin_dir / "omd-package", "uninstall"], environment)
            assert removed["upstream"] == str(upstream) and store.is_dir()
            assert not prefix.exists() and not (bin_dir / "codex").exists()
            checks[profile] = {"archive_install": True, "installed_control": True,
                               "author_tools": True, "direct_switch": True,
                               "optional_services_absent": True, "upstream_restore": True,
                               "store_preserved": True}
        assert {str(path.relative_to(home)): support.digest(path) for path in files} == initial
    with tarfile.open(archive, "r:xz") as packed:
        archive_lock = packed.extractfile("payload/runtime/lean-release.lock.json").read()
    result = {"status": "pass", "archive_sha256": support.digest(archive),
              "archive_release_lock_sha256": hashlib.sha256(archive_lock).hexdigest(),
              "prebuilt_release_lock_sha256": support.digest(ROOT / "runtime/lean-release.lock.json"),
              "checks": checks, "shared_state_preserved": True,
              "scope": "isolated Apple Silicon archive install; no provider or subscription request"}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    print(json.dumps(result))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--upstream", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    run(args.archive.resolve(), args.sha256, args.upstream.resolve(), args.output.resolve())


if __name__ == "__main__":
    main()
