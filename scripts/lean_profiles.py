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
    from scripts import private_lean_v1 as private
    from scripts import claude_lock
    from scripts import typed_tasks_lock
    from scripts import lsp_sync_lock
    from scripts import terminal_mods_lock
    from scripts import batch2_lock
except ModuleNotFoundError:
    import private_lean_v1 as private
    import claude_lock
    import typed_tasks_lock
    import lsp_sync_lock
    import terminal_mods_lock
    import batch2_lock


ROOT = Path(__file__).resolve().parents[1]
PRODUCT = "oh-my-diff-lean-package-candidate-v1"
SCHEMA = 1
DEFAULT_ACTIVE = ("omd_logo", "omd_model_picker", "omd_workspace")
PACKAGES = ("omd_advisor", "omd_claude_cli", "omd_coordination", "omd_git", "omd_logo", "omd_lsp_sync", "omd_model_picker",
            "omd_recovery", "omd_research", "omd_selection_copy", "omd_typed_tasks", "omd_workspace")
PLATFORM_PACKAGES = ("omd_logo",)
TOOL_NAMES = ("omd-graph", "omd-health", "omd-lsp")
MANAGEMENT_FILES = ("scripts/lean_profiles.py", "scripts/private_lean_v1.py",
                    "scripts/claude_lock.py",
                    "runtime/claude-full.lock.json",
                    "scripts/typed_tasks_lock.py", "runtime/typed-tasks-full.lock.json",
                    "scripts/lsp_sync_lock.py", "runtime/lsp-sync-full.lock.json",
                    "scripts/terminal_mods_lock.py", "runtime/terminal-mods-full.lock.json",
                    "scripts/batch2_lock.py", "runtime/batch2-full.lock.json",
                    "scripts/preview_lock.py", "scripts/browser_bundle.py",
                    "runtime/preview-v1.lock.json", "LEAN_PROFILES.md")


def invoke(*arguments):
    result = subprocess.run([str(item) for item in arguments], capture_output=True, text=True)
    if result.returncode:
        raise ValueError((result.stderr or result.stdout or "command failed").strip())
    return json.loads(result.stdout)


def package_sources(preview):
    claude = claude_lock.load()
    typed = typed_tasks_lock.load()
    lsp = lsp_sync_lock.load()
    terminal = terminal_mods_lock.load()
    batch2 = batch2_lock.load()
    if any(package.get('mod_api') != preview['mod_api'] for package in (claude, typed, lsp, terminal, batch2)):
        raise ValueError('Full mod API disagrees with pinned preview')
    return {**preview['packages'], claude['package']['id']: claude['package'], typed['package']['id']: typed['package'],
            lsp['package']['id']: lsp['package'], **terminal['packages'], **batch2['packages']}


def profile_packages(profile):
    return PACKAGES if profile == "full" else PLATFORM_PACKAGES


def paths(prefix, bin_dir, store):
    prefix, bin_dir = private.validate_locations(prefix, bin_dir)
    store = private.resolved(store)
    if store == Path(store.anchor) or private.within(store, ROOT):
        raise ValueError("mod store must be outside the source checkout")
    if any(private.within(store, value) or private.within(value, store)
           for value in (prefix, bin_dir, *private.state_roots())):
        raise ValueError("mod store must be separate from installation, launchers and Codex state")
    return prefix, bin_dir, store


def identity(binary):
    binary = private.resolved(binary)
    result = private.binary_identity(binary)
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
        if private.digest(ROOT / name) != expected:
            raise ValueError(f"lean candidate source changed: {name}")
    return record


