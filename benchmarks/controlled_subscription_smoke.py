import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import threading
import time

from .controlled_live_smoke import ROOT, captured_text, setup
from .gateway import Budget, Gateway
from .qualification import credentials, quota


def subscription_route(models):
    return {"url": "https://chatgpt.com/backend-api/codex",
            "credential_env": "OMD_SUBSCRIPTION_ACCESS", "account_env": "OMD_SUBSCRIPTION_ACCOUNT",
            "models": models, "account_alias": "user-chatgpt-subscription",
            "billing": "subscription", "native_subscription": True,
            "included_usage_verified": True, "request_exposure_usd": "0",
            "timeout_seconds": 120,
            "bounds": {"input_accounting": "observed-prefix-v1", "input_token_ceiling": 240000,
                       "output_tokens": 32000, "requests_per_session": 40, "input_items": 512}}


def meta_route():
    return {"url": "https://api.meta.ai/v1", "credential_env": "OMD_LIVE_META_KEY",
            "models": ["muse-spark-1.3-contributor"], "account_alias": "user-meta-api-key",
            "billing": "estimate", "request_exposure_usd": "0.014",
            "settle_completed_usage": True, "timeout_seconds": 120,
            "rate_card": "Meta Contributor 2026-09-23 synthetic-only",
            "rates": {"input": "0.10", "cache_read": "0.002", "cache_write": "0.10", "output": "0.20"},
            "bounds": {"input_token_ceiling": 120000, "input_accounting": "observed-prefix-v1",
                       "output_tokens": 4000, "requests_per_session": 20, "input_items": 128}}


def load_meta_key():
    for line in (ROOT / ".env").read_text().splitlines():
        name, separator, value = line.strip().removeprefix("export ").partition("=")
        if separator and name.strip() == "museapi":
            os.environ["OMD_LIVE_META_KEY"] = value.strip().strip("\"'")
            return
    raise RuntimeError("Meta Contributor credential is unavailable")


def used_percent():
    return int(quota()["rate_limit"]["primary_window"]["used_percent"])


def stop_group(process):
    if process.poll() is None:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass


def run(binary, output, max_weekly_used_percent, deadline, usd_exposure):
    if output.exists():
        raise ValueError("output already exists")
    credentials()
    load_meta_key()
    before = used_percent()
    if before >= max_weekly_used_percent:
        raise ValueError("weekly quota guard is already reached")
    if datetime.now(timezone.utc) >= deadline:
        raise ValueError("elapsed qualification deadline has passed")
    output.mkdir(parents=True)
    node = Path(subprocess.check_output(["mise", "which", "node"], cwd=ROOT, text=True).strip()).resolve()
    budget = Budget({"seconds": min(600, int((deadline - datetime.now(timezone.utc)).total_seconds())),
                     "requests": 40, "max_output_tokens": 4000, "max_request_bytes": 1000000,
                     "max_response_bytes": 4000000, "usd_exposure": usd_exposure}, output / "budget")
    destination = output / "preview"
    destination.mkdir()
    samples = []
    stop_reason = []
    with Gateway({"omd_openai_api": subscription_route(["gpt-5.6-sol"]),
                  "omd_openai_astra": subscription_route(["gpt-6-astra"]),
                  "omd_meta_api": meta_route()}, budget, destination) as gateway:
        repo, env = setup(destination, node, gateway, "preview")
        manifest_path = destination / "manifest.json"
        manifest = json.loads(manifest_path.read_text())
        manifest["limits"]["requests"] = 32
        manifest["limits"]["seconds"] = 600
        for route in manifest["leads"].values():
            route["rates"].update(input_microusd_per_million=0, cached_microusd_per_million=0,
                                  output_microusd_per_million=0, reservation_microusd=0,
                                  included_subscription=True)
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
        for name in ("OMD_SUBSCRIPTION_ACCESS", "OMD_SUBSCRIPTION_ACCOUNT",
                     "OMD_LIVE_META_KEY", "OPENAI_API_KEY"):
            env.pop(name, None)
        prompt = ("Fix solution.py so add returns the sum. Preserve unrelated files. "
                  "Use OMD's reviewed contribution exactly once to make the edit, run "
                  "/usr/bin/python3 -m unittest test_solution.py, and complete the task "
                  "with an exact-candidate review. Call omd_complete only after the native "
                  "final review approves the current candidate; otherwise report blocked.")
        process = subprocess.Popen([str(binary), "exec", "--json", "--skip-git-repo-check", prompt],
                                   cwd=repo, env=env, stdin=subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   text=True, start_new_session=True)
        stopped = threading.Event()

        def monitor():
            while not stopped.wait(2) and process.poll() is None:
                try:
                    used = used_percent()
                    samples.append({"seconds": round(time.monotonic() - started, 2),
                                    "weekly_used_percent": used})
                    if used >= max_weekly_used_percent:
                        stop_reason.append("weekly quota guard reached")
                        stop_group(process)
                        return
                except Exception as error:
                    stop_reason.append(f"weekly quota query failed: {type(error).__name__}")
                    stop_group(process)
                    return

        started = time.monotonic()
        thread = threading.Thread(target=monitor, daemon=True)
        thread.start()
        try:
            stdout, stderr = process.communicate(timeout=min(600, budget.remaining_seconds()))
        except subprocess.TimeoutExpired as error:
            stop_reason.append("session runtime guard reached")
            stop_group(process)
            stdout, stderr = process.communicate(timeout=20)
            stdout = captured_text(error.stdout) + stdout
            stderr = captured_text(error.stderr) + stderr
        finally:
            stopped.set()
            thread.join(timeout=25)
            stop_group(process)
        (destination / "stdout.jsonl").write_text(stdout)
        (destination / "stderr.txt").write_text(stderr)
    check = subprocess.run(["/usr/bin/python3", "-m", "unittest", "test_solution.py"],
                           cwd=repo, capture_output=True, text=True)
    receipts = list((destination / "evidence").glob("completion-receipt-*.json"))
    after = used_percent()
    result = {"arm": "preview", "elapsed_seconds": time.monotonic() - started,
              "exit_code": process.returncode, "test_exit_code": check.returncode,
              "test_output": check.stdout + check.stderr,
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
    summary = {"binary_sha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
               "api_reserved_or_settled_upper_usd": str(budget.reserved),
               "subscription_weekly_used_percent_before": before,
               "subscription_weekly_used_percent_after": after,
               "subscription_max_used_percent": max_weekly_used_percent,
               "subscription_samples": samples, "stop_reason": stop_reason,
               "result": result}
    (output / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps({key: value for key, value in summary.items()
                      if key not in ("subscription_samples", "result")}, sort_keys=True))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--bin", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--max-weekly-used-percent", type=int, required=True)
    parser.add_argument("--deadline", type=datetime.fromisoformat, required=True)
    parser.add_argument("--usd-exposure", default="0.26")
    args = parser.parse_args()
    if args.deadline.tzinfo is None:
        raise ValueError("deadline must include timezone")
    run(args.bin.resolve(), args.output.resolve(), args.max_weekly_used_percent,
        args.deadline, args.usd_exposure)


if __name__ == "__main__":
    main()
