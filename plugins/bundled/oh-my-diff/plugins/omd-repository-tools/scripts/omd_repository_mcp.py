#!/usr/bin/env python3
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import sys
import tempfile


PROTOCOL_VERSION = "2025-03-26"
MAX_REQUEST_BYTES = 1024 * 1024
MAX_CAPTURE_BYTES = 25 * 1024 * 1024
MAX_REPORT_FINDINGS = 50
TIMEOUT_SECONDS = 150


def schema(properties, required):
    return {
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": False,
    }


STRING = {"type": "string", "minLength": 1, "maxLength": 4096}
REVISION = {"type": "string", "minLength": 1, "maxLength": 256}
SHA256 = {"type": "string", "pattern": "^[0-9a-f]{64}$"}
TOOLS = [
    {
        "name": "graph_snapshot",
        "description": "Build a bounded version-bound repository graph and deterministic static HTML snapshot. Both outputs must be inside .omd/graph/ and may only replace earlier graph artifacts.",
        "inputSchema": schema(
            {
                "repository": STRING,
                "graph_path": STRING,
                "html_path": STRING,
                "repository_id": {"type": "string", "minLength": 1, "maxLength": 256},
                "revision": REVISION,
            },
            ["repository", "graph_path", "html_path", "repository_id", "revision"],
        ),
    },
    {
        "name": "graph_validate",
        "description": "Validate a graph artifact and refuse it when supported repository source is stale.",
        "inputSchema": schema(
            {"repository": STRING, "graph_path": STRING},
            ["repository", "graph_path"],
        ),
    },
    {
        "name": "graph_html",
        "description": "Regenerate static HTML inside .omd/graph/ from a fresh graph artifact without rebuilding the graph; only earlier graph HTML may be replaced.",
        "inputSchema": schema(
            {"repository": STRING, "graph_path": STRING, "html_path": STRING},
            ["repository", "graph_path", "html_path"],
        ),
    },
    {
        "name": "graph_select",
        "description": "Select bounded graph nodes and their source-backed neighborhoods after freshness validation.",
        "inputSchema": schema(
            {
                "repository": STRING,
                "graph_path": STRING,
                "node_ids": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 64,
                    "items": {"type": "string", "minLength": 1, "maxLength": 1024},
                },
            },
            ["repository", "graph_path", "node_ids"],
        ),
    },
    {
        "name": "health_baseline",
        "description": "Create a version-bound health baseline from an explicitly approved constraints artifact.",
        "inputSchema": schema(
            {
                "repository": STRING,
                "constraints_path": STRING,
                "baseline_path": STRING,
                "revision": REVISION,
            },
            ["repository", "constraints_path", "baseline_path", "revision"],
        ),
    },
    {
        "name": "health_check",
        "description": "Run the one-shot health guard and write a report separated into introduced, debt, and uncertain findings.",
        "inputSchema": schema(
            {
                "repository": STRING,
                "constraints_path": STRING,
                "baseline_path": STRING,
                "report_path": STRING,
                "revision": REVISION,
            },
            [
                "repository",
                "constraints_path",
                "baseline_path",
                "report_path",
                "revision",
            ],
        ),
    },
    {
        "name": "health_report",
        "description": "Read one bounded page from a generated health report without changing source.",
        "inputSchema": schema(
            {
                "repository": STRING,
                "report_path": STRING,
                "report_sha256": SHA256,
                "category": {
                    "type": "string",
                    "enum": ["introduced", "debt", "uncertain"],
                },
                "offset": {"type": "integer", "minimum": 0, "maximum": 4096},
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": MAX_REPORT_FINDINGS,
                },
            },
            ["repository", "report_path", "report_sha256", "category"],
        ),
    },
]


class ToolError(Exception):
    pass


def text(value, maximum, field):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise ToolError(
            f"{field} must be a non-empty string of at most {maximum} characters"
        )
    return value


def repository_path(value):
    supplied = Path(text(value, 4096, "repository")).expanduser()
    if not supplied.is_absolute() or supplied.is_symlink():
        raise ToolError(
            "repository must be a canonical absolute directory without a symlink endpoint"
        )
    try:
        repository = supplied.resolve(strict=True)
    except (OSError, RuntimeError) as error:
        raise ToolError(f"repository is unavailable: {error}") from error
    if supplied != repository or not repository.is_dir():
        raise ToolError(
            "repository must be a canonical absolute directory without symlink traversal"
        )
    return repository


