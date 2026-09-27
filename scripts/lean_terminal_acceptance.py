#!/usr/bin/env python3
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import struct
import subprocess
import tempfile
import termios
import time

try:
    from scripts import private_lean_v1 as private
except ModuleNotFoundError:
    import private_lean_v1 as private


ROOT = Path(__file__).resolve().parents[1]
TOOLS = ("omd-graph", "omd-health", "omd-lsp")


def call(args, env):
    result = subprocess.run([str(item) for item in args], cwd=ROOT, env=env,
                            capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError((result.stderr or result.stdout)[-1200:])
    return json.loads(result.stdout)


def terminal(binary, repo, env, width, expected):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 28, width, 0, 0))
    process = subprocess.Popen([str(binary), "-C", str(repo)], cwd=repo, env=env,
                               stdin=slave, stdout=slave, stderr=slave,
                               start_new_session=True)
    os.close(slave)
    output = bytearray()

    def read_until(phrase, seconds):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            ready, _, _ = select.select([master], [], [], 0.2)
            if ready:
                try:
                    output.extend(os.read(master, 65536))
                except OSError:
                    break
            if phrase in re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", output.decode(errors="replace")):
                return True
        return False

    try:
        title = "Oh My Diffed" if width >= 40 else "OMD (v"
        if not read_until(title, 8):
            raise AssertionError("release terminal title was not visible")
        os.write(master, b"/status")
        read_until("show current session configuration", 4)
        os.write(master, b"\r")
        if not read_until(expected, 8):
            clean = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", output.decode(errors="replace"))
            raise AssertionError(f"release terminal status did not show {expected}: {clean[-700:]}")
        clean = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", output.decode(errors="replace"))
        return {"width": width, "title_visible": title in clean,
                "status_visible": expected in clean,
                "trace_sha256": hashlib.sha256(output).hexdigest(),
                "plain_excerpt": clean[-600:]}
    finally:
        os.close(master)
        if process.poll() is None:
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                if process.poll() is None:
                    process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    if process.poll() is None:
                        process.kill()
                    process.wait(timeout=10)


def run(artifact_dir, upstream, output):
    if output.exists():
        raise ValueError("evidence output already exists")
    node = Path(subprocess.check_output(["mise", "which", "node"], cwd=ROOT, text=True).strip()).resolve()
    with tempfile.TemporaryDirectory(prefix="omd-terminal-acceptance-", dir="/private/tmp") as temporary:
        base = Path(temporary)
        home = base / "codex-home"
        home.mkdir()
        shutil.copy2(ROOT / "benchmarks/fixtures/controlled-models.json", home / "models.json")
        repo = base / "repo"
        repo.mkdir()
        (home / "config.toml").write_text(
            'model = "gpt-5.6-sol"\nmodel_provider = "omd_local_probe"\n'
            f'model_catalog_json = {json.dumps(str(home / "models.json"))}\n'
            'check_for_update_on_startup = false\n'
            '[features]\ndaemon_auto_start = false\n'
            '[model_providers.omd_local_probe]\nname = "Local inactive probe"\n'
            'base_url = "http://127.0.0.1:9/v1"\nwire_api = "responses"\n'
            'requires_openai_auth = false\n'
            f'[projects.{json.dumps(str(repo))}]\ntrust_level = "trusted"\n'
        )
        env = os.environ.copy()
        env.update(CODEX_HOME=str(home), CODEX_SQLITE_HOME=str(home), TERM="xterm-256color")
        env["PATH"] = str(upstream.parent) + os.pathsep + env.get("PATH", "")
        observations = {}
        for profile, expected in (("platform", "Modding platform only"), ("full", "Full OMD")):
            prefix = base / f"{profile}-prefix"
            bin_dir = base / f"{profile}-bin"
            store = base / f"{profile}-store"
            command = ["python3", "-m", "scripts.lean_profiles", "--prefix", prefix,
                       "--bin-dir", bin_dir]
            install = ["install", "--profile", profile, "--binary", artifact_dir / "codex",
                       "--manager", artifact_dir / "omd-mod", "--omd", artifact_dir / "omd", "--author-archive", artifact_dir / "mod-api.tgz",
                       "--node", node, "--store", store]
            if profile == "full":
                for name in TOOLS:
                    install += [f"--{name}", artifact_dir / name]
            call(command + install, env)
            observations[profile] = terminal(bin_dir / "codex", repo, env, 80, expected)
            if profile == "full":
                call(command + ["mod", "disable", "omd_workspace"], env)
                observations["full_disabled_narrow"] = terminal(bin_dir / "codex", repo, env, 24, expected)
            call(command + ["activate", "direct"], env)
            observations[f"{profile}_direct"] = terminal(bin_dir / "codex", repo, env, 80,
                                                           "upstream-style direct")
            call(command + ["uninstall"], env)
    result = {"status": "pass", "candidate_lock_sha256": private.digest(ROOT / "runtime/lean-release.lock.json"),
              "artifact_sha256": private.digest(artifact_dir / "codex"),
              "checks": observations,
              "scope": "isolated local PTY title and status with an inactive loopback provider; no model request"}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    print(json.dumps({"status": result["status"], "checks": list(observations)}))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifact-dir", type=Path, required=True)
    parser.add_argument("--upstream", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    run(args.artifact_dir.resolve(), args.upstream.resolve(), args.output.resolve())


if __name__ == "__main__":
    main()
