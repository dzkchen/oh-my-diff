import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
from types import SimpleNamespace

from .first_run_live_smoke import ROOT, load_key, prepare
from .gateway import Budget, Gateway
from .mod_fixture import install


CAPABILITIES = {
    "delegation": True, "escalation": True, "checkpoints": True,
    "guidelines": True, "repository_knowledge": True, "code_graph": True,
    "code_health": True, "semantic_lsp": True, "reactive_rules": True,
    "unified_review": True, "completion_gate": True, "terminal": True,
    "application_bridge": False,
}


def captured_text(value):
    return value.decode(errors="replace") if isinstance(value, bytes) else (value or "")


def native_rate(model):
    input_rate, cached_rate, output_rate, reservation, ceiling = {
        "gpt-5.6-sol": (5000000, 400000, 20000000, 1080000, 200000),
        "gpt-6-astra": (12500000, 1000000, 50000000, 1200000, 80000),
        "muse-spark-1.3-contributor": (100000, 2000, 200000, 14000, 120000),
    }[model]
    return {"input_microusd_per_million": input_rate,
            "cached_microusd_per_million": cached_rate,
            "output_microusd_per_million": output_rate,
            "reservation_microusd": reservation, "max_output_tokens": 4000,
            "input_token_ceiling": ceiling, "included_subscription": False}


def setup(destination, node, gateway, arm):
    raise RuntimeError("legacy live controlled fixture requires a rebuilt OMD_MODE=omd mod workflow, host routes, and contract before provider use")
    repo, home, env = prepare(destination, node, gateway.port, gateway.token, "direct")
    shell_home = repo / ".omd-cache"
    shell_home.mkdir()
    exclude = repo / ".git/info/exclude"
    exclude.write_text(exclude.read_text() + "\n.omd/\n.omd-cache/\n")
    catalog = json.loads((home / "models.json").read_text())
    sol = next(item for item in catalog["models"] if item["slug"] == "gpt-5.6-sol")
    muse = dict(sol)
    muse.update(slug="muse-spark-1.3-contributor", display_name="Muse Spark 1.3 Contributor",
                use_responses_lite=False, apply_patch_tool_type=None,
                supports_parallel_tool_calls=False)
    catalog["models"].append(muse)
    (home / "models.json").write_text(json.dumps(catalog))
    config = (home / "config.toml").read_text().replace(
        f'HOME = {json.dumps(str(repo))}', f'HOME = {json.dumps(str(shell_home))}')
    for provider in ("omd_openai_astra", "omd_meta_api"):
        config += (f'\n[model_providers.{provider}]\nname = "Bounded {provider}"\n'
                   f'base_url = "http://127.0.0.1:{gateway.port}/{provider}"\n'
                   'wire_api = "responses"\nenv_key = "OMD_GATEWAY_TOKEN"\n'
                   'requires_openai_auth = false\nsupports_websockets = false\n'
                   'request_max_retries = 0\nstream_max_retries = 0\n')
    (home / "config.toml").write_text(config)
    grant = destination / "grant.json"
    grant.write_text(json.dumps({"schema": 1, "data_authorized": True, "revocable": True,
                                 "split": "development", "repositories": ["synthetic-fixture"]}))
    def route(model):
        provider = {"gpt-5.6-sol": "omd_openai_api", "gpt-6-astra": "omd_openai_astra",
                    "muse-spark-1.3-contributor": "omd_meta_api"}[model]
        return {"model": model, "provider": provider, "reasoning_effort": "low",
                "responses_url": f"http://127.0.0.1:{gateway.port}/{provider}/responses",
                "rates": native_rate(model)}

    manifest = {
        "repository": str(repo), "evidence": str(destination / "evidence"),
        "scratch": str(repo / ".omd"), "authorization": str(grant),
        "authorization_sha256": hashlib.sha256(grant.read_bytes()).hexdigest(),
        "repository_identity": "synthetic-fixture", "approved_untracked": [],
        "limits": {"requests": 16, "exposure_microusd": 2500000, "seconds": 240,
                   "concurrent_workers": 2, "max_depth": 2, "max_reassessments": 1},
        "worker_limits": {"requests": 5, "exposure_microusd": 500000, "seconds": 90},
        "capabilities": CAPABILITIES,
        "communication": {"concise_user_updates": False, "structured_worker_reports": False},
        "checkpoint": {"objective": "Fix solution.py so add returns the sum while preserving unrelated work.",
                       "acceptance_criteria": ["Python tests pass", "separate exact-candidate review approves",
                                               "reviewed change integrates without losing unrelated work"],
                       "max_no_progress_calls": 2},
        "legitimate_wait_tools": ["wait_agent", "write_stdin", "wait"],
        "lifecycle": {"explicit_resume": None},
        "recovery": {"contributor_attempts": 2, "equivalent_failure_threshold": 2,
                     "fallback_to_opposite_lead": True},
        "lead_policy": {"mode": "fixed", "lead": "sol"},
        "leads": {"sol": route("gpt-5.6-sol"), "astra": route("gpt-6-astra")},
        "context_policy": {"mode": "focused_brief", "max_bytes": 2000000},
        "worker_contexts": [{"mode": "parent_history", "max_bytes": 2000000}],
        "escalation": {"allowed_failure_classes": ["environment", "edit", "diagnosis", "model"],
                       "max_attempts": 1, "evidence_bytes": 100000},
        "worker": route("muse-spark-1.3-contributor"),
        "check_command": ["/usr/bin/python3", "-m", "unittest", "test_solution.py"],
        "toolchain_reads": ["/Library/Developer/CommandLineTools"],
        "snapshot_bytes": 4000000, "max_request_bytes": 2000000,
    }
    if arm == "preview":
        install(destination, manifest, node, "coordination-task-entry")
    path = destination / "manifest.json"
    path.write_text(json.dumps(manifest, indent=2))
    env.update(OMD_MODE="enabled", OMD_CONTROLLED_MANIFEST=str(path))
    return repo, env


