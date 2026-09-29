#!/usr/bin/env python3
import hashlib
import json
import os
from pathlib import Path
import re
import sys


MAX_INPUT_BYTES = 262_144
MAX_RULE_BYTES = 65_536
TOKEN = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
TOOL = re.compile(r"^[A-Za-z0-9_.:/-]{1,128}$")
OUTCOMES = {
    "completed_host_success",
    "completed_host_failure",
    "blocked",
    "failed_before_execution",
    "failed_after_execution",
    "aborted",
}


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


def read_json_input():
    payload = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    if len(payload) > MAX_INPUT_BYTES:
        raise Invalid("hook input exceeds size limit")
    value = parse_json(payload)
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


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def load_manifest():
    if os.environ.get("OMD_MODE") != "omd":
        return None
    raw = os.environ.get("OMD_GUIDANCE_CONFIG")
    if not raw and os.environ.get("OMD_MOD_STORE"):
        candidate = Path(os.environ["OMD_MOD_STORE"]) / "plugin-config" / "omd-guidance-hooks.json"
        if candidate.exists():
            raw = str(candidate)
    if not raw:
        return None
    path = canonical_file(raw, "plugin configuration")
    data = path.read_bytes()
    if len(data) > MAX_INPUT_BYTES:
        raise Invalid("plugin configuration exceeds hook size limit")
    manifest = parse_json(data)
    if not isinstance(manifest, dict):
        raise Invalid("plugin configuration must be an object")
    return manifest


def valid_text(value, limit):
    return isinstance(value, str) and 0 < len(value.strip()) <= limit


def valid_unique_text(values, item_limit, byte_limit, require=False):
    return (
        isinstance(values, list)
        and (not require or bool(values))
        and len(values) <= item_limit
        and all(isinstance(value, str) for value in values)
        and len(values) == len(set(values))
        and all(valid_text(value, byte_limit) for value in values)
    )


def valid_worker_report(raw):
    if not isinstance(raw, str) or len(raw.encode()) > MAX_RULE_BYTES:
        return False
    try:
        report = parse_json(raw)
    except (Invalid, json.JSONDecodeError):
        return False
    if not isinstance(report, dict) or set(report) != {
        "schema",
        "status",
        "summary",
        "scope",
        "uncertainty",
        "evidence",
        "required_clarification",
    }:
        return False
    if (
        type(report["schema"]) is not int
        or report["schema"] != 1
        or not isinstance(report["status"], str)
        or report["status"] not in {"completed", "partial", "blocked"}
        or not valid_text(report["summary"], 4096)
        or not valid_unique_text(report["scope"], 32, 1024, require=True)
        or not valid_unique_text(report["uncertainty"], 32, 1024)
        or not valid_unique_text(report["evidence"], 64, 4096)
        or not valid_unique_text(report["required_clarification"], 16, 1024)
    ):
        return False
    if report["status"] == "blocked" and not report["required_clarification"]:
        return False
    return report["status"] != "completed" or not report["required_clarification"]


def validate_rule_set(value):
    if not isinstance(value, dict) or set(value) != {"schema", "version", "rules"}:
        raise Invalid("reactive rule set shape is invalid")
    rules = value["rules"]
    if (
        type(value["schema"]) is not int
        or value["schema"] != 1
        or not isinstance(value["version"], str)
        or not TOKEN.fullmatch(value["version"])
    ):
        raise Invalid("reactive rule set identity is invalid")
    if not isinstance(rules, list) or not 1 <= len(rules) <= 16:
        raise Invalid("reactive rule count is invalid")
    ids = set()
    triggers = set()
    for rule in rules:
        if not isinstance(rule, dict) or set(rule) != {
            "id",
            "scope",
            "trigger",
            "instruction",
            "max_activations",
            "max_context_reactivations",
        }:
            raise Invalid("reactive rule shape is invalid")
        trigger = rule["trigger"]
        if not isinstance(trigger, dict) or set(trigger) != {"event", "tool", "outcome"}:
            raise Invalid("reactive trigger shape is invalid")
        identity = (rule["scope"], trigger["event"], trigger["tool"], trigger["outcome"])
        if (
            not isinstance(rule["id"], str)
            or not TOKEN.fullmatch(rule["id"])
            or rule["id"] in ids
            or rule["scope"] not in {"lead", "worker"}
            or trigger["event"] != "tool_finished"
            or not isinstance(trigger["tool"], str)
            or not TOOL.fullmatch(trigger["tool"])
            or trigger["outcome"] not in OUTCOMES
            or identity in triggers
            or not isinstance(rule["instruction"], str)
            or not 0 < len(rule["instruction"]) <= 512
            or rule["instruction"].strip() != rule["instruction"]
            or "\n" in rule["instruction"]
            or "\r" in rule["instruction"]
            or type(rule["max_activations"]) is not int
            or not 1 <= rule["max_activations"] <= 8
            or type(rule["max_context_reactivations"]) is not int
            or not 0 <= rule["max_context_reactivations"] <= 4
        ):
            raise Invalid("reactive rule is invalid or ambiguous")
        ids.add(rule["id"])
        triggers.add(identity)
    return value