def copy_curated_plugins(destination):
    lock = private.plugin_lock()
    index = json.loads((ROOT / "extensions/index.json").read_text())
    selected = {package["id"] for package in index["packages"]
                if package["extension_type"] == "plugin"
                and package["support_status"] in ("reviewed_candidate", "supported")}
    if not selected or not selected <= set(lock["plugins"]):
        raise ValueError("curated plugin selection disagrees with the pinned bundle")
    source = ROOT / lock["source"]
    if private.digest(ROOT / lock["guide"]["path"]) != lock["guide"]["sha256"]:
        raise ValueError("pinned bundled plugin guide changed")
    files = {}
    for name, expected in lock["files"].items():
        if name.startswith("plugins/") and name.split("/")[1] in selected:
            if private.digest(source / name) != expected:
                raise ValueError(f"pinned curated plugin source changed: {name}")
            target = destination / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source / name, target)
            files[name] = expected
    marketplace = json.loads((source / ".agents/plugins/marketplace.json").read_text())
    listed = {entry["name"] for entry in marketplace["plugins"]}
    if marketplace.get("name") != lock["marketplace"] or not selected <= listed:
        raise ValueError("curated plugin marketplace changed")
    if listed == set(lock["plugins"]) and private.digest(
            source / ".agents/plugins/marketplace.json") != lock["files"][".agents/plugins/marketplace.json"]:
        raise ValueError("pinned bundled plugin marketplace changed")
    marketplace["plugins"] = [entry for entry in marketplace["plugins"] if entry["name"] in selected]
    private.atomic_text(destination / ".agents/plugins/marketplace.json",
                        json.dumps(marketplace, indent=2) + "\n")
    return {"marketplace": str(destination), "plugins": sorted(selected), "files": files,
            "marketplace_sha256": private.digest(destination / ".agents/plugins/marketplace.json"),
            "installed_by_candidate": [],
            "note": "available for explicit installation; no plugin is configured by this installer"}


def load(prefix):
    record = json.loads((prefix / "install.json").read_text())
    if record.get("schema") != SCHEMA or record.get("product") != PRODUCT:
        raise ValueError("unrecognized candidate installation")
    if private.resolved(record["prefix"]) != prefix:
        raise ValueError("installation prefix changed")
    return record


def write(prefix, record):
    private.atomic_text(prefix / "install.json", json.dumps(record, indent=2, sort_keys=True) + "\n")


def selected_text(record):
    binary = record["binary"]["installed_path"]
    store = record["store"]
    selection = record["activation"]["selection"]
    lines = ["#!/bin/sh", "unset OMD_INSTALL_PROFILE OMD_CONTROLLED_MANIFEST OMD_MOD_STORE"]
    lines.append(f"export OMD_INSTALL_PROFILE={'platform_only' if record['profile'] == 'platform' else 'full'}")
    if selection == "direct":
        lines.append("export OMD_MODE=upstream_direct")
    elif selection == "controlled":
        lines.extend(["export OMD_MODE=enabled",
                      f"export OMD_CONTROLLED_MANIFEST={shlex.quote(record['activation']['controlled_manifest'])}"])
    else:
        lines.extend(["export OMD_MODE=platform", f"export OMD_MOD_STORE={shlex.quote(store)}"])
    lines.append(f"exec {shlex.quote(binary)} \"$@\"")
    return "\n".join(lines) + "\n"


