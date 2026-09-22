#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
from datetime import datetime, timezone

try:
    from scripts import browser_bundle
    from scripts.preview_lock import package_digest
except ModuleNotFoundError:
    import browser_bundle
    from preview_lock import package_digest


ROOT = Path(__file__).resolve().parents[1]
SCHEMA = 1
PRODUCT = "oh-my-diff-private-lean-v1"
PREVIEW_SCHEMA = 1
PREVIEW_PRODUCT = "oh-my-diff-private-preview-v1"
PLUGIN_SCHEMA = 1
PLUGIN_PRODUCT = "oh-my-diff-bundled-plugin-v1"
PACKAGE_FILES = ("mod.json", "index.ts")


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(arguments, cwd=None, env=None, capture=True):
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


def lock_inputs():
    upstream = json.loads((ROOT / "upstream.lock.json").read_text())
    lean = json.loads((ROOT / "runtime/lean-v1.lock.json").read_text())
    patch = ROOT / lean["runtime_patch"]["path"]
    if digest(patch) != lean["runtime_patch"]["sha256"]:
        raise ValueError("frozen runtime patch hash mismatch")
    if lean["upstream"]["commit"] != upstream["commit"]:
        raise ValueError("lean-v1 and upstream locks disagree")
    return upstream, lean


def plugin_lock():
    lock = json.loads((ROOT / "runtime/plugin-v1.lock.json").read_text())
    if lock.get("schema") != PLUGIN_SCHEMA or lock.get("product") != PLUGIN_PRODUCT:
        raise ValueError("unrecognized bundled plugin lock")
    return lock


def plugin_sources(lock=None):
    lock = lock or plugin_lock()
    source = ROOT / lock["source"]
    guide = ROOT / lock["guide"]["path"]
    if digest(guide) != lock["guide"]["sha256"]:
        raise ValueError("pinned bundled plugin guide changed")
    recorded = set(lock["files"])
    actual = {
        path.relative_to(source).as_posix()
        for path in source.rglob("*")
        if path.is_file() and "__pycache__" not in path.parts and path.suffix != ".pyc"
    }
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


def copy_plugin_bundle(destination):
    lock = plugin_sources()
    source = ROOT / lock["source"]
    for name in lock["files"]:
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source / name, target)
    guide = destination.parent / "README.md"
    shutil.copy2(ROOT / lock["guide"]["path"], guide)
    return {
        "schema": lock["schema"],
        "product": lock["product"],
        "marketplace": lock["marketplace"],
        "installed_path": str(destination),
        "guide": str(guide),
        "guide_sha256": lock["guide"]["sha256"],
        "files": lock["files"],
        "plugins": lock["plugins"],
        "shared_state": "not installed or configured",
    }


def verify_plugin_bundle(record):
    destination = resolved(record["installed_path"])
    if record.get("schema") != PLUGIN_SCHEMA or record.get("product") != PLUGIN_PRODUCT:
        raise ValueError("installed plugin bundle record is unrecognized")
    for name, expected in record["files"].items():
        path = destination / name
        if not path.is_file() or digest(path) != expected:
            raise ValueError(f"installed plugin bundle changed: {name}")
    guide = resolved(record["guide"])
    if not guide.is_file() or digest(guide) != record["guide_sha256"]:
        raise ValueError("installed plugin bundle guide changed")
    return record


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


def write_manifest(prefix, manifest):
    atomic_text(prefix / "install.json", json.dumps(manifest, indent=2, sort_keys=True) + "\n")


def load_manifest(prefix):
    prefix = resolved(prefix)
    path = prefix / "install.json"
    if not path.is_file():
        raise ValueError(f"no managed private lean-v1 installation at {prefix}")
    manifest = json.loads(path.read_text())
    if manifest.get("schema") != SCHEMA or manifest.get("product") != PRODUCT:
        raise ValueError("refusing an unrecognized installation manifest")
    if resolved(manifest["prefix"]) != prefix:
        raise ValueError("installation manifest prefix mismatch")
    return manifest


