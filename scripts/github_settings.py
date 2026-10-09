#!/usr/bin/env python3
import argparse
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SETTINGS = ROOT / ".github/settings.json"
REPOSITORY = "dzkchen/oh-my-diff"


def gh(*args, payload=None):
    result = subprocess.run(["gh", *args], input=None if payload is None else json.dumps(payload),
                            text=True, capture_output=True)
    if result.returncode:
        raise SystemExit(f"gh {' '.join(args[:3])} failed: {result.stderr.strip()}")
    return result.stdout


def labels(settings, dry_run):
    wanted = {label["name"]: label for label in settings["labels"]}
    current = {label["name"]: label for label in json.loads(gh("label", "list", "--repo", REPOSITORY, "--limit", "200",
                                                               "--json", "name,color,description"))}
    for name, label in wanted.items():
        if current.get(name, {}) | {"name": name} != label:
            print("set", name)
            if not dry_run:
                gh("label", "create", name, "--repo", REPOSITORY, "--force", "--color", label["color"],
                   "--description", label["description"])
    for name in sorted(set(current) - set(wanted)):
        print("delete", name)
        if not dry_run:
            gh("label", "delete", name, "--repo", REPOSITORY, "--yes")


def repository(settings, dry_run):
    print("repository merge settings, private vulnerability reporting and main branch protection")
    if not dry_run:
        gh("api", "--method", "PATCH", f"repos/{REPOSITORY}", "--input", "-", payload=settings["repository"])
        gh("api", "--method", "PUT", f"repos/{REPOSITORY}/private-vulnerability-reporting")
        protection = dict(settings["branch_protection"])
        branch = protection.pop("branch")
        gh("api", "--method", "PUT", f"repos/{REPOSITORY}/branches/{branch}/protection", "--input", "-", payload=protection)


def main():
    parser = argparse.ArgumentParser(description="Apply .github/settings.json to the GitHub repository")
    parser.add_argument("scope", choices=("labels", "repository", "all"))
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    settings = json.loads(SETTINGS.read_text())
    if args.scope in ("labels", "all"):
        labels(settings, args.dry_run)
    if args.scope in ("repository", "all"):
        repository(settings, args.dry_run)


if __name__ == "__main__":
    main()