def contained_path(repository, value, field, must_exist):
    raw = text(value, 4096, field)
    relative = PurePosixPath(raw)
    if (
        relative.is_absolute()
        or raw in (".", "")
        or any(part in ("", ".", "..") for part in relative.parts)
    ):
        raise ToolError(f"{field} must be a normalized repository-relative path")
    target = repository.joinpath(*relative.parts)
    cursor = repository
    for part in relative.parts[:-1]:
        cursor = cursor / part
        if cursor.is_symlink():
            raise ToolError(f"{field} crosses a symlink")
        if cursor.exists() and not cursor.is_dir():
            raise ToolError(f"{field} has a non-directory parent")
    if target.is_symlink():
        raise ToolError(f"{field} cannot be a symlink")
    resolved = target.resolve(strict=must_exist)
    try:
        resolved.relative_to(repository)
    except ValueError as error:
        raise ToolError(f"{field} must stay inside the repository") from error
    if must_exist and not resolved.is_file():
        raise ToolError(f"{field} must name an existing regular file")
    if not must_exist and target.exists() and not target.is_file():
        raise ToolError(f"{field} must name a file")
    return target


def graph_output(repository, value, field):
    target = contained_path(repository, value, field, False)
    parts = PurePosixPath(value).parts
    if parts[:2] != (".omd", "graph") or len(parts) < 3 or ".git" in parts:
        raise ToolError(f"{field} must name a file inside .omd/graph/")
    return target


def executable(name):
    located = shutil.which(name, path=os.environ.get("PATH"))
    if not located:
        raise ToolError(f"required {name} executable is not installed on PATH")
    path = Path(located).resolve(strict=True)
    if not path.is_file() or not os.access(path, os.X_OK):
        raise ToolError(f"required {name} executable is not runnable")
    return path


def run_binary(name, arguments, accepted=(0,)):
    with (
        tempfile.TemporaryFile() as stdout_file,
        tempfile.TemporaryFile() as stderr_file,
    ):
        try:
            result = subprocess.run(
                [str(executable(name)), *map(str, arguments)],
                stdin=subprocess.DEVNULL,
                stdout=stdout_file,
                stderr=stderr_file,
                timeout=TIMEOUT_SECONDS,
                check=False,
            )
        except subprocess.TimeoutExpired as error:
            raise ToolError(
                f"{name} exceeded the {TIMEOUT_SECONDS}-second tool limit"
            ) from error
        if (
            stdout_file.tell() > MAX_CAPTURE_BYTES
            or stderr_file.tell() > MAX_CAPTURE_BYTES
        ):
            raise ToolError(f"{name} exceeded the bounded tool output limit")
        stdout_file.seek(0)
        stderr_file.seek(0)
        try:
            stdout = stdout_file.read().decode("utf-8", errors="strict")
        except UnicodeDecodeError as error:
            raise ToolError(f"{name} returned non-UTF-8 output") from error
        stderr = stderr_file.read().decode("utf-8", errors="replace").strip()
        if result.returncode not in accepted:
            detail = stderr or stdout.strip() or f"exit {result.returncode}"
            raise ToolError(f"{name} refused the request: {detail[-8000:]}")
    try:
        payload = json.loads(stdout)
    except json.JSONDecodeError as error:
        raise ToolError(f"{name} returned malformed JSON") from error
    if not isinstance(payload, dict):
        raise ToolError(f"{name} returned a non-object JSON result")
    return result.returncode, payload


def file_sha256(path):
    value = hashlib.sha256()
    with path.open("rb") as handle:
        while block := handle.read(1024 * 1024):
            value.update(block)
    return value.hexdigest()


def artifact(relative, path):
    return {
        "path": relative,
        "bytes": path.stat().st_size,
        "sha256": file_sha256(path),
    }