def browser_config_args(browser):
    command = browser["launcher"]
    return [
        "--config", f"mcp_servers.omd_browser.command={json.dumps(command)}",
        "--config", "mcp_servers.omd_browser.args=[]",
        "--config", "mcp_servers.omd_browser.enabled=true",
        "--config", "mcp_servers.omd_browser.required=false",
        "--config", "mcp_servers.omd_browser.startup_timeout_sec=30",
        "--config", "mcp_servers.omd_browser.tool_timeout_sec=120",
        "--config", 'mcp_servers.omd_browser.default_tools_approval_mode="prompt"',
    ]


def bridge_selection(controlled_manifest, browser):
    if not controlled_manifest or not browser:
        return None
    manifest = json.loads(Path(controlled_manifest).read_text())
    if not manifest.get("capabilities", {}).get("application_bridge", False):
        return None
    reference = manifest.get("bridge")
    if not isinstance(reference, dict) or set(reference) != {"path", "sha256"}:
        raise ValueError("application_bridge requires an exact bridge policy reference")
    policy = Path(reference["path"]).expanduser()
    expected = reference["sha256"]
    if (not policy.is_absolute() or policy != policy.resolve()
            or not isinstance(expected, str) or len(expected) != 64
            or any(character not in "0123456789abcdef" for character in expected)):
        raise ValueError("bridge policy reference is not canonical")
    if not policy.is_file() or digest(policy) != expected:
        raise ValueError("bridge policy is absent or changed")
    launcher = browser.get("bridge", {}).get("launcher")
    if not launcher:
        raise ValueError("installed bundle does not contain the bridge launcher")
    return {"launcher": launcher, "policy": str(policy), "sha256": expected}


def bridge_config_args(bridge):
    return [
        "--config", f"mcp_servers.omd_bridge.command={json.dumps(bridge['launcher'])}",
        "--config", "mcp_servers.omd_bridge.args=[]",
        "--config", f"mcp_servers.omd_bridge.env.OMD_BRIDGE_POLICY={json.dumps(bridge['policy'])}",
        "--config", f"mcp_servers.omd_bridge.env.OMD_BRIDGE_POLICY_SHA256={json.dumps(bridge['sha256'])}",
        "--config", "mcp_servers.omd_bridge.enabled=true",
        "--config", "mcp_servers.omd_bridge.required=false",
        "--config", "mcp_servers.omd_bridge.startup_timeout_sec=10",
        "--config", "mcp_servers.omd_bridge.tool_timeout_sec=60",
        "--config", 'mcp_servers.omd_bridge.default_tools_approval_mode="prompt"',
    ]


def wrapper_text(binary, selection, mode=None, controlled_manifest=None, browser=None):
    lines = ["#!/bin/sh"]
    if selection == "omd":
        lines.append(f"export OMD_MODE={shlex.quote(mode)}")
        if controlled_manifest:
            lines.append(f"export OMD_CONTROLLED_MANIFEST={shlex.quote(str(controlled_manifest))}")
        else:
            lines.append("unset OMD_CONTROLLED_MANIFEST")
    else:
        lines.extend(["unset OMD_MODE", "unset OMD_CONTROLLED_MANIFEST"])
    command = [str(binary)]
    if selection == "omd" and browser:
        command.extend(browser_config_args(browser))
        bridge = bridge_selection(controlled_manifest, browser)
        if bridge:
            command.extend(bridge_config_args(bridge))
    lines.append(f"exec {shlex.join(command)} \"$@\"")
    return "\n".join(lines) + "\n"


