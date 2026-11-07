#!/usr/bin/env python3
import argparse
import errno
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shlex
import shutil
import signal
import subprocess
import sys
import tarfile
import tomllib
from datetime import datetime, timezone

from scripts import install_support as support
from scripts import authority_broker
from scripts import mods_lock


ROOT = Path(__file__).resolve().parents[1]
PRODUCT = "oh-my-diff-install-v1"
SCHEMA = 1
PROFILE_LABELS = {"platform": "OMD Core", "full": "OMD+"}
DEFAULT_ACTIVE = ("omd_auto_continue", "omd_logo", "omd_mods", "omd_statusline", "omd_tool_lines", "omd_update")
PACKAGES = tuple(sorted(support.mods_lock()["packages"]))
PLATFORM_PACKAGES = ("omd_logo", "omd_mods", "omd_update")
HOST_TOOLS = ("omd", "omd-contract")
LAUNCHERS = ("codex", "omd-mod-author", "omd-package", *HOST_TOOLS, "omd-mod")
UNINSTALL_JOURNAL = ".uninstall.json"
CURSOR_DATA = Path("/private/tmp") / f"omd-cursor-{os.getuid()}"
MODS_MARKER = ".mods-applying.json"
ROUTES = {"profiles": "omd_profiles"}
CODEX_VALUE_OPTIONS = {"-c", "--config", "--enable", "--disable", "-m", "--model", "--local-provider", "-p", "--profile",
                       "-s", "--sandbox", "-a", "--ask-for-approval", "-C", "--cd", "--add-dir", "--remote",
                       "--remote-auth-token-env", "--listen", "--ws-auth", "--ws-token-file", "--ws-token-sha256",
                       "--ws-shared-secret-file", "--ws-issuer", "--ws-audience", "--ws-max-clock-skew-seconds",
                       "--ws-allowed-origin"}
UNATTENDED_COMMANDS = ("exec", "e", "review", "login", "logout", "mcp", "plugin", "app-server", "remote-control", "app", "completion", "update", "doctor",
                       "sandbox", "debug", "apply", "a", "queue", "archive", "delete", "migrate-rollouts", "migrate-nfs-db", "unarchive", "exec-server",
                       "features", "help", "stdio-to-uds", "responses-api-proxy")
CODEX_FLAGS = {"--oss", "--approve-for-me", "--not-so-yolo", "--dangerously-bypass-approvals-and-sandbox", "--yolo",
               "--dangerously-bypass-hook-trust", "--search", "--no-daemon", "--strict-config"}
MANAGEMENT_FILES = ("scripts/profiles.py", "scripts/install_support.py", "scripts/authority_broker.py",
                    "scripts/mods_lock.py", "runtime/mods.lock.json", "extensions/index.json",
                    "upstream.lock.json", "docs/install.md", "install.sh")


def invoke(*arguments):
    return json.loads(support.output(arguments))


def profile_packages(profile):
    if profile == "full":
        experimental = {entry["id"] for entry in json.loads((ROOT / "extensions/index.json").read_text())["packages"]
                        if entry["support_status"] == "experimental"}
        return tuple(identifier for identifier in PACKAGES if identifier not in experimental)
    return PLATFORM_PACKAGES


def link(source, target):
    try:
        os.link(source, target)
    except OSError as error:
        if error.errno == errno.EEXIST:
            raise
        shutil.copy2(source, target)


def relink(source, target, objects):
    temporary = objects / f".{target.name}.{os.urandom(4).hex()}"
    try:
        os.link(source, temporary)
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


def share(objects, path):
    try:
        name = support.digest(path)
        stored = objects / name
        objects.mkdir(exist_ok=True)
        try:
            os.link(path, stored)
        except FileExistsError:
            if not os.path.samestat(path.stat(), stored.stat()) and path.stat().st_mode == stored.stat().st_mode:
                if support.digest(stored) == name:
                    relink(stored, path, objects)
                else:
                    relink(path, stored, objects)
        return name
    except OSError:
        return None


def place(source, target, objects):
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)
    return objects and share(objects, target) or support.digest(target)


def deduplicate(root):
    objects = root / "objects"
    for directory in (root / "catalog", *root.glob("releases/*/prefix/management"), *root.glob("releases/*/prefix/sources")):
        for path in directory.rglob("*"):
            try:
                single = path.is_file() and not path.is_symlink() and path.stat().st_nlink == 1
            except OSError:
                continue
            if single:
                share(objects, path)


def replace_tree(source, target):
    staged, retired = target.with_name(f".{target.name}.new"), target.with_name(f".{target.name}.old")
    for leftover in (staged, retired):
        shutil.rmtree(leftover, ignore_errors=True)
    shutil.copytree(source, staged)
    if target.is_dir():
        target.rename(retired)
    staged.rename(target)
    shutil.rmtree(retired, ignore_errors=True)


def sync_sources(manager, store, origin, packages):
    selections = {item.get("path"): item for item in invoke(manager, "selection-status", store)["selections"]}
    changed = []
    for identifier, package in packages.items():
        target = store / "sources" / identifier
        pending = target.with_name(f".{identifier}.pending.json")
        selection = selections.get(str(target), {})
        files = {path.relative_to(target).as_posix() for path in target.rglob("*") if path.is_file()}
        current = files == set(package["files"]) and all(support.digest(target / name) == digest
                                                         for name, digest in package["files"].items())
        if current and not pending.exists() and selection.get("sha256", package["sha256"]) == package["sha256"]:
            continue
        if not pending.exists():
            support.atomic_text(pending, json.dumps({"selected": bool(selection.get("selected"))}))
        if not current:
            replace_tree(origin / identifier, target)
        invoke(manager, "trust-all", store, json.dumps([{"path": str(target), "sha256": package["sha256"],
                                                         "capabilities": package["capabilities"]}]))
        if json.loads(pending.read_text())["selected"]:
            invoke(manager, "enable", store, target)
        pending.unlink()
        changed.append(identifier)
    if changed:
        invoke(manager, "reload", store)
    return changed


def refresh_kept_copies(manager, store, origin, packages, installed):
    kept = {identifier: {"sha256": package["package_sha256"], "files": package["files"],
                         "capabilities": package["capabilities"]}
            for identifier, package in packages.items()
            if identifier not in installed and (store / "sources" / identifier).is_dir()}
    return sync_sources(manager, store, origin, kept)


def keep_bundled_copies(manager, store):
    selected = [item for item in invoke(manager, "selection-status", store)["selections"] if item["selected"]]
    for item in selected:
        if item["packaged"] and any(other["path"] == str(store / "sources" / item["id"]) and other["scope"] == item["scope"]
                                    for other in selected):
            invoke(manager, "package-disable", store, item["id"])


def retire_packages(manager, store, profile, previous):
    retired = set(PACKAGES) - set(profile_packages("full")) - set(ROUTES.values())
    if previous and profile != "full":
        return set(previous.get("retired", ()))
    newly = retired - set(previous.get("retired", ())) if previous else set()
    if newly:
        for item in invoke(manager, "selection-status", store)["selections"]:
            if item["selected"] and item["id"] in newly and item["path"] == str(store / "sources" / item["id"]):
                invoke(manager, "disable", store, item["path"])
    return retired


