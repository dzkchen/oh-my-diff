import hashlib
import json
import os
import re
from pathlib import Path
import shlex
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[1]
BASE_SCHEMA = 1
BASE_PRODUCT = "oh-my-diff-base-v1"
PLUGIN_SCHEMA = 1
PLUGIN_PRODUCT = "oh-my-diff-bundled-plugin-v1"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(arguments, cwd=None, env=None, capture=True):
    arguments = [str(item) for item in arguments]
    streams = {"stdout": subprocess.PIPE, "stderr": subprocess.PIPE} if capture else {}
    result = subprocess.run(arguments, cwd=cwd, env=env, text=True, **streams)
    if result.returncode:
        detail = ((result.stderr or result.stdout)[-12000:] if capture else "").rstrip()
        raise RuntimeError(f"command failed ({result.returncode}): {shlex.join(arguments)}\n{detail}")
    return result


def output(arguments, cwd=None, env=None):
    return run(arguments, cwd=cwd, env=env).stdout.strip()


def resolved(path):
    return Path(path).expanduser().resolve()


def within(path, parent):
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def state_roots():
    home = resolved(os.environ.get("CODEX_HOME", Path.home() / ".codex"))
    sqlite = resolved(os.environ.get("CODEX_SQLITE_HOME", home))
    return home, sqlite


def path_without(bin_dir):
    return os.pathsep.join(item for item in os.environ.get("PATH", "").split(os.pathsep)
                           if item and resolved(item) != bin_dir)


def validate_locations(prefix, bin_dir):
    prefix = resolved(prefix)
    bin_dir = resolved(bin_dir)
    if prefix == Path(prefix.anchor) or bin_dir == Path(bin_dir.anchor):
        raise ValueError("installation paths must not be filesystem roots")
    for state in set(state_roots()):
        if within(prefix, state) or within(bin_dir, state):
            raise ValueError("installation paths must not be inside shared Codex state")
        if within(state, prefix):
            raise ValueError("installation prefix must not contain shared Codex state")
    if within(bin_dir, prefix):
        raise ValueError("bin directory must be outside the removable installation prefix")
    return prefix, bin_dir


def plugin_lock():
    lock = json.loads((ROOT / "runtime/plugins.lock.json").read_text())
    if lock.get("schema") != PLUGIN_SCHEMA or lock.get("product") != PLUGIN_PRODUCT:
        raise ValueError("unrecognized bundled plugin lock")
    return lock


def plugin_inventory(source):
    names = json.loads((ROOT / "plugins/release-files.json").read_text())
    if not isinstance(names, list) or any(not isinstance(name, str) for name in names):
        raise ValueError("invalid bundled plugin release inventory")
    if len(names) != len(set(names)):
        raise ValueError("duplicate bundled plugin release file")
    for name in names:
        path = Path(name)
        if path.is_absolute() or path.as_posix() != name or ".." in path.parts:
            raise ValueError(f"unsafe bundled plugin release file: {name}")
        if any((source / parent).is_symlink() for parent in (path, *path.parents)):
            raise ValueError(f"symlink in bundled plugin release file: {name}")
        if not (source / path).is_file():
            raise ValueError(f"missing bundled plugin release file: {name}")
    return sorted(names)


def plugin_sources(lock=None):
    lock = lock or plugin_lock()
    source = ROOT / lock["source"]
    guide = ROOT / lock["guide"]["path"]
    if digest(guide) != lock["guide"]["sha256"]:
        raise ValueError("pinned bundled plugin guide changed")
    recorded = set(lock["files"])
    actual = set(plugin_inventory(source))
    if actual != recorded:
        raise ValueError("bundled plugin file inventory changed")
    for name, expected in lock["files"].items():
        if digest(source / name) != expected:
            raise ValueError(f"pinned bundled plugin source changed: {name}")
    marketplace = json.loads((source / ".agents/plugins/marketplace.json").read_text())
    if marketplace.get("name") != lock["marketplace"]:
        raise ValueError("bundled plugin marketplace identity changed")
    for identifier, plugin in lock["plugins"].items():
        manifest = json.loads(
            (source / f"plugins/{identifier}/.codex-plugin/plugin.json").read_text()
        )
        if manifest.get("name") != identifier or manifest.get("version") != plugin["version"]:
            raise ValueError(f"bundled plugin identity changed: {identifier}")
        if "mod" in plugin["extension_types"] or plugin.get("mod_required"):
            raise ValueError(f"bundled plugin is incorrectly classified as a mod: {identifier}")
    return lock


def compatible_upstream(version, pinned):
    major, minor, _ = pinned.split(".")
    return re.fullmatch(rf"codex-cli {re.escape(major)}\.{re.escape(minor)}\.\d+", version) is not None


def compatible_node(version, pinned):
    found = re.fullmatch(r"v(\d+)\.(\d+)\.\d+", version)
    major, minor, _ = pinned.split(".")
    return found is not None and found[1] == major and int(found[2]) >= int(minor)


def binary_identity(path):
    path = resolved(path)
    if not path.is_file() or not os.access(path, os.X_OK):
        raise ValueError(f"not an executable file: {path}")
    version = output([str(path), "--version"])
    return {"path": str(path), "sha256": digest(path), "version": version}


def atomic_text(path, text, mode=0o644):
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def check_or_write(path, text, write, stale):
    if write:
        atomic_text(path, text)
        print(f"wrote {path.relative_to(ROOT)}")
    elif not path.is_file() or path.read_text() != text:
        raise SystemExit(stale)


def base_lock():
    lock = json.loads((ROOT / "runtime/base.lock.json").read_text())
    if lock.get("schema") != BASE_SCHEMA or lock.get("product") != BASE_PRODUCT:
        raise ValueError("unrecognized base lock")
    return lock


def base_sources(lock):
    if digest(ROOT / lock["types"]["path"]) != lock["types"]["sha256"]:
        raise ValueError(f"pinned mod API types changed: {lock['types']['path']}")
    for identifier, package in lock["packages"].items():
        if package.get("extension_type") != "mod":
            raise ValueError(f"pinned package {identifier} must be labeled as a mod")
        base = ROOT / package["source"]
        for name, expected in package["files"].items():
            if digest(base / name) != expected:
                raise ValueError(f"pinned package source changed: {package['source']}/{name}")
        declared = json.loads((base / "mod.json").read_text())
        if declared["api"] != package.get("api", lock["mod_api"]):
            raise ValueError(f"package {identifier} declares mod API {declared['api']}; "
                             f"this release is pinned to {lock['mod_api']}")
        if declared["id"] != identifier:
            raise ValueError(f"pinned package disagrees with the lock: {identifier}")
    return lock
