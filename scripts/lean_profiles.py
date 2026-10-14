#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shlex
import shutil
import subprocess
import sys
import tarfile
import tomllib
from datetime import datetime, timezone

try:
    from scripts import install_support as support
    from scripts import authority_broker
    from scripts import full_mods_lock
    from scripts import preview_lock
except ModuleNotFoundError:
    import install_support as support
    import authority_broker
    import full_mods_lock
    import preview_lock


ROOT = Path(__file__).resolve().parents[1]
PRODUCT = "oh-my-diff-lean-package-candidate-v1"
SCHEMA = 1
PROFILE_LABELS = {"platform": "OMD Core", "full": "OMD+"}
DEFAULT_ACTIVE = ("omd_inspector", "omd_logo", "omd_model_picker", "omd_mods", "omd_plan_panel",
                  "omd_plan_removal", "omd_tool_lines", "omd_update")
PACKAGES = tuple(sorted((*preview_lock.PACKAGES, *full_mods_lock.PACKAGES)))
PLATFORM_PACKAGES = ("omd_logo", "omd_mods", "omd_update")
HOST_TOOLS = ("omd", "omd-contract")
ROUTES = {"claude": "omd_claude_cli", "profiles": "omd_profiles"}
MANAGEMENT_FILES = ("scripts/lean_profiles.py", "scripts/install_support.py", "scripts/authority_broker.py",
                    "scripts/full_mods_lock.py", "runtime/full-mods.lock.json",
                    "scripts/preview_lock.py",
                    "runtime/preview-v1.lock.json", "upstream.lock.json", "LEAN_PROFILES.md", "install.sh")


def invoke(*arguments):
    result = subprocess.run([str(item) for item in arguments], capture_output=True, text=True)
    if result.returncode:
        raise ValueError((result.stderr or result.stdout or "command failed").strip())
    return json.loads(result.stdout)


def package_sources(preview):
    full = full_mods_lock.load()
    if full["mod_api"] != preview["mod_api"]:
        raise ValueError("OMD+ mod API disagrees with pinned preview")
    return {**preview["packages"], **full["packages"]}


def profile_packages(profile):
    return PACKAGES if profile == "full" else PLATFORM_PACKAGES


def sync_sources(manager, store, origin, packages):
    selections = {item.get("path"): item for item in invoke(manager, "selection-status", store)["selections"]}
    changed = []
    for identifier, package in packages.items():
        target = store / "sources" / identifier
        files = {path.relative_to(target).as_posix() for path in target.rglob("*") if path.is_file()}
        if files == set(package["files"]) and all(support.digest(target / name) == digest
                                                  for name, digest in package["files"].items()):
            continue
        staged, retired = target.with_name(f".{identifier}.new"), target.with_name(f".{identifier}.old")
        for leftover in (staged, retired):
            shutil.rmtree(leftover, ignore_errors=True)
        shutil.copytree(origin / identifier, staged)
        if target.is_dir():
            target.rename(retired)
        staged.rename(target)
        shutil.rmtree(retired, ignore_errors=True)
        invoke(manager, "trust-all", store, json.dumps([{"path": str(target), "sha256": package["sha256"],
                                                         "capabilities": package["capabilities"]}]))
        if selections.get(str(target), {}).get("selected"):
            invoke(manager, "enable", store, target)
        changed.append(identifier)
    if changed:
        invoke(manager, "reload", store)
    return changed


def reconcile(prefix, bin_dir):
    record = load(prefix)
    _, manager = check(record, bin_dir)
    return {"restored": sync_sources(manager, Path(record["store"]), prefix / "sources", record["packages"])}


def paths(prefix, bin_dir, store):
    prefix, bin_dir = support.validate_locations(prefix, bin_dir)
    store = support.resolved(store)
    if store == Path(store.anchor) or support.within(store, ROOT):
        raise ValueError("mod store must be outside the source checkout")
    if any(support.within(store, value) or support.within(value, store)
           for value in (prefix, bin_dir, *support.state_roots())):
        raise ValueError("mod store must be separate from installation, launchers and Codex state")
    return prefix, bin_dir, store


def identity(binary):
    binary = support.resolved(binary)
    result = support.binary_identity(binary)
    version = json.loads((ROOT / "upstream.lock.json").read_text())["tag"].removeprefix("rust-v")
    if not support.compatible_upstream(result["version"], version):
        raise ValueError(f"candidate requires a Codex {version.rsplit('.', 1)[0]}.x host")
    return result


def candidate_lock(upstream, patch, preview):
    record = json.loads((ROOT / "runtime/lean-release.lock.json").read_text())
    if (record.get("schema") != SCHEMA or record.get("product") != PRODUCT
            or record.get("upstream_commit") != upstream["commit"]
            or record.get("runtime_patch_sha256") != patch["patch"]["sha256"]
            or record.get("mod_api") != preview["mod_api"]
            or record.get("node") != preview["node"]):
        raise ValueError("lean release lock disagrees with pinned runtime sources")
    for name, expected in record["source_sha256"].items():
        if support.digest(ROOT / name) != expected:
            raise ValueError(f"lean candidate source changed: {name}")
    return record


def copy_plugins(destination):
    lock = support.plugin_sources()
    source = ROOT / lock["source"]
    for name in lock["files"]:
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source / name, target)
    return {"marketplace": str(destination), "plugins": sorted(lock["plugins"]), "files": lock["files"],
            "marketplace_sha256": lock["files"][".agents/plugins/marketplace.json"],
            "installed_by_candidate": [],
            "note": "available for explicit installation; no plugin is configured by this installer"}