def reconcile(prefix, bin_dir):
    record = load(prefix)
    _, manager = check(record, bin_dir)
    return {"restored": sync_sources(manager, Path(record["store"]), prefix / "sources", record["packages"])}


def apply_mods(prefix, bin_dir, bundle, applied, backup):
    record = load(prefix)
    lock_path, marker = prefix / "management/runtime/mods.lock.json", prefix / MODS_MARKER
    resuming = json.loads(marker.read_text()) if marker.is_file() else None
    if resuming and support.digest(lock_path) == resuming["lock"]:
        record["management"]["files"]["runtime/mods.lock.json"] = resuming["lock"]
        write(prefix, record)
    _, manager = check(record, bin_dir)
    for leftover in (prefix / ".mods-previous.new", *(prefix / "sources").glob(".*")):
        shutil.rmtree(leftover, ignore_errors=True)
    lock = json.loads(lock_path.read_text())
    offered = json.loads((bundle / "mods.lock.json").read_text())
    if offered.get("mod_api") != lock["mod_api"]:
        raise ValueError(f"the mod bundle is for mod API {offered.get('mod_api')}; this installation hosts {lock['mod_api']}")
    forced = set(resuming["ids"]) if resuming else set()
    changed = {identifier: package for identifier, package in offered["packages"].items()
               if identifier in lock["packages"] and (identifier in forced
                                                      or package["package_sha256"] != lock["packages"][identifier]["package_sha256"])}
    if not changed:
        marker.unlink(missing_ok=True)
        return {"updated": []}
    for identifier, package in changed.items():
        source = (bundle / "sources" / identifier).resolve()
        files = {path.relative_to(source).as_posix() for path in source.rglob("*") if path.is_file()}
        if files != set(package["files"]) or any(support.digest(source / name) != digest for name, digest in package["files"].items()):
            raise ValueError(f"mod bundle files differ from its lock: {identifier}")
        verify(manager, source, package["package_sha256"])
    if backup:
        staged = prefix / ".mods-previous.new"
        for identifier in changed:
            shutil.copytree(prefix / "sources" / identifier, staged / "sources" / identifier)
        staged.mkdir(exist_ok=True)
        support.atomic_text(staged / "mods.lock.json", json.dumps({
            "mod_api": lock["mod_api"], "applied": record.get("mods_bundle"),
            "packages": {identifier: lock["packages"][identifier] for identifier in changed}}, indent=2, sort_keys=True) + "\n")
        shutil.rmtree(prefix / "mods-previous", ignore_errors=True)
        staged.rename(prefix / "mods-previous")
    lock["packages"].update(changed)
    text = json.dumps(lock, indent=2, sort_keys=True) + "\n"
    identifiers = sorted(changed)
    support.atomic_text(marker, json.dumps({"lock": hashlib.sha256(text.encode()).hexdigest(), "ids": identifiers}))
    for identifier in changed:
        replace_tree(bundle / "sources" / identifier, prefix / "sources" / identifier)
    support.atomic_text(lock_path, text)
    record["management"]["files"]["runtime/mods.lock.json"] = support.digest(lock_path)
    installed = {}
    for identifier in identifiers:
        package = lock["packages"][identifier]
        record["sources"][identifier] = package["files"]
        if identifier in record["packages"]:
            installed[identifier] = record["packages"][identifier] = {
                "version": package["version"], "sha256": package["package_sha256"], "files": package["files"],
                "capabilities": package["capabilities"]}
    if applied:
        record["mods_bundle"] = applied
    else:
        record.pop("mods_bundle", None)
    write(prefix, record)
    store = Path(record["store"])
    index = json.loads((store / "package-index.json").read_text())
    managed = prefix.name == "prefix" and prefix.parent.parent.name == "releases"
    for identifier in set(identifiers) & index["packages"].keys():
        entry, package = index["packages"][identifier][0], lock["packages"][identifier]
        if entry["source"]["kind"] == "local":
            shelf = (shelve(prefix / "sources" / identifier, prefix.parents[2] / "catalog" / identifier / package["package_sha256"])
                     if managed else prefix / "sources" / identifier)
            index["packages"][identifier] = [entry | {"version": package["version"], "integrity": package["package_sha256"],
                                                      "source": {"kind": "local", "path": str(shelf)}}]
    support.atomic_text(store / "package-index.json", json.dumps(index, indent=2) + "\n")
    sync_sources(manager, store, prefix / "sources", installed)
    marker.unlink()
    return {"updated": sorted(installed)}


def rollback_mods(prefix, bin_dir):
    backup = prefix / "mods-previous"
    if not backup.is_dir():
        raise ValueError("no first-party mod update to roll back")
    result = apply_mods(prefix, bin_dir, backup, json.loads((backup / "mods.lock.json").read_text()).get("applied"), False)
    retired = prefix / ".mods-previous.new"
    backup.rename(retired)
    shutil.rmtree(retired)
    return result


def update_mods(prefix, bin_dir, bundle, serial):
    if (prefix / MODS_MARKER).is_file():
        rollback_mods(prefix, bin_dir)
    try:
        return apply_mods(prefix, bin_dir, bundle, {"serial": serial}, True)
    except BaseException:
        if (prefix / MODS_MARKER).is_file():
            rollback_mods(prefix, bin_dir)
        raise


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
        raise ValueError(f"this release requires a Codex {version.rsplit('.', 1)[0]}.x host")
    return result


def release_lock(upstream, patch, mods):
    record = json.loads((ROOT / "runtime/release.lock.json").read_text())
    if (record.get("schema") != SCHEMA or record.get("product") != PRODUCT
            or record.get("upstream_commit") != upstream["commit"]
            or record.get("runtime_patch_sha256") != patch["patch"]["sha256"]
            or record.get("mod_api") != mods["mod_api"]
            or record.get("node") != mods["node"]):
        raise ValueError("release lock disagrees with pinned runtime sources")
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
            "installed_by_omd": [],
            "note": "available for explicit installation; no plugin is configured by this installer"}


def load(prefix):
    record = json.loads((prefix / "install.json").read_text())
    if record.get("schema") != SCHEMA or record.get("product") != PRODUCT:
        raise ValueError("unrecognized OMD installation")
    if support.resolved(record["prefix"]) != prefix:
        raise ValueError("installation prefix changed")
    return record


def write(prefix, record):
    support.atomic_text(prefix / "install.json", json.dumps(record, indent=2, sort_keys=True) + "\n")


def omd_text(record, tool, control):
    update = record.get("update")
    routed = (f"case \"$1\" in update|uninstall) command=$1; shift; OMD_PYTHON={shlex.quote(update['python'])} exec sh "
              f"{shlex.quote(update['installer'])} \"$command\" --root {shlex.quote(update['root'])} \"$@\";; esac\n" if update
              else f"if [ \"$1\" = uninstall ]; then shift; exec {shlex.quote(str(control))} uninstall \"$@\"; fi\n")
    mini = f"if [ \"$1\" = mini ]; then shift; exec {shlex.quote(str(control))} mini -- \"$@\"; fi\n"
    return (f"#!/bin/sh\n{omd_help(record, tool)}{mini}{routed}export OMD_MOD_STORE={shlex.quote(record['store'])}\n"
            f"exec {shlex.quote(tool)} \"$@\"\n")