def load_rule_set(manifest):
    reference = manifest.get("reactive_rules")
    repository_raw = manifest.get("repository")
    if not isinstance(repository_raw, str):
        raise Invalid("repository path is absent")
    repository = Path(repository_raw)
    if not repository.is_absolute() or repository.resolve() != repository or not repository.is_dir():
        raise Invalid("repository path is not canonical")
    if not isinstance(reference, dict) or set(reference) != {"path", "sha256"}:
        raise Invalid("reactive rule reference is invalid")
    path = canonical_file(reference["path"], "reactive rule source")
    try:
        path.relative_to(repository)
        raise Invalid("reactive rule source must be host-owned")
    except ValueError:
        pass
    data = path.read_bytes()
    if len(data) > MAX_RULE_BYTES or sha256(data) != reference["sha256"]:
        raise Invalid("reactive rule source changed or exceeds its bound")
    return path, reference["sha256"], validate_rule_set(parse_json(data))


def write_marker(manifest, event, rule, source, source_sha256, scope, rule_set_version):
    evidence_raw = manifest.get("evidence")
    if not isinstance(evidence_raw, str):
        raise Invalid("evidence path is absent")
    evidence = Path(evidence_raw)
    if not evidence.is_absolute() or evidence.resolve() != evidence or not evidence.is_dir():
        raise Invalid("evidence path is not canonical")
    identity = f"{event['turn_id']}\0{event['tool_use_id']}".encode()
    directory = evidence / ".omd-hook-events"
    directory.mkdir(mode=0o700, exist_ok=True)
    if directory.is_symlink() or directory.resolve() != directory:
        raise Invalid("reactive hook marker directory is not canonical")
    marker = {
        "schema": 1,
        "event": "post_tool_use",
        "session_id": event["session_id"],
        "turn_id": event["turn_id"],
        "tool_use_id": event["tool_use_id"],
        "agent_id": event.get("agent_id"),
        "scope": scope,
        "tool": event["tool_name"],
        "outcome": "completed_host_success",
        "source": str(source),
        "source_sha256": source_sha256,
        "rule_set_version": rule_set_version,
        "rule_id": rule["id"],
    }
    body = json.dumps(marker, sort_keys=True, separators=(",", ":")) + "\n"
    target = directory / f"{sha256(identity)}.json"
    try:
        descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        if target.is_symlink() or not target.is_file() or target.read_text() != body:
            raise Invalid("reactive hook marker collision")
        return
    with os.fdopen(descriptor, "w") as handle:
        handle.write(body)
        handle.flush()
        os.fsync(handle.fileno())


def post_tool_use(manifest, event):
    capabilities = manifest.get("capabilities", {})
    if not isinstance(capabilities, dict):
        raise Invalid("plugin capabilities are invalid")
    if capabilities.get("reactive_rules") is not True:
        return
    required = {"session_id", "turn_id", "tool_name", "tool_use_id"}
    if not required.issubset(event) or not all(isinstance(event[key], str) and event[key] for key in required):
        raise Invalid("post-tool event identity is invalid")
    source, source_sha256, rule_set = load_rule_set(manifest)
    agent_id = event.get("agent_id")
    if agent_id is not None and (not isinstance(agent_id, str) or not agent_id):
        raise Invalid("post-tool agent identity is invalid")
    scope = "worker" if agent_id is not None else "lead"
    matches = [
        rule
        for rule in rule_set["rules"]
        if rule["scope"] == scope
        and rule["trigger"] == {
            "event": "tool_finished",
            "tool": event["tool_name"],
            "outcome": "completed_host_success",
        }
    ]
    if len(matches) > 1:
        raise Invalid("reactive hook event is ambiguous")
    if matches:
        write_marker(manifest, event, matches[0], source, source_sha256, scope, rule_set["version"])


def subagent_stop(manifest, event):
    communication = manifest.get("communication", {})
    if (
        not isinstance(communication, dict)
        or communication.get("structured_worker_reports") is not True
    ):
        return
    if not valid_worker_report(event.get("last_assistant_message")):
        print(json.dumps({
            "decision": "block",
            "reason": "Return the exact OMD structured worker report with every required field; incomplete worker output cannot be integrated.",
        }))


def main():
    event = read_json_input()
    manifest = load_manifest()
    if manifest is None:
        return
    name = event.get("hook_event_name")
    if name == "PostToolUse":
        post_tool_use(manifest, event)
    elif name == "SubagentStop":
        subagent_stop(manifest, event)
    else:
        raise Invalid("unsupported hook event")


if __name__ == "__main__":
    try:
        main()
    except (Invalid, json.JSONDecodeError, OSError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1) from error
