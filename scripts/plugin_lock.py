#!/usr/bin/env python3
import json
import sys
from pathlib import Path

from scripts import install_support as support

ROOT = Path(__file__).resolve().parents[1]
LOCK = ROOT / "runtime/plugins.lock.json"


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
        descriptor = source / f"plugins/{identifier}/.codex-plugin/omd.json"
        if descriptor.is_file():
            component = json.loads(descriptor.read_text())
            actual = support.package_digest(descriptor.parent.parent / component["component"])
            if component["sha256"] != actual:
                raise SystemExit(f"{descriptor.relative_to(ROOT)} pins {component['sha256']}; its component digest is {actual}")
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
    support.check_or_write(LOCK, json.dumps(build(), indent=2) + "\n", "--write" in sys.argv[1:],
                           "bundled plugin lock is stale; rerun with --write after reviewing the sources")


if __name__ == "__main__":
    main()