def omd_help(record, tool):
    rows = [("Mods", [("omd mods list", "Installed mods and whether each is on"),
                      ("omd mods catalog [QUERY]", "Search the mod directory"),
                      ("omd install MOD", "Install a mod: a name, npm:PACKAGE, git+URL or ./folder"),
                      ("omd mods enable MOD", "Turn on a mod you installed (disable turns it off)"),
                      ("omd mods remove MOD", "Uninstall a mod")])]
    if record.get("profile") == "full":
        rows.append(("Sessions", [("omd mini", "Start Codex in the minimal scrollback interface (omd_mini mod)")]))
    rows.append(("Oh My Diff", [*([("omd update", "Install the newest release"),
                                   ("omd update status", "Check the install and update settings"),
                                   ("omd update rollback", "Undo the last update")] if record.get("update") else []),
                                ("omd uninstall [--purge]", "Remove OMD; --purge removes its mod data and sign-ins too; Codex data stays"),
                                ("omd help --all", "Every command and flag")]))
    lines = ["", "${b}Oh My Diff${r}  Codex CLI, extended with mods", "",
             "Run ${b}codex${r} as usual, and type ${b}/mods${r} inside it to turn mods on or off."]
    for title, commands in rows:
        lines += ["", f"${{b}}{title}${{r}}", *(f"  {name:<26}${{d}}{text}${{r}}" for name, text in commands)]
    lines += ["", "${d}Docs: https://github.com/dzkchen/oh-my-diff${r}", ""]
    return (f"if [ \"$1\" = help ] && [ \"$2\" = --all ]; then exec {shlex.quote(tool)} --help; fi\n"
            "case \"$1\" in ''|help|-h|--help)\n"
            "  b= d= r=; if [ -t 1 ]; then b=$(printf '\\033[1m') d=$(printf '\\033[2m') r=$(printf '\\033[0m'); fi\n"
            "  cat <<EOF\n" + "\n".join(lines) + "\nEOF\n  exit 0;;\nesac\n")


def selected_text(record):
    binary = record["binary"]["installed_path"]
    store = record["store"]
    selection = record["activation"]["selection"]
    lines = ["#!/bin/sh"]
    update = record.get("update")
    if update:
        root, installer = shlex.quote(update["root"]), f"OMD_PYTHON={shlex.quote(update['python'])} sh {shlex.quote(update['installer'])}"
        request = shlex.quote(str(Path(store) / "data/user/omd_update/store.json"))
        marker = f"{root}/sessions/$$"
        ready = f'{{ [ -e {root}/update/ready.json ] && {{ [ -z "$busy" ] || [ ! -e {root}/update/announced ] || [ {root}/update/ready.json -nt {root}/update/announced ] || [ -n "$(find {root}/update/announced -mmin +60 2>/dev/null)" ]; }}; }}'
        lines += [f"mkdir -p {root}/sessions", "busy=", "unattended=", "skip=",
                  f'for a; do if [ -n "$skip" ]; then skip=; continue; fi; case "$a" in -V|--version|-h|--help|{"|".join(UNATTENDED_COMMANDS)}) unattended=1; break;; {"|".join(sorted(CODEX_VALUE_OPTIONS | {"-i", "--image"}))}) skip=1;; -*) ;; *) break;; esac; done',
                  f'for m in {root}/sessions/*; do [ -e "$m" ] && {{ kill -0 "${{m##*/}}" 2>/dev/null && busy=1 || rm -f "$m"; }}; done',
                  f": > {marker}",
                  f'if [ -z "$OH_MY_DIFF_UPDATED" ] && {{ [ -e {root}/update/journal.json ] || {{ [ -z "$unattended" ] && {{ {ready} || {{ [ -e {root}/update/state.json ] && {{ [ ! -e {root}/update/notice.json ] || [ {root}/update/state.json -nt {root}/update/notice.json ]; }}; }} || {{ [ -e {request} ] && {{ [ ! -e {root}/update/seen ] || [ {request} -nt {root}/update/seen ]; }} && grep -q \'"request":\' {request}; }}; }}; }}; }}; then',
                  f'  {installer} launch --root {root} --session $$ ${{unattended:+--unattended}}',
                  f'  OH_MY_DIFF_UPDATED=1 exec {root}/current/bin/codex "$@"',
                  "fi",
                  "unset OH_MY_DIFF_UPDATED",
                  f"[ {root}/update/next -nt {marker} ] || ({installer} tick --root {root} </dev/null >/dev/null 2>&1 &)",
                  f"OH_MY_DIFF_UPDATE=; [ -f {root}/update/notice.json ] && read -r OH_MY_DIFF_UPDATE < {root}/update/notice.json; export OH_MY_DIFF_UPDATE"]
    lines.append("unset OMD_INSTALL_PROFILE OMD_MOD_STORE")
    lines.append(f"export OMD_INSTALL_PROFILE={'platform_only' if record['profile'] == 'platform' else 'full'}")
    if selection == "direct":
        lines.append("export OMD_MODE=upstream_direct")
    else:
        lines.extend(["export OMD_MODE=omd", f"export OMD_MOD_STORE={shlex.quote(store)}"])
    flags = ["-c", "features.daemon_auto_start=false"]
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
    result = subprocess.run([tool, action, *arguments], stdin=subprocess.DEVNULL, capture_output=True, text=True)
    if result.returncode:
        raise ValueError((result.stderr or result.stdout).strip() or f"omd-contract {action} failed")
    return json.loads(result.stdout)


def check(record, bin_dir):
    binary = Path(record["binary"]["installed_path"])
    manager = Path(record["manager"]["installed_path"])
    for path, expected in ((binary, record["binary"]["sha256"]),
                           (Path(record["code_mode_host"]["installed_path"]), record["code_mode_host"]["sha256"]),
                           (Path(record["broker"]["installed_path"]), record["broker"]["sha256"]),
                           (Path(record["runner"]["installed_path"]), record["runner"]["sha256"]),
                           (manager, record["manager"]["sha256"])):
        if not path.is_file() or support.digest(path) != expected:
            raise ValueError(f"managed artifact changed: {path}")
    for name, expected in launchers(record).items():
        if not ours(bin_dir / name, expected):
            raise ValueError(f"managed launcher is absent or modified: {name}")
    if support.digest(bin_dir / "codex") != hashlib.sha256(selected_text(record).encode()).hexdigest():
        raise ValueError("managed launcher differs from effective settings")
    for name, details in record.get("tools", {}).items():
        tool = Path(details["installed_path"])
        if not tool.is_file() or support.digest(tool) != details["sha256"]:
            raise ValueError(f"managed tool changed: {name}")
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
    for name, expected in record["management"]["files"].items():
        path = Path(record["prefix"]) / "management" / name
        if not path.is_file() or support.digest(path) != expected:
            raise ValueError(f"managed package control changed: {name}")
    return binary, manager


def launchers(record):
    return {"codex": record["activation"]["sha256"], "omd-mod-author": record["author"]["launcher_sha256"],
            "omd-package": record["management"]["launcher_sha256"],
            **{name: details["launcher_sha256"] for name, details in record.get("tools", {}).items()}}


def ours(path, expected):
    return not path.is_symlink() and path.is_file() and support.digest(path) == expected


