#!/usr/bin/env python3
import argparse
import functools
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCES = [ROOT / "mods/first-party", ROOT / "mods/optional", ROOT / "mods/examples"]
TUI_OPERATIONS = {
    "exec.run", "exec.output_page", "workspace.read", "workspace.list", "workspace.stat",
    "workspace.check_access", "workspace.transaction", "workspace.backup", "workspace.restore",
    "store.get", "store.put", "store.delete", "store.list", "store.export", "store.reset",
    "app.request", "credentials.request", "terminal.notify", "terminal.show_thread", "commands.list",
    "commands.describe", "commands.invoke", "config.describe", "config.set", "environment.read",
    "sessions.ports", "terminal.import_file", "terminal.image_sample", "composer.read", "composer.write",
    "builtins.invoke", "packages.apply", "contract.select", "terminal.open", "terminal.prompt", "terminal.pane", "terminal.panes",
    "terminal.notice", "terminal.blit", "terminal.pty",
    "app.routes", "turns.activity", "events.publish", "credentials.list", "settings.write",
    "packages.list", "packages.preview", "packages.reload",
}
MOCKS = {
    "store.get": None, "store.put": {"stored": True}, "store.delete": {"deleted": True},
    "store.list": {"keys": []}, "exec.run": {"exit_code": 0, "stdout": "", "stderr": ""},
    "workspace.read": {"text": ""}, "workspace.list": {"entries": []},
    "workspace.stat": {"exists": False}, "workspace.check_access": {"allowed": True},
}
BUILTIN_SLASH = {
    "model", "ide", "permissions", "keymap", "vim", "setup-default-sandbox", "experimental", "approve",
    "memories", "skills", "import", "hooks", "review", "rename", "new", "archive", "delete", "resume",
    "fork", "worktree", "app", "init", "compact", "recap", "plan", "voice", "goal", "agents", "side",
    "btw", "copy", "export", "raw", "tui", "diff", "mention", "status", "daemon", "warnings", "cd",
    "pwd", "cwd", "usage", "debug-config", "title", "statusline", "theme", "pets", "pet", "mcp", "apps",
    "plugins", "logout", "quit", "exit", "feedback", "rollout", "ps", "stop", "clean", "clear",
    "test-approval", "subagents", "debug-m-drop", "debug-m-update", "omd",
}
EVENTS = dict(re.findall(r'\("([a-z_]+)", "([a-z_.]+)"\)', re.search(
    r"pub const MOD_EVENTS:[\s\S]*?= &\[([\s\S]*?)\];", (ROOT / "runtime/omd/src/mods.rs").read_text()).group(1)))
INTERCEPTS = dict(re.findall(r'\("([a-z_]+)", "([a-z_.]+)"\)', re.search(
    r"pub const MOD_INTERCEPT_SURFACES:[\s\S]*?= &\[([\s\S]*?)\];", (ROOT / "runtime/omd/src/mods.rs").read_text()).group(1)))
REGISTRATIONS = {"tool": "tools", "command": "commands", "middleware": "middleware", "provide": "services", "contract": "contracts"}
NATIVE_KEY = re.compile(r"""['"`](alt\+[bdfrvx]|ctrl\+shift\+f|f8)['"`]""", re.IGNORECASE)


def manifest(path):
    return json.loads((path / "mod.json").read_text())


def packages(names):
    found = [path for source in SOURCES for path in sorted(source.iterdir()) if (path / "mod.json").is_file()]
    return [path for path in found if not names or path.name in names or manifest(path)["id"] in names]