def load(prefix):
    record = json.loads((prefix / "install.json").read_text())
    if record.get("schema") != SCHEMA or record.get("product") != PRODUCT:
        raise ValueError("unrecognized candidate installation")
    if support.resolved(record["prefix"]) != prefix:
        raise ValueError("installation prefix changed")
    return record


def write(prefix, record):
    support.atomic_text(prefix / "install.json", json.dumps(record, indent=2, sort_keys=True) + "\n")


def selected_text(record):
    binary = record["binary"]["installed_path"]
    store = record["store"]
    selection = record["activation"]["selection"]
    lines = ["#!/bin/sh"]
    update = record.get("update")
    if update:
        root, installer = shlex.quote(update["root"]), f"OMD_PYTHON={shlex.quote(update['python'])} sh {shlex.quote(update['installer'])}"
        request = shlex.quote(str(Path(store) / "data/user/omd_update/store.json"))
        # The marker precedes the journal check and an update journals before reading markers, so each sees the other.
        lines += [f"mkdir -p {root}/sessions && : > {root}/sessions/$$",
                  f'if [ -z "$OH_MY_DIFF_UPDATED" ] && {{ [ -e {root}/update/ready.json ] || [ -e {root}/update/journal.json ] || [ {request} -nt {root}/update/seen ]; }}; then',
                  f"  {installer} launch --root {root} --session $$",
                  f'  OH_MY_DIFF_UPDATED=1 exec {root}/current/bin/codex "$@"',
                  "fi",
                  "unset OH_MY_DIFF_UPDATED",
                  f"[ {root}/update/next -nt {root}/sessions/$$ ] || ({installer} tick --root {root} </dev/null >/dev/null 2>&1 &)",
                  f"OH_MY_DIFF_UPDATE=; [ -f {root}/update/state.json ] && read -r OH_MY_DIFF_UPDATE < {root}/update/state.json; export OH_MY_DIFF_UPDATE"]
    lines.append("unset OMD_INSTALL_PROFILE OMD_CONTROLLED_MANIFEST OMD_MOD_STORE")
    lines.append(f"export OMD_INSTALL_PROFILE={'platform_only' if record['profile'] == 'platform' else 'full'}")
    if selection == "direct":
        lines.append("export OMD_MODE=upstream_direct")
    else:
        lines.extend(["export OMD_MODE=omd", f"export OMD_MOD_STORE={shlex.quote(store)}",
                      f"export OMD_NODE={shlex.quote(record['author']['node'])}"])
    # Oh My Diff runs Codex in embedded mode, so the launcher keeps the shared background server from starting.
    flags = ["-c", "features.daemon_auto_start=false"] if selection != "direct" else []
    for provider in record.get("providers", {}).values() if selection != "direct" else ():
        key = provider["env_key"]
        lines.append(f'{key}="$(cat {shlex.quote(provider["token"])} 2>/dev/null)"; export {key}')
        settings = {"name": provider["name"], "base_url": provider["base_url"], "wire_api": "responses", "env_key": key,
                    "request_max_retries": 0, "stream_max_retries": 0, "supports_websockets": False}
        for field, value in settings.items():
            flags += ["-c", f"model_providers.{provider['id']}.{field}={json.dumps(value)}"]
    lines.append(f"exec {shlex.join([binary, *flags])} \"$@\"")
    return "\n".join(lines) + "\n"


def contract(prefix, action, key):
    record = load(prefix)
    tool = record["tools"]["omd-contract"]["installed_path"]
    if action in ("plan", "select") and not key:
        raise ValueError(f"contract {action} needs ID@VERSION; contract list shows them")
    arguments = [record["store"]] if action == "list" else [record["store"], str(Path.cwd()), *([key] if key else ["user"] if action == "clear" else [])]
    return json.loads(support.output([tool, action, *arguments]))


def check(record, bin_dir):
    binary = Path(record["binary"]["installed_path"])
    manager = Path(record["manager"]["installed_path"])
    for path, expected in ((binary, record["binary"]["sha256"]),
                           (Path(record["code_mode_host"]["installed_path"]), record["code_mode_host"]["sha256"]),
                           (manager, record["manager"]["sha256"])):
        if not path.is_file() or support.digest(path) != expected:
            raise ValueError(f"managed artifact changed: {path}")
    launcher = bin_dir / "codex"
    if launcher.is_symlink() or not launcher.is_file() or support.digest(launcher) != record["activation"]["sha256"]:
        raise ValueError("managed launcher is absent or modified")
    if support.digest(launcher) != hashlib.sha256(selected_text(record).encode()).hexdigest():
        raise ValueError("managed launcher differs from effective settings")
    for name, details in record.get("tools", {}).items():
        tool = Path(details["installed_path"])
        if not tool.is_file() or support.digest(tool) != details["sha256"]:
            raise ValueError(f"managed tool changed: {name}")
        tool_launcher = bin_dir / name
        if tool_launcher.is_symlink() or not tool_launcher.is_file() or support.digest(tool_launcher) != details["launcher_sha256"]:
            raise ValueError(f"managed tool launcher changed: {name}")
    bundle = record.get("plugin_bundle")
    if bundle:
        root = Path(bundle["marketplace"])
        for name, expected in bundle["files"].items():
            path = root / name
            if not path.is_file() or support.digest(path) != expected:
                raise ValueError(f"managed plugin source changed: {name}")
        marketplace = root / ".agents/plugins/marketplace.json"
        if not marketplace.is_file() or support.digest(marketplace) != bundle["marketplace_sha256"]:
            raise ValueError("managed plugin marketplace changed")
    author = record["author"]
    for name, expected in author["files"].items():
        path = Path(record["prefix"]) / name
        if not path.is_file() or support.digest(path) != expected:
            raise ValueError(f"managed author package changed: {name}")
    author_launcher = bin_dir / "omd-mod-author"
    if (author_launcher.is_symlink() or not author_launcher.is_file()
            or support.digest(author_launcher) != author["launcher_sha256"]):
        raise ValueError("managed author launcher changed")
    management = record["management"]
    for name, expected in management["files"].items():
        path = Path(record["prefix"]) / "management" / name
        if not path.is_file() or support.digest(path) != expected:
            raise ValueError(f"managed package control changed: {name}")
    control_launcher = bin_dir / "omd-package"
    if (control_launcher.is_symlink() or not control_launcher.is_file()
            or support.digest(control_launcher) != management["launcher_sha256"]):
        raise ValueError("managed package control launcher changed")
    return binary, manager


