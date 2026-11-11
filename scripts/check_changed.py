import argparse
import json
from pathlib import Path
import shlex
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def git(root, *args):
    return subprocess.check_output(["git", *args], cwd=root, stderr=subprocess.PIPE).decode()


def changed_paths(root, base):
    revision = git(root, "rev-parse", "--verify", "--end-of-options", f"{base}^{{commit}}").strip()
    ancestor = git(root, "merge-base", "HEAD", revision).strip()
    paths = set()
    for args in (
        ("diff", "--name-only", "--no-renames", "-z", ancestor, "HEAD", "--"),
        ("diff", "--name-only", "--no-renames", "-z", "--cached", "HEAD", "--"),
        ("diff", "--name-only", "--no-renames", "-z", "--"),
        ("ls-files", "--others", "--exclude-standard", "-z"),
    ):
        paths.update(filter(None, git(root, *args).split("\0")))
    return ancestor, sorted(paths)


def checks(root, ancestor, paths):
    if not paths:
        return []
    selected = [
        ["git", "diff", "--check", ancestor, "--"],
        ["git", "diff", "--cached", "--check", "--"],
        [sys.executable, "scripts/release.py", "check"],
    ]
    if any(not path.endswith(".md") or path.startswith(("runtime/", "mods/", "plugins/")) for path in paths):
        selected += [
            ["mise", "run", "mods:check"],
            ["mise", "run", "native:ownership"],
            [sys.executable, "-m", "scripts.mods_lock"],
            [sys.executable, "-m", "scripts.plugin_lock"],
        ]
    optional = json.loads((root / "tests/suites.json").read_text())["optional"]
    python_tests = [path[:-3].replace("/", ".") for path in paths
                    if path.startswith("tests/test_") and path.endswith(".py")
                    and "/" not in path[len("tests/"):] and path not in optional and (root / path).is_file()]
    node_tests = [path for path in paths if path.startswith(("tests/", "mods/", "plugins/"))
                  and path.endswith((".test.mjs", ".test.cjs", ".test.js", ".spec.mjs", ".spec.cjs", ".spec.js"))
                  and path not in optional and (root / path).is_file()]
    if python_tests:
        selected.append([sys.executable, "-m", "unittest", *python_tests])
    if node_tests:
        selected.append(["node", "--test", *node_tests])
    if any(path.startswith(".github/workflows/") for path in paths):
        selected.append(["mise", "exec", "actionlint@1.7.12", "--", "actionlint"])
    return selected


def main():
    parser = argparse.ArgumentParser(description="Run portable checks and changed test files; choose related tests separately.")
    parser.add_argument("--base", default="origin/main", help="Compare from the merge base with this ref (default: origin/main)")
    parser.add_argument("--list", action="store_true", help="Print paths and commands without running checks")
    args = parser.parse_args()
    try:
        ancestor, paths = changed_paths(ROOT, args.base)
    except subprocess.CalledProcessError:
        parser.exit(1, f"Cannot compare with {args.base!r}; fetch that ref or pass --base REF.\n")
    print(f"Changes since merge base {ancestor[:12]} with {args.base}, including staged, unstaged and untracked files:", flush=True)
    for path in paths:
        print(f"  {path}", flush=True)
    if not paths:
        print("No changed files.")
        return 0
    selected = checks(ROOT, ancestor, paths)
    for command in selected:
        print(f"\n$ {shlex.join(command)}", flush=True)
        if not args.list:
            try:
                result = subprocess.run(command, cwd=ROOT)
            except OSError as error:
                parser.exit(1, f"Could not run {command[0]}: {error}\n")
            if result.returncode:
                return result.returncode
    print("\nRelated tests, mod-host scenarios, native checks and terminal checks are not selected automatically.")
    print("Choose them from CONTRIBUTING.md and tests/README.md; this command does not follow test dependencies.")
    if not args.list:
        print("Selected checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