def activate(prefix, bin_dir, selection, mode=None, controlled_manifest=None):
    prefix, bin_dir = validate_locations(prefix, bin_dir)
    manifest = load_manifest(prefix)
    if resolved(manifest["bin_dir"]) != bin_dir:
        raise ValueError("bin directory does not match the installed manifest")
    if selection == "omd":
        if mode not in ("upstream_direct", "enabled"):
            raise ValueError("OMD activation requires upstream_direct or enabled mode")
        if mode == "enabled":
            if controlled_manifest is None:
                raise ValueError("enabled mode requires --manifest")
            controlled_manifest = resolved(controlled_manifest)
            if not controlled_manifest.is_file():
                raise ValueError("controlled manifest is not a file")
        elif controlled_manifest is not None:
            raise ValueError("--manifest is only valid with enabled mode")
        binary = prefix / "artifacts/omd/codex"
    else:
        if mode is not None or controlled_manifest is not None:
            raise ValueError("upstream activation does not accept OMD settings")
        binary = prefix / "artifacts/upstream/codex"
    browser = manifest.get("browser")
    if browser:
        verified = browser_bundle.verify(prefix / "browser")
        if verified["tree"] != browser["tree"]:
            raise ValueError("installed browser bundle differs from the installation manifest")
    expected = manifest["artifacts"][selection]["sha256"]
    if digest(binary) != expected:
        raise ValueError(f"refusing to activate modified {selection} artifact")
    wrapper = bin_dir / "codex"
    current = manifest.get("activation")
    if wrapper.is_symlink() or (wrapper.exists()
                                and (not current or digest(wrapper) != current.get("wrapper_sha256"))):
        raise ValueError(f"refusing to replace unmanaged or modified launcher: {wrapper}")
    text = wrapper_text(binary, selection, mode, controlled_manifest, browser)
    atomic_text(wrapper, text, 0o755)
    manifest["activation"] = {
        "selection": selection,
        "mode": mode,
        "controlled_manifest": str(controlled_manifest) if controlled_manifest else None,
        "wrapper": str(wrapper),
        "wrapper_sha256": digest(wrapper),
    }
    write_manifest(prefix, manifest)
    return manifest


def verify_platform():
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        raise ValueError("private lean-v1 installation is supported only on Apple Silicon macOS")


def clone_pinned(repository, checkout, commit):
    run(["git", "clone", "--no-checkout", str(repository), str(checkout)])
    run(["git", "checkout", "--detach", commit], cwd=checkout)
    if output(["git", "rev-parse", "HEAD"], cwd=checkout) != commit:
        raise ValueError("source checkout did not resolve to the pinned commit")