def status(prefix, bin_dir):
    record = load(prefix)
    if support.resolved(record["bin_dir"]) != bin_dir:
        raise ValueError("launcher directory changed")
    _, manager = check(record, bin_dir)
    store = Path(record["store"])
    host = invoke(manager, "status", store)
    if host["api"] != record["mod_api"]:
        raise ValueError("mod store API no longer matches candidate")
    selection = invoke(manager, "selection-status", store)
    active = {item["id"]: item for item in host["mods"]}
    locked = package_sources(support.preview_lock())
    packages = []
    for identifier in profile_packages(record["profile"]):
        source = store / "sources" / identifier
        current = source.is_dir() and all(
            (source / name).is_file() and support.digest(source / name) == locked[identifier]["files"][name]
            for name in locked[identifier]["files"]
        )
        packages.append({"id": identifier, "installed": source.is_dir(), "pinned_source_current": current,
                         "enabled_in_store": identifier in active,
                         "active": identifier in active and not active[identifier].get("error")
                         and record["activation"]["selection"] != "direct",
                         "loaded_by_profile": identifier in active and record["activation"]["selection"] != "direct",
                         "error": active.get(identifier, {}).get("error")})
    return {"product": PRODUCT, "version": record["version"], "profile": record["profile"],
            "profile_label": PROFILE_LABELS[record["profile"]],
            "activation": record["activation"]["selection"],
            "host_mode": "upstream_direct" if record["activation"]["selection"] == "direct" else "omd",
            "binary_sha256": record["binary"]["sha256"], "runtime_patch_sha256": record["runtime_patch_sha256"],
            "store": str(store), "mod_api": host["api"], "packages": packages,
            "effective_mod_selection": selection,
            "plugin_bundle": record.get("plugin_bundle"),
            "author": record["author"],
            "package_control": str(bin_dir / "omd-package"),
            "installed_tools": sorted(record.get("tools", {})),
            "other_active_mods": [item for item in host["mods"] if item["id"] not in profile_packages(record["profile"])],
            "installer_configured_optional_services": [], "shared_state": record["shared_state"]}


def status_summary(result):
    lines = [f"{result['product']} {result['profile_label']} · mode {result['activation']} · mod API {result['mod_api']}",
             f"store {result['store']}"]
    for package in result["packages"]:
        state = "failed: " + package["error"] if package["error"] else "active" if package["active"] else (
            "enabled" if package["enabled_in_store"] else "installed" if package["installed"] else "missing")
        lines.append(f"  {package['id']}: {state}")
    lines.append("omd-package status --json prints every detail")
    return "\n".join(lines)


def activate(prefix, bin_dir, selection):
    record = load(prefix)
    check(record, bin_dir)
    if selection not in ("direct", record["profile"]):
        raise ValueError("activation must select the installed profile or direct")
    record["activation"] = {"selection": selection}
    launcher = bin_dir / "codex"
    support.atomic_text(launcher, selected_text(record), 0o755)
    record["activation"]["sha256"] = support.digest(launcher)
    write(prefix, record)
    return status(prefix, bin_dir)


def select_mod(prefix, bin_dir, identifier, enabled):
    record = load(prefix)
    if identifier not in record["packages"]:
        raise ValueError("only installed first-party candidate mods can be selected here")
    _, manager = check(record, bin_dir)
    source = Path(record["store"]) / "sources" / identifier
    def selection():
        current = invoke(manager, "selection-status", record["store"])
        matches = [item for item in current["selections"] if item.get("path") == str(source)]
        if len(matches) != 1 or matches[0].get("id") != identifier or not isinstance(matches[0].get("selected"), bool):
            raise ValueError(f"managed mod selection is unavailable: {identifier}")
        return matches[0]

    def loaded():
        result = status(prefix, bin_dir)
        package = next((item for item in result["packages"] if item["id"] == identifier), None)
        if package is None or package["error"] or package["enabled_in_store"] != enabled:
            raise ValueError(f"managed mod selection did not load: {identifier}: {package['error'] if package else 'absent'}")
        return result

    previous = selection()
    if previous["selected"] == enabled:
        return loaded()
    invoke(manager, "enable" if enabled else "disable", record["store"], source)
    try:
        invoke(manager, "reload", record["store"])
        return loaded()
    except Exception as error:
        try:
            invoke(manager, "enable" if previous["selected"] else "disable", record["store"], source)
            invoke(manager, "reload", record["store"])
            restored = selection()
            if restored["selected"] != previous["selected"] or restored["settings_sha256"] != previous["settings_sha256"]:
                raise ValueError("managed mod selection or settings changed during rollback")
        except Exception as rollback_error:
            raise ValueError(f"managed mod selection failed: {error}; rollback failed: {rollback_error}") from rollback_error
        raise ValueError(f"managed mod selection failed and was restored: {error}") from error


