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
    from scripts import full_mods_lock
    from scripts import preview_lock
except ModuleNotFoundError:
    import install_support as support
    import full_mods_lock
    import preview_lock


ROOT = Path(__file__).resolve().parents[1]
PRODUCT = "oh-my-diff-lean-package-candidate-v1"
SCHEMA = 1
PROFILE_LABELS = {"platform": "OMD Core", "full": "OMD+"}
DEFAULT_ACTIVE = ("omd_inspector", "omd_logo", "omd_model_picker", "omd_workspace")
PACKAGES = tuple(sorted((*preview_lock.PACKAGES, *full_mods_lock.PACKAGES)))
PLATFORM_PACKAGES = ("omd_logo",)
HOST_TOOLS = ("omd", "omd-contract")
ROUTES = {"claude": "omd_claude_cli", "muse": "omd_muse"}
MANAGEMENT_FILES = ("scripts/lean_profiles.py", "scripts/install_support.py",
                    "scripts/full_mods_lock.py", "runtime/full-mods.lock.json",
                    "scripts/preview_lock.py",
                    "runtime/preview-v1.lock.json", "LEAN_PROFILES.md")


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
    if result["version"] != f"codex-cli {version}":
        raise ValueError(f"candidate requires the pinned Codex {version} host")
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
    prefixes = tuple(f"plugins/optional/plugins/{identifier}/" for identifier in support.SELECTED_OPTIONAL_PLUGINS)
    if set(support.optional_plugin_sources()) != {name for name in record["source_sha256"] if name.startswith(prefixes)}:
        raise ValueError("selected optional plugin source inventory changed")
    return record