def check(record, bin_dir):
    binary = Path(record["binary"]["installed_path"])
    manager = Path(record["manager"]["installed_path"])
    for path, expected in ((binary, record["binary"]["sha256"]),
                           (manager, record["manager"]["sha256"])):
        if not path.is_file() or private.digest(path) != expected:
            raise ValueError(f"managed artifact changed: {path}")
    launcher = bin_dir / "codex"
    if launcher.is_symlink() or not launcher.is_file() or private.digest(launcher) != record["activation"]["sha256"]:
        raise ValueError("managed launcher is absent or modified")
    if private.digest(launcher) != hashlib.sha256(selected_text(record).encode()).hexdigest():
        raise ValueError("managed launcher differs from effective settings")
    for name, details in record.get("tools", {}).items():
        tool = Path(details["installed_path"])
        if not tool.is_file() or private.digest(tool) != details["sha256"]:
            raise ValueError(f"managed tool changed: {name}")
        tool_launcher = bin_dir / name
        if tool_launcher.is_symlink() or not tool_launcher.is_file() or private.digest(tool_launcher) != details["launcher_sha256"]:
            raise ValueError(f"managed tool launcher changed: {name}")
    bundle = record.get("plugin_bundle")
    if bundle:
        root = Path(bundle["marketplace"])
        for name, expected in bundle["files"].items():
            path = root / name
            if not path.is_file() or private.digest(path) != expected:
                raise ValueError(f"managed plugin source changed: {name}")
        marketplace = root / ".agents/plugins/marketplace.json"
        if not marketplace.is_file() or private.digest(marketplace) != bundle["marketplace_sha256"]:
            raise ValueError("managed plugin marketplace changed")
    author = record["author"]
    for name, expected in author["files"].items():
        path = Path(record["prefix"]) / name
        if not path.is_file() or private.digest(path) != expected:
            raise ValueError(f"managed author package changed: {name}")
    author_launcher = bin_dir / "omd-mod-author"
    if (author_launcher.is_symlink() or not author_launcher.is_file()
            or private.digest(author_launcher) != author["launcher_sha256"]):
        raise ValueError("managed author launcher changed")
    management = record["management"]
    for name, expected in management["files"].items():
        path = Path(record["prefix"]) / "management" / name
        if not path.is_file() or private.digest(path) != expected:
            raise ValueError(f"managed package control changed: {name}")
    control_launcher = bin_dir / "omd-package"
    if (control_launcher.is_symlink() or not control_launcher.is_file()
            or private.digest(control_launcher) != management["launcher_sha256"]):
        raise ValueError("managed package control launcher changed")
    return binary, manager


def status(prefix, bin_dir):
    record = load(prefix)
    if private.resolved(record["bin_dir"]) != bin_dir:
        raise ValueError("launcher directory changed")
    _, manager = check(record, bin_dir)
    store = Path(record["store"])
    host = invoke(manager, "status", store)
    if host["api"] != record["mod_api"]:
        raise ValueError("mod store API no longer matches candidate")
    selection = invoke(manager, "selection-status", store)
    active = {item["id"]: item for item in host["mods"]}
    locked = package_sources(private.preview_lock())
    packages = []
    for identifier in profile_packages(record["profile"]):
        source = store / "sources" / identifier
        current = source.is_dir() and all(
            (source / name).is_file() and private.digest(source / name) == locked[identifier]["files"][name]
            for name in locked[identifier]["files"]
        )
        packages.append({"id": identifier, "installed": source.is_dir(), "pinned_source_current": current,
                         "enabled_in_store": identifier in active,
                         "loaded_by_profile": identifier in active and record["activation"]["selection"] != "direct",
                         "error": active.get(identifier, {}).get("error")})
    return {"product": PRODUCT, "profile": record["profile"],
            "activation": record["activation"]["selection"],
            "host_mode": {"direct": "upstream_direct", "controlled": "enabled"}.get(
                record["activation"]["selection"], "platform"),
            "controlled_manifest": record["activation"].get("controlled_manifest"),
            "binary_sha256": record["binary"]["sha256"], "runtime_patch_sha256": record["runtime_patch_sha256"],
            "store": str(store), "mod_api": host["api"], "packages": packages,
            "effective_mod_selection": selection,
            "plugin_bundle": record.get("plugin_bundle"),
            "author": record["author"],
            "package_control": str(bin_dir / "omd-package"),
            "installed_tools": sorted(record.get("tools", {})),
            "other_active_mods": [item for item in host["mods"] if item["id"] not in profile_packages(record["profile"])],
            "installer_configured_optional_services": [], "shared_state": record["shared_state"]}