def route(prefix, bin_dir, name, args):
    record = load(prefix)
    check(record, bin_dir)
    identifier = ROUTES[name]
    if record["profile"] != "full":
        raise ValueError(f"the {name} route is available only in OMD+")
    if args.setup:
        setup = Path(record["store"]) / "sources" / identifier / "setup.mjs"
        extra = json.dumps({"add": {key: getattr(args, key) for key in ("credential", "protocol", "url", "window", "paid", "reasoning", "cache_control", "max_output")} | {"name": args.add, "model": args.upstream_model} if args.add else None,
                            "remove": args.remove, "allowance": args.allowance}) if name == "profiles" else str(args.path or "")
        result = subprocess.run([record["author"]["node"], str(setup), "setup", str(prefix / "install.json"), extra],
                                stdout=subprocess.PIPE, text=True)
        if result.returncode:
            raise ValueError(f"{name} setup failed")
        details = json.loads(result.stdout)
        record.setdefault("providers", {})[identifier] = details.pop("provider")
        launcher = bin_dir / "codex"
        support.atomic_text(launcher, selected_text(record), 0o755)
        record["activation"]["sha256"] = support.digest(launcher)
        write(prefix, record)
        if name in ("cursor", "muse"):
            source = (Path(record["store"]) / "sources" / identifier).resolve()
            mods = json.loads((Path(record["store"]) / "mods.json").read_text())["mods"]
            current = next((item.get("settings") or {} for item in mods if Path(item["path"]).resolve() == source), {})
            settings = {**current, "route": record["providers"][identifier]["route"]}
            invoke(record["manager"]["installed_path"], "settings", record["store"], source, json.dumps(settings))
        select_mod(prefix, bin_dir, identifier, True)
        return details
    provider = record.get("providers", {}).get(identifier)
    if not provider:
        raise ValueError(f"run `omd-package {name} --setup` first")
    if record["activation"]["selection"] == "direct":
        raise ValueError(f"activate OMD+ before using the {name} route")
    selections = invoke(record["manager"]["installed_path"], "selection-status", record["store"])["selections"]
    if not any(item.get("id") == identifier and item.get("effective") and not item.get("error") for item in selections):
        raise ValueError(f"the {name} route needs its mod enabled: omd-package mod enable {identifier}")
    models = json.loads(Path(provider["route"]).read_text())
    wanted = args.model or models["default"]
    model = next((item["slug"] for item in models["models"] if wanted in (item["slug"], item.get("family"))), None)
    if model is None:
        raise ValueError(f"unknown {name} model {wanted}; choose one of {', '.join(item['slug'] for item in models['models'])}")
    launcher = bin_dir / "codex"
    os.execv(launcher, [str(launcher), "-c", f"model_provider={json.dumps(identifier)}", "-c", f"model={json.dumps(model)}",
                        "-c", f"model_catalog_json={json.dumps(provider['catalog'])}", *args.codex])


def verify(manager, source, expected):
    if invoke(manager, "inspect", source)["sha256"] != expected:
        raise ValueError(f"package digest mismatch: {source.name}")


def shelve(source, destination):
    if not destination.is_dir():
        staged = destination.with_name(f".{destination.name}.new")
        shutil.rmtree(staged, ignore_errors=True)
        staged.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(source, staged)
        staged.rename(destination)
    return destination


