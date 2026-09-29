#!/usr/bin/env python3
import json
import os
from pathlib import Path
import sys


MAX_BYTES = 262_144


class Invalid(Exception):
    pass


def object_without_duplicates(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise Invalid("JSON object contains a duplicate field")
        value[key] = item
    return value


def parse_json(data):
    return json.loads(data, object_pairs_hook=object_without_duplicates)


def read_object(stream, label):
    data = stream.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise Invalid(f"{label} exceeds size limit")
    value = parse_json(data)
    if not isinstance(value, dict):
        raise Invalid(f"{label} must be an object")
    return value


def active():
    if os.environ.get("OMD_MODE") != "omd":
        return False
    raw = os.environ.get("OMD_BRIDGE_CONFIG")
    if not raw and os.environ.get("OMD_MOD_STORE"):
        candidate = Path(os.environ["OMD_MOD_STORE"]) / "plugin-config" / "omd-application-bridges.json"
        if candidate.exists():
            raw = str(candidate)
    if not raw:
        return False
    path = Path(raw).expanduser()
    if not path.is_absolute() or path.resolve() != path or not path.is_file():
        raise Invalid("plugin configuration path is not canonical")
    with path.open("rb") as stream:
        manifest = read_object(stream, "plugin configuration")
    capabilities = manifest.get("capabilities", {})
    if not isinstance(capabilities, dict):
        raise Invalid("plugin capabilities are invalid")
    return capabilities.get("application_bridge") is True


def main():
    event = read_object(sys.stdin.buffer, "hook input")
    if not active():
        return
    name = event.get("hook_event_name")
    if name == "SessionStart":
        print(
            json.dumps(
                {
                    "hookSpecificOutput": {
                        "hookEventName": "SessionStart",
                        "additionalContext": "The OMD application bridge is enabled. Use the adapter-scoped browser_bridge, node_bridge, rust_bridge, python_bridge, or java_bridge MCP tool only for relevant bounded errors, warning/error logs, and explicitly exposed pull-only state. Every call remains prompt-approved. Do not infer DOM, heap, process, filesystem, credential, or network authority.",
                    }
                }
            )
        )
    elif name != "SessionEnd":
        raise Invalid("unsupported hook event")


if __name__ == "__main__":
    try:
        main()
    except (Invalid, json.JSONDecodeError, OSError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1) from error