def activate(prefix, bin_dir, selection, controlled_manifest=None):
    record = load(prefix)
    check(record, bin_dir)
    if selection not in ("direct", record["profile"], "controlled" if record["profile"] == "full" else None):
        raise ValueError("activation must select the installed profile, direct, or Full controlled mode")
    if selection == "controlled":
        if controlled_manifest is None:
            raise ValueError("controlled mode requires --manifest")
        controlled_manifest = private.resolved(controlled_manifest)
        if not controlled_manifest.is_file():
            raise ValueError("controlled manifest is unavailable")
        declared = json.loads(controlled_manifest.read_text())
        selected_store = declared.get("mods") if isinstance(declared, dict) else None
        if not isinstance(selected_store, str) or private.resolved(selected_store) != private.resolved(record["store"]):
            raise ValueError("controlled manifest must select this candidate's mod store")
    elif controlled_manifest is not None:
        raise ValueError("--manifest is only valid for controlled mode")
    record["activation"] = {"selection": selection,
                            "controlled_manifest": str(controlled_manifest) if controlled_manifest else None}
    launcher = bin_dir / "codex"
    private.atomic_text(launcher, selected_text(record), 0o755)
    record["activation"]["sha256"] = private.digest(launcher)
    write(prefix, record)
    return status(prefix, bin_dir)


def select_mod(prefix, bin_dir, identifier, enabled):
    record = load(prefix)
    if identifier not in record["packages"]:
        raise ValueError("only installed first-party candidate mods can be selected here")
    _, manager = check(record, bin_dir)
    source = Path(record["store"]) / "sources" / identifier
    invoke(manager, "enable" if enabled else "disable", record["store"], source)
    invoke(manager, "reload", record["store"])
    return status(prefix, bin_dir)