def install(args):
    prefix, bin_dir, store = paths(args.prefix, args.bin_dir, args.store)
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        raise ValueError("this candidate installer supports Apple Silicon macOS")
    if (prefix.exists() or (bin_dir / "codex").exists() or (bin_dir / "codex").is_symlink()
            or (bin_dir / "omd-mod-author").exists() or (bin_dir / "omd-mod-author").is_symlink()
            or (bin_dir / "omd").exists() or (bin_dir / "omd").is_symlink()
            or (bin_dir / "omd-contract").exists() or (bin_dir / "omd-contract").is_symlink()
            or (bin_dir / "omd-package").exists() or (bin_dir / "omd-package").is_symlink()):
        raise ValueError("managed prefix or launcher already exists")
    if store.exists() != args.attach_store:
        raise ValueError("use --attach-store for an existing mod store; omit it for a new store")
    upstream_lock = json.loads((ROOT / "upstream.lock.json").read_text())
    patch_lock = json.loads((ROOT / "runtime/patches/manifest.json").read_text())
    if support.digest(ROOT / patch_lock["patch"]["path"]) != patch_lock["patch"]["sha256"]:
        raise ValueError("active runtime patch hash mismatch")
    locked = support.preview_sources(support.preview_lock())
    if full_mods_lock.load() != full_mods_lock.build():
        raise ValueError("OMD+ mod lock differs from pinned sources")
    packages = package_sources(locked)
    candidate = candidate_lock(upstream_lock, patch_lock, locked)
    if tuple(sorted(packages)) != PACKAGES:
        raise ValueError("first-party candidate inventory changed")
    binary = identity(args.binary)
    if binary["sha256"] != candidate["artifacts"]["codex"]["sha256"]:
        raise ValueError("Codex binary differs from frozen lean candidate")
    code_mode_host = Path(binary["path"]).parent / "codex-code-mode-host"
    if (not code_mode_host.is_file()
            or support.digest(code_mode_host) != candidate["artifacts"]["codex-code-mode-host"]["sha256"]):
        raise ValueError("code-mode host beside the Codex binary differs from frozen lean candidate")
    broker_helper = Path(binary["path"]).parent / "omd-broker"
    if (not broker_helper.is_file()
            or support.digest(broker_helper) != candidate["artifacts"]["omd-broker"]["sha256"]):
        raise ValueError("authority broker beside the Codex binary differs from frozen lean candidate")
    manager = support.resolved(args.manager)
    node = support.resolved(args.node)
    if not manager.is_file() or not os.access(manager, os.X_OK):
        raise ValueError("mod manager executable is unavailable")
    if support.digest(manager) != candidate["artifacts"]["omd-mod"]["sha256"]:
        raise ValueError("mod manager differs from frozen lean candidate")
    author_archive = support.resolved(args.author_archive)
    if (not author_archive.is_file()
            or support.digest(author_archive) != candidate["artifacts"]["mod-api.tgz"]["sha256"]):
        raise ValueError("mod author archive differs from pinned lean package")
    if not support.compatible_node(support.output([str(node), "--version"]), locked["node"]):
        raise ValueError(f"Node {locked['node']} or a later {locked['node'].split('.')[0]}.x is required")
    fallback = shutil.which("codex", path=support.path_without(bin_dir))
    if not fallback:
        raise ValueError("no upstream Codex fallback resolves on PATH")
    fallback_id = identity(fallback)
    previous = load(support.resolved(args.previous)) if args.previous else None
    bin_dir.mkdir(parents=True, exist_ok=True)
    prefix.mkdir(parents=True)
    managed = prefix.name == "prefix" and prefix.parent.parent.name == "releases"
    made_store = False
    made_launchers = []
    try:
        artifacts = prefix / "artifacts"
        artifacts.mkdir()
        for source, name in ((Path(binary["path"]), "codex"), (code_mode_host, "codex-code-mode-host"),
                             (broker_helper, "omd-broker"), (manager, "omd-mod")):
            shutil.copy2(source, artifacts / name)
        author_root = prefix / "author"
        author_root.mkdir()
        with tarfile.open(author_archive, "r:gz") as archive:
            archive.extractall(author_root, filter="data")
        author_cli = author_root / "package/author/cli.mjs"
        if not author_cli.is_file():
            raise ValueError("packed mod author CLI is absent")
        author_files = {path.relative_to(prefix).as_posix(): support.digest(path)
                        for path in author_root.rglob("*") if path.is_file()}
        management_root = prefix / "management"
        management_files = {}
        for name in MANAGEMENT_FILES:
            target = management_root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / name, target)
            management_files[name] = support.digest(target)
        installed_manager = artifacts / "omd-mod"
        if authority_broker.deployed():
            authority_broker.main(["pin", "--add", *(f"--pin={path}" for path in (
                artifacts / "codex", installed_manager,
                *(support.resolved(getattr(args, name.replace("-", "_"))) for name in HOST_TOOLS)))])
        if not args.attach_store:
            store.parent.mkdir(parents=True, exist_ok=True)
            invoke(installed_manager, "init", store, node)
            made_store = True
        host = invoke(installed_manager, "status", store)
        if host["api"] != locked["mod_api"]:
            raise ValueError("candidate mod API does not match the source lock")
        installed = {}
        plugin_bundle = None
        tools = {}
        for name in HOST_TOOLS:
            source = support.resolved(getattr(args, name.replace("-", "_")))
            if not source.is_file() or not os.access(source, os.X_OK):
                raise ValueError(f"host tool binary is unavailable: {name}")
            if support.digest(source) != candidate["artifacts"][name]["sha256"]:
                raise ValueError(f"host tool differs from frozen lean candidate: {name}")
            target = artifacts / name
            shutil.copy2(source, target)
            tools[name] = {"installed_path": str(target), "sha256": support.digest(target)}
        tools["omd-mod"] = {"installed_path": str(installed_manager), "sha256": support.digest(installed_manager)}
        if args.profile == "full":
            plugin_bundle = copy_plugins(prefix / "bundles/oh-my-diff")
        sources = store / "sources"
        sources.mkdir(exist_ok=True)
        trusted, enabled = [], []
        curated = {entry["id"]: entry for entry in json.loads((ROOT / "extensions/index.json").read_text())["packages"]
                   if entry["extension_type"] == "mod" and entry["support_status"] in ("reviewed_candidate", "supported")}
        catalog = {}
        for identifier in PACKAGES:
            package = packages[identifier]
            for name in package["files"]:
                (prefix / "sources" / identifier / name).parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(ROOT / package["source"] / name, prefix / "sources" / identifier / name)
            if identifier in curated:
                shelf = (shelve(prefix / "sources" / identifier, prefix.parents[2] / "catalog" / identifier / package["package_sha256"])
                         if managed else prefix / "sources" / identifier)
                catalog[identifier] = [{"version": package["version"], "integrity": package["package_sha256"],
                                        "source": {"kind": "local", "path": str(shelf)},
                                        "description": curated[identifier]["capability"],
                                        "support": curated[identifier]["support_status"]}]
            if identifier not in profile_packages(args.profile):
                continue
            installed[identifier] = {"version": package["version"], "sha256": package["package_sha256"],
                                     "files": package["files"], "capabilities": package["capabilities"]}
            target = sources / identifier
            if not target.is_dir():
                shutil.copytree(prefix / "sources" / identifier, target)
                trusted.append({"path": str(target), "sha256": package["package_sha256"],
                                "capabilities": package["capabilities"]})
                if identifier in DEFAULT_ACTIVE and not args.attach_store:
                    enabled.append(target)
        (store / "package-index.json").write_text(json.dumps({"schema": 1, "packages": catalog}, indent=2) + "\n")
        for item in trusted:
            verify(installed_manager, Path(item["path"]), item["sha256"])
        if trusted:
            invoke(installed_manager, "trust-all", store, json.dumps(trusted))
        for target in enabled:
            invoke(installed_manager, "enable", store, target)
        sync_sources(installed_manager, store, prefix / "sources", installed)
        for identifier in installed:
            verify(installed_manager, sources / identifier, installed[identifier]["sha256"])
        home, sqlite = support.state_roots()
        record = {"schema": SCHEMA, "product": PRODUCT,
                  "installed_at": datetime.now(timezone.utc).isoformat(),
                  "prefix": str(prefix), "bin_dir": str(bin_dir), "store": str(store),
                  "profile": args.profile, "profile_label": PROFILE_LABELS[args.profile],
                  "version": candidate["version"], "mod_api": host["api"], "packages": installed,
                  "sources": {identifier: packages[identifier]["files"] for identifier in PACKAGES},
                  "plugin_bundle": plugin_bundle,
                  "binary": {**binary, "installed_path": str(artifacts / "codex"),
                             "sha256": support.digest(artifacts / "codex")},
                  "code_mode_host": {"installed_path": str(artifacts / "codex-code-mode-host"),
                                     "sha256": support.digest(artifacts / "codex-code-mode-host")},
                  "broker": {"installed_path": str(artifacts / "omd-broker"),
                             "sha256": support.digest(artifacts / "omd-broker")},
                  "manager": {"installed_path": str(installed_manager),
                              "sha256": support.digest(installed_manager)},
                  "author": {"archive_sha256": support.digest(author_archive),
                             "node": str(node), "files": author_files},
                  "management": {"files": management_files},
                  "tools": tools,
                  "upstream_fallback": fallback_id,
                  "upstream_commit": upstream_lock["commit"],
                  "runtime_patch_sha256": patch_lock["patch"]["sha256"],
                  "shared_state": {"codex_home": str(home), "codex_sqlite_home": str(sqlite),
                                   "policy": "inherited unchanged; never removed by uninstall"},
                  "activation": {"selection": args.profile}}
        if managed:
            record["update"] = {"root": str(prefix.parents[2]), "installer": str(management_root / "install.sh"),
                                "python": sys.executable}
        if previous and previous["profile"] == args.profile:
            record["activation"]["selection"] = previous["activation"]["selection"]
            if previous.get("providers"):
                record["providers"] = previous["providers"]
        launcher = bin_dir / "codex"
        support.atomic_text(launcher, selected_text(record), 0o755)
        made_launchers.append(launcher)
        record["activation"]["sha256"] = support.digest(launcher)
        author_launcher = bin_dir / "omd-mod-author"
        support.atomic_text(author_launcher,
                            f"#!/bin/sh\nexec {shlex.quote(str(node))} {shlex.quote(str(author_cli))} \"$@\"\n",
                            0o755)
        made_launchers.append(author_launcher)
        record["author"]["launcher_sha256"] = support.digest(author_launcher)
        control_launcher = bin_dir / "omd-package"
        support.atomic_text(control_launcher,
                            f"#!/bin/sh\nexport PYTHONDONTWRITEBYTECODE=1 OMD_PACKAGE_CWD=\"$PWD\"\n"
                            f"cd {shlex.quote(str(management_root))} || exit 1\n"
                            f"for python in {shlex.quote(sys.executable)} python3.14 python3.13 python3.12 python3; do\n"
                            "  command -v \"$python\" >/dev/null 2>&1 && \"$python\" -c 'import sys; raise SystemExit(sys.version_info < (3, 12))' 2>/dev/null && break\n"
                            "done\n"
                            f"exec \"$python\" -m scripts.lean_profiles "
                            f"--prefix {shlex.quote(str(prefix))} --bin-dir {shlex.quote(str(bin_dir))} \"$@\"\n",
                            0o755)
        made_launchers.append(control_launcher)
        record["management"]["launcher_sha256"] = support.digest(control_launcher)
        for name, details in tools.items():
            tool_launcher = bin_dir / name
            launcher_text = f"#!/bin/sh\nexec {shlex.quote(details['installed_path'])} \"$@\"\n"
            if name == "omd":
                update = record.get("update")
                routed = (f"if [ \"$1\" = update ]; then shift; OMD_PYTHON={shlex.quote(update['python'])} exec sh "
                          f"{shlex.quote(update['installer'])} update --root {shlex.quote(update['root'])} \"$@\"; fi\n") if update else ""
                launcher_text = (f"#!/bin/sh\n{routed}export OMD_MOD_STORE={shlex.quote(str(store))}\nexec {shlex.quote(details['installed_path'])} \"$@\"\n")
            support.atomic_text(tool_launcher, launcher_text, 0o755)
            made_launchers.append(tool_launcher)
            details["launcher_sha256"] = support.digest(tool_launcher)
        write(prefix, record)
        result = status(prefix, bin_dir)
        failed = [(package["id"], package["error"]) for package in result["packages"] if package["error"]]
        if failed:
            raise ValueError(f"candidate mod failed to load during installation: {failed}")
        return result
    except BaseException:
        for launcher in made_launchers:
            if launcher.is_file() and not launcher.is_symlink():
                launcher.unlink()
        shutil.rmtree(prefix)
        if made_store:
            shutil.rmtree(store)
        raise