def graph_tool(name, arguments):
    repository = repository_path(arguments.get("repository"))
    if name == "graph_snapshot":
        graph_raw = text(arguments.get("graph_path"), 4096, "graph_path")
        html_raw = text(arguments.get("html_path"), 4096, "html_path")
        graph = graph_output(repository, graph_raw, "graph_path")
        html = graph_output(repository, html_raw, "html_path")
        identity = text(arguments.get("repository_id"), 256, "repository_id")
        revision = text(arguments.get("revision"), 256, "revision")
        _, payload = run_binary(
            "omd-graph", ["snapshot", repository, graph, html, identity, revision]
        )
        return {
            "status": "created",
            "repository": payload,
            "graph": artifact(graph_raw, graph),
            "html": artifact(html_raw, html),
        }
    graph_raw = text(arguments.get("graph_path"), 4096, "graph_path")
    graph = contained_path(repository, graph_raw, "graph_path", True)
    if name == "graph_validate":
        _, payload = run_binary("omd-graph", ["validate", repository, graph])
        return {
            "status": "fresh",
            "repository": payload,
            "graph": artifact(graph_raw, graph),
        }
    if name == "graph_html":
        html_raw = text(arguments.get("html_path"), 4096, "html_path")
        html = graph_output(repository, html_raw, "html_path")
        _, payload = run_binary("omd-graph", ["html", repository, graph, html])
        return {
            "status": "created",
            "repository": payload,
            "graph": artifact(graph_raw, graph),
            "html": artifact(html_raw, html),
        }
    node_ids = arguments.get("node_ids")
    if not isinstance(node_ids, list) or not 1 <= len(node_ids) <= 64:
        raise ToolError("node_ids must contain between 1 and 64 node identifiers")
    checked = [text(value, 1024, "node_ids item") for value in node_ids]
    _, payload = run_binary("omd-graph", ["select", repository, graph, *checked])
    return {
        "status": "selected",
        "graph": artifact(graph_raw, graph),
        "selection": payload,
    }


def health_summary(payload, artifact_key, relative, path, status, inputs):
    result = {
        "status": status,
        artifact_key: artifact(relative, path),
        "repository_identity": payload.get("repository_identity"),
        "revision": payload.get("revision", payload.get("current_revision")),
        "source_digest": payload.get(
            "source_digest", payload.get("current_source_digest")
        ),
        "constraints_version": payload.get("constraints_version"),
        "constraints_sha256": payload.get("constraints_sha256"),
        "counts": {
            "checks": len(payload.get("checks", [])),
            "introduced": len(payload.get("introduced_findings", [])),
            "debt": len(
                payload.get("existing_debt", payload.get("existing_observations", []))
            ),
            "uncertain": len(payload.get("uncertain_findings", [])),
        },
    }
    result["inputs"] = {
        key: artifact(input_relative, input_path)
        for key, input_relative, input_path in inputs
    }
    return result