def status(prefix, bin_dir):
    record = load(prefix)
    if support.resolved(record["bin_dir"]) != bin_dir:
        raise ValueError("launcher directory changed")
    _, manager = check(record, bin_dir)
    store = Path(record["store"])
    host = invoke(manager, "status", store)
    if host["api"] != record["mod_api"]:
        raise ValueError("mod store API no longer matches the installation")
    selection = invoke(manager, "selection-status", store)
    active = {item["id"]: item for item in host["mods"]}
    locked = support.mods_lock()["packages"]
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


def activation_summary(result):
    if result["activation"] == "direct":
        return f"Direct mode: codex runs without mods. `omd-package activate {result['profile']}` brings them back."
    active = sum(1 for package in result["packages"] if package["active"])
    return f"{result['profile_label']} is active with {active} of {len(result['packages'])} mods on."


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
        raise ValueError("only installed first-party mods can be selected here")
    _, manager = check(record, bin_dir)
    source = Path(record["store"]) / "sources" / identifier
    def selection():
        current = invoke(manager, "selection-status", record["store"])
        matches = [item for item in current["selections"] if item.get("path") == str(source)]
        if len(matches) != 1 or matches[0].get("id") != identifier or not isinstance(matches[0].get("selected"), bool):
            if any(item.get("id") == identifier for item in current["selections"]):
                raise ValueError(f"{identifier} is no longer your profile's copy; use omd mods {'enable' if enabled else 'disable'} {identifier}")
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


def route_setup(prefix, record, name, identifier, options):
    setup = Path(record["store"]) / "sources" / identifier / "setup.mjs"
    node = record["author"]["node"] or shutil.which("node")
    if not node:
        raise ValueError(f"{name} setup needs Node.js on PATH")
    stripping = subprocess.run([node, "-p", "process.features.typescript"], stdout=subprocess.PIPE, text=True)
    if stripping.stdout.strip() not in {"strip", "transform"}:
        raise ValueError(f"{name} setup needs Node.js 22.18 or later: {node}")
    result = subprocess.run([node, str(setup), "setup", str(prefix / "install.json"), json.dumps(options)], stdout=subprocess.PIPE, text=True)
    if result.returncode:
        raise ValueError(f"{name} setup failed")
    return json.loads(result.stdout)


def add_package(prefix, record, identifier):
    package = support.mods_lock()["packages"][identifier]
    manager = record["manager"]["installed_path"]
    target = Path(record["store"]) / "sources" / identifier
    shutil.rmtree(target, ignore_errors=True)
    shutil.copytree(prefix / "sources" / identifier, target)
    verify(manager, target, package["package_sha256"])
    invoke(manager, "trust-all", record["store"], json.dumps([{"path": str(target), "sha256": package["package_sha256"],
                                                              "capabilities": package["capabilities"]}]))
    record["packages"][identifier] = {"version": package["version"], "sha256": package["package_sha256"],
                                      "files": package["files"], "capabilities": package["capabilities"]}
    write(prefix, record)


def route(prefix, bin_dir, name, args):
    record = load(prefix)
    check(record, bin_dir)
    identifier = ROUTES[name]
    if record["profile"] != "full":
        raise ValueError(f"the {name} route is available only in OMD+")
    if args.setup:
        if identifier not in record["packages"]:
            add_package(prefix, record, identifier)
        details = route_setup(prefix, record, name, identifier, {
            "add": {key: getattr(args, key) for key in ("credential", "protocol", "url", "window", "paid", "reasoning", "cache_control", "text_only", "max_output")} | {"name": args.add, "model": args.upstream_model} if args.add else None,
            "remove": args.remove, "allowance": args.allowance})
        record.setdefault("providers", {})[identifier] = details.pop("provider")
        launcher = bin_dir / "codex"
        support.atomic_text(launcher, selected_text(record), 0o755)
        record["activation"]["sha256"] = support.digest(launcher)
        write(prefix, record)
        select_mod(prefix, bin_dir, identifier, True)
        return details
    provider = record.get("providers", {}).get(identifier)
    if not provider:
        raise ValueError(f"run `omd-package {name} --setup` first")
    if record["activation"]["selection"] == "direct":
        raise ValueError(f"activate OMD+ before using the {name} route")
    selections = invoke(record["manager"]["installed_path"], "selection-status", record["store"])["selections"]
    if not any(item.get("id") == identifier and item.get("effective") and not item.get("error") for item in selections):
        raise ValueError(f"the {name} route needs its mod enabled: {enable_hint(selections, identifier)}")
    host = Path(record["store"]) / "host.json"
    written = {route["model"] for route in (json.loads(host.read_text()).get("routes", []) if host.is_file() else [])
               if route.get("provider") == identifier and isinstance(route.get("data"), dict)}
    if written and written != {item["slug"] for item in json.loads(Path(provider["catalog"]).read_text())["models"]}:
        route_setup(prefix, record, name, identifier, {})
    models = json.loads(Path(provider["route"]).read_text())
    wanted = args.model or models["default"]
    model = next((item["slug"] for item in models["models"] if wanted in (item["slug"], item.get("family"))), None)
    if model is None:
        raise ValueError(f"unknown {name} model {wanted}; choose one of {', '.join(item['slug'] for item in models['models'])}")
    launcher = bin_dir / "codex"
    os.execv(launcher, [str(launcher), "-c", f"model_provider={json.dumps(identifier)}", "-c", f"model={json.dumps(model)}",
                        "-c", f"model_catalog_json={json.dumps(provider['catalog'])}",
                        *(["-c", 'web_search="disabled"'] if name == "profiles" else []), *args.codex])


def session_options(codex):
    kept, index = [], 0
    while index < len(codex) and codex[index] != "--":
        argument = codex[index]
        name = argument.split("=", 1)[0]
        if name in CODEX_FLAGS or (name in CODEX_VALUE_OPTIONS and "=" in argument) \
                or (argument[:2] in CODEX_VALUE_OPTIONS and len(argument) > 2 and argument[1] != "-"):
            kept.append(argument)
        elif name in CODEX_VALUE_OPTIONS and index + 1 < len(codex):
            kept += codex[index:index + 2]
            index += 1
        index += 1
    return kept


def enable_hint(selections, identifier):
    enable = f"omd mods enable {identifier}"
    return enable if any(item.get("id") == identifier for item in selections) else f"omd install {identifier}, then {enable}"


