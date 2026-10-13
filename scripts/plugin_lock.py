#!/usr/bin/env python3
import json
import sys
from pathlib import Path

try:
    from scripts import install_support as support
except ModuleNotFoundError:
    import install_support as support

ROOT = Path(__file__).resolve().parents[1]
LOCK = ROOT / "runtime/plugin-v1.lock.json"


def build():
    lock = json.loads(LOCK.read_text())
    source = ROOT / lock["source"]
    marketplace = json.loads((source / ".agents/plugins/marketplace.json").read_text())
    listed = [plugin["name"] for plugin in marketplace["plugins"]]
    unclassified = sorted(set(listed) - set(lock["plugins"]))
    if unclassified:
        raise SystemExit(f"classify extension_types and mod_required in {LOCK.relative_to(ROOT)} for: {unclassified}")
    plugins = {}
    for identifier in listed:
        manifest = json.loads((source / f"plugins/{identifier}/.codex-plugin/plugin.json").read_text())
        plugins[identifier] = {**lock["plugins"][identifier], "version": manifest["version"]}
    files = support.plugin_inventory(source)
    return {
        **lock,
        "marketplace": marketplace["name"],
        "guide": {**lock["guide"], "sha256": support.digest(ROOT / lock["guide"]["path"])},
        "plugins": plugins,
        "files": {name: support.digest(source / name) for name in files},
    }


def main():
    text = json.dumps(build(), indent=2) + "\n"
    if "--write" in sys.argv[1:]:
        LOCK.write_text(text)
        print(f"wrote {LOCK.relative_to(ROOT)}")
    elif LOCK.read_text() != text:
        raise SystemExit("bundled plugin lock is stale; rerun with --write after reviewing the sources")
    else:
        print("bundled plugin lock matches the pinned sources")


if __name__ == "__main__":
    main()