def health_tool(name, arguments):
    repository = repository_path(arguments.get("repository"))
    if name == "health_report":
        report_raw = text(arguments.get("report_path"), 4096, "report_path")
        report = contained_path(repository, report_raw, "report_path", True)
        expected_sha256 = text(arguments.get("report_sha256"), 64, "report_sha256")
        if (
            len(expected_sha256) != 64
            or any(value not in "0123456789abcdef" for value in expected_sha256)
            or file_sha256(report) != expected_sha256
        ):
            raise ToolError("health report SHA256 does not match the check receipt")
        if report.stat().st_size > 8 * 1024 * 1024:
            raise ToolError("health report exceeds the native report size limit")
        try:
            payload = json.loads(report.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            raise ToolError(f"health report is unreadable: {error}") from error
        if (
            not isinstance(payload, dict)
            or payload.get("schema") != 1
            or payload.get("generator") != "omd-focused-code-health-v1"
        ):
            raise ToolError("health report has an unsupported schema or generator")
        category = arguments.get("category")
        fields = {
            "introduced": "introduced_findings",
            "debt": "existing_debt",
            "uncertain": "uncertain_findings",
        }
        if category not in fields:
            raise ToolError("category must be introduced, debt, or uncertain")
        values = payload.get(fields[category])
        if not isinstance(values, list):
            raise ToolError(
                "health report does not contain the requested finding category"
            )
        offset = arguments.get("offset", 0)
        limit = arguments.get("limit", 20)
        if type(offset) is not int or not 0 <= offset <= 4096:
            raise ToolError("offset must be an integer between 0 and 4096")
        if type(limit) is not int or not 1 <= limit <= MAX_REPORT_FINDINGS:
            raise ToolError(
                f"limit must be an integer between 1 and {MAX_REPORT_FINDINGS}"
            )
        return {
            "status": "read",
            "report": artifact(report_raw, report),
            "category": category,
            "offset": offset,
            "limit": limit,
            "total": len(values),
            "findings": values[offset : offset + limit],
            "metadata": {
                key: payload.get(key)
                for key in (
                    "repository_identity",
                    "baseline_revision",
                    "baseline_source_digest",
                    "current_revision",
                    "current_source_digest",
                    "constraints_version",
                    "constraints_sha256",
                )
            },
        }
    constraints_raw = text(arguments.get("constraints_path"), 4096, "constraints_path")
    baseline_raw = text(arguments.get("baseline_path"), 4096, "baseline_path")
    constraints = contained_path(repository, constraints_raw, "constraints_path", True)
    revision = text(arguments.get("revision"), 256, "revision")
    if name == "health_baseline":
        baseline = contained_path(repository, baseline_raw, "baseline_path", False)
        _, payload = run_binary(
            "omd-health", ["baseline", repository, constraints, baseline, revision]
        )
        return health_summary(
            payload,
            "baseline",
            baseline_raw,
            baseline,
            "baseline_created",
            [("constraints", constraints_raw, constraints)],
        )
    baseline = contained_path(repository, baseline_raw, "baseline_path", True)
    report_raw = text(arguments.get("report_path"), 4096, "report_path")
    report = contained_path(repository, report_raw, "report_path", False)
    returncode, payload = run_binary(
        "omd-health",
        ["check", repository, constraints, baseline, report, revision],
        accepted=(0, 2),
    )
    status = (
        "introduced_findings" if returncode == 2 else "clear_of_introduced_findings"
    )
    return health_summary(
        payload,
        "report",
        report_raw,
        report,
        status,
        [
            ("constraints", constraints_raw, constraints),
            ("baseline", baseline_raw, baseline),
        ],
    )


def call_tool(params):
    if not isinstance(params, dict):
        raise ToolError("tool request parameters must be an object")
    name = params.get("name")
    arguments = params.get("arguments", {})
    if not isinstance(arguments, dict):
        raise ToolError("tool arguments must be an object")
    if name in {"graph_snapshot", "graph_validate", "graph_html", "graph_select"}:
        payload = graph_tool(name, arguments)
    elif name in {"health_baseline", "health_check", "health_report"}:
        payload = health_tool(name, arguments)
    else:
        raise ToolError(f"unknown tool: {name}")
    rendered = json.dumps(payload, indent=2, sort_keys=True)
    return {
        "content": [{"type": "text", "text": rendered}],
        "structuredContent": payload,
    }


def response(request):
    method = request.get("method")
    if method == "initialize":
        requested = request.get("params", {}).get("protocolVersion")
        version = (
            requested if isinstance(requested, str) and requested else PROTOCOL_VERSION
        )
        return {
            "protocolVersion": version,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": "omd-repository-tools", "version": "0.1.0"},
        }
    if method == "ping":
        return {}
    if method == "tools/list":
        return {"tools": TOOLS}
    if method == "tools/call":
        return call_tool(request.get("params"))
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
            request = json.loads(raw)
        except (UnicodeError, json.JSONDecodeError):
            continue
        if not isinstance(request, dict) or request.get("jsonrpc") != "2.0":
            continue
        if "id" not in request:
            continue
        try:
            result = response(request)
            emit({"jsonrpc": "2.0", "id": request["id"], "result": result})
        except ToolError as error:
            if request.get("method") == "tools/call":
                emit(
                    {
                        "jsonrpc": "2.0",
                        "id": request["id"],
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
                        "id": request["id"],
                        "error": {"code": -32602, "message": str(error)},
                    }
                )
        except Exception as error:
            emit(
                {
                    "jsonrpc": "2.0",
                    "id": request["id"],
                    "error": {"code": -32603, "message": str(error)},
                }
            )


if __name__ == "__main__":
    main()
