#!/usr/bin/env python3
import hashlib
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


def read_json(path, label):
    data = path.read_bytes()
    if len(data) > MAX_BYTES:
        raise Invalid(f"{label} exceeds size limit")
    value = json.loads(data, object_pairs_hook=object_without_duplicates)
    if not isinstance(value, dict):
        raise Invalid(f"{label} must be an object")
    return value, data


def canonical_file(raw, label):
    if not isinstance(raw, str) or not raw:
        raise Invalid(f"{label} path is absent")
    path = Path(raw).expanduser()
    if not path.is_absolute() or path.resolve() != path or not path.is_file():
        raise Invalid(f"{label} path is not a canonical file")
    return path


def configuration(environment):
    return environment.get("OMD_BRIDGE_CONFIG") or (str(Path(environment["OMD_MOD_STORE"]) / "plugin-config/omd-application-bridges.json") if environment.get("OMD_MOD_STORE") else None)


def idle(reason):
    sys.stderr.write(f"omd-application-bridges: {reason}; no tools are offered\n")
    for line in sys.stdin:
        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(request, dict) or "id" not in request:
            continue
        method = request.get("method")
        params = request.get("params") if isinstance(request.get("params"), dict) else {}
        result = ({"protocolVersion": params.get("protocolVersion", "2025-06-18"), "capabilities": {"tools": {}},
                   "serverInfo": {"name": "omd_application_bridges", "version": "0.1.0"}} if method == "initialize"
                  else {"tools": []} if method == "tools/list" else None)
        reply = {"jsonrpc": "2.0", "id": request["id"]}
        reply.update({"result": result} if result is not None else {"error": {"code": -32601, "message": reason}})
        sys.stdout.write(json.dumps(reply) + "\n")
        sys.stdout.flush()


def selection(environment):
    if environment.get("OMD_MODE") != "omd":
        raise Invalid("application bridge requires OMD mode")
    manifest_path = canonical_file(configuration(environment), "plugin configuration")
    manifest, _ = read_json(manifest_path, "plugin configuration")
    capabilities = manifest.get("capabilities", {})
    if (
        not isinstance(capabilities, dict)
        or capabilities.get("application_bridge") is not True
    ):
        raise Invalid("application bridge capability is not enabled")
    reference = manifest.get("bridge")
    if not isinstance(reference, dict) or set(reference) != {"path", "sha256"}:
        raise Invalid("application bridge requires an exact policy reference")
    policy = canonical_file(reference["path"], "bridge policy")
    expected = reference["sha256"]
    if (
        not isinstance(expected, str)
        or len(expected) != 64
        or any(character not in "0123456789abcdef" for character in expected)
    ):
        raise Invalid("bridge policy SHA256 is invalid")
    data = policy.read_bytes()
    if len(data) > 65_536 or hashlib.sha256(data).hexdigest() != expected:
        raise Invalid("bridge policy changed or exceeds its bound")
    repository = manifest.get("repository")
    if isinstance(repository, str):
        root = Path(repository)
        if root.is_absolute():
            try:
                policy.relative_to(root)
            except ValueError:
                pass
            else:
                raise Invalid("bridge policy must remain outside the repository")
    return policy, expected


def locate_launcher(plugin_root):
    plugin_root = Path(plugin_root)
    if not plugin_root.is_absolute() or plugin_root.resolve() != plugin_root:
        raise Invalid("plugin root is not canonical")
    prefix = plugin_root.parents[3]
    install = prefix / "install.json"
    manifest, _ = read_json(install, "private installation manifest")
    launcher = prefix / "browser/bin/omd-bridge-mcp"
    recorded = manifest.get("browser", {}).get("bridge", {}).get("launcher")
    if recorded != str(launcher) or not launcher.is_file() or launcher.is_symlink():
        raise Invalid("managed application bridge launcher is absent or changed")
    if not os.access(launcher, os.X_OK):
        raise Invalid("managed application bridge launcher is not executable")
    return launcher


def main():
    configured = configuration(os.environ)
    if not configured or not Path(configured).expanduser().exists():
        idle(f"not configured; create {configured or '$OMD_MOD_STORE/plugin-config/omd-application-bridges.json'}")
        return
    try:
        policy, expected = selection(os.environ)
        plugin_root = Path(__file__).resolve().parents[1]
        launcher = locate_launcher(plugin_root)
        environment = os.environ.copy()
        environment["OMD_BRIDGE_POLICY"] = str(policy)
        environment["OMD_BRIDGE_POLICY_SHA256"] = expected
        environment["OMD_BRIDGE_PLUGIN_SURFACE"] = "1"
        os.execve(launcher, [str(launcher)], environment)
    except (Invalid, json.JSONDecodeError, OSError) as error:
        raise SystemExit(str(error)) from error


if __name__ == "__main__":
    main()
