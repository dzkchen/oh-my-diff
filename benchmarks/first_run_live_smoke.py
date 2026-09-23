import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time

from .gateway import Budget, Gateway
from .mod_fixture import install


ROOT = Path(__file__).resolve().parents[1]


def load_key():
    for line in (ROOT / ".env").read_text().splitlines():
        name, separator, value = line.strip().removeprefix("export ").partition("=")
        if separator and name.strip() == "OPENAI_API_KEY":
            os.environ["OMD_LIVE_OPENAI_KEY"] = value.strip().strip("\"'")
            return
    raise RuntimeError("OPENAI_API_KEY is unavailable")


def prepare(destination, node, port, token, arm):
    repo = destination / "repo"
    home = destination / "home"
    repo.mkdir(parents=True)
    home.mkdir()
    (repo / "solution.py").write_text("def add(a, b):\n    return a - b\n")
    (repo / "test_solution.py").write_text(
        "import unittest\nfrom solution import add\n\n"
        "class TestAdd(unittest.TestCase):\n"
        "    def test_positive(self): self.assertEqual(add(2, 3), 5)\n"
        "    def test_negative(self): self.assertEqual(add(-2, 3), 1)\n"
    )
    (repo / "notes.txt").write_text("Keep these notes.\n")
    (repo / "AGENTS.md").write_text("Preserve unrelated files.\n")
    (repo / ".gitignore").write_text("__pycache__/\n")
    subprocess.run(["/usr/bin/git", "init", "-q"], cwd=repo, check=True)
    subprocess.run(["/usr/bin/git", "add", "."], cwd=repo, check=True)
    subprocess.run(["/usr/bin/git", "-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "commit", "-qm", "Starting source"], cwd=repo, check=True)
    (repo / "unrelated.txt").write_text("Uncommitted user work\n")
    models = json.loads((ROOT / "benchmarks/fixtures/controlled-models.json").read_text())
    for model in models["models"]:
        model["tool_mode"] = "direct"
        model["prefer_websockets"] = False
        model["base_instructions"] = "You are a coding assistant. Follow the user's task, use available tools, and preserve unrelated files."
    (home / "models.json").write_text(json.dumps(models))
    (home / "config.toml").write_text(
        f'model = "gpt-5.6-sol"\nmodel_provider = "omd_openai_api"\n'
        f'model_catalog_json = {json.dumps(str(home / "models.json"))}\n'
        'model_reasoning_effort = "low"\nweb_search = "disabled"\n'
        'approval_policy = "never"\ndefault_permissions = "experiment"\n'
        'check_for_update_on_startup = false\n'
        '[features]\nshell_snapshot = false\ncode_mode = false\n'
        '[analytics]\nenabled = false\n[feedback]\nenabled = false\n'
        '[shell_environment_policy]\ninherit = "none"\n'
        '[shell_environment_policy.set]\nPATH = "/usr/bin:/bin:/usr/sbin:/sbin"\n'
        f'HOME = {json.dumps(str(repo))}\n'
        '[model_providers.omd_openai_api]\nname = "Bounded OpenAI API"\n'
        f'base_url = "http://127.0.0.1:{port}/omd_openai_api"\n'
        'wire_api = "responses"\nenv_key = "OMD_GATEWAY_TOKEN"\n'
        'requires_openai_auth = false\nsupports_websockets = false\n'
        'request_max_retries = 0\nstream_max_retries = 0\n'
        '[permissions.experiment.network]\nenabled = false\n'
        '[permissions.experiment.filesystem]\n":minimal" = "read"\n'
        f'{json.dumps(str(repo))} = "write"\n'
        '"/usr/bin" = "read"\n"/bin" = "read"\n'
        '"/usr/sbin" = "read"\n"/sbin" = "read"\n'
        '"/Library/Developer/CommandLineTools" = "read"\n'
        f'[projects.{json.dumps(str(repo))}]\ntrust_level = "trusted"\n'
    )
    env = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": str(home),
           "CODEX_HOME": str(home), "CODEX_SQLITE_HOME": str(home),
           "NO_PROXY": "127.0.0.1,localhost", "TERM": "dumb",
           "OMD_GATEWAY_TOKEN": token}
    if arm in ("platform", "full"):
        selected = {}
        install(destination, selected, node, "counter" if arm == "platform" else "workspace-only")
        env.update(OMD_MODE="platform", OMD_MOD_STORE=selected["mods"])
    else:
        env["OMD_MODE"] = "upstream_direct"
    return repo, home, env


def run(binary, output, arms, usd_exposure, max_requests):
    if output.exists():
        raise RuntimeError("output already exists")
    output.mkdir(parents=True)
    load_key()
    node = Path(subprocess.check_output(["mise", "which", "node"], cwd=ROOT, text=True).strip()).resolve()
    route = {"url": "https://api.openai.com/v1", "credential_env": "OMD_LIVE_OPENAI_KEY",
             "models": ["gpt-5.6-sol"], "account_alias": "user-api-key", "billing": "estimate",
             "request_exposure_usd": "0.38", "settle_completed_usage": True,
             "timeout_seconds": 120, "rate_card": "OpenAI API standard 2026-09-23",
             "rates": {"input": "4", "cache_read": "0.40", "cache_write": "5", "output": "20"},
             "bounds": {"input_token_ceiling": 60000, "output_tokens": 4000,
                        "requests_per_session": 10, "input_items": 128}}
    limits = {"seconds": 12600, "requests": max_requests, "max_output_tokens": 4000,
              "max_request_bytes": 1000000, "max_response_bytes": 4000000,
              "usd_exposure": usd_exposure}
    budget = Budget(limits, output / "budget")
    started = time.monotonic()
    results = []
    for arm in arms:
        destination = output / arm
        destination.mkdir()
        with Gateway({"omd_openai_api": route}, budget, destination) as gateway:
            repo, home, env = prepare(destination, node, gateway.port, gateway.token, arm)
            prompt = ("Fix solution.py so add returns the sum. Run /usr/bin/python3 -m unittest "
                      "test_solution.py. Preserve unrelated files. Before editing, search the "
                      "available tools for mod_fixture_count and invoke it once if present.")
            arm_started = time.monotonic()
            process = subprocess.run([str(binary), "exec", "--json", "--skip-git-repo-check", prompt],
                                     cwd=repo, env=env, stdin=subprocess.DEVNULL,
                                     capture_output=True, text=True, timeout=min(300, budget.remaining_seconds()))
            arm_elapsed = time.monotonic() - arm_started
            (destination / "stdout.jsonl").write_text(process.stdout)
            (destination / "stderr.txt").write_text(process.stderr)
        ledger = gateway.ledger()
        check = subprocess.run(["/usr/bin/python3", "-m", "unittest", "test_solution.py"],
                               cwd=repo, capture_output=True, text=True)
        result = {"arm": arm, "elapsed_seconds": arm_elapsed,
                  "exit_code": process.returncode, "test_exit_code": check.returncode,
                  "test_output": check.stdout + check.stderr,
                  "solution_sha256": hashlib.sha256((repo / "solution.py").read_bytes()).hexdigest(),
                  "notes_preserved": (repo / "notes.txt").read_text() == "Keep these notes.\n",
                  "unrelated_preserved": (repo / "unrelated.txt").read_text() == "Uncommitted user work\n",
                  "requests": len(ledger), "request_statuses": [record["status"] for record in ledger],
                  "mod_status": json.loads((destination / "mod-store/mod-status.json").read_text()) if arm in ("platform", "full") and (destination / "mod-store/mod-status.json").exists() else None}
        results.append(result)
        (destination / "result.json").write_text(json.dumps(result, indent=2) + "\n")
        if budget.stopped or budget.remaining_seconds() < 300:
            break
    summary = {"binary_sha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
               "elapsed_seconds": time.monotonic() - started, "admitted_requests": budget.count,
               "reserved_or_settled_upper_usd": str(budget.reserved), "results": results}
    (output / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--bin", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--arms", choices=("direct,platform", "platform", "full", "direct,full"), default="direct,platform")
    parser.add_argument("--usd-exposure", default="4")
    parser.add_argument("--max-requests", type=int, default=10)
    args = parser.parse_args()
    run(args.bin.resolve(), args.output.resolve(), args.arms.split(","), args.usd_exposure, args.max_requests)


if __name__ == "__main__":
    main()
