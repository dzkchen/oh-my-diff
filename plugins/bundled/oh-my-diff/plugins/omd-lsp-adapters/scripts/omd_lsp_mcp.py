#!/usr/bin/env python3
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tempfile


PROTOCOL_VERSION = "2025-03-26"
MAX_REQUEST_BYTES = 1024 * 1024
MAX_CAPTURE_BYTES = 8 * 1024 * 1024
TIMEOUT_SECONDS = 150
LANGUAGES = {
    "rust_lsp": "rust",
    "typescript_lsp": "typescript",
    "javascript_lsp": "javascript",
    "python_lsp": "python",
    "java_lsp": "java",
}
ACTIONS = (
    "status",
    "diagnostics",
    "definition",
    "references",
    "code_actions",
    "apply_code_action",
    "rename_symbol",
    "rename_file",
)


def schema(properties, required):
    return {
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": False,
    }


STRING = {"type": "string", "minLength": 1, "maxLength": 4096}
PATH = {"type": "string", "minLength": 1, "maxLength": 4096}
PATHS = {
    "type": "array",
    "minItems": 1,
    "maxItems": 128,
    "uniqueItems": True,
    "items": PATH,
}
POSITION = schema(
    {
        "line": {"type": "integer", "minimum": 0},
        "character": {"type": "integer", "minimum": 0},
    },
    ["line", "character"],
)
RANGE = schema({"start": POSITION, "end": POSITION}, ["start", "end"])
EXPECTED = {
    "type": "object",
    "maxProperties": 128,
    "additionalProperties": {
        "anyOf": [
            {"type": "string", "pattern": "^[0-9a-f]{64}$"},
            {"type": "null"},
        ]
    },
}
PROPERTIES = {
    "repository": STRING,
    "preference_store": STRING,
    "repository_identity": {"type": "string", "minLength": 1, "maxLength": 512},
    "action": {"type": "string", "enum": list(ACTIONS)},
    "paths": PATHS,
    "path": PATH,
    "position": POSITION,
    "range": RANGE,
    "include_declaration": {"type": "boolean"},
    "action_value": {"type": "object"},
    "new_name": {"type": "string", "minLength": 1, "maxLength": 512},
    "old_path": PATH,
    "new_path": PATH,
    "scope": PATHS,
    "expected_versions": EXPECTED,
}


def tool(name, language):
    display = {
        "rust": "Rust",
        "typescript": "TypeScript",
        "javascript": "JavaScript",
        "python": "Python",
        "java": "Java",
    }[language]
    return {
        "name": name,
        "description": (
            f"Use the {display} language-server adapter after explicit repository opt-in. "
            "Commands cover fresh diagnostics, definition, references, edit-only code actions, "
            "and exact-scope symbol or file rename. The native operator admits installed servers, "
            "synchronizes documents, validates hashes and scope, writes atomically, and cleans up. "
            "Unsupported operations return an explicit ordinary-tool fallback and never count as success."
        ),
        "inputSchema": schema(
            PROPERTIES,
            ["repository", "preference_store", "repository_identity", "action"],
        ),
    }


TOOLS = [tool(name, language) for name, language in LANGUAGES.items()]


class ToolError(Exception):
    pass


def text(value, maximum, field):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise ToolError(
            f"{field} must be a non-empty string of at most {maximum} characters"
        )
    return value


def canonical_directory(value, field):
    supplied = Path(text(value, 4096, field)).expanduser()
    if not supplied.is_absolute() or supplied.is_symlink():
        raise ToolError(
            f"{field} must be a canonical absolute directory without a symlink endpoint"
        )
    try:
        resolved = supplied.resolve(strict=True)
    except (OSError, RuntimeError) as error:
        raise ToolError(f"{field} is unavailable: {error}") from error
    if supplied != resolved or not resolved.is_dir():
        raise ToolError(
            f"{field} must be a canonical absolute directory without symlink traversal"
        )
    return resolved


def canonical_file(value, field):
    supplied = Path(text(value, 4096, field)).expanduser()
    if not supplied.is_absolute() or supplied.is_symlink():
        raise ToolError(
            f"{field} must be an existing canonical absolute file without a symlink endpoint"
        )
    try:
        resolved = supplied.resolve(strict=True)
    except (OSError, RuntimeError) as error:
        raise ToolError(f"{field} is unavailable: {error}") from error
    if supplied != resolved or not resolved.is_file():
        raise ToolError(
            f"{field} must be an existing canonical absolute file without symlink traversal"
        )
    if resolved.stat().st_size > 1024 * 1024:
        raise ToolError(f"{field} exceeds the native 1 MiB preference-store limit")
    return resolved


def relative_path(value, field):
    raw = text(value, 4096, field)
    path = PurePosixPath(raw)
    if (
        path.is_absolute()
        or raw in ("", ".")
        or any(part in ("", ".", "..") for part in path.parts)
    ):
        raise ToolError(f"{field} must be a normalized repository-relative path")
    return raw


