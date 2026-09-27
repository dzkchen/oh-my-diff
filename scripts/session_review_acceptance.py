import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[1]


def run(manager, dispatcher, codex, node, output):
    def call(*args, ok=True):
        result = subprocess.run([str(value) for value in args], capture_output=True, text=True, env=environment, timeout=40)
        if ok and result.returncode:
            raise AssertionError(result.stderr)
        return result

    with tempfile.TemporaryDirectory(prefix="omd-session-review-", dir="/private/tmp") as scratch:
        base = Path(scratch).resolve()
        repo, other, home, store = (base / name for name in ("repo", "other", "home", "store"))
        for directory in (repo, other, home / "sessions"):
            directory.mkdir(parents=True)
        environment = {**os.environ, "CODEX_HOME": str(home), "CODEX_SQLITE_HOME": str(home)}
        call(codex, "plugin", "marketplace", "add", ROOT / "plugins/optional", "--json")
        for identifier in ("omd-anchored-edit", "omd-session-review", "omd-curated-memory"):
            installed = json.loads(call(codex, "plugin", "add", f"{identifier}@oh-my-diff-optional", "--json").stdout)
            assert identifier in json.dumps(installed)
            call(codex, "plugin", "remove", f"{identifier}@oh-my-diff-optional")
        package = base / "omd-session-review"
        shutil.copytree(ROOT / "plugins/optional/plugins/omd-session-review", package)
        component = package / "mod"
        call(manager, "plugin-component", package)
        call(manager, "init", store, node)
        inspected = json.loads(call(manager, "inspect", component).stdout)
        call(manager, "trust", store, component, inspected["sha256"], "commands,sessions_read")
        command = [dispatcher, "session-review", "--repo", repo, "--store", store, "--home", home]
        assert call(*command, ok=False).returncode != 0
        call(manager, "enable", store, component)
        assert "No qualifying" in call(*command).stdout

        def session(identifier, text, scope=repo, opted_out=False):
            rows = [
                {"type": "session_meta", "payload": {"id": identifier, "session_id": identifier, "cwd": str(scope), "timestamp": "2026-09-25T12:00:00Z", "memory_mode": "disabled" if opted_out else "enabled"}},
                {"type": "turn_context", "payload": {"turn_id": "turn-one", "cwd": str(scope)}},
                {"type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": text}]}},
                {"type": "response_item", "payload": {"type": "message", "role": "assistant", "channel": "analysis", "content": [{"type": "output_text", "text": "HIDDEN_SENTINEL"}]}},
            ]
            path = home / "sessions" / f"{identifier}.jsonl"
            path.write_text("".join(json.dumps(row) + "\n" for row in rows))
            return path

        a = session("session-a", "Please always use pnpm for this project.")
        session("session-b", "Fix missing dependency in a different build.")
        session("session-c", "Investigate missing dependency in the test environment.")
        session("session-duplicate-task", "Fix missing dependency in a different build.")
        session("session-secret", "Always retain password=SECRET_SENTINEL")
        session("session-optout", "Always reuse OPTOUT_SENTINEL", opted_out=True)
        session("session-other", "Always reuse CROSS_PROJECT_SENTINEL", scope=other)
        before = {str(path): hashlib.sha256(path.read_bytes()).hexdigest() for path in home.rglob("*.jsonl")}
        report = call(*command, "--since", "2026-09-01..2026-09-26").stdout
        assert "explicit user preference" in report and "inferred repeated pattern" in report
        assert "1 duplicate tasks omitted" in report and "omd-session://session-a/turn/turn-one" in report
        assert not any(marker in report for marker in ("HIDDEN_SENTINEL", "SECRET_SENTINEL", "OPTOUT_SENTINEL", "CROSS_PROJECT_SENTINEL"))
        assert "No qualifying" in call(*command, "--since", "2026-09-26").stdout
        assert "absent, opted out" in call(*command, "--session", "missing").stdout
        assert before == {str(path): hashlib.sha256(path.read_bytes()).hexdigest() for path in home.rglob("*.jsonl")}
        a.write_text(a.read_text() + '{"type":')
        assert "incomplete or bounded" in call(*command, "--session", "session-a").stdout
        duplicate = home / "sessions/ambiguous.jsonl"
        shutil.copyfile(a, duplicate)
        assert "Session review unavailable" in call(*command).stdout
        duplicate.unlink()
        call(manager, "disable", store, component)
        assert call(*command, ok=False).returncode != 0
        assert not list(repo.iterdir())
        result = {"status": "pass", "scope": "real sandboxed plugin command; synthetic selected sessions only", "checks": ["three optional plugins install and remove", "disabled command", "missing sessions", "explicit and inferred report", "source revisions", "date and ID selection", "duplicate tasks and IDs", "partial concurrent tail", "secret and reasoning exclusion", "opt-out", "cross-project isolation", "no source mutation", "disable"], "report": report}
        output.write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps({key: value for key, value in result.items() if key != "report"}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--manager", type=Path, required=True)
    parser.add_argument("--dispatcher", type=Path, required=True)
    parser.add_argument("--codex", type=Path, required=True)
    parser.add_argument("--node", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    run(args.manager.resolve(), args.dispatcher.resolve(), args.codex.resolve(), args.node.resolve(), args.output.resolve())