class Host:
    def __init__(self, omd_mod, node, work):
        self.omd_mod, self.node, self.work = omd_mod, node, work
        self.repo = work / "repo"
        self.repo.mkdir()
        (self.repo / "src").mkdir()
        (self.repo / "src/app.ts").write_text("export const a = 1;\n")
        for args in (["init", "-q", "--initial-branch=main"], ["add", "."],
                     ["-c", "user.name=omd", "-c", "user.email=omd@example.invalid", "commit", "-qm", "initial"]):
            subprocess.run(["git", *args], cwd=self.repo, check=True, capture_output=True)
        self.env = {key: value for key, value in os.environ.items() if not key.startswith(("OMD_", "CODEX_"))}
        self.env["HOME"] = str(work / "home")
        (work / "home").mkdir()

    def run(self, *args, check=True, timeout=120):
        try:
            result = subprocess.run([self.omd_mod, *map(str, args)], cwd=self.repo, env=self.env,
                                    capture_output=True, text=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            return None, "timeout"
        if result.returncode:
            if check:
                raise RuntimeError(f"omd-mod {' '.join(map(str, args[:2]))}: {result.stderr.strip()[-400:]}")
            return None, result.stderr.strip()[:400]
        return json.loads(result.stdout) if result.stdout.strip() else None, None

    def store(self, name, paths, providers):
        location = self.work / name
        self.run("init", location, self.node)
        refused = {}
        pending = list(paths)
        for path in pending:
            needed = [providers.get(service["name"]) for service in manifest(path).get("services", {}).get("imports", [])]
            needed += [providers.get(mod) for mod in manifest(path).get("requires", [])]
            pending += [provider for provider in needed if provider and provider not in pending]
        for _ in range(len(pending) + 1):
            if not pending:
                break
            retry = []
            for path in pending:
                inspected, error = self.run("inspect", path, check=False)
                if error:
                    refused[path.name] = f"inspect: {error}"
                    continue
                capabilities = ",".join(inspected["manifest"]["capabilities"])
                secrets = [arg for name in inspected["manifest"].get("exec_environment", [])
                           for arg in ("--allow-secret-env", name)]
                _, error = self.run("trust", location, path, inspected["sha256"], capabilities, *secrets, check=False)
                if not error:
                    _, error = self.run("enable", location, path, check=False)
                if error and "service_provider_missing" in error:
                    retry.append(path)
                elif error:
                    refused[path.name] = error
                else:
                    refused.pop(path.name, None)
            if len(retry) == len(pending):
                refused.update({path.name: "service_provider_missing" for path in retry})
                break
            pending = retry
        return location, refused

    def status(self, location):
        status, error = self.run("status", location, check=False)
        return status or {"mods": [], "terminal": {"diagnostics": [f"status: {error}"]}}

    def offline_command(self, location, mod, name):
        scenario = self.work / "scenario.json"
        scenario.write_text(json.dumps({
            "schema": 1, "host_operations": {operation: [{"result": reply}] * 32 for operation, reply in MOCKS.items()},
            "steps": [{"type": "invoke", "mod": mod, "event": "command", "name": name, "payload": ""}]}))
        output, error = self.run("test", location, scenario, check=False, timeout=60)
        steps = json.dumps(output["steps"]) if output else error or ""
        return set(re.findall(r"offline_unmocked_host_operation: ([\w.]+)", steps))

    def scenario(self, path, providers):
        file = path / "mod.test.json"
        scenario = json.loads(file.read_text())
        extra = [(path / package).resolve() for package in scenario.get("packages", [])]
        location, refused = self.store(f"scenario-{path.parent.name}-{path.name}", [*extra, path], providers)
        found = [f"scenario {name}: {reason}" for name, reason in refused.items()]
        for mod, settings in scenario.get("settings", {}).items():
            target = next((item for item in [*extra, path] if manifest(item)["id"] == mod), providers.get(mod))
            _, error = self.run("settings", location, target, json.dumps(settings), check=False)
            if error:
                found.append(f"scenario settings {mod}: {error}")
        output, error = self.run("test", location, file, check=False, timeout=300)
        if error:
            return found + [f"scenario: {error}"]
        return found + [f"scenario step {index}: {json.dumps(step['error'])[:300]}"
                        for index, step in enumerate(output["steps"]) if "error" in step]


@functools.cache
def registered(path):
    source = "\n".join(file.read_text() for file in path.rglob("*.ts") if "node_modules" not in file.parts)
    found = {EVENTS[name] for name in re.findall(r"api\.(?:on|replace)\(\s*'([a-z_]+)'", source) if name in EVENTS}
    found |= {INTERCEPTS[name] for name in re.findall(r"api\.intercept\(\s*'([a-z_]+)'", source) if name in INTERCEPTS}
    return found | {capability for call, capability in REGISTRATIONS.items() if f"api.{call}(" in source}


def problems_from_status(status, label, paths):
    found = []
    for item in status.get("mods", []):
        if item.get("error"):
            found.append(f"{item['id']}: {item['error']}")
        unused = [grant for grant in item.get("unused_grants") or [] if item["id"] not in paths or grant not in registered(paths[item["id"]])]
        if unused:
            found.append(f"{item['id']}: unused capabilities {', '.join(unused)}")
    for item in status.get("rejected") or []:
        found.append(f"{item.get('id') or item.get('path')}: rejected {item.get('reason')}")
    for diagnostic in status.get("terminal", {}).get("diagnostics", []):
        found.append(f"{label} view {diagnostic}")
    return found


def static_problems(path):
    found = []
    schema = manifest(path).get("settings_schema", {}).get("properties", {})
    found += [f"setting {key} has no default" for key, value in schema.items() if "default" not in value]
    for source in path.rglob("*.ts"):
        if "node_modules" in source.parts or source.name.endswith(".d.ts"):
            continue
        found += [f"{source.name}: key {key} belongs to the native keymap"
                  for key in sorted(set(NATIVE_KEY.findall(source.read_text())))]
    return found


def collisions(status, ids):
    owners = {}
    for item in status.get("mods", []):
        if item["id"] in ids:
            for command in item.get("registrations", {}).get("commands", []):
                owners.setdefault(command["name"], []).append(item["id"])
    found = [f"{','.join(mods)}: /{name} conflicts with a built-in command"
             for name, mods in owners.items() if name in BUILTIN_SLASH]
    found += [f"{','.join(mods)}: /{name} is defined by more than one mod"
              for name, mods in owners.items() if len(mods) > 1]
    return found


def check(host, paths, providers, commands, scenarios):
    report = {}
    ids = {manifest(path)["id"]: path for path in packages([])}
    first_party = [path for path in paths if path.parent.name in ("first-party", "optional")]
    if first_party:
        location, refused = host.store("all", first_party, providers)
        status = host.status(location)
        report["first-party together"] = [f"{name}: {reason}" for name, reason in refused.items()]
        report["first-party together"] += problems_from_status(status, "default", ids)
        report["first-party together"] += collisions(status, {manifest(path)["id"] for path in first_party})
    for path in paths:
        mod = manifest(path)["id"]
        location, refused = host.store(f"store-{path.parent.name}-{path.name}", [path], providers)
        found = static_problems(path) + [f"{name}: {reason}" for name, reason in refused.items()]
        status = host.status(location)
        found += problems_from_status(status, "default", ids)
        item = next((item for item in status.get("mods", []) if item["id"] == mod), None)
        names = [command["name"] for command in (item or {}).get("registrations", {}).get("commands", [])]
        for name in names if commands else []:
            refused_operations = host.offline_command(location, mod, name) - TUI_OPERATIONS
            found += [f"/{mod}:{name} calls {operation}, which slash commands cannot use"
                      for operation in sorted(refused_operations)]
            _, error = host.run("command", location, mod, name, '""', check=False, timeout=60)
            if error and ("Error" in error or error == "timeout") and not any(
                    reason in error for reason in ("host_operation_unavailable", "client_surface_unavailable")):
                found.append(f"/{mod}:{name} threw {error.removeprefix('Error: ').splitlines()[0][:200]}")
            found += problems_from_status(host.status(location), f"after /{mod}:{name}", ids)
        if scenarios and (path / "mod.test.json").is_file():
            found += host.scenario(path, providers)
        report[f"{path.parent.name}/{path.name}"] = sorted(set(found))
    return {name: found for name, found in report.items() if found}


def main():
    parser = argparse.ArgumentParser(description="Load every first-party package and example through the real host and report what it refuses.")
    parser.add_argument("--omd-mod", default=shutil.which("omd-mod"), help="omd-mod binary built from the applied runtime patch")
    parser.add_argument("--node", default=None, help="Node 24 executable (default: mise which node)")
    parser.add_argument("--no-commands", action="store_true", help="skip running each registered command")
    parser.add_argument("--scenarios", action="store_true", help="also run each package's offline mod.test.json scenario")
    parser.add_argument("--json", action="store_true", help="print the full report as JSON")
    parser.add_argument("packages", nargs="*", help="limit to these package directory names or mod IDs")
    args = parser.parse_args()
    if not args.omd_mod:
        parser.error("omd-mod not found; pass --omd-mod")
    node = args.node or subprocess.run(["mise", "which", "node"], cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip()
    every = packages([])
    providers = {manifest(path)["id"]: path for path in every}
    providers |= {service["name"]: path for path in every
                  for service in manifest(path).get("services", {}).get("exports", [])}
    with tempfile.TemporaryDirectory(prefix="omd-host-check-") as work:
        report = check(Host(Path(args.omd_mod).resolve(), node, Path(work)), packages(args.packages), providers, not args.no_commands, args.scenarios)
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        for name, found in report.items():
            print(name)
            print("".join(f"  {line}\n" for line in found), end="")
        print(f"{len(report)} package groups with problems" if report else "every package loads cleanly on the real host")
    return 1 if report else 0


if __name__ == "__main__":
    sys.exit(main())