def paths(value, field):
    if not isinstance(value, list) or not 1 <= len(value) <= 128:
        raise ToolError(f"{field} must contain between 1 and 128 paths")
    checked = [relative_path(item, f"{field} item") for item in value]
    if len(set(checked)) != len(checked):
        raise ToolError(f"{field} contains duplicate paths")
    return checked


def position(value, field):
    if not isinstance(value, dict) or set(value) != {"line", "character"}:
        raise ToolError(f"{field} must contain line and character")
    if any(type(value[key]) is not int or value[key] < 0 for key in value):
        raise ToolError(f"{field} line and character must be non-negative integers")
    return value


def range_value(value):
    if not isinstance(value, dict) or set(value) != {"start", "end"}:
        raise ToolError("range must contain start and end positions")
    return {
        "start": position(value["start"], "range.start"),
        "end": position(value["end"], "range.end"),
    }


def expected_versions(value):
    if not isinstance(value, dict) or len(value) > 128:
        raise ToolError("expected_versions must be an object with at most 128 paths")
    result = {}
    for path, digest in value.items():
        checked = relative_path(path, "expected_versions path")
        if digest is not None and not (
            isinstance(digest, str) and re.fullmatch(r"[0-9a-f]{64}", digest)
        ):
            raise ToolError(
                "expected_versions values must be lowercase SHA256 strings or null"
            )
        result[checked] = digest
    return result


def request(arguments):
    action = arguments.get("action")
    if action not in ACTIONS:
        raise ToolError(f"action must be one of {', '.join(ACTIONS)}")
    base = {"repository", "preference_store", "repository_identity", "action"}
    action_fields = {
        "status": set(),
        "diagnostics": {"paths"},
        "definition": {"paths", "path", "position"},
        "references": {"paths", "path", "position", "include_declaration"},
        "code_actions": {"paths", "path", "range"},
        "apply_code_action": {
            "paths",
            "action_value",
            "scope",
            "expected_versions",
        },
        "rename_symbol": {
            "paths",
            "path",
            "position",
            "new_name",
            "scope",
            "expected_versions",
        },
        "rename_file": {
            "paths",
            "old_path",
            "new_path",
            "scope",
            "expected_versions",
        },
    }
    extra = set(arguments) - base - action_fields[action]
    if extra:
        raise ToolError(f"{action} does not accept: {', '.join(sorted(extra))}")
    result = {"action": action}
    if action == "status":
        return result
    result["paths"] = paths(arguments.get("paths"), "paths")
    if action == "diagnostics":
        return result
    if action in {"definition", "references", "code_actions", "rename_symbol"}:
        result["path"] = relative_path(arguments.get("path"), "path")
    if action in {"definition", "references", "rename_symbol"}:
        result["position"] = position(arguments.get("position"), "position")
    if action == "references":
        declaration = arguments.get("include_declaration", False)
        if not isinstance(declaration, bool):
            raise ToolError("include_declaration must be boolean")
        result["include_declaration"] = declaration
    if action == "code_actions":
        result["range"] = range_value(arguments.get("range"))
    if action == "apply_code_action":
        action_value = arguments.get("action_value")
        if not isinstance(action_value, dict):
            raise ToolError("action_value must be the exact object returned by code_actions")
        result["action_value"] = action_value
    if action == "rename_symbol":
        result["new_name"] = text(arguments.get("new_name"), 512, "new_name")
    if action == "rename_file":
        result["old_path"] = relative_path(arguments.get("old_path"), "old_path")
        result["new_path"] = relative_path(arguments.get("new_path"), "new_path")
    if action in {"apply_code_action", "rename_symbol", "rename_file"}:
        result["scope"] = paths(arguments.get("scope"), "scope")
        result["expected_versions"] = expected_versions(
            arguments.get("expected_versions")
        )
    return result


def executable():
    located = shutil.which("omd-lsp", path=os.environ.get("PATH"))
    if not located:
        raise ToolError("required omd-lsp executable is not installed on PATH")
    path = Path(located).resolve(strict=True)
    if not path.is_file() or not os.access(path, os.X_OK):
        raise ToolError("required omd-lsp executable is not runnable")
    return path


