#!/usr/bin/env python3
"""Start the patched TUI with every first-party mod enabled and a scripted provider, run one turn and every slash command."""
import argparse
import json
from pathlib import Path
import re
import sys

from scripts.pty_session import ROOT, Session, call, environment, fresh, git, provider

FIRST_PARTY = sorted(path for path in (ROOT / "mods/first-party").iterdir() if (path / "mod.json").is_file())


def commands():
    found = []
    for path in FIRST_PARTY:
        source = (path / "index.ts").read_text()
        found += [(json.loads((path / "mod.json").read_text())["id"], name) for name in re.findall(r"api\.command\(\s*'([^']+)'", source)]
    return found


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binaries", type=Path, required=True, help="directory holding codex, omd-mod and codex-code-mode-host")
    parser.add_argument("--show", action="store_true", help="print what each command rendered instead of asserting")
    args = parser.parse_args()
    manager = args.binaries / "omd-mod"
    base = fresh("smoke")
    repo = base / "repo"
    repo.mkdir()
    git(repo, "init", "-q")
    store = base / "store"
    call([manager, "init", store, call(["mise", "which", "node"], ROOT).stdout.strip()], ROOT)
    for path in FIRST_PARTY:
        inspected = json.loads(call([manager, "inspect", path], ROOT).stdout)
        call([manager, "trust", store, path, inspected["sha256"], ",".join(inspected["manifest"]["capabilities"])], ROOT)
        call([manager, "enable", store, path], ROOT)
    server, url = provider()
    session = Session(args.binaries / "codex", repo, environment(base, args.binaries, repo, store, url))
    failures = []
    try:
        assert session.ready(), session.text()[-1500:]
        assert f"{len(FIRST_PARTY)} mods on" in session.text(), session.text()[-500:]
        mark = len(session.raw)
        session.type("say hello")
        session.keys(b"\r")
        assert session.wait("FIXTURE_DONE", 60, mark), session.text(mark)[-1500:]
        for mod, name in commands():
            mark = len(session.raw)
            shown = session.command(f"/{name}", name, 20)
            rendered = session.text(mark)
            if args.show:
                print(f"----- /{name} ({mod}) -----\n{rendered[-700:]}\n")
            if not shown or "panicked" in rendered:
                failures.append(f"/{name}: {rendered[-300:]}")
    finally:
        session.close(base / "trace.bin")
        server.shutdown()
    print("\n".join(failures) or f"turn and {len(commands())} commands ran; trace {base / 'trace.bin'}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