def register_plugins(prefix, bin_dir):
    record = load(prefix)
    binary, _ = check(record, bin_dir)
    bundle = record.get("plugin_bundle")
    if not bundle:
        raise ValueError("OMD Core stages no plugins; install --profile full first")
    root = Path(bundle["marketplace"])
    link = prefix.parents[2] / "current"
    # Codex records the resolved path, which a later update prunes; the current link survives updates.
    source = link / prefix.name / root.relative_to(prefix) if support.resolved(link) == prefix.parent else root
    name = json.loads((root / ".agents/plugins/marketplace.json").read_text())["name"]
    home = Path(record["shared_state"]["codex_home"])
    config = home / "config.toml"
    env = {**os.environ, "CODEX_HOME": str(home)}

    def configured():
        entry = tomllib.loads(config.read_text()).get("marketplaces", {}).get(name) if config.is_file() else None
        return entry.get("source") if isinstance(entry, dict) else None

    if configured() != str(source):
        if configured() is not None:
            subprocess.run([binary, "plugin", "marketplace", "remove", name], check=True, capture_output=True, env=env)
        subprocess.run([binary, "plugin", "marketplace", "add", source], check=True, capture_output=True, env=env)
        text = config.read_text()
        written = f"source = {json.dumps(str(support.resolved(source)))}"
        if text.count(written) != 1:
            raise ValueError(f"Codex did not record marketplace {name} as expected")
        support.atomic_text(config, text.replace(written, f"source = {json.dumps(str(source))}"),
                            config.stat().st_mode & 0o777)
        if configured() != str(source):
            raise ValueError(f"Codex marketplace {name} source was not recorded")
    return {"marketplace": name, "source": str(source), "plugins": bundle["plugins"],
            "next": f"codex plugin add PLUGIN@{name}"}