def install(args):
    prefix, bin_dir, store = paths(args.prefix, args.bin_dir, args.store)
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        raise ValueError("this candidate installer supports Apple Silicon macOS")
    if (prefix.exists() or (bin_dir / "codex").exists() or (bin_dir / "codex").is_symlink()
            or (bin_dir / "omd-mod-author").exists() or (bin_dir / "omd-mod-author").is_symlink()
            or (bin_dir / "omd").exists() or (bin_dir / "omd").is_symlink()
            or (bin_dir / "omd-package").exists() or (bin_dir / "omd-package").is_symlink()):
        raise ValueError("managed prefix or launcher already exists")
    if args.profile == "full":
        if any(getattr(args, name.replace("-", "_")) is None for name in TOOL_NAMES):
            raise ValueError("Full OMD requires the three matching optional tool binaries")
        if any((bin_dir / name).exists() or (bin_dir / name).is_symlink() for name in TOOL_NAMES):
            raise ValueError("optional tool launcher path is already managed")
    elif any(getattr(args, name.replace("-", "_")) is not None for name in TOOL_NAMES):
        raise ValueError("the platform-only profile has no bundled optional tools")
    if store.exists() != args.attach_store:
        raise ValueError("use --attach-store for an existing mod store; omit it for a new store")
    upstream_lock = json.loads((ROOT / "upstream.lock.json").read_text())
    patch_lock = json.loads((ROOT / "runtime/patches/manifest.json").read_text())
    if private.digest(ROOT / patch_lock["patch"]["path"]) != patch_lock["patch"]["sha256"]:
        raise ValueError("active runtime patch hash mismatch")
    locked = private.preview_sources(private.preview_lock())
    if claude_lock.load() != claude_lock.build():
        raise ValueError('Claude Full lock differs from pinned sources')
    if typed_tasks_lock.load() != typed_tasks_lock.build():
        raise ValueError('typed task Full lock differs from pinned sources')
    if lsp_sync_lock.load() != lsp_sync_lock.build():
        raise ValueError('LSP synchronization Full lock differs from pinned sources')
    if terminal_mods_lock.load() != terminal_mods_lock.build():
        raise ValueError('terminal mod Full lock differs from pinned sources')
    if batch2_lock.load() != batch2_lock.build():
        raise ValueError('Batch 2 Full lock differs from pinned sources')
    packages = package_sources(locked)
    candidate = candidate_lock(upstream_lock, patch_lock, locked)
    if tuple(sorted(packages)) != PACKAGES:
        raise ValueError("first-party candidate inventory changed")
    binary = identity(args.binary)
    if binary["sha256"] != candidate["artifacts"]["codex"]["sha256"]:
        raise ValueError("Codex binary differs from frozen lean candidate")
    manager = private.resolved(args.manager)
    node = private.resolved(args.node)
    if not manager.is_file() or not os.access(manager, os.X_OK):
        raise ValueError("mod manager executable is unavailable")
    if private.digest(manager) != candidate["artifacts"]["omd-mod"]["sha256"]:
        raise ValueError("mod manager differs from frozen lean candidate")
    author_archive = private.resolved(args.author_archive)
    if (not author_archive.is_file()
            or private.digest(author_archive) != candidate["artifacts"]["mod-api.tgz"]["sha256"]):
        raise ValueError("mod author archive differs from pinned lean package")
    if private.output([str(node), "--version"]) != f"v{locked['node']}":
        raise ValueError(f"Node {locked['node']} is required")
    fallback = shutil.which("codex", path=private.path_without(bin_dir))
    if not fallback:
        raise ValueError("no upstream Codex fallback resolves on PATH")
    fallback_id = private.binary_identity(fallback)
    if fallback_id["version"] != binary["version"]:
        raise ValueError("upstream fallback version does not match the candidate")
    if args.attach_store:
        for identifier in profile_packages(args.profile):
            target = store / "sources" / identifier
            package = packages[identifier]
            if target.is_dir() and any(
                not (target / name).is_file() or private.digest(target / name) != package["files"][name]
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
        author_files = {path.relative_to(prefix).as_posix(): private.digest(path)
                        for path in author_root.rglob("*") if path.is_file()}
        management_root = prefix / "management"
        management_files = {}
        for name in MANAGEMENT_FILES:
            target = management_root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / name, target)
            management_files[name] = private.digest(target)
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
        for name in ("omd",) + (TOOL_NAMES if args.profile == "full" else ()):
            source = private.resolved(getattr(args, name.replace("-", "_")))
            if not source.is_file() or not os.access(source, os.X_OK):
                raise ValueError(f"optional tool binary is unavailable: {name}")
            if private.digest(source) != candidate["artifacts"][name]["sha256"]:
                raise ValueError(f"optional tool differs from frozen lean candidate: {name}")
            target = artifacts / name
            shutil.copy2(source, target)
            tools[name] = {"installed_path": str(target), "sha256": private.digest(target)}
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
        home, sqlite = private.state_roots()
        record = {"schema": SCHEMA, "product": PRODUCT,
                  "installed_at": datetime.now(timezone.utc).isoformat(),
                  "prefix": str(prefix), "bin_dir": str(bin_dir), "store": str(store),
                  "profile": args.profile, "mod_api": host["api"], "packages": installed,
                  "plugin_bundle": plugin_bundle,
                  "binary": {**binary, "installed_path": str(artifacts / "codex"),
                             "sha256": private.digest(artifacts / "codex")},
                  "manager": {"installed_path": str(installed_manager),
                              "sha256": private.digest(installed_manager)},
                  "author": {"archive_sha256": private.digest(author_archive),
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
        private.atomic_text(launcher, selected_text(record), 0o755)
        made_launchers.append(launcher)
        record["activation"]["sha256"] = private.digest(launcher)
        author_launcher = bin_dir / "omd-mod-author"
        private.atomic_text(author_launcher,
                            f"#!/bin/sh\nexec {shlex.quote(str(node))} {shlex.quote(str(author_cli))} \"$@\"\n",
                            0o755)
        made_launchers.append(author_launcher)
        record["author"]["launcher_sha256"] = private.digest(author_launcher)
        control_launcher = bin_dir / "omd-package"
        private.atomic_text(control_launcher,
                            f"#!/bin/sh\nexport PYTHONDONTWRITEBYTECODE=1\n"
                            f"cd {shlex.quote(str(management_root))} || exit 1\n"
                            f"exec {shlex.quote(sys.executable)} -m scripts.lean_profiles "
                            f"--prefix {shlex.quote(str(prefix))} --bin-dir {shlex.quote(str(bin_dir))} \"$@\"\n",
                            0o755)
        made_launchers.append(control_launcher)
        record["management"]["launcher_sha256"] = private.digest(control_launcher)
        for name, details in tools.items():
            tool_launcher = bin_dir / name
            launcher_text = private.tool_wrapper_text(details["installed_path"])
            if name == "omd":
                launcher_text = f"#!/bin/sh\nexport OMD_MOD_STORE={shlex.quote(str(store))}\nexec {shlex.quote(details['installed_path'])} \"$@\"\n"
            private.atomic_text(tool_launcher, launcher_text, 0o755)
            made_launchers.append(tool_launcher)
            details["launcher_sha256"] = private.digest(tool_launcher)
        write(prefix, record)
        result = status(prefix, bin_dir)
        if any(package["error"] for package in result["packages"]):
            raise ValueError("candidate mod failed to load during installation")
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
            if isinstance(source, str) and private.within(private.resolved(source), prefix):
                raise ValueError(f"Codex marketplace {name} still references the installation; remove or relocate it before uninstall")
    fallback = record["upstream_fallback"]
    current = private.binary_identity(fallback["path"])
    if current["sha256"] != fallback["sha256"]:
        raise ValueError("upstream fallback changed; refusing to remove launcher")
    if private.resolved(shutil.which("codex", path=private.path_without(bin_dir))) != private.resolved(fallback["path"]):
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
    parser = argparse.ArgumentParser(description="Install and inspect the local lean candidate profiles")
    parser.add_argument("--prefix", type=Path, required=True)
    parser.add_argument("--bin-dir", type=Path, required=True)
    commands = parser.add_subparsers(dest="command", required=True)
    install_parser = commands.add_parser("install")
    install_parser.add_argument("--profile", choices=("platform", "full"), required=True)
    install_parser.add_argument("--binary", type=Path, required=True)
    install_parser.add_argument("--manager", type=Path, required=True)
    install_parser.add_argument("--omd", type=Path, required=True)
    install_parser.add_argument("--author-archive", type=Path, required=True)
    install_parser.add_argument("--node", type=Path, required=True)
    install_parser.add_argument("--store", type=Path, required=True)
    for name in TOOL_NAMES:
        install_parser.add_argument(f"--{name}", type=Path)
    install_parser.add_argument("--attach-store", action="store_true")
    commands.add_parser("status")
    activate_parser = commands.add_parser("activate")
    activate_parser.add_argument("selection", choices=("platform", "full", "direct", "controlled"))
    activate_parser.add_argument("--manifest", type=Path)
    mod_parser = commands.add_parser("mod")
    mod_parser.add_argument("action", choices=("enable", "disable"))
    mod_parser.add_argument("identifier", choices=PACKAGES)
    claude_parser = commands.add_parser('claude')
    claude_parser.add_argument('--repository', type=Path, default=Path.cwd())
    claude_parser.add_argument('--model')
    claude_parser.add_argument('--claude', type=Path)
    claude_parser.add_argument('--max-requests', type=int, default=8)
    claude_parser.add_argument('--prompt', required=True)
    commands.add_parser("uninstall")
    args = parser.parse_args()
    prefix, bin_dir = private.validate_locations(args.prefix, args.bin_dir)
    if args.command == "install":
        result = install(args)
    elif args.command == "status":
        result = status(prefix, bin_dir)
    elif args.command == "activate":
        result = activate(prefix, bin_dir, args.selection, args.manifest)
    elif args.command == "mod":
        result = select_mod(prefix, bin_dir, args.identifier, args.action == "enable")
    elif args.command == 'claude':
        record = load(prefix)
        check(record, bin_dir)
        if record['profile'] != 'full':
            raise ValueError('the Claude mod is available only in Full OMD')
        node = record['author']['node']
        setup = Path(record['store']) / 'sources' / 'omd_claude_cli' / 'setup.mjs'
        os.execv(node, [node, str(setup), str(prefix / 'install.json'),
                        str(args.repository), args.model or '',
                        str(args.claude) if args.claude else '',
                        str(args.max_requests), args.prompt])
    else:
        result = uninstall(prefix, bin_dir)
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, ValueError) as error:
        raise SystemExit(str(error)) from error