def mini(prefix, bin_dir, codex):
    record = load(prefix)
    check(record, bin_dir)
    if record["activation"]["selection"] == "direct":
        raise ValueError("activate OMD Core or OMD+ before using omd mini")
    selections = invoke(record["manager"]["installed_path"], "selection-status", record["store"])["selections"]
    if not any(item.get("id") == "omd_mini" and item.get("effective") and not item.get("error") for item in selections):
        raise ValueError(f"omd mini needs its mod enabled: {enable_hint(selections, 'omd_mini')}")
    if not (sys.stdin.isatty() and sys.stdout.isatty()):
        raise ValueError("omd mini needs a terminal; use `codex exec` for piped or scripted runs")
    launch, run, mode, options = os.urandom(8).hex(), 0, "mini", session_options(codex)
    for name in (signal.SIGINT, signal.SIGQUIT):
        signal.signal(name, signal.SIG_IGN)
    while True:
        env = {**os.environ, "OH_MY_DIFF_PRESENTATION": mode, "OH_MY_DIFF_LAUNCH": f"{launch}.{run}",
               **({"OMD_TUI_MOD_UI": "omd_mini", "OMD_TUI_HEADER": "off", "OMD_TUI_COMPOSER": "plain"} if mode == "mini" else {})}
        code = subprocess.run([bin_dir / "codex", *(["--no-alt-screen", "-c", "tui.show_tooltips=false"] if mode == "mini" else []), *codex], env=env,
                              preexec_fn=lambda: [signal.signal(name, signal.SIG_DFL) for name in (signal.SIGINT, signal.SIGQUIT)]).returncode
        exported = subprocess.run([record["tools"]["omd"]["installed_path"], "store", "export", "--mod", "omd_mini",
                                   "--store", record["store"], "--scope", "user"], capture_output=True, text=True)
        try:
            entry = json.loads(exported.stdout)["entries"].get(f"switch_{launch}") if exported.returncode == 0 else None
        except (ValueError, KeyError, AttributeError):
            entry = None
        request = entry.get("value") if isinstance(entry, dict) else None
        if not (isinstance(request, dict) and request.get("run") == run and request.get("target") in ("mini", "full")
                and isinstance(request.get("thread"), str) and re.fullmatch(r"[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}", request["thread"])):
            return code
        mode, codex, run = request["target"], [*options, "resume", request["thread"]], run + 1


def verify(manager, source, expected):
    if invoke(manager, "inspect", source)["sha256"] != expected:
        raise ValueError(f"package digest mismatch: {source.name}")


def shelve(source, destination):
    if not destination.is_dir():
        staged = destination.with_name(f".{destination.name}.new")
        shutil.rmtree(staged, ignore_errors=True)
        staged.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(source, staged, copy_function=link)
        staged.rename(destination)
    return destination