def pinned_binaries(record):
    return {record["binary"]["installed_path"], record["manager"]["installed_path"],
            *(tool["installed_path"] for tool in record["tools"].values())}


def broker(prefix, bin_dir, action, also=()):
    record = load(prefix)
    _, manager = check(record, bin_dir)
    arguments = [action]
    if action in ("install", "pin"):
        pins = pinned_binaries(record).union(*(pinned_binaries(load(support.resolved(other))) for other in also))
        arguments += [f"--pin={path}" for path in sorted(pins)]
    if action == "install":
        arguments += ["--helper", record["broker"]["installed_path"]]
    snapshot = invoke(manager, "broker-grants-import", record["store"]) if action == "install" else None
    result = authority_broker.main(arguments)
    if action == "install":
        invoke(manager, "broker-grants-import", record["store"], json.dumps(snapshot))
        invoke(manager, "reload", record["store"])
    return result


def administrator_policy(prefix, bin_dir, action, source=None):
    record = load(prefix)
    _, manager = check(record, bin_dir)
    if action == "explain":
        return invoke(manager, "policy", "explain", record["store"])
    arguments = [f"policy-{action}"]
    if action == "install":
        if source is None:
            raise ValueError("usage: omd-package policy install FILE")
        invoke(manager, "policy", "check", source.resolve())
        arguments.append(str(source.resolve()))
    result = authority_broker.main(arguments)
    invoke(manager, "reload", record["store"])
    return result


def uninstall(prefix, bin_dir, keep_broker=False):
    record = load(prefix)
    check(record, bin_dir)
    if authority_broker.deployed() and not keep_broker:
        raise ValueError("the authority broker is deployed; run omd-package broker uninstall first")
    managed = {prefix / "install.json", Path(record["binary"]["installed_path"]),
               Path(record["code_mode_host"]["installed_path"]), Path(record["broker"]["installed_path"]),
               Path(record["manager"]["installed_path"])}
    managed.update(Path(details["installed_path"]) for details in record.get("tools", {}).values())
    managed.update(prefix / name for name in record["author"]["files"])
    managed.update(prefix / "management" / name for name in record["management"]["files"])
    sources = record.get("sources")
    if sources is None:
        sources = {identifier: package["files"] for identifier, package in record["packages"].items()}
    managed.update(prefix / "sources" / identifier / name
                   for identifier, files in sources.items() for name in files)
    bundle = record.get("plugin_bundle")
    if bundle:
        root = Path(bundle["marketplace"])
        managed.add(root / ".agents/plugins/marketplace.json")
        managed.update(root / name for name in bundle["files"])
    actual = {path for path in prefix.rglob("*") if path.is_file() or path.is_symlink()}
    if actual != managed:
        raise ValueError("installation prefix contains unmanaged files; move them before uninstall")
    config = Path(record["shared_state"]["codex_home"]) / "config.toml"
    if config.is_file():
        marketplaces = tomllib.loads(config.read_text()).get("marketplaces", {})
        for name, details in marketplaces.items():
            source = details.get("source") if isinstance(details, dict) else None
            if isinstance(source, str) and support.within(support.resolved(source), prefix):
                raise ValueError(f"Codex marketplace {name} still references the installation; remove or relocate it before uninstall")
    found = shutil.which("codex", path=support.path_without(bin_dir))
    if not found:
        raise ValueError("no upstream codex remains on PATH; refusing to remove the launcher")
    support.binary_identity(found)
    for name in record.get("tools", {}):
        (bin_dir / name).unlink()
    (bin_dir / "omd-package").unlink()
    (bin_dir / "omd-mod-author").unlink()
    (bin_dir / "codex").unlink()
    shutil.rmtree(prefix)
    return {"uninstalled": True, "upstream": str(support.resolved(found)),
            "preserved_mod_store": record["store"], "shared_state": record["shared_state"]}


