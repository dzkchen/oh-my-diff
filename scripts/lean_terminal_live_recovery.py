#!/usr/bin/env python3
"""One same-process, zero-provider PTY recovery case using existing mod commands."""
import argparse
import importlib.metadata
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

from scripts import install_support as support, lean_profiles
from scripts.lean_profile_acceptance import isolated_environment
from scripts.lean_terminal_acceptance import ROOT, call, terminal, native_blossom_visible


FIXTURE_ERROR = "intentional isolated live appearance fixture"


def fixture_failed(status):
    return any(item["id"] == "omd_usage" and FIXTURE_ERROR in (item["error"] or "")
               for item in status["mods"])


def run(artifacts, upstream, output):
    import pyte

    if output.exists():
        raise ValueError("evidence output already exists")
    version = json.loads((ROOT / "upstream.lock.json").read_text())["tag"].removeprefix("rust-v")
    node = Path(subprocess.check_output(["mise", "which", "node"], cwd=ROOT, text=True).strip()).resolve()
    operations = []
    result = {"status": "partial", "operations": operations,
        "artifact_sha256": support.digest(artifacts / "codex"),
        "candidate_lock_sha256": support.digest(ROOT / "runtime/lean-release.lock.json"),
        "fixture_sha256": support.digest(Path(__file__)),
        "terminal_fixture_sha256": support.digest(ROOT / "scripts/lean_terminal_acceptance.py"),
        "screen_parser": {"package": "pyte", "version": importlib.metadata.version("pyte"),
            "source_sha256": support.digest(Path(pyte.__file__)),
            "screen_source_sha256": support.digest(Path(pyte.screens.__file__)),
            "stream_source_sha256": support.digest(Path(pyte.streams.__file__))},
        "scope": "one live OMD+ process; manager usage disable and trusted broken/repaired usage source; explicit existing TUI command reload boundary; no prompt or model request",
        "limits": ["manager reload is queued; the existing inspector close slash command explicitly reloads the TUI command host and publishes its presentation preview",
            "native task host caches are recorded separately from TUI command previews; no accepted-turn reload claim",
            "simulated xterm screen parsing, not physical terminal painting"]}

    def save():
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")

    with tempfile.TemporaryDirectory(prefix="omd-terminal-live-recovery-", dir="/private/tmp") as temporary:
        base = Path(temporary)
        home, repo = base / "codex-home", base / "repo"
        home.mkdir()
        repo.mkdir()
        shutil.copy2(ROOT / "tests/fixtures/controlled-models.json", home / "models.json")
        (home / "config.toml").write_text(
            'model = "gpt-5.6-sol"\nmodel_provider = "omd_local_probe"\n'
            f'model_catalog_json = {json.dumps(str(home / "models.json"))}\n'
            'check_for_update_on_startup = false\n[features]\ndaemon_auto_start = false\n'
            '[model_providers.omd_local_probe]\nname = "Local inactive probe"\n'
            'base_url = "http://127.0.0.1:9/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n'
            f'[projects.{json.dumps(str(repo))}]\ntrust_level = "trusted"\n')
        env = isolated_environment(base, home, upstream)
        env["TERM"] = "xterm-256color"
        for name in ("FORCE_COLOR", "COLORTERM", "NO_COLOR", "TMUX", "TMUX_PANE",
                     "SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY", "TERM_PROGRAM"):
            env.pop(name, None)
        prefix, bin_dir, store = base / "prefix", base / "bin", base / "store"
        command = ["python3", "-m", "scripts.lean_profiles", "--prefix", prefix, "--bin-dir", bin_dir]
        call(command + ["install", "--profile", "full", "--binary", artifacts / "codex",
            "--manager", artifacts / "omd-mod", "--omd", artifacts / "omd",
            "--omd-contract", artifacts / "omd-contract", "--author-archive", artifacts / "mod-api.tgz",
            "--node", node, "--store", store], env)
        manager = prefix / "artifacts/omd-mod"
        call([manager, "settings", store, store / "sources/omd_usage", json.dumps({"budget_usd": 7.77})], env)
        call(command + ["mod", "enable", "omd_usage"], env)

        def exercise(send, read_frame, visible, mark_visible, capture, process, cache_events):
            pid = process.pid
            initial = json.loads((store / "mod-view.json").read_text())
            thread = initial["input"]["presentation"]["thread_id"]
            assert thread and initial["input"]["presentation"]["phase"] == "fresh"

            def appearance(theme=True, note=None, broken=False):
                return (visible(f"OpenAI Codex (v{version})")
                    and visible("| OMD+") and visible("Budget $0.00 of $") == theme
                    and (not note or visible(note))
                    and (not broken or (visible("1 failed") and
                         fixture_failed(json.loads((store / "mod-status.json").read_text()))))
                    and not native_blossom_visible(capture()["screen"]))

            def boundary(label, theme=True, note=None, broken=False,
                         invocation="omd_inspector:inspect close"):
                assert process.pid == pid and process.poll() is None
                status = call([manager, "status", store], env)
                config = json.loads((store / "mods.json").read_text())
                operations.append({"stage": label, "pid": pid, "store_revision": config["revision"],
                    "configuration_sha256": support.digest(store / "mods.json"),
                    "manager_status": status,
                    "boundary": "/" + invocation + " (existing local user command; no model turn)"})
                send(("/" + invocation).encode(), label + "_completion", lambda: visible("› /" + invocation))
                send(b"\r", label, lambda: appearance(theme, note, broken))
                current = json.loads((store / "mod-view.json").read_text())
                assert current["input"]["presentation"] == initial["input"]["presentation"]
                rollout_records = [json.loads(line) for path in (home / "sessions").rglob("*.jsonl")
                                   for line in path.read_text().splitlines() if line.strip()]
                assert not any(record.get("type") == "response_item" and
                    record.get("payload", {}).get("role") in ("user", "assistant")
                    or record.get("type") == "event_msg" and
                    record.get("payload", {}).get("type") in ("user_message", "task_started", "agent_message")
                    for record in rollout_records), "a model turn unexpectedly entered rollout history"
                operations[-1]["rollout_record_types"] = [record.get("type") for record in rollout_records]
                operations[-1]["native_cache_presentation"] = current["input"]["presentation"]
                operations[-1]["native_view_sha256"] = support.digest(store / "mod-view.json")
                operations[-1]["native_status_sha256"] = support.digest(store / "mod-status.json")
                save()
                print(json.dumps({"stage": label, "status": "pass", "pid": pid}), flush=True)
                return status

            identifier = "omd_usage"
            source = store / "sources" / identifier
            call(command + ["mod", "disable", identifier], env)
            boundary(identifier + "_live_disabled", theme=False)
            entry = source / "index.ts"
            original = entry.read_bytes()
            declared = json.loads((source / "mod.json").read_text())

            def trust_reload():
                inspected = call([manager, "inspect", source], env)
                call([manager, "trust", store, source, inspected["sha256"], ",".join(declared["capabilities"])], env)
                call([manager, "enable", store, source], env)
                call([manager, "reload", store], env)
                return inspected["sha256"]

            try:
                entry.write_text(f"throw new Error('{FIXTURE_ERROR}');\n")
                broken_digest = trust_reload()
                status = boundary(identifier + "_live_broken", theme=False, broken=True)
                assert fixture_failed(status), "trusted package did not report the fixture error"
                operations[-1]["trusted_source_sha256"] = broken_digest
            finally:
                entry.write_bytes(original)
                repaired_digest = trust_reload()
            healthy = boundary(identifier + "_live_repaired", note="Soft budget $8.88",
                invocation="omd_usage:budget 8.88")
            assert all(item["error"] is None for item in healthy["mods"])
            assert not healthy["rejected"] and healthy["reload_error"] is None
            operations[-1]["trusted_source_sha256"] = repaired_digest
            return {"pid": pid, "thread_id": thread, "process_count": 1, "model_prompts": 0,
                "model_provider": "inactive loopback port 9", "native_cache_initial_input": initial["input"]}

        try:
            result["check"] = terminal(bin_dir / "codex", repo, env, 80, version,
                profile="OMD+", backdrop="Budget $0.00 of $7.77",
                cache_store=store, startup_seconds=15,
                live_mods=(*lean_profiles.DEFAULT_ACTIVE, "omd_usage"),
                trace_path=output.with_suffix(".trace"), live_recovery=exercise)
            result["status"] = "pass"
        except Exception as error:
            result.update(status="fail", error=str(error))
            raise
        finally:
            save()
        call(command + ["uninstall"], env)
    print(json.dumps({"status": result["status"], "live_stages": len(operations)}), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    for name in ("artifact-dir", "upstream", "output"):
        parser.add_argument("--" + name, type=Path, required=True)
    args = parser.parse_args()
    run(args.artifact_dir.resolve(), args.upstream.resolve(), args.output.resolve())