def native_adapter(repository, store, identity, language, payload):
    encoded = json.dumps(payload, separators=(",", ":"))
    if len(encoded.encode("utf-8")) > MAX_REQUEST_BYTES:
        raise ToolError("adapter request exceeds the 1 MiB native limit")
    with (
        tempfile.TemporaryFile() as stdout_file,
        tempfile.TemporaryFile() as stderr_file,
    ):
        try:
            result = subprocess.run(
                [
                    str(executable()),
                    "adapter",
                    str(repository),
                    str(store),
                    identity,
                    language,
                ],
                input=encoded.encode("utf-8"),
                stdout=stdout_file,
                stderr=stderr_file,
                timeout=TIMEOUT_SECONDS,
                check=False,
            )
        except subprocess.TimeoutExpired as error:
            raise ToolError(
                f"omd-lsp exceeded the {TIMEOUT_SECONDS}-second adapter limit"
            ) from error
        if (
            stdout_file.tell() > MAX_CAPTURE_BYTES
            or stderr_file.tell() > MAX_CAPTURE_BYTES
        ):
            raise ToolError("omd-lsp exceeded the bounded adapter output limit")
        stdout_file.seek(0)
        stderr_file.seek(0)
        stdout = stdout_file.read().decode("utf-8", errors="strict")
        stderr = stderr_file.read().decode("utf-8", errors="replace").strip()
    if result.returncode:
        detail = stderr or stdout.strip() or f"exit {result.returncode}"
        raise ToolError(f"omd-lsp refused the request: {detail[-8000:]}")
    try:
        response = json.loads(stdout)
    except json.JSONDecodeError as error:
        raise ToolError("omd-lsp returned malformed JSON") from error
    if not isinstance(response, dict) or response.get("status") not in {
        "ready",
        "completed",
        "unsupported",
        "failed",
    }:
        raise ToolError("omd-lsp returned an unsupported result shape")
    return response


def presentation(payload, language, action):
    status = payload["status"]
    if status == "unsupported":
        return {
            "outcome": "unsupported",
            "summary": f"{language} {action} did not produce semantic evidence: {payload.get('reason', 'operation unavailable')}",
            "next_step": payload.get(
                "fallback",
                "Use ordinary repository tools and an executable check without claiming LSP coverage.",
            ),
        }
    if status == "failed":
        return {
            "outcome": "failed",
            "summary": f"{language} {action} failed: {payload.get('error', 'native operation failed')}",
            "next_step": "Correct the request or use ordinary repository tools; do not present this as passed semantic evidence.",
        }
    return {
        "outcome": status,
        "summary": f"{language} {action} completed through the native OMD safety boundary.",
    }


def call_tool(params):
    if not isinstance(params, dict):
        raise ToolError("tool request parameters must be an object")
    name = params.get("name")
    if name not in LANGUAGES:
        raise ToolError(f"unknown tool: {name}")
    arguments = params.get("arguments", {})
    if not isinstance(arguments, dict):
        raise ToolError("tool arguments must be an object")
    repository = canonical_directory(arguments.get("repository"), "repository")
    store = canonical_file(arguments.get("preference_store"), "preference_store")
    identity = text(arguments.get("repository_identity"), 512, "repository_identity")
    native_request = request(arguments)
    language = LANGUAGES[name]
    payload = native_adapter(repository, store, identity, language, native_request)
    payload["adapter"] = {"plugin": "omd-lsp-adapters", "tool": name}
    payload["presentation"] = presentation(payload, language, native_request["action"])
    rendered = json.dumps(payload, indent=2, sort_keys=True)
    result = {
        "content": [{"type": "text", "text": rendered}],
        "structuredContent": payload,
    }
    if payload["status"] == "failed":
        result["isError"] = True
    return result


def response(request_value):
    method = request_value.get("method")
    if method == "initialize":
        requested = request_value.get("params", {}).get("protocolVersion")
        version = (
            requested if isinstance(requested, str) and requested else PROTOCOL_VERSION
        )
        return {
            "protocolVersion": version,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": "omd-lsp-adapters", "version": "0.1.0"},
        }
    if method == "ping":
        return {}
    if method == "tools/list":
        return {"tools": TOOLS}
    if method == "tools/call":
        return call_tool(request_value.get("params"))
    raise ToolError(f"unsupported method: {method}")


def emit(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def main():
    while raw := sys.stdin.buffer.readline(MAX_REQUEST_BYTES + 1):
        if len(raw) > MAX_REQUEST_BYTES:
            while raw and not raw.endswith(b"\n"):
                raw = sys.stdin.buffer.readline(MAX_REQUEST_BYTES + 1)
            continue
        try:
            request_value = json.loads(raw)
        except (UnicodeError, json.JSONDecodeError):
            continue
        if not isinstance(request_value, dict) or request_value.get("jsonrpc") != "2.0":
            continue
        if "id" not in request_value:
            continue
        try:
            result = response(request_value)
            emit({"jsonrpc": "2.0", "id": request_value["id"], "result": result})
        except ToolError as error:
            if request_value.get("method") == "tools/call":
                emit(
                    {
                        "jsonrpc": "2.0",
                        "id": request_value["id"],
                        "result": {
                            "content": [{"type": "text", "text": str(error)}],
                            "isError": True,
                        },
                    }
                )
            else:
                emit(
                    {
                        "jsonrpc": "2.0",
                        "id": request_value["id"],
                        "error": {"code": -32602, "message": str(error)},
                    }
                )
        except Exception as error:
            emit(
                {
                    "jsonrpc": "2.0",
                    "id": request_value["id"],
                    "error": {"code": -32603, "message": str(error)},
                }
            )


if __name__ == "__main__":
    main()
