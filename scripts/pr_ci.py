import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess


def needs_native(paths):
    return any(
        path.startswith("runtime/")
        or not (path.endswith(".md") or path.startswith(("docs/", "mods/first-party/", "mods/examples/", "plugins/", "tests/")))
        for path in paths
    )


def native_fingerprint():
    records = subprocess.check_output(["git", "ls-tree", "-r", "-z", "HEAD"]).split(b"\0")
    digest = hashlib.sha256()
    for record in records:
        if not record:
            continue
        path = record.split(b"\t", 1)[1].decode()
        if needs_native([path]) and path not in (
            "runtime/mods.lock.json", "runtime/plugins.lock.json", "runtime/release.lock.json",
        ):
            digest.update(record + b"\0")
    return digest.hexdigest()


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
    parser.add_argument("command", choices=("select", "gate", "fingerprint"))
    args = parser.parse_args()
    if args.command == "fingerprint":
        with Path(os.environ["GITHUB_OUTPUT"]).open("a") as output:
            output.write(f"key=native-success-v1-macos-15-{native_fingerprint()}\n")
        return
    if args.command == "gate":
        results = json.loads(os.environ["PR_NEEDS"])
        print(json.dumps(results, indent=2))
        raise SystemExit(0 if gate(results) else 1)
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    if os.environ["GITHUB_EVENT_NAME"] == "push":
        base = event["before"]
    elif os.environ["GITHUB_EVENT_NAME"] == "merge_group":
        base = event["merge_group"]["base_sha"]
    else:
        base = "HEAD^1"
    paths = subprocess.check_output([
        "git", "diff", "--name-only", "--no-renames", "-z", base, "HEAD", "--",
    ]).decode().split("\0")
    selected = str(needs_native(path for path in paths if path)).lower()
    with Path(os.environ["GITHUB_OUTPUT"]).open("a") as output:
        output.write(f"native={selected}\n")
    print(f"Native validation: {selected}")


if __name__ == "__main__":
    main()
