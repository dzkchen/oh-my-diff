#!/usr/bin/env python3
import io
import json
import re
import subprocess
import tarfile
import tempfile
from pathlib import Path

from scripts.base_lock import package_digest


ROOT = Path(__file__).resolve().parents[1]
INDEX = ROOT / "extensions/index.json"
DEVELOPMENT = ROOT / "extensions/development.json"
MARKETPLACE = ROOT / "plugins/bundled/oh-my-diff/.agents/plugins/marketplace.json"
COMPATIBILITY = ROOT / "mods/compatibility.json"


def checked_path(value, directory=True):
    path = Path(value)
    if path.is_absolute() or ".." in path.parts:
        raise ValueError(f"unsafe source path: {value}")
    resolved = (ROOT / path).resolve()
    if not resolved.is_relative_to(ROOT) or (directory and not resolved.is_dir()) or (not directory and not resolved.is_file()):
        raise ValueError(f"missing or escaping path: {value}")
    return resolved


def check_published(identifier, source, published, root=ROOT):
    if not (published["repository"].startswith("https://") and re.fullmatch(r"[0-9a-f]{40}", published["revision"])
            and re.fullmatch(r"[0-9a-f]{64}", published["sha256"])):
        raise ValueError(f"{identifier}: invalid published source")
    if package_digest(root / source) != published["sha256"]:
        raise ValueError(f"{identifier}: source digest differs from the published sha256")
    archive = subprocess.run(["git", "archive", published["revision"], source], cwd=root, capture_output=True)
    if archive.returncode:
        raise ValueError(f"{identifier}: published revision is unavailable: {archive.stderr.decode().strip()}")
    with tempfile.TemporaryDirectory() as directory:
        with tarfile.open(fileobj=io.BytesIO(archive.stdout)) as tar:
            tar.extractall(directory, filter="data")
        try:
            published_digest = package_digest(Path(directory) / source)
        except FileNotFoundError as error:
            raise ValueError(f"{identifier}: published revision lacks {Path(error.filename).name}") from None
    if published_digest != published["sha256"]:
        raise ValueError(f"{identifier}: source differs from its published revision")


def check():
    index = json.loads(INDEX.read_text())
    development = json.loads(DEVELOPMENT.read_text())
    matrix = json.loads(COMPATIBILITY.read_text())
    pins = index["release_pin"]
    host = matrix["host"]
    if index["schema"] != 1 or development["schema"] != 1:
        raise ValueError("unsupported catalog schema")
    if (pins["codex"], pins["omd"], pins["mod_api"]) != (host["codex"], host["omd"], host["current_api"]):
        raise ValueError("catalog release pin differs from host compatibility")
    entries = index["packages"]
    experiments = development["packages"]
    ids = [entry["id"] for entry in entries + experiments]
    if len(ids) != len(set(ids)):
        raise ValueError("duplicate catalog identity")
    marketplace = json.loads(MARKETPLACE.read_text())
    marketplace_ids = {entry["name"] for entry in marketplace["plugins"]}
    listed_plugins = {entry["id"] for entry in entries + experiments
                      if entry["extension_type"] == "plugin" and entry["source"].startswith("plugins/bundled/oh-my-diff/")}
    if marketplace_ids != listed_plugins:
        raise ValueError("catalog differs from bundled plugin marketplace")
    first_party = {path.parent.name for path in (ROOT / "mods/first-party").glob("*/mod.json")}
    listed_mods = {entry["id"] for entry in entries + experiments if entry["extension_type"] == "mod" and entry["source"].startswith("mods/first-party/")}
    if first_party != listed_mods:
        raise ValueError("catalog differs from first-party mod set")
    for entry in entries:
        source = checked_path(entry["source"])
        review = checked_path(entry["review"], directory=False)
        if f"`{entry['id']}`" not in review.read_text():
            raise ValueError(f"{entry['id']}: missing review decision")
        for field in ("capability", "license", "maintainer", "compatibility", "tested_versions"):
            if not entry.get(field):
                raise ValueError(f"{entry['id']}: missing {field}")
        if entry["support_status"] not in {"reviewed_candidate", "supported", "deprecated"}:
            raise ValueError(f"{entry['id']}: unknown support status")
        if entry["support_status"] == "supported":
            if entry["license"] == "undeclared" or not entry.get("release_evidence"):
                raise ValueError(f"{entry['id']}: supported status requires license and release evidence")
            checked_path(entry["release_evidence"], directory=False)
        if entry["support_status"] == "deprecated":
            deprecation = entry.get("deprecation", {})
            if not all(deprecation.get(field) for field in ("reason", "replacement", "support_until", "issue")):
                raise ValueError(f"{entry['id']}: deprecated status requires migration details")
        if entry["extension_type"] == "mod":
            manifest = json.loads((source / "mod.json").read_text())
            if (entry["id"], entry["version"], entry["license"]) != (
                manifest["id"], manifest["version"], manifest.get("license", "undeclared")
            ):
                raise ValueError(f"{entry['id']}: mod manifest differs")
            if manifest["api"] not in entry["compatibility"]:
                raise ValueError(f"{entry['id']}: mod API differs")
            if published := entry.get("published"):
                check_published(entry["id"], entry["source"], published)
        elif entry["extension_type"] == "plugin":
            manifest = json.loads((source / ".codex-plugin/plugin.json").read_text())
            if (entry["id"], entry["version"], entry["license"]) != (
                manifest["name"], manifest["version"], manifest.get("license", "undeclared")
            ):
                raise ValueError(f"{entry['id']}: plugin manifest differs")
            for component in entry.get("components", []):
                if component["extension_type"] not in {"skill", "hook"}:
                    raise ValueError(f"{entry['id']}: unknown component type")
                child = source / component["path"]
                expected = child / "SKILL.md" if component["extension_type"] == "skill" else child
                if not expected.is_file() or not expected.resolve().is_relative_to(source):
                    raise ValueError(f"{entry['id']}: missing component {component['path']}")
        else:
            raise ValueError(f"{entry['id']}: unknown extension type")
    for entry in experiments:
        source = checked_path(entry["source"])
        review = checked_path(entry["review"], directory=False)
        if f"`{entry['id']}`" not in review.read_text():
            raise ValueError(f"{entry['id']}: missing development decision")
        if not entry.get("reason") or entry["extension_type"] not in {"mod", "plugin"}:
            raise ValueError(f"{entry['id']}: invalid development entry")
        manifest_name = "mod.json" if entry["extension_type"] == "mod" else ".codex-plugin/plugin.json"
        manifest = json.loads((source / manifest_name).read_text())
        if entry["id"] != manifest["id" if entry["extension_type"] == "mod" else "name"]:
            raise ValueError(f"{entry['id']}: development identity differs")
    return len(entries), len(experiments)


if __name__ == "__main__":
    reviewed, development = check()
    print(f"extension index: {reviewed} reviewed candidates, {development} development entries")