def run(binary, output, arms, usd_exposure, max_requests):
    raise RuntimeError("legacy live controlled fixture requires a rebuilt OMD_MODE=omd mod workflow, host routes, and contract before provider use")
    if output.exists():
        raise ValueError("output already exists")
    output.mkdir(parents=True)
    load_key()
    for line in (ROOT / ".env").read_text().splitlines():
        name, separator, value = line.strip().removeprefix("export ").partition("=")
        if separator and name.strip() == "museapi":
            os.environ["OMD_LIVE_META_KEY"] = value.strip().strip("\"'")
            break
    if not os.environ.get("OMD_LIVE_META_KEY"):
        raise RuntimeError("Meta Contributor credential is unavailable")
    node = Path(subprocess.check_output(["mise", "which", "node"], cwd=ROOT, text=True).strip()).resolve()
    sol = {"url": "https://api.openai.com/v1", "credential_env": "OMD_LIVE_OPENAI_KEY",
             "models": ["gpt-5.6-sol"], "account_alias": "user-api-key",
             "billing": "estimate", "request_exposure_usd": "1.08",
             "settle_completed_usage": True, "timeout_seconds": 120,
             "rate_card": "GPT-5.6 Sol standard ceiling 2026-09-23",
             "rates": {"input": "4", "cache_read": "0.40", "cache_write": "5", "output": "20"},
             "bounds": {"input_token_ceiling": 200000, "input_accounting": "observed-prefix-v1", "output_tokens": 4000,
                        "requests_per_session": 20, "input_items": 128}}
    astra = {"url": "https://api.openai.com/v1", "credential_env": "OMD_LIVE_OPENAI_KEY",
             "models": ["gpt-6-astra"], "account_alias": "user-api-key",
             "billing": "estimate", "request_exposure_usd": "1.20",
             "settle_completed_usage": True, "timeout_seconds": 120,
             "rate_card": "GPT-6 Astra standard ceiling 2026-09-23",
             "rates": {"input": "10", "cache_read": "1", "cache_write": "12.50", "output": "50"},
             "bounds": {"input_token_ceiling": 80000, "input_accounting": "observed-prefix-v1", "output_tokens": 4000,
                        "requests_per_session": 20, "input_items": 128}}
    meta = {"url": "https://api.meta.ai/v1", "credential_env": "OMD_LIVE_META_KEY",
            "models": ["muse-spark-1.3-contributor"], "account_alias": "user-meta-api-key",
            "billing": "estimate", "request_exposure_usd": "0.014",
            "settle_completed_usage": True, "timeout_seconds": 120,
            "rate_card": "Meta Contributor 2026-09-23 synthetic-only",
            "rates": {"input": "0.10", "cache_read": "0.002", "cache_write": "0.10", "output": "0.20"},
            "bounds": {"input_token_ceiling": 120000, "input_accounting": "observed-prefix-v1", "output_tokens": 4000,
                       "requests_per_session": 20, "input_items": 128}}
    budget = Budget({"seconds": 12600, "requests": max_requests, "max_output_tokens": 4000,
                     "max_request_bytes": 1000000, "max_response_bytes": 4000000,
                     "usd_exposure": usd_exposure}, output / "budget")
    started = time.monotonic()
    results = []
    for arm in arms:
        destination = output / arm
        destination.mkdir()
        with Gateway({"omd_openai_api": sol, "omd_openai_astra": astra,
                      "omd_meta_api": meta}, budget, destination) as gateway:
            repo, env = setup(destination, node, gateway, arm)
            prompt = ("Fix solution.py so add returns the sum. Preserve unrelated files. "
                      "Use OMD's reviewed contribution exactly once to make the edit, run "
                      "/usr/bin/python3 -m unittest test_solution.py, and complete the "
                      "task with an exact-candidate review.")
            arm_started = time.monotonic()
            try:
                process = subprocess.run([str(binary), "exec", "--json", "--skip-git-repo-check", prompt],
                                         cwd=repo, env=env, stdin=subprocess.DEVNULL,
                                         capture_output=True, text=True,
                                         timeout=min(360, budget.remaining_seconds()))
            except subprocess.TimeoutExpired as error:
                process = SimpleNamespace(returncode=124,
                                          stdout=captured_text(error.stdout),
                                          stderr=captured_text(error.stderr))
            arm_elapsed = time.monotonic() - arm_started
            (destination / "stdout.jsonl").write_text(process.stdout)
            (destination / "stderr.txt").write_text(process.stderr)
        check = subprocess.run(["/usr/bin/python3", "-m", "unittest", "test_solution.py"],
                               cwd=repo, capture_output=True, text=True)
        receipts = list((destination / "evidence").glob("completion-receipt-*.json"))
        result = {"arm": arm, "elapsed_seconds": arm_elapsed,
                  "exit_code": process.returncode,
                  "test_exit_code": check.returncode, "test_output": check.stdout + check.stderr,
                  "notes_preserved": (repo / "notes.txt").read_text() == "Keep these notes.\n",
                  "unrelated_preserved": (repo / "unrelated.txt").read_text() == "Uncommitted user work\n",
                  "solution_sha256": hashlib.sha256((repo / "solution.py").read_bytes()).hexdigest(),
                  "requests": len(gateway.ledger()),
                  "request_statuses": [item["status"] for item in gateway.ledger()],
                  "completion_receipts": [(record.get("receipt") or record).get("status")
                                          for path in receipts
                                          if (record := json.loads(path.read_text()))],
                  "mod_status": json.loads((destination / "evidence/mod-status.json").read_text())
                  if (destination / "evidence/mod-status.json").exists() else None}
        results.append(result)
        (destination / "result.json").write_text(json.dumps(result, indent=2) + "\n")
        if budget.stopped or budget.remaining_seconds() < 360:
            break
    summary = {"binary_sha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
               "elapsed_seconds": time.monotonic() - started,
               "admitted_requests": budget.count,
               "reserved_or_settled_upper_usd": str(budget.reserved), "results": results}
    (output / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--bin", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--arms", choices=("baseline", "preview", "baseline,preview"), default="baseline,preview")
    parser.add_argument("--usd-exposure", default="1.5")
    parser.add_argument("--max-requests", type=int, default=20)
    args = parser.parse_args()
    run(args.bin.resolve(), args.output.resolve(), args.arms.split(","), args.usd_exposure, args.max_requests)


if __name__ == "__main__":
    main()
