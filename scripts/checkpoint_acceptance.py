#!/usr/bin/env python3
import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.pty_session import ROOT, Session, call, environment, fresh, git, provider

EDIT = "printf 'two\\n' > a.txt && rm b.txt && printf 'hello\\n' > new.txt && printf 'agent was here\\n' > notes.txt"
FILES = ["a.txt", "b.txt", "new.txt", "notes.txt"]


def reply(body, count):
    items = body.get("input", [])
    last_user = max((index for index, item in enumerate(items) if item.get("role") == "user"), default=-1)
    answered = any(item.get("type") == "function_call_output" for item in items[last_user + 1:])
    if "EDIT_FILES" in json.dumps(items[last_user] if last_user >= 0 else {}) and not answered:
        arguments = {"cmd": EDIT, "yield_time_ms": 500}
        return [{"type": "function_call", "id": f"fc{count}", "call_id": f"call{count}", "name": "exec_command", "arguments": json.dumps(arguments)}]
    return [{"type": "message", "id": f"m{count}", "role": "assistant", "content": [{"type": "output_text", "text": "FIXTURE_DONE"}]}]


def files(repo):
    return {name: (repo / name).read_text() if (repo / name).exists() else None for name in FILES}


def main():
    parser = argparse.ArgumentParser(description="Run omd_checkpoint in a real Codex TUI with a scripted local model "
                                                 "(no paid calls): one turn edits files, then /undo, /undo force and /redo.")
    parser.add_argument("--binaries", type=Path, required=True, help="directory with the patched codex and omd-mod")
    args = parser.parse_args()
    codex, manager = (args.binaries / name for name in ["codex", "omd-mod"])
    base = fresh("checkpoint")
    repo = base / "repo"
    repo.mkdir()
    git(repo, "init", "-q", "-b", "main")
    (repo / "a.txt").write_text("one\n")
    (repo / "b.txt").write_text("bee\n")
    git(repo, "add", ".")
    git(repo, "commit", "-qm", "fixture")
    (repo / "notes.txt").write_text("my untracked notes\n")

    store = base / "store"
    module = ROOT / "mods/first-party/omd_checkpoint"
    call([manager, "init", store], ROOT)
    inspected = json.loads(call([manager, "inspect", module], ROOT).stdout)
    call([manager, "trust", store, module, inspected["sha256"], ",".join(inspected["manifest"]["capabilities"])], ROOT)
    call([manager, "enable", store, module], ROOT)
    call([manager, "trust-program", store, "omd_checkpoint", "git"], ROOT)

    server, url = provider(reply)
    tui = Session(codex, repo, environment(base, args.binaries, repo, store, url))
    results = {"run": str(base)}
    try:
        results["ready"] = tui.ready()
        results["turn"] = tui.command("EDIT_FILES now", "FIXTURE_DONE", 60)
        tui.pump(2.0)
        results["after_turn"] = files(repo)
        results["list"] = tui.command("/undo list", "Checkpoints in this repository", 30)
        (repo / "a.txt").write_text("my edit after the turn\n")
        results["refused_over_my_edit"] = tui.command("/undo", "changed since: a.txt", 30)
        results["my_edit_kept"] = (repo / "a.txt").read_text() == "my edit after the turn\n"
        results["force"] = tui.command("/undo force", "Undid the", 30)
        results["after_undo"] = files(repo)
        results["redo"] = tui.command("/redo", "Redid the", 30)
        results["after_redo"] = files(repo)
        results["head_unchanged"] = git(repo, "rev-list", "--count", "main").strip() == "1"
        results["index_untouched"] = git(repo, "diff", "--cached", "--name-only") == ""
    finally:
        tui.close(base / "tui.trace")
        server.shutdown()
    expected = {"after_turn": {"a.txt": "two\n", "b.txt": None, "new.txt": "hello\n", "notes.txt": "agent was here\n"},
                "after_undo": {"a.txt": "one\n", "b.txt": "bee\n", "new.txt": None, "notes.txt": "my untracked notes\n"},
                "after_redo": {"a.txt": "my edit after the turn\n", "b.txt": None, "new.txt": "hello\n", "notes.txt": "agent was here\n"}}
    results["ok"] = all(value is True for key, value in results.items() if key not in (*expected, "run")) \
        and all(results.get(key) == value for key, value in expected.items())
    (base / "results.json").write_text(json.dumps(results, indent=2))
    print(json.dumps(results, indent=2))
    sys.exit(0 if results["ok"] else 1)


if __name__ == "__main__":
    main()
