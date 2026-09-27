#!/usr/bin/env python3
import hashlib
import json
import os
from pathlib import Path
import sys


MAX_BYTES = 262_144
CADENCES = {"stable_milestone", "risk_triggered", "every_turn", "final"}


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


def read_input():
    data = sys.stdin.buffer.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise Invalid("hook input exceeds size limit")
    value = parse_json(data)
    if not isinstance(value, dict):
        raise Invalid("hook input must be an object")
    return value


def canonical_file(raw, label):
    if not isinstance(raw, str) or not raw:
        raise Invalid(f"{label} path is absent")
    path = Path(raw).expanduser()
    if not path.is_absolute() or path.resolve() != path or not path.is_file():
        raise Invalid(f"{label} path is not a canonical file")
    return path


def load_manifest():
    if os.environ.get("OMD_MODE") != "enabled":
        return None
    raw = os.environ.get("OMD_CONTROLLED_MANIFEST")
    if not raw:
        return None
    path = canonical_file(raw, "controlled manifest")
    data = path.read_bytes()
    if len(data) > MAX_BYTES:
        raise Invalid("controlled manifest exceeds hook size limit")
    value = parse_json(data)
    if not isinstance(value, dict):
        raise Invalid("controlled manifest must be an object")
    capabilities = value.get("capabilities", {})
    review = value.get("review", {})
    if not isinstance(capabilities, dict) or not isinstance(review, dict):
        raise Invalid("controlled review configuration is invalid")
    return value


def every_turn_selected(manifest):
    return (
        os.environ.get("OMD_REVIEW_CADENCE_OWNER", "manual") != "advisor"
        and manifest is not None
        and manifest.get("capabilities", {}).get("unified_review") is True
        and manifest.get("review", {}).get("every_turn_advice") is True
    )


def identity(event):
    session = event.get("session_id")
    turn = event.get("turn_id")
    if (
        not isinstance(session, str)
        or not session
        or not isinstance(turn, str)
        or not turn
    ):
        raise Invalid("hook session and turn identity are required")
    return session, turn


def data_directory():
    raw = os.environ.get("PLUGIN_DATA")
    if not isinstance(raw, str) or not raw:
        raise Invalid("PLUGIN_DATA is absent")
    path = Path(raw).expanduser()
    if not path.is_absolute():
        raise Invalid("PLUGIN_DATA must be absolute")
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    if path.is_symlink() or path.resolve() != path:
        raise Invalid("PLUGIN_DATA is not canonical")
    return path


def token(value):
    return hashlib.sha256(value.encode()).hexdigest()


def marker_path(event):
    session, turn = identity(event)
    return data_directory() / f"{token(session)}-{token(turn)}.json"


def record_review(event):
    if event.get("tool_name") != "omd_review":
        return
    arguments = event.get("tool_input")
    if not isinstance(arguments, dict) or arguments.get("cadence") not in CADENCES:
        raise Invalid("successful omd_review event has invalid cadence")
    tool_use = event.get("tool_use_id")
    if not isinstance(tool_use, str) or not tool_use:
        raise Invalid("successful omd_review event has no tool identity")
    session, turn = identity(event)
    body = (
        json.dumps(
            {
                "schema": 1,
                "session_id": session,
                "turn_id": turn,
                "tool_use_id": tool_use,
                "cadence": arguments["cadence"],
            },
            sort_keys=True,
            separators=(",", ":"),
        )
        + "\n"
    )
    target = marker_path(event)
    temporary = target.with_suffix(f".{token(tool_use)}.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as handle:
        handle.write(body)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, target)


def valid_marker(target, event):
    if not target.is_file() or target.is_symlink():
        return False
    data = target.read_bytes()
    if len(data) > MAX_BYTES:
        return False
    try:
        marker = parse_json(data)
    except (Invalid, json.JSONDecodeError):
        return False
    session, turn = identity(event)
    return (
        isinstance(marker, dict)
        and set(marker)
        == {
            "schema",
            "session_id",
            "turn_id",
            "tool_use_id",
            "cadence",
        }
        and marker["schema"] == 1
        and marker["session_id"] == session
        and marker["turn_id"] == turn
        and isinstance(marker["tool_use_id"], str)
        and bool(marker["tool_use_id"])
        and marker["cadence"] in CADENCES
    )


def check_stop(event):
    if event.get("agent_id") is not None:
        return
    target = marker_path(event)
    if valid_marker(target, event):
        return
    print(
        json.dumps(
            {
                "decision": "block",
                "reason": "Every-turn OMD review is selected. Use $omd-review-policy:omd-review-cadence and run the native omd_review tool for the current candidate before ending this turn.",
            }
        )
    )


def clear_session(event):
    session = event.get("session_id")
    if not isinstance(session, str) or not session:
        raise Invalid("hook session identity is required")
    directory = data_directory()
    prefix = f"{token(session)}-"
    for path in directory.iterdir():
        if path.is_file() and not path.is_symlink() and path.name.startswith(prefix):
            path.unlink()


def main():
    event = read_input()
    manifest = load_manifest()
    if not every_turn_selected(manifest):
        return
    name = event.get("hook_event_name")
    if name == "PostToolUse":
        record_review(event)
    elif name == "Stop":
        check_stop(event)
    elif name == "SessionEnd":
        clear_session(event)
    else:
        raise Invalid("unsupported hook event")


if __name__ == "__main__":
    try:
        main()
    except (Invalid, json.JSONDecodeError, OSError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1) from error
