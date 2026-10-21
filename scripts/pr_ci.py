import argparse
import json
import os
from pathlib import Path
import subprocess


def needs_native(paths):
    return any(
        not (path.endswith(".md") or path.startswith(("docs/", "mods/first-party/", "mods/examples/", "plugins/", "tests/")))
        for path in paths
    )


def gate(needs):
    selection = needs["changes"]
    selected = selection.get("outputs", {}).get("native")
    return (
        selection["result"] == "success"
        and selected in ("true", "false")
        and needs["portable"]["result"] == "success"
        and needs["native"]["result"] == ("success" if selected == "true" else "skipped")
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("select", "gate"))
    args = parser.parse_args()
    if args.command == "gate":
        results = json.loads(os.environ["PR_NEEDS"])
        print(json.dumps(results, indent=2))
        raise SystemExit(0 if gate(results) else 1)
    paths = subprocess.check_output([
        "git", "diff", "--name-only", "--no-renames", "-z", os.environ["PR_BASE_SHA"], "HEAD", "--",
    ]).decode().split("\0")
    selected = str(needs_native(path for path in paths if path)).lower()
    with Path(os.environ["GITHUB_OUTPUT"]).open("a") as output:
        output.write(f"native={selected}\n")
    print(f"Native validation: {selected}")


if __name__ == "__main__":
    main()