def main():
    parser = argparse.ArgumentParser(prog="omd-package", description="Install, inspect and switch the OMD Core and OMD+ profiles")
    parser.add_argument("--prefix", type=Path, required=True, help=argparse.SUPPRESS)
    parser.add_argument("--bin-dir", type=Path, required=True, help=argparse.SUPPRESS)
    commands = parser.add_subparsers(dest="command", required=True, metavar="COMMAND")
    install_parser = commands.add_parser("install", help="install a profile (used by install.sh)")
    install_parser.add_argument("--profile", choices=PROFILE_LABELS, required=True,
                                help="platform: OMD Core; full: OMD+")
    install_parser.add_argument("--binary", type=Path, required=True)
    install_parser.add_argument("--manager", type=Path, required=True)
    for name in HOST_TOOLS:
        install_parser.add_argument(f"--{name}", type=Path, required=True)
    install_parser.add_argument("--author-archive", type=Path, required=True)
    install_parser.add_argument("--node", type=Path, required=True)
    install_parser.add_argument("--store", type=Path, required=True)
    install_parser.add_argument("--attach-store", action="store_true")
    install_parser.add_argument("--previous", type=Path, help="prefix of the installation this one replaces")
    commands.add_parser("reconcile", help="restore this installation's first-party mod sources in its store (used by install.sh)")
    status_parser = commands.add_parser("status", help="show the installed profile and its mods")
    status_parser.add_argument("--json", action="store_true", help="print the full status as JSON")
    activate_parser = commands.add_parser("activate", help="switch between OMD Core, OMD+ and upstream-style direct mode")
    activate_parser.add_argument("selection", choices=("platform", "full", "direct"),
                                 help="platform: OMD Core; full: OMD+; direct: upstream-style behavior")
    mod_parser = commands.add_parser("mod", help="enable or disable one profile mod")
    mod_parser.add_argument("action", choices=("enable", "disable"))
    mod_parser.add_argument("identifier", choices=PACKAGES)
    for name in ROUTES:
        route_parser = commands.add_parser(name, help=f"set up or launch the opt-in {name} route")
        route_parser.add_argument("--setup", action="store_true")
        route_parser.add_argument(f"--{name}", dest="path", type=Path, help=f"{name} CLI or SDK module path for --setup")
        route_parser.add_argument("--model", help="model slug or family shortcut")
        if name == "profiles":
            for flag in ("add", "remove", "credential", "protocol", "url", "upstream-model", "window", "max-output", "paid", "allowance"):
                route_parser.add_argument(f"--{flag}")
            route_parser.add_argument("--reasoning", action="store_true")
            route_parser.add_argument("--cache-control", action="store_true")
        route_parser.add_argument("codex", nargs=argparse.REMAINDER, help="arguments passed to codex")
    contract_parser = commands.add_parser("contract", help="list, show or select the workflow contract for this repository")
    contract_parser.add_argument("action", choices=("list", "status", "plan", "select", "clear"))
    contract_parser.add_argument("contract", nargs="?", help="ID@VERSION for plan and select")
    commands.add_parser("plugins", help="add the OMD+ plugin marketplace to Codex at a path that survives updates")
    broker_parser = commands.add_parser("broker", help="deploy or manage the OS-separated authority broker (sudo)")
    broker_parser.add_argument("action", choices=("install", "pin", "status", "reset", "uninstall"))
    broker_parser.add_argument("--also", type=Path, action="append", default=[],
                               help="also pin the binaries of another installation prefix")
    policy_parser = commands.add_parser("policy", help="install, roll back, remove or explain the administrator policy file (sudo)")
    policy_parser.add_argument("action", choices=("install", "rollback", "remove", "explain"))
    policy_parser.add_argument("file", type=Path, nargs="?")
    uninstall_parser = commands.add_parser("uninstall", help="remove this installation and its launchers")
    uninstall_parser.add_argument("--keep-broker", action="store_true",
                                  help="remove this installation while another one keeps using the authority broker")
    args = parser.parse_args()
    # The launcher runs from its management directory; commands act on the caller's directory.
    os.chdir(os.environ.pop("OMD_PACKAGE_CWD", "."))
    prefix, bin_dir = support.validate_locations(args.prefix, args.bin_dir)
    if args.command == "install":
        result = install(args)
    elif args.command == "status":
        result = status(prefix, bin_dir)
        if not args.json:
            print(status_summary(result))
            return
    elif args.command == "reconcile":
        result = reconcile(prefix, bin_dir)
    elif args.command == "activate":
        result = activate(prefix, bin_dir, args.selection)
    elif args.command == "mod":
        result = select_mod(prefix, bin_dir, args.identifier, args.action == "enable")
    elif args.command in ROUTES:
        result = route(prefix, bin_dir, args.command, args)
    elif args.command == "contract":
        result = contract(prefix, args.action, args.contract)
    elif args.command == "plugins":
        result = register_plugins(prefix, bin_dir)
    elif args.command == "broker":
        result = broker(prefix, bin_dir, args.action, args.also)
    elif args.command == "policy":
        result = administrator_policy(prefix, bin_dir, args.action, args.file)
    else:
        result = uninstall(prefix, bin_dir, args.keep_broker)
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, ValueError) as error:
        raise SystemExit(str(error)) from error