def install(args):
    prefix, bin_dir, store = paths(args.prefix, args.bin_dir, args.store)
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        raise ValueError("this installer supports Apple Silicon macOS")
    if prefix.exists() or any((bin_dir / name).exists() or (bin_dir / name).is_symlink() for name in LAUNCHERS):
        raise ValueError("managed prefix or launcher already exists")
    if store.exists() != args.attach_store:
        raise ValueError("use --attach-store for an existing mod store; omit it for a new store")
    upstream_lock = json.loads((ROOT / "upstream.lock.json").read_text())
    patch_lock = json.loads((ROOT / "runtime/patches/manifest.json").read_text())
    if support.digest(ROOT / patch_lock["patch"]["path"]) != patch_lock["patch"]["sha256"]:
        raise ValueError("active runtime patch hash mismatch")
    locked = support.mods_lock()
    if locked != mods_lock.build():
        raise ValueError("first-party mod lock differs from pinned sources")
    packages = locked["packages"]
    release = release_lock(upstream_lock, patch_lock, locked)
    binary = identity(args.binary)
    if binary["sha256"] != release["artifacts"]["codex"]["sha256"]:
        raise ValueError("Codex binary differs from the release lock")
    code_mode_host = Path(binary["path"]).parent / "codex-code-mode-host"
    if (not code_mode_host.is_file()
            or support.digest(code_mode_host) != release["artifacts"]["codex-code-mode-host"]["sha256"]):
        raise ValueError("code-mode host beside the Codex binary differs from the release lock")
    broker_helper = Path(binary["path"]).parent / "omd-broker"
    if (not broker_helper.is_file()
            or support.digest(broker_helper) != release["artifacts"]["omd-broker"]["sha256"]):
        raise ValueError("authority broker beside the Codex binary differs from the release lock")
    runner = Path(binary["path"]).parent / "omd-runner"
    if not runner.is_file() or support.digest(runner) != release["artifacts"]["omd-runner"]["sha256"]:
        raise ValueError("mod runner beside the Codex binary differs from the release lock")
    manager = support.resolved(args.manager)
    node = support.resolved(args.node) if args.node else None
    if not manager.is_file() or not os.access(manager, os.X_OK):
        raise ValueError("mod manager executable is unavailable")
    if support.digest(manager) != release["artifacts"]["omd-mod"]["sha256"]:
        raise ValueError("mod manager differs from the release lock")
    author_archive = support.resolved(args.author_archive)
    if (not author_archive.is_file()
            or support.digest(author_archive) != release["artifacts"]["mod-api.tgz"]["sha256"]):
        raise ValueError("mod author archive differs from the release lock")
    fallback = shutil.which("codex", path=support.path_without(bin_dir))
    if not fallback:
        raise ValueError("no upstream Codex fallback resolves on PATH")
    fallback_id = identity(fallback)
    previous = load(support.resolved(args.previous)) if args.previous else None
    attached = (store / "mods.json").read_bytes() if args.attach_store else None
    bin_dir.mkdir(parents=True, exist_ok=True)
    prefix.mkdir(parents=True)
    managed = prefix.name == "prefix" and prefix.parent.parent.name == "releases"
    objects = prefix.parents[2] / "objects" if managed else None
    made_store = False
    made_launchers = []
    try:
        artifacts = prefix / "artifacts"
        artifacts.mkdir()
        for source, name in ((Path(binary["path"]), "codex"), (code_mode_host, "codex-code-mode-host"),
                             (broker_helper, "omd-broker"), (runner, "omd-runner"), (manager, "omd-mod")):
            shutil.copy2(source, artifacts / name)
        for command in (["codex", "--version"], ["codex-code-mode-host", "--help"], ["omd-runner"]):
            subprocess.run([artifacts / command[0], *command[1:]], stdin=subprocess.DEVNULL, capture_output=True, timeout=60,
                           check=True)
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
            management_files[name] = place(ROOT / name, management_root / name, objects)
        installed_manager = artifacts / "omd-mod"
        if authority_broker.deployed():
            authority_broker.main(["pin", "--add", f"--manifest={signed_manifest(prefix)}", *(f"--pin={path}" for path in (
                artifacts / "codex", installed_manager,
                *(support.resolved(getattr(args, name.replace("-", "_"))) for name in HOST_TOOLS)))])
        if not args.attach_store:
            store.parent.mkdir(parents=True, exist_ok=True)
            invoke(installed_manager, "init", store)
            made_store = True
        else:
            invoke(installed_manager, "authorize-runner", store)
        host = invoke(installed_manager, "status", store)
        if host["api"] != locked["mod_api"]:
            raise ValueError("mod store API does not match the source lock")
        installed = {}
        plugin_bundle = None
        tools = {}
        for name in HOST_TOOLS:
            source = support.resolved(getattr(args, name.replace("-", "_")))
            if not source.is_file() or not os.access(source, os.X_OK):
                raise ValueError(f"host tool binary is unavailable: {name}")
            if support.digest(source) != release["artifacts"][name]["sha256"]:
                raise ValueError(f"host tool differs from the release lock: {name}")
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
                   if entry["extension_type"] == "mod" and entry["support_status"] in ("experimental", "reviewed_candidate", "supported")}
        catalog = {identifier: [{"version": entry["version"], "integrity": entry["published"]["sha256"],
                                 "source": {"kind": "repository", "repository": entry["published"]["repository"],
                                            "revision": entry["published"]["revision"], "subdirectory": entry["source"]},
                                 "description": entry["capability"], "support": entry["support_status"]}]
                   for identifier, entry in curated.items() if "published" in entry}
        routed = previous.get("providers", {}) if previous and previous["profile"] == args.profile else {}
        wanted = set(profile_packages(args.profile)) | {identifier for identifier in ROUTES.values() if identifier in routed}
        for identifier in PACKAGES:
            package = packages[identifier]
            for name in package["files"]:
                place(ROOT / package["source"] / name, prefix / "sources" / identifier / name, objects)
            if identifier in curated:
                shelf = (shelve(prefix / "sources" / identifier, prefix.parents[2] / "catalog" / identifier / package["package_sha256"])
                         if managed else prefix / "sources" / identifier)
                catalog[identifier] = [{"version": package["version"], "integrity": package["package_sha256"],
                                        "source": {"kind": "local", "path": str(shelf)},
                                        "description": curated[identifier]["capability"],
                                        "support": curated[identifier]["support_status"]}]
            if identifier not in wanted:
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
        support.atomic_text(store / "package-index.json", json.dumps({"schema": 1, "packages": catalog}, indent=2) + "\n")
        granted = {Path(item["path"]).resolve(): item.get("capabilities")
                   for item in invoke(installed_manager, "selection-status", store)["selections"]}
        revoked = [identifier for identifier in PLATFORM_PACKAGES
                   if not granted.get((sources / identifier).resolve())
                   and all(item["path"] != str(sources / identifier) for item in trusted)]
        for item in trusted:
            verify(installed_manager, Path(item["path"]), item["sha256"])
        if trusted:
            invoke(installed_manager, "trust-all", store, json.dumps(trusted))
        for target in enabled:
            invoke(installed_manager, "enable", store, target)
        sync_sources(installed_manager, store, prefix / "sources", installed)
        keep_bundled_copies(installed_manager, store)
        retired = retire_packages(installed_manager, store, args.profile, previous)
        refresh_kept_copies(installed_manager, store, prefix / "sources", packages, installed)
        if revoked:
            invoke(installed_manager, "trust-all", store, json.dumps([
                {"path": str(sources / identifier), "sha256": installed[identifier]["sha256"],
                 "capabilities": installed[identifier]["capabilities"]} for identifier in revoked]))
        for identifier in revoked:
            invoke(installed_manager, "enable", store, sources / identifier)
        for identifier in PLATFORM_PACKAGES:
            invoke(installed_manager, "require", store, sources / identifier)
        for identifier in installed:
            verify(installed_manager, sources / identifier, installed[identifier]["sha256"])
        home, sqlite = support.state_roots()
        record = {"schema": SCHEMA, "product": PRODUCT,
                  "installed_at": datetime.now(timezone.utc).isoformat(),
                  "prefix": str(prefix), "bin_dir": str(bin_dir), "store": str(store),
                  "profile": args.profile, "profile_label": PROFILE_LABELS[args.profile],
                  "version": release["version"], "mod_api": host["api"], "packages": installed,
                  "sources": {identifier: packages[identifier]["files"] for identifier in PACKAGES},
                  "plugin_bundle": plugin_bundle,
                  "binary": {**binary, "installed_path": str(artifacts / "codex"),
                             "sha256": support.digest(artifacts / "codex")},
                  "code_mode_host": {"installed_path": str(artifacts / "codex-code-mode-host"),
                                     "sha256": support.digest(artifacts / "codex-code-mode-host")},
                  "broker": {"installed_path": str(artifacts / "omd-broker"),
                             "sha256": support.digest(artifacts / "omd-broker")},
                  "runner": {"installed_path": str(artifacts / "omd-runner"),
                             "sha256": support.digest(artifacts / "omd-runner")},
                  "manager": {"installed_path": str(installed_manager),
                              "sha256": support.digest(installed_manager)},
                  "author": {"archive_sha256": support.digest(author_archive),
                             "node": str(node) if node else None, "files": author_files},
                  "management": {"files": management_files},
                  "tools": tools,
                  "upstream_fallback": fallback_id,
                  "upstream_commit": upstream_lock["commit"],
                  "runtime_patch_sha256": patch_lock["patch"]["sha256"],
                  "shared_state": {"codex_home": str(home), "codex_sqlite_home": str(sqlite),
                                   "policy": "inherited unchanged; never removed by uninstall"},
                  "activation": {"selection": args.profile}, "retired": sorted(retired)}
        if managed:
            record["update"] = {"root": str(prefix.parents[2]), "installer": str(management_root / "install.sh"),
                                "python": sys.executable}
        if previous and previous["profile"] == args.profile:
            record["activation"]["selection"] = previous["activation"]["selection"]
            providers = {key: value for key, value in previous.get("providers", {}).items() if key in ROUTES.values()}
            if providers:
                record["providers"] = providers
        launcher = bin_dir / "codex"
        support.atomic_text(launcher, selected_text(record), 0o755)
        made_launchers.append(launcher)
        record["activation"]["sha256"] = support.digest(launcher)
        author_launcher = bin_dir / "omd-mod-author"
        support.atomic_text(author_launcher,
                            f"#!/bin/sh\nexec {shlex.quote(str(node or 'node'))} {shlex.quote(str(author_cli))} \"$@\"\n",
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
                            f"exec \"$python\" -m scripts.profiles "
                            f"--prefix {shlex.quote(str(prefix))} --bin-dir {shlex.quote(str(bin_dir))} \"$@\"\n",
                            0o755)
        made_launchers.append(control_launcher)
        record["management"]["launcher_sha256"] = support.digest(control_launcher)
        for name, details in tools.items():
            tool_launcher = bin_dir / name
            launcher_text = (omd_text(record, details["installed_path"], control_launcher) if name == "omd"
                             else f"#!/bin/sh\nexec {shlex.quote(details['installed_path'])} \"$@\"\n")
            support.atomic_text(tool_launcher, launcher_text, 0o755)
            made_launchers.append(tool_launcher)
            details["launcher_sha256"] = support.digest(tool_launcher)
        write(prefix, record)
        result = status(prefix, bin_dir)
        failed = [(package["id"], package["error"]) for package in result["packages"] if package["error"]]
        if failed:
            raise ValueError(f"first-party mod failed to load during installation: {failed}")
        if managed:
            deduplicate(prefix.parents[2])
        return result
    except BaseException:
        for launcher in made_launchers:
            if launcher.is_file() and not launcher.is_symlink():
                launcher.unlink()
        shutil.rmtree(prefix, ignore_errors=True)
        if made_store:
            shutil.rmtree(store, ignore_errors=True)
        if attached is not None:
            (store / "mods.json").write_bytes(attached)
        raise