def install(args):
    verify_platform()
    prefix, bin_dir = validate_locations(args.prefix, args.bin_dir)
    if prefix.exists():
        raise ValueError(f"installation prefix already exists: {prefix}")
    wrapper = bin_dir / "codex"
    if wrapper.exists() or wrapper.is_symlink():
        raise ValueError(f"activation path already exists: {wrapper}")
    upstream_lock, lean_lock = lock_inputs()
    upstream = binary_identity(args.upstream)
    supported = lean_lock["private_installation"]["supported_upstream"]
    if upstream["version"] != supported:
        raise ValueError(f"supported upstream executable must report {supported}")
    if within(resolved(upstream["path"]), prefix):
        raise ValueError("supported upstream executable must be outside the installation prefix")
    fallback = shutil.which("codex", path=path_without(bin_dir))
    if not fallback or resolved(fallback) != resolved(upstream["path"]):
        raise ValueError("supported upstream executable must resolve on PATH without the managed bin directory")
    if args.target_dir:
        target = resolved(args.target_dir)
        if target == Path(target.anchor):
            raise ValueError("build target must not be a filesystem root")
        for protected in (*state_roots(), prefix, bin_dir):
            if within(target, protected) or within(protected, target):
                raise ValueError("build target must be separate from state, install and launcher paths")
    browser_archive = getattr(args, "browser_archive", None)
    browser_archive_sha256 = getattr(args, "browser_archive_sha256", None)
    if bool(browser_archive) != bool(browser_archive_sha256):
        raise ValueError("prebuilt browser provisioning requires both --browser-archive and --browser-archive-sha256")
    toolchain = output(["rustc", f"+{upstream_lock['rust_toolchain']}", "--version"])
    parent = prefix.parent
    parent.mkdir(parents=True, exist_ok=True)
    staging = parent / f".{prefix.name}.staging"
    staging.mkdir(mode=0o700)
    moved = False
    try:
        checkout = staging / "source"
        clone_pinned(args.repository, checkout, upstream_lock["commit"])
        output([sys.executable, str(ROOT / "scripts/normalize_upstream_lock.py"), str(checkout)])
        output([sys.executable, str(ROOT / "scripts/apply_runtime_patch.py"), str(checkout)])
        cargo_target = resolved(args.target_dir) if args.target_dir else staging / "target"
        environment = os.environ.copy()
        environment["CARGO_TARGET_DIR"] = str(cargo_target)
        build = ["cargo", f"+{upstream_lock['rust_toolchain']}", "build", "--locked",
                 "--release", "-p", "codex-cli", "--bin", "codex", "-p", "codex-omd", "--bin", "omd-mod"]
        run(build, cwd=checkout / "codex-rs", env=environment, capture=False)
        candidate_source = cargo_target / "release/codex"
        manager_source = cargo_target / "release/omd-mod"
        candidate = binary_identity(candidate_source)
        if candidate["version"] != upstream["version"]:
            raise ValueError("candidate and supported upstream versions differ")
        machine = output(["file", "-b", str(candidate_source)])
        if "arm64" not in machine:
            raise ValueError("candidate is not an arm64 executable")
        for name, source in (("upstream/codex", Path(upstream["path"])), ("omd/codex", candidate_source),
                             ("omd/omd-mod", manager_source)):
            destination = staging / f"artifacts/{name}"
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
            destination.chmod(destination.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        if browser_archive:
            browser = browser_bundle.install_archive(browser_archive, browser_archive_sha256,
                                                     staging / "browser")
        else:
            browser = browser_bundle.build_bundle(staging / "browser",
                                                  getattr(args, "browser_node_archive", None))
        bundled_plugin = copy_plugin_bundle(staging / "plugins/oh-my-diff")
        if not args.target_dir:
            shutil.rmtree(cargo_target)
        home, sqlite = state_roots()
        manifest = {
            "schema": SCHEMA,
            "product": PRODUCT,
            "installed_at": datetime.now(timezone.utc).isoformat(),
            "prefix": str(prefix),
            "bin_dir": str(bin_dir),
            "host": {"system": platform.system(), "machine": platform.machine()},
            "shared_state": {"codex_home": str(home), "codex_sqlite_home": str(sqlite),
                             "policy": "inherited unchanged; never removed by uninstall"},
            "inputs": {
                "repository": str(args.repository),
                "commit": upstream_lock["commit"],
                "tag": upstream_lock["tag"],
                "rust_toolchain": upstream_lock["rust_toolchain"],
                "rustc": toolchain,
                "normalized_cargo_lock_sha256": upstream_lock["normalized_cargo_lock_sha256"],
                "runtime_patch_sha256": lean_lock["runtime_patch"]["sha256"],
                "build": build,
            },
            "artifacts": {
                "upstream": {**upstream, "installed_path": str(staging / "artifacts/upstream/codex")},
                "omd": {**candidate, "installed_path": str(staging / "artifacts/omd/codex")},
            },
            "mod_manager": {"sha256": digest(staging / "artifacts/omd/omd-mod"),
                            "installed_path": str(staging / "artifacts/omd/omd-mod"),
                            "mod_api": preview_lock()["mod_api"]},
            "browser": {
                "installed_path": str(prefix / "browser"),
                "launcher": str(prefix / "browser" / browser["launcher"]),
                "bridge": {
                    **browser["bridge"],
                    "launcher": str(prefix / "browser" / browser["bridge"]["launcher"]),
                },
                "provisioning": browser["provisioning"],
                "node": browser["node"],
                "mcp": browser["mcp"],
                "browser": browser["browser"],
                "tree": browser["tree"],
                "approval": browser["approval"],
                "sandbox": browser["sandbox"],
                "cleanup": browser["cleanup"],
            },
            "bundled_plugin": bundled_plugin,
            "activation": None,
            "linux_benchmark": {"retained": True, "runtime_install_target": False,
                                "guide": "benchmarks/README.md"},
        }
        for artifact in (*manifest["artifacts"].values(), manifest["mod_manager"]):
            artifact["installed_path"] = artifact["installed_path"].replace(str(staging), str(prefix), 1)
        manifest["bundled_plugin"]["installed_path"] = manifest["bundled_plugin"][
            "installed_path"
        ].replace(str(staging), str(prefix), 1)
        manifest["bundled_plugin"]["guide"] = manifest["bundled_plugin"]["guide"].replace(
            str(staging), str(prefix), 1
        )
        write_manifest(staging, manifest)
        staging.rename(prefix)
        moved = True
        browser_manifest = json.loads((prefix / "browser/bundle.json").read_text())
        if (browser_manifest.get("schema") != browser_bundle.SCHEMA
                or browser_manifest.get("product") != browser_bundle.PRODUCT):
            raise ValueError("installed browser bundle manifest is unrecognized")
        browser_manifest["destination"] = str(prefix / "browser")
        browser_bundle.write_json(prefix / "browser/bundle.json", browser_manifest)
        activate(prefix, bin_dir, "omd", "upstream_direct")
        return load_manifest(prefix)
    except BaseException:
        if staging.exists():
            shutil.rmtree(staging)
        if moved and prefix.exists():
            installed_manifest = json.loads((prefix / "install.json").read_text())
            activation = installed_manifest.get("activation")
            wrapper = bin_dir / "codex"
            expected_wrapper = hashlib.sha256(wrapper_text(
                prefix / "artifacts/omd/codex", "omd", "upstream_direct",
                browser=installed_manifest.get("browser")).encode()).hexdigest()
            recorded_wrapper = activation.get("wrapper_sha256") if activation else expected_wrapper
            if not wrapper.is_symlink() and wrapper.is_file() and digest(wrapper) == recorded_wrapper:
                wrapper.unlink()
            shutil.rmtree(prefix)
        raise


def status(prefix, bin_dir):
    prefix, bin_dir = validate_locations(prefix, bin_dir)
    manifest = load_manifest(prefix)
    if resolved(manifest["bin_dir"]) != bin_dir:
        raise ValueError("bin directory does not match the installed manifest")
    activation = manifest.get("activation")
    wrapper = bin_dir / "codex"
    if (not activation or wrapper.is_symlink() or not wrapper.is_file()
            or digest(wrapper) != activation["wrapper_sha256"]):
        raise ValueError("managed launcher is absent or modified")
    selected = activation["selection"]
    artifact = prefix / f"artifacts/{selected}/codex"
    if digest(artifact) != manifest["artifacts"][selected]["sha256"]:
        raise ValueError("active artifact is modified")
    recorded_manager = manifest.get("mod_manager")
    if recorded_manager and digest(prefix / "artifacts/omd/omd-mod") != recorded_manager["sha256"]:
        raise ValueError("installed omd-mod manager is modified")
    if manifest.get("browser"):
        browser = browser_bundle.verify(prefix / "browser")
        if browser["tree"] != manifest["browser"]["tree"]:
            raise ValueError("installed browser bundle differs from the installation manifest")
    if manifest.get("bundled_plugin"):
        verify_plugin_bundle(manifest["bundled_plugin"])
    return manifest


def preview_lock():
    lock = json.loads((ROOT / "runtime/preview-v1.lock.json").read_text())
    if lock.get("schema") != PREVIEW_SCHEMA or lock.get("product") != PREVIEW_PRODUCT:
        raise ValueError("unrecognized preview lock")
    return lock


def preview_sources(lock):
    if digest(ROOT / lock["types"]["path"]) != lock["types"]["sha256"]:
        raise ValueError(f"pinned preview types changed: {lock['types']['path']}")
    for identifier, package in lock["packages"].items():
        if package.get("extension_type") != "mod":
            raise ValueError(f"pinned preview package {identifier} must be labeled as a mod")
        base = ROOT / package["source"]
        for name, expected in package["files"].items():
            if digest(base / name) != expected:
                raise ValueError(f"pinned preview source changed: {package['source']}/{name}")
        declared = json.loads((base / "mod.json").read_text())
        if declared["api"] != lock["mod_api"]:
            raise ValueError(f"package {identifier} declares mod API {declared['api']}; "
                             f"this preview is pinned to {lock['mod_api']}")
        if declared["id"] != identifier:
            raise ValueError(f"pinned preview package disagrees with the lock: {identifier}")
    return lock


def digest_of_package(path):
    return package_digest(path)


def manager(prefix):
    binary = prefix / "artifacts/omd/omd-mod"
    if not binary.is_file():
        raise ValueError("this installation has no omd-mod manager; reinstall to enable the mod preview")
    recorded = load_manifest(prefix).get("mod_manager")
    if not recorded or digest(binary) != recorded["sha256"]:
        raise ValueError("installed omd-mod manager is absent or modified")
    return binary


def omd_mod(prefix, *arguments):
    return json.loads(output([str(manager(prefix)), *arguments]) or "null")


def validate_store(store, prefix, bin_dir):
    store = resolved(store)
    if store == Path(store.anchor):
        raise ValueError("mod store must not be a filesystem root")
    for protected in (ROOT, prefix, bin_dir, *state_roots()):
        if within(store, protected) or within(protected, store):
            raise ValueError("mod store must be outside this repository, the install prefix, the launcher and Codex state")
    return store


def preview_state(store):
    record = store / "preview.json"
    if not record.is_file():
        raise ValueError(f"not a preview store: {store}")
    state = json.loads(record.read_text())
    if state.get("schema") != PREVIEW_SCHEMA or state.get("product") != PREVIEW_PRODUCT:
        raise ValueError(f"unrecognized preview store: {store}")
    return state


def preview_install(prefix, bin_dir, store, node):
    status(prefix, bin_dir)
    lock = preview_sources(preview_lock())
    node = resolved(node)
    reported = output([str(node), "--version"])
    if reported != f"v{lock['node']}":
        raise ValueError(f"preview requires Node {lock['node']}; {node} reports {reported}")
    store = validate_store(store, prefix, bin_dir)
    if store.exists():
        preview_state(store)
    else:
        store.parent.mkdir(parents=True, exist_ok=True)
        omd_mod(prefix, "init", str(store), str(node))
    host_api = omd_mod(prefix, "status", str(store))["api"]
    if host_api != lock["mod_api"]:
        raise ValueError(f"installed host runs mod API {host_api}; this preview is pinned to {lock['mod_api']}. "
                         "Install a matching build or a matching preview revision.")
    (store / "sources").mkdir(exist_ok=True)
    shutil.copy2(ROOT / lock["types"]["path"], store / "api.d.ts")
    shutil.copy2(ROOT / lock["guide"]["path"], store / "PREVIEW.md")
    installed = {}
    for identifier, package in sorted(lock["packages"].items()):
        target = store / "sources" / identifier
        target.mkdir(exist_ok=True)
        for name in PACKAGE_FILES:
            shutil.copy2(ROOT / package["source"] / name, target / name)
        inspected = omd_mod(prefix, "inspect", str(target))
        declared = inspected["manifest"]["api"]
        if declared != host_api:
            raise ValueError(f"package {identifier} declares mod API {declared}; this host runs {host_api}")
        if inspected["sha256"] != package["package_sha256"]:
            raise ValueError(f"installed package digest differs from the pinned digest: {identifier}")
        if inspected["manifest"]["capabilities"] != package["capabilities"]:
            raise ValueError(f"package {identifier} requests capabilities outside its pinned grant")
        omd_mod(prefix, "trust", str(store), str(target), inspected["sha256"], ",".join(package["capabilities"]))
        omd_mod(prefix, "enable", str(store), str(target))
        installed[identifier] = {"path": str(target), "version": package["version"],
                                 "extension_type": package["extension_type"],
                                 "sha256": inspected["sha256"], "capabilities": package["capabilities"]}
    record = {"schema": PREVIEW_SCHEMA, "product": PREVIEW_PRODUCT,
              "installed_at": datetime.now(timezone.utc).isoformat(),
              "prefix": str(prefix), "store": str(store), "node": str(node),
              "mod_api": host_api, "packages": installed,
              "types": str(store / "api.d.ts"), "guide": str(store / "PREVIEW.md"),
              "manager": str(manager(prefix))}
    atomic_text(store / "preview.json", json.dumps(record, indent=2, sort_keys=True) + "\n")
    return {**record, "next": [f'add "mods": "{store}" to the controlled manifest used by activate omd --mode enabled',
                               f"edit {store}/sources/<id>/index.ts, then inspect, trust, enable and reload with {manager(prefix)}"]}


def preview_status(prefix, bin_dir, store, controlled_manifest=None):
    status(prefix, bin_dir)
    store = validate_store(store, prefix, bin_dir)
    state = preview_state(store)
    try:
        host = omd_mod(prefix, "status", str(store))
        host_error = None
    except RuntimeError as error:
        host = {"api": load_manifest(prefix)["mod_manager"]["mod_api"], "mods": []}
        host_error = str(error).strip().splitlines()[-1]
    host_api = host["api"]
    packages = []
    for identifier, package in sorted(state["packages"].items()):
        target = Path(package["path"])
        edited = {name: digest(target / name) for name in PACKAGE_FILES}
        pinned = preview_lock()["packages"].get(identifier, {}).get("files", {})
        active = next((item for item in host.get("mods", []) if item.get("id") == identifier), None)
        packages.append({"id": identifier, "path": str(target), "version": package["version"],
                         "extension_type": package["extension_type"],
                         "trusted_sha256": package["sha256"],
                         "locally_edited": edited != pinned,
                         "trusted_digest_current": digest_of_package(target) == package["sha256"],
                         "enabled": bool(active), "error": (active or {}).get("error")})
    selected = None
    if controlled_manifest:
        declared = json.loads(Path(controlled_manifest).read_text()).get("mods")
        selected = bool(declared) and resolved(declared) == store
    return {"store": str(store), "mod_api": {"host": host_api, "preview": state["mod_api"],
                                             "compatible": host_api == state["mod_api"]},
            "manager": str(manager(prefix)), "node": state["node"], "packages": packages,
            "reload_error": host.get("reload_error"), "host_error": host_error,
            "selected_by_manifest": selected}


def preview_select(prefix, bin_dir, store, identifier, enabled):
    status(prefix, bin_dir)
    store = validate_store(store, prefix, bin_dir)
    state = preview_state(store)
    chosen = [state["packages"][identifier]] if identifier else list(state["packages"].values())
    if identifier and identifier not in state["packages"]:
        raise ValueError(f"unknown preview package: {identifier}")
    for package in chosen:
        omd_mod(prefix, "enable" if enabled else "disable", str(store), package["path"])
    omd_mod(prefix, "reload", str(store))
    return preview_status(prefix, bin_dir, store)


def preview_uninstall(prefix, bin_dir, store, force):
    status(prefix, bin_dir)
    store = validate_store(store, prefix, bin_dir)
    state = preview_state(store)
    edits = [identifier for identifier, package in state["packages"].items()
             if any(digest(Path(package["path"]) / name) != preview_lock()["packages"][identifier]["files"][name]
                    for name in PACKAGE_FILES)]
    if edits and not force:
        raise ValueError(f"locally edited preview sources would be removed: {', '.join(sorted(edits))}; pass --force to remove them")
    shutil.rmtree(store)
    return {"removed": str(store), "removed_local_edits": sorted(edits),
            "note": "the installed build, Codex state and controlled manifests are unchanged"}


def uninstall(prefix, bin_dir):
    prefix, bin_dir = validate_locations(prefix, bin_dir)
    manifest = status(prefix, bin_dir)
    upstream = manifest["artifacts"]["upstream"]
    original = binary_identity(upstream["path"])
    if original["sha256"] != upstream["sha256"] or original["version"] != upstream["version"]:
        raise ValueError("supported upstream executable changed; refusing automatic uninstall")
    located = shutil.which("codex", path=path_without(bin_dir))
    if not located or resolved(located) != resolved(upstream["path"]):
        raise ValueError("supported upstream executable would not be restored on PATH")
    wrapper = bin_dir / "codex"
    wrapper.unlink()
    shutil.rmtree(prefix)
    return {"uninstalled": True, "upstream": upstream["path"], "upstream_restore": "resolved",
            "shared_state": manifest["shared_state"]}


def parser():
    result = argparse.ArgumentParser(description="Build and manage the private Apple Silicon lean-v1 installation")
    result.add_argument("--prefix", type=Path, required=True)
    result.add_argument("--bin-dir", type=Path, required=True)
    commands = result.add_subparsers(dest="command", required=True)
    install_parser = commands.add_parser("install")
    install_parser.add_argument("--upstream", type=Path, required=True)
    install_parser.add_argument("--repository", default="https://github.com/openai/codex.git")
    install_parser.add_argument("--target-dir", type=Path)
    install_parser.add_argument("--browser-node-archive", type=Path)
    install_parser.add_argument("--browser-archive", type=Path)
    install_parser.add_argument("--browser-archive-sha256")
    activate_parser = commands.add_parser("activate")
    activate_parser.add_argument("selection", choices=("omd", "upstream"))
    activate_parser.add_argument("--mode", choices=("upstream_direct", "enabled"))
    activate_parser.add_argument("--manifest", type=Path)
    commands.add_parser("status")
    commands.add_parser("uninstall")
    preview_parser = commands.add_parser("preview")
    preview_commands = preview_parser.add_subparsers(dest="preview_command", required=True)
    preview_install_parser = preview_commands.add_parser("install")
    preview_install_parser.add_argument("--store", type=Path, required=True)
    preview_install_parser.add_argument("--node", type=Path, required=True)
    preview_status_parser = preview_commands.add_parser("status")
    preview_status_parser.add_argument("--store", type=Path, required=True)
    preview_status_parser.add_argument("--manifest", type=Path)
    for name in ("enable", "disable"):
        selection_parser = preview_commands.add_parser(name)
        selection_parser.add_argument("--store", type=Path, required=True)
        selection_parser.add_argument("--id")
    preview_uninstall_parser = preview_commands.add_parser("uninstall")
    preview_uninstall_parser.add_argument("--store", type=Path, required=True)
    preview_uninstall_parser.add_argument("--force", action="store_true")
    return result


def main():
    args = parser().parse_args()
    prefix, bin_dir = validate_locations(args.prefix, args.bin_dir)
    if args.command == "install":
        result = install(args)
    elif args.command == "activate":
        result = activate(prefix, bin_dir, args.selection, args.mode, args.manifest)
    elif args.command == "status":
        result = status(prefix, bin_dir)
    elif args.command == "preview":
        if args.preview_command == "install":
            result = preview_install(prefix, bin_dir, args.store, args.node)
        elif args.preview_command == "status":
            result = preview_status(prefix, bin_dir, args.store, args.manifest)
        elif args.preview_command == "uninstall":
            result = preview_uninstall(prefix, bin_dir, args.store, args.force)
        else:
            result = preview_select(prefix, bin_dir, args.store, args.id, args.preview_command == "enable")
    else:
        result = uninstall(prefix, bin_dir)
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, ValueError) as error:
        raise SystemExit(str(error)) from error