def copy_curated_plugins(destination):
    lock = support.plugin_lock()
    index = json.loads((ROOT / "extensions/index.json").read_text())
    selected = {package["id"] for package in index["packages"]
                if package["extension_type"] == "plugin"
                and package["support_status"] in ("reviewed_candidate", "supported")}
    if not selected or not selected <= set(lock["plugins"]):
        raise ValueError("curated plugin selection disagrees with the pinned bundle")
    source = ROOT / lock["source"]
    if support.digest(ROOT / lock["guide"]["path"]) != lock["guide"]["sha256"]:
        raise ValueError("pinned bundled plugin guide changed")
    files = {}
    for name, expected in lock["files"].items():
        if name.startswith("plugins/") and name.split("/")[1] in selected:
            if support.digest(source / name) != expected:
                raise ValueError(f"pinned curated plugin source changed: {name}")
            target = destination / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source / name, target)
            files[name] = expected
    marketplace = json.loads((source / ".agents/plugins/marketplace.json").read_text())
    listed = {entry["name"] for entry in marketplace["plugins"]}
    if marketplace.get("name") != lock["marketplace"] or not selected <= listed:
        raise ValueError("curated plugin marketplace changed")
    if listed == set(lock["plugins"]) and support.digest(
            source / ".agents/plugins/marketplace.json") != lock["files"][".agents/plugins/marketplace.json"]:
        raise ValueError("pinned bundled plugin marketplace changed")
    marketplace["plugins"] = [entry for entry in marketplace["plugins"] if entry["name"] in selected]
    optional_sources = support.optional_plugin_sources()
    for identifier in support.SELECTED_OPTIONAL_PLUGINS:
        source = ROOT / "plugins/optional/plugins" / identifier
        for name in optional_sources:
            path = ROOT / name
            if not path.is_relative_to(source):
                continue
            relative = f"plugins/{identifier}/{path.relative_to(source).as_posix()}"
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, target)
            files[relative] = support.digest(path)
        marketplace["plugins"].append({"name": identifier,
                                       "source": {"source": "local", "path": f"./plugins/{identifier}"},
                                       "policy": {"installation": "AVAILABLE", "authentication": "ON_INSTALL"},
                                       "category": "Developer Tools"})
    selected.update(support.SELECTED_OPTIONAL_PLUGINS)
    support.atomic_text(destination / ".agents/plugins/marketplace.json",
                        json.dumps(marketplace, indent=2) + "\n")
    return {"marketplace": str(destination), "plugins": sorted(selected), "files": files,
            "marketplace_sha256": support.digest(destination / ".agents/plugins/marketplace.json"),
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
    lines = ["#!/bin/sh", "unset OMD_INSTALL_PROFILE OMD_CONTROLLED_MANIFEST OMD_MOD_STORE"]
    lines.append(f"export OMD_INSTALL_PROFILE={'platform_only' if record['profile'] == 'platform' else 'full'}")
    if selection == "direct":
        lines.append("export OMD_MODE=upstream_direct")
    else:
        lines.extend(["export OMD_MODE=omd", f"export OMD_MOD_STORE={shlex.quote(store)}"])
    flags = []
    for provider in record.get("providers", {}).values() if selection != "direct" else ():
        key = provider["env_key"]
        lines.append(f'{key}="$(cat {shlex.quote(provider["token"])} 2>/dev/null)"; export {key}')
        settings = {"name": provider["name"], "base_url": provider["base_url"], "wire_api": "responses", "env_key": key,
                    "request_max_retries": 0, "stream_max_retries": 0, "supports_websockets": False}
        for field, value in settings.items():
            flags += ["-c", f"model_providers.{provider['id']}.{field}={json.dumps(value)}"]
    lines.append(f"exec {shlex.join([binary, *flags])} \"$@\"")
    return "\n".join(lines) + "\n"


def check(record, bin_dir):
    binary = Path(record["binary"]["installed_path"])
    manager = Path(record["manager"]["installed_path"])
    for path, expected in ((binary, record["binary"]["sha256"]),
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
    return {"product": PRODUCT, "profile": record["profile"],
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
        result = subprocess.run([record["author"]["node"], str(setup), "setup", str(prefix / "install.json"),
                                 str(args.path or "")], capture_output=True, text=True)
        if result.returncode:
            raise ValueError(result.stderr.strip() or f"{name} setup failed")
        details = json.loads(result.stdout)
        record.setdefault("providers", {})[identifier] = details.pop("provider")
        launcher = bin_dir / "codex"
        support.atomic_text(launcher, selected_text(record), 0o755)
        record["activation"]["sha256"] = support.digest(launcher)
        write(prefix, record)
        if name == "muse":
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
    if support.output([str(node), "--version"]) != f"v{locked['node']}":
        raise ValueError(f"Node {locked['node']} is required")
    fallback = shutil.which("codex", path=support.path_without(bin_dir))
    if not fallback:
        raise ValueError("no upstream Codex fallback resolves on PATH")
    fallback_id = support.binary_identity(fallback)
    if fallback_id["version"] != binary["version"]:
        raise ValueError("upstream fallback version does not match the candidate")
    if args.attach_store:
        for identifier in profile_packages(args.profile):
            target = store / "sources" / identifier
            package = packages[identifier]
            if target.is_dir() and any(
                not (target / name).is_file() or support.digest(target / name) != package["files"][name]
                for name in package["files"]
            ):
                raise ValueError(f"existing store has a different first-party candidate package: {identifier}")
    bin_dir.mkdir(parents=True, exist_ok=True)
    prefix.mkdir(parents=True)
    made_store = False
    made_launchers = []
    try:
        artifacts = prefix / "artifacts"
        artifacts.mkdir()
        for source, name in ((Path(binary["path"]), "codex"), (manager, "omd-mod")):
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
        if args.profile == "full":
            plugin_bundle = copy_curated_plugins(prefix / "bundles/oh-my-diff")
        sources = store / "sources"
        sources.mkdir(exist_ok=True)
        for identifier in profile_packages(args.profile):
            package = packages[identifier]
            target = sources / identifier
            added = not target.is_dir()
            if added:
                target.mkdir()
                for name in package["files"]:
                    (target / name).parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(ROOT / package["source"] / name, target / name)
            inspected = invoke(installed_manager, "inspect", target)
            if inspected["sha256"] != package["package_sha256"]:
                raise ValueError(f"package digest mismatch: {identifier}")
            if added:
                invoke(installed_manager, "trust", store, target, inspected["sha256"],
                       ",".join(package["capabilities"]))
                if identifier in DEFAULT_ACTIVE and not args.attach_store:
                    invoke(installed_manager, "enable", store, target)
            installed[identifier] = {"version": package["version"], "sha256": inspected["sha256"]}
        home, sqlite = support.state_roots()
        record = {"schema": SCHEMA, "product": PRODUCT,
                  "installed_at": datetime.now(timezone.utc).isoformat(),
                  "prefix": str(prefix), "bin_dir": str(bin_dir), "store": str(store),
                  "profile": args.profile, "profile_label": PROFILE_LABELS[args.profile],
                  "mod_api": host["api"], "packages": installed,
                  "plugin_bundle": plugin_bundle,
                  "binary": {**binary, "installed_path": str(artifacts / "codex"),
                             "sha256": support.digest(artifacts / "codex")},
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
                            f"#!/bin/sh\nexport PYTHONDONTWRITEBYTECODE=1\n"
                            f"cd {shlex.quote(str(management_root))} || exit 1\n"
                            f"exec {shlex.quote(sys.executable)} -m scripts.lean_profiles "
                            f"--prefix {shlex.quote(str(prefix))} --bin-dir {shlex.quote(str(bin_dir))} \"$@\"\n",
                            0o755)
        made_launchers.append(control_launcher)
        record["management"]["launcher_sha256"] = support.digest(control_launcher)
        for name, details in tools.items():
            tool_launcher = bin_dir / name
            launcher_text = f"#!/bin/sh\nexec {shlex.quote(details['installed_path'])} \"$@\"\n"
            if name == "omd":
                launcher_text = f"#!/bin/sh\nexport OMD_MOD_STORE={shlex.quote(str(store))}\nexec {shlex.quote(details['installed_path'])} \"$@\"\n"
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


def uninstall(prefix, bin_dir):
    record = load(prefix)
    check(record, bin_dir)
    managed = {prefix / "install.json", Path(record["binary"]["installed_path"]),
               Path(record["manager"]["installed_path"])}
    managed.update(Path(details["installed_path"]) for details in record.get("tools", {}).values())
    managed.update(prefix / name for name in record["author"]["files"])
    managed.update(prefix / "management" / name for name in record["management"]["files"])
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
    fallback = record["upstream_fallback"]
    current = support.binary_identity(fallback["path"])
    if current["sha256"] != fallback["sha256"]:
        raise ValueError("upstream fallback changed; refusing to remove launcher")
    if support.resolved(shutil.which("codex", path=support.path_without(bin_dir))) != support.resolved(fallback["path"]):
        raise ValueError("upstream fallback no longer resolves on PATH")
    for name in record.get("tools", {}):
        (bin_dir / name).unlink()
    (bin_dir / "omd-package").unlink()
    (bin_dir / "omd-mod-author").unlink()
    (bin_dir / "codex").unlink()
    shutil.rmtree(prefix)
    return {"uninstalled": True, "upstream": fallback["path"],
            "preserved_mod_store": record["store"], "shared_state": record["shared_state"]}


def main():
    parser = argparse.ArgumentParser(description="Install and inspect the local OMD Core and OMD+ candidate profiles")
    parser.add_argument("--prefix", type=Path, required=True)
    parser.add_argument("--bin-dir", type=Path, required=True)
    commands = parser.add_subparsers(dest="command", required=True)
    install_parser = commands.add_parser("install")
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
    commands.add_parser("status")
    activate_parser = commands.add_parser("activate")
    activate_parser.add_argument("selection", choices=("platform", "full", "direct"),
                                 help="platform: OMD Core; full: OMD+; direct: upstream-style behavior")
    mod_parser = commands.add_parser("mod")
    mod_parser.add_argument("action", choices=("enable", "disable"))
    mod_parser.add_argument("identifier", choices=PACKAGES)
    for name in ROUTES:
        route_parser = commands.add_parser(name, help=f"set up or launch the opt-in {name} route")
        route_parser.add_argument("--setup", action="store_true")
        route_parser.add_argument(f"--{name}", dest="path", type=Path, help=f"{name} CLI path for --setup")
        route_parser.add_argument("--model", help="model slug or family shortcut")
        route_parser.add_argument("codex", nargs=argparse.REMAINDER, help="arguments passed to codex")
    commands.add_parser("uninstall")
    args = parser.parse_args()
    prefix, bin_dir = support.validate_locations(args.prefix, args.bin_dir)
    if args.command == "install":
        result = install(args)
    elif args.command == "status":
        result = status(prefix, bin_dir)
    elif args.command == "activate":
        result = activate(prefix, bin_dir, args.selection)
    elif args.command == "mod":
        result = select_mod(prefix, bin_dir, args.identifier, args.action == "enable")
    elif args.command in ROUTES:
        result = route(prefix, bin_dir, args.command, args)
    else:
        result = uninstall(prefix, bin_dir)
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, ValueError) as error:
        raise SystemExit(str(error)) from error