def register_plugins(prefix, bin_dir):
    record = load(prefix)
    binary, _ = check(record, bin_dir)
    bundle = record.get("plugin_bundle")
    if not bundle:
        raise ValueError("OMD Core stages no plugins; install --profile full first")
    root = Path(bundle["marketplace"])
    link = prefix.parents[2] / "current"
    source = link / prefix.name / root.relative_to(prefix) if support.resolved(link) == prefix.parent else root
    name = json.loads((root / ".agents/plugins/marketplace.json").read_text())["name"]
    home = Path(record["shared_state"]["codex_home"])
    config = home / "config.toml"
    env = {**os.environ, "CODEX_HOME": str(home)}

    def configured():
        entry = tomllib.loads(config.read_text()).get("marketplaces", {}).get(name) if config.is_file() else None
        return entry.get("source") if isinstance(entry, dict) else None

    if configured() != str(source):
        home.mkdir(mode=0o700, parents=True, exist_ok=True)
        if configured() is not None:
            support.run([binary, "plugin", "marketplace", "remove", name], env=env)
        support.run([binary, "plugin", "marketplace", "add", source], env=env)
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


def signed_manifest(prefix):
    manifest = Path(prefix).parent / "omd-release.json"
    if not manifest.is_file():
        raise ValueError(f"{Path(prefix).parent} was not installed from a signed release; "
                         "the authority broker pins only signed release binaries")
    return manifest


def broker(prefix, bin_dir, action, also=(), purge=False):
    if purge and action != "uninstall":
        raise ValueError("--purge is only valid with broker uninstall")
    record = load(prefix)
    _, manager = check(record, bin_dir)
    arguments = [action]
    if purge:
        arguments.append("--purge")
    if action in ("install", "pin"):
        prefixes = [prefix, *(support.resolved(other) for other in also)]
        pins = set().union(*(pinned_binaries(load(item)) for item in prefixes))
        arguments += [f"--pin={path}" for path in sorted(pins)]
        arguments += [f"--manifest={signed_manifest(item)}" for item in prefixes]
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


def purge_accounts(record):
    stores = [Path(record["store"])]
    if update := record.get("update"):
        root = support.resolved(update["root"])
        if support.resolved(record["prefix"]).parents[2] != root:
            raise ValueError("managed installation root changed")
        directory = root / "stores"
        stores = list(directory.iterdir()) if directory.is_dir() and not directory.is_symlink() else []
    accounts = []
    for store in stores:
        directory = store / "routes/claude/accounts"
        if not directory.is_dir() or directory.resolve() != directory:
            continue
        accounts.extend(path for path in sorted(directory.iterdir()) if path.is_dir() and not path.is_symlink()
                        and re.fullmatch(r"[a-z][a-z0-9_-]{0,23}", path.name) and path.name not in ("default", "api"))
    claude = shutil.which("claude") if accounts else None
    if accounts and not claude:
        raise ValueError("Claude CLI is required to sign out OMD's isolated accounts; install claude and retry --purge")
    env = {name: value for name, value in os.environ.items() if not name.startswith(("ANTHROPIC_", "CLAUDE_"))}
    for account in accounts:
        try:
            result = subprocess.run([claude, "auth", "logout"], env={**env, "CLAUDE_CONFIG_DIR": str(account)},
                                    capture_output=True, text=True, timeout=10)
        except (OSError, subprocess.TimeoutExpired) as error:
            raise ValueError(f"Could not sign out OMD Claude account {account.name}; its store is kept for retry") from error
        if result.returncode:
            raise ValueError(f"Could not sign out OMD Claude account {account.name}; its store is kept for retry")
    if CURSOR_DATA.is_symlink():
        CURSOR_DATA.unlink()
    elif CURSOR_DATA.exists():
        info = CURSOR_DATA.stat()
        if not CURSOR_DATA.is_dir() or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError(f"Cursor's OMD data directory is not private to this user: {CURSOR_DATA}")
        shutil.rmtree(CURSOR_DATA)
    return {"signed_out_claude_accounts": len(accounts)}


def uninstall(prefix, bin_dir, keep_broker=False, purge=False):
    journal = prefix / UNINSTALL_JOURNAL
    resuming = journal.is_file()
    record = json.loads(journal.read_text()) if resuming else load(prefix)
    if not resuming:
        check(record, bin_dir)
    purge = purge or record.get("purge_mod_store", False)
    if authority_broker.deployed() and not keep_broker:
        raise ValueError(f"the authority broker is deployed; run omd-package broker uninstall{' --purge' if purge else ''} first")
    policies = [path for path in (authority_broker.POLICY, authority_broker.POLICY.with_name("policy.json.previous"))
                if path.exists() or path.is_symlink()]
    if purge and policies:
        raise ValueError("administrator policy files remain; run omd-package broker uninstall --purge first: "
                         + ", ".join(map(str, policies)))
    if purge:
        if keep_broker:
            raise ValueError("--purge cannot keep a broker that may still hold OMD sign-ins; remove the broker first")
        if record.get("update"):
            raise ValueError("use omd uninstall --purge to remove all managed installations and their stores")
        _, _, store = paths(prefix, bin_dir, record["store"])
        shared = [support.resolved(record["shared_state"][key]) for key in ("codex_home", "codex_sqlite_home")
                  if record["shared_state"].get(key)]
        if any(support.within(store, state) or support.within(state, store) for state in shared):
            raise ValueError("mod store must be separate from shared Codex state")
        record = {**record, "purge_mod_store": True}
    managed = {prefix / "install.json", journal, Path(record["binary"]["installed_path"]),
               Path(record["code_mode_host"]["installed_path"]), Path(record["broker"]["installed_path"]),
               Path(record["runner"]["installed_path"]),
               Path(record["manager"]["installed_path"])}
    managed.update(Path(details["installed_path"]) for details in record.get("tools", {}).values())
    managed.update(prefix / name for name in record["author"]["files"])
    managed.update(prefix / "management" / name for name in record["management"]["files"])
    managed.update(prefix / "sources" / identifier / name
                   for identifier, files in record["sources"].items() for name in files)
    managed.update(path for root in (prefix / "mods-previous", prefix / ".mods-previous.new", *(prefix / "sources").glob(".*"))
                   for path in root.rglob("*") if path.is_file())
    managed.update(path for path in (prefix / MODS_MARKER,) if path.is_file())
    bundle = record.get("plugin_bundle")
    if bundle:
        root = Path(bundle["marketplace"])
        managed.add(root / ".agents/plugins/marketplace.json")
        managed.update(root / name for name in bundle["files"])
    actual = {path for path in prefix.rglob("*") if path.is_file() or path.is_symlink()}
    if not (actual <= managed if resuming else actual == managed - {journal}):
        raise ValueError("installation prefix contains unmanaged files; move them before uninstall")
    if resuming:
        return removed(prefix, bin_dir, record)
    found = shutil.which("codex", path=support.path_without(bin_dir))
    if not found:
        raise ValueError("no upstream codex remains on PATH; refusing to remove the launcher")
    support.binary_identity(found)
    if purge:
        purge_accounts(record)
    plugins = remove_plugins(record, prefix)
    record = {**record, "upstream": str(support.resolved(found))}
    support.atomic_text(journal, json.dumps(record))
    return removed(prefix, bin_dir, record) | ({"removed_plugins": plugins} if plugins else {})


def remove_plugins(record, prefix):
    home = Path(record["shared_state"]["codex_home"])
    config = home / "config.toml"
    env = {**os.environ, "CODEX_HOME": str(home)}

    def ours():
        settings = tomllib.loads(config.read_text()) if config.is_file() else {}
        names = [name for name, details in settings.get("marketplaces", {}).items()
                 if isinstance(details, dict) and isinstance(details.get("source"), str)
                 and support.within(support.resolved(details["source"]), prefix)]
        return names, [plugin for plugin in settings.get("plugins", {}) if plugin.rsplit("@", 1)[-1] in names]

    names, plugins = ours()
    for plugin in plugins:
        support.run([record["binary"]["installed_path"], "plugin", "remove", plugin], env=env)
    for name in names:
        support.run([record["binary"]["installed_path"], "plugin", "marketplace", "remove", name], env=env)
    if any(ours()):
        raise ValueError("Codex still lists OMD plugins from this installation; remove them with codex plugin remove")
    return plugins


def removed(prefix, bin_dir, record):
    journal = prefix / UNINSTALL_JOURNAL
    for name, expected in launchers(record).items():
        if ours(bin_dir / name, expected):
            (bin_dir / name).unlink()
    if record.get("purge_mod_store"):
        store = Path(record["store"])
        if store.is_symlink():
            store.unlink()
        elif store.exists():
            shutil.rmtree(store)
    for path in prefix.iterdir():
        if path.is_dir() and not path.is_symlink():
            shutil.rmtree(path)
        elif path != journal:
            path.unlink()
    journal.unlink()
    prefix.rmdir()
    return {"uninstalled": True, "purged_mod_store" if record.get("purge_mod_store") else "preserved_mod_store": record["store"],
            "shared_state": record["shared_state"], "upstream": record["upstream"],
            "preserved_administrator_policy": [str(path) for path in
                (authority_broker.POLICY, authority_broker.POLICY.with_name("policy.json.previous")) if path.exists() or path.is_symlink()],
            **({} if record.get("purge_mod_store") else {"purge_option": "omd uninstall --purge removes OMD mod data and saved sign-ins too"})}


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
    install_parser.add_argument("--node", type=Path, help="Node.js for omd-mod-author and route setup (default: node on PATH)")
    install_parser.add_argument("--store", type=Path, required=True)
    install_parser.add_argument("--attach-store", action="store_true")
    install_parser.add_argument("--previous", type=Path, help="prefix of the installation this one replaces")
    commands.add_parser("reconcile", help="restore this installation's first-party mod sources in its store (used by install.sh)")
    commands.add_parser("purge-accounts", help="sign out isolated accounts before uninstall (used by install.sh)")
    mods_parser = commands.add_parser("mods-update", help="apply a verified first-party mod bundle (used by install.sh)")
    mods_parser.add_argument("--bundle", type=Path, required=True)
    mods_parser.add_argument("--serial", type=int, required=True)
    commands.add_parser("mods-rollback", help="undo the last first-party mod bundle (used by install.sh)")
    status_parser = commands.add_parser("status", help="show the installed profile and its mods")
    status_parser.add_argument("--json", action="store_true", help="print the full status as JSON")
    activate_parser = commands.add_parser("activate", help="switch between OMD Core, OMD+ and upstream-style direct mode")
    activate_parser.add_argument("selection", choices=("platform", "full", "direct"),
                                 help="platform: OMD Core; full: OMD+; direct: upstream-style behavior")
    activate_parser.add_argument("--json", action="store_true", help="print the full status as JSON")
    mod_parser = commands.add_parser("mod", help="enable or disable one profile mod")
    mod_parser.add_argument("action", choices=("enable", "disable"))
    mod_parser.add_argument("identifier", choices=PACKAGES)
    mod_parser.add_argument("--json", action="store_true", help="print the full status as JSON")
    for name in ROUTES:
        route_parser = commands.add_parser(name, help=f"set up or launch the opt-in {name} route")
        route_parser.add_argument("--setup", action="store_true")
        route_parser.add_argument("--model", help="model slug or family shortcut")
        for flag in ("add", "remove", "credential", "protocol", "url", "upstream-model", "window", "max-output", "paid", "allowance"):
            route_parser.add_argument(f"--{flag}")
        route_parser.add_argument("--reasoning", action="store_true")
        route_parser.add_argument("--cache-control", action="store_true")
        route_parser.add_argument("--text-only", action="store_true")
        route_parser.add_argument("codex", nargs=argparse.REMAINDER, help="arguments passed to codex")
    mini_parser = commands.add_parser("mini", help="launch the scrollback-first mini interface (omd mini)")
    mini_parser.add_argument("codex", nargs=argparse.REMAINDER, help="arguments passed to codex")
    contract_parser = commands.add_parser("contract", help="list, show or select the workflow contract for this repository")
    contract_parser.add_argument("action", choices=("list", "status", "plan", "select", "clear"))
    contract_parser.add_argument("contract", nargs="?", help="ID@VERSION for plan and select")
    commands.add_parser("plugins", help="add the OMD+ plugin marketplace to Codex at a path that survives updates")
    broker_parser = commands.add_parser("broker", help="deploy or manage the OS-separated authority broker (sudo)")
    broker_parser.add_argument("action", choices=("install", "pin", "status", "reset", "uninstall"))
    broker_parser.add_argument("--also", type=Path, action="append", default=[],
                               help="also pin the binaries of another installation prefix")
    broker_parser.add_argument("--purge", action="store_true", help="with broker uninstall, also remove the administrator policy and its backup")
    policy_parser = commands.add_parser("policy", help="install, roll back, remove or explain the administrator policy file (sudo)")
    policy_parser.add_argument("action", choices=("install", "rollback", "remove", "explain"))
    policy_parser.add_argument("file", type=Path, nargs="?")
    uninstall_parser = commands.add_parser("uninstall", help="remove this installation and its launchers")
    uninstall_parser.add_argument("--keep-broker", action="store_true",
                                  help="remove this installation while another one keeps using the authority broker")
    uninstall_parser.add_argument("--purge", action="store_true", help="also remove this installation's mod data and saved sign-ins; Codex data stays")
    args = parser.parse_args()
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
    elif args.command == "purge-accounts":
        record = load(prefix)
        check(record, bin_dir)
        result = purge_accounts(record)
    elif args.command == "mods-update":
        result = update_mods(prefix, bin_dir, args.bundle.resolve(), args.serial)
    elif args.command == "mods-rollback":
        result = rollback_mods(prefix, bin_dir)
    elif args.command == "activate":
        result = activate(prefix, bin_dir, args.selection)
        if not args.json:
            print(activation_summary(result))
            return
    elif args.command == "mod":
        result = select_mod(prefix, bin_dir, args.identifier, args.action == "enable")
        if not args.json:
            print(f"{args.identifier} is {args.action}d.")
            return
    elif args.command in ROUTES:
        result = route(prefix, bin_dir, args.command, args)
    elif args.command == "mini":
        raise SystemExit(mini(prefix, bin_dir, args.codex[1:] if args.codex[:1] == ["--"] else args.codex))
    elif args.command == "contract":
        result = contract(prefix, args.action, args.contract)
    elif args.command == "plugins":
        result = register_plugins(prefix, bin_dir)
    elif args.command == "broker":
        result = broker(prefix, bin_dir, args.action, args.also, args.purge)
    elif args.command == "policy":
        result = administrator_policy(prefix, bin_dir, args.action, args.file)
    else:
        result = uninstall(prefix, bin_dir, args.keep_broker, args.purge)
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, ValueError) as error:
        raise SystemExit(str(error)) from error
