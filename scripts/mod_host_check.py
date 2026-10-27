#!/usr/bin/env python3
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCES = [ROOT / "mods/first-party", ROOT / "mods/examples", ROOT / "mods/ports"]
TUI_SURFACE = json.loads((ROOT / "mods/conformance/tui-surface.json").read_text())
TUI_OPERATIONS = set(TUI_SURFACE["operations"])
BUILTIN_SLASH = set(TUI_SURFACE["slash_commands"])
MOCKS = {
    "store.get": None, "store.put": {"revision": 1}, "store.delete": {"deleted": True},
    "store.list": {"keys": [], "cursor": None, "generation": 0},
    "exec.run": {"exit_code": 0, "signal": None, "stdout": "", "stderr": "",
                 "stdout_sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
                 "stdout_bytes": 0, "output_artifact": None, "stdout_truncated": False,
                 "stdout_preview_truncated": False, "stderr_truncated": False,
                 "stderr_preview_truncated": False, "timed_out": False, "duration_ms": 0,
                 "program": {"path": "/bin/sh", "sha256": "0" * 64}, "guards_verified": 0},
    "workspace.read": {"files": {}}, "workspace.list": {"entries": [], "truncated": False},
    "workspace.stat": {"files": {}}, "workspace.check_access": {"paths": [], "write": False},
}
EVENTS = dict(re.findall(r'\("([a-z_]+)", "([a-z_.]+)"\)', re.search(
    r"pub const MOD_EVENTS:[\s\S]*?= &\[([\s\S]*?)\];", (ROOT / "runtime/omd/src/mods.rs").read_text()).group(1)))
INTERCEPTS = dict(re.findall(r'\("([a-z_]+)", "([a-z_.]+)"\)', re.search(
    r"pub const MOD_INTERCEPT_SURFACES:[\s\S]*?= &\[([\s\S]*?)\];", (ROOT / "runtime/omd/src/mods.rs").read_text()).group(1)))
SOURCE_REPORTS = {}
NODE = None


def manifest(path):
    return json.loads((path / "mod.json").read_text())


def packages(names):
    found = [path for source in SOURCES for path in sorted(source.iterdir()) if (path / "mod.json").is_file()]
    return [path for path in found if not names or path.name in names or manifest(path)["id"] in names]


class Host:
    def __init__(self, omd_mod, work):
        self.omd_mod, self.work = omd_mod, work
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
        self.run("init", location)
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
            "schema": 1, "host_operations": {operation: [{"result": reply, "optional": True}] * 32 for operation, reply in MOCKS.items()},
            "steps": [{"type": "invoke", "mod": mod, "event": "command", "name": name, "payload": "", "thread_id": "host-check"}]}))
        output, error = self.run("test", location, scenario, check=False, timeout=60)
        steps = output.get("steps") if isinstance(output, dict) else None
        if error:
            failures = [error]
        elif not isinstance(steps, list) or len(steps) != 1 or not isinstance(steps[0], dict):
            failures = ["missing offline scenario result"]
        else:
            failures = [json.dumps(step["error"]) for step in steps if "error" in step]
        refused = set()
        unexpected = []
        for failure in failures:
            operations = re.findall(r"offline_unmocked_host_operation: ([\w.]+)", failure)
            refused.update(operations)
            if not operations:
                unexpected.append(failure[:400])
        return refused, unexpected

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
                        for index, step in enumerate(output["steps"]) if "error" in step and "expect_error" not in scenario["steps"][index]]


def registered(item, path=None):
    registrations = item.get("registrations", {})
    found = {EVENTS[name] for kind in ("events", "replacements")
             for name in registrations.get(kind, []) if name in EVENTS}
    interceptors = list(registrations.get("interceptors", []))
    if path is not None:
        if any(str(source.resolve()) not in SOURCE_REPORTS for source in source_files(path)):
            inspect_sources([path])
        for source in source_files(path):
            for call in SOURCE_REPORTS[str(source.resolve())]["registrations"]:
                if call["method"] in ("on", "replace"):
                    found.update(EVENTS[name] for name in call["names"] if name in EVENTS)
                elif call["method"] == "intercept":
                    interceptors.extend({"pattern": name} for name in call["names"])
                else:
                    capability = {"tool": "tools", "command": "commands", "middleware": "middleware",
                                  "provide": "services", "contract": "contracts"}.get(call["method"])
                    if capability:
                        found.add(capability)
    for entry in interceptors:
        pattern = entry.get("pattern", "")
        for surface, capability in INTERCEPTS.items():
            negated = pattern.startswith("!")
            selector = pattern[1:] if negated else pattern
            matches = bool(re.fullmatch(re.escape(selector).replace(r"\*", ".*"), surface))
            if pattern != "!*" and matches != negated and capability in item.get("capabilities", []):
                found.add(capability)
    if "tool_result" in registrations.get("events", []) and "middleware" in item.get("capabilities", []):
        found.add("middleware")
    return found | {kind for kind in ("tools", "commands", "services", "contracts") if registrations.get(kind)}


def source_files(path):
    return [source for source in sorted(path.rglob("*"))
            if source.suffix in (".ts", ".tsx") and not source.name.endswith(".d.ts")
            and "node_modules" not in source.parts]


def node():
    global NODE
    NODE = NODE or subprocess.run(["mise", "which", "node"], cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip()
    return NODE


def inspect_sources(paths):
    files = [str(source.resolve()) for path in paths for source in source_files(path)]
    if files:
        result = subprocess.run([node(), str(ROOT / "scripts/mod_source_check.mjs")], input=json.dumps(files),
                                cwd=ROOT, capture_output=True, text=True, check=True)
        SOURCE_REPORTS.update(json.loads(result.stdout))


def problems_from_status(status, label, paths):
    found = []
    for item in status.get("mods", []):
        if item.get("error"):
            found.append(f"{item['id']}: {item['error']}")
        registered_capabilities = registered(item, paths.get(item["id"]))
        unused = [grant for grant in item.get("unused_grants") or [] if grant not in registered_capabilities]
        if unused:
            found.append(f"{item['id']}: unused capabilities {', '.join(unused)}")
    for item in status.get("rejected") or []:
        found.append(f"{item.get('id') or item.get('path')}: rejected {item.get('reason')}")
    for diagnostic in status.get("terminal", {}).get("diagnostics", []):
        found.append(f"{label} view {diagnostic}")
    return found


def static_problems(path):
    found = []
    package = manifest(path)
    schema = package.get("settings_schema", {}).get("properties", {})
    found += [f"setting {key} has no default" for key, value in schema.items() if "default" not in value]
    needed = {"package_text_assets_v1"} if package.get("assets") else set()
    commands, tools = [], 0
    if any(str(source.resolve()) not in SOURCE_REPORTS for source in source_files(path)):
        inspect_sources([path])
    for source in source_files(path):
        text = source.read_text()
        report = SOURCE_REPORTS[str(source.resolve())]
        found += [f"{source.name}: {error}" for error in report["errors"]]
        found += [f"{source.name}: key {key} belongs to the native keymap" for key in sorted(set(report["keys"]))]
        if (size := len(text.encode())) > 524_288:
            found.append(f"{source.name}: {size} bytes exceeds the 524288-byte package file limit")
        commands += report["commands"]
        tools += report["tools"]
        if report["imports"]:
            needed.add("package_imports_v1")
        if report["component"]:
            needed.add("component_modules_v1")
    required = set(package.get("compatibility", {}).get("required_features", []))
    found += [f"assets, relative imports and api.component need required feature {feature}" for feature in sorted(needed - required)]
    if path.parent.name == "first-party":
        found += [f"/{name} conflicts with a built-in command" for name in sorted(set(commands) & BUILTIN_SLASH)]
    found += [f"{count} {kind} exceed the limit of 32" for kind, count in (("commands", len(commands)), ("tools", tools)) if count > 32]
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
    first_party = [path for path in paths if path.parent.name == "first-party"]
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
        names = [command["name"] for command in (item or {}).get("registrations", {}).get("commands", [])
                 if not command.get("cli")]
        for name in names if commands else []:
            refused_operations, probe_errors = host.offline_command(location, mod, name)
            found += [f"/{mod}:{name} calls {operation}, which slash commands cannot use"
                      for operation in sorted(refused_operations - TUI_OPERATIONS)]
            found += [f"/{mod}:{name} offline probe failed: {error}" for error in probe_errors]
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
    parser.add_argument("--no-commands", action="store_true", help="skip running each registered command")
    parser.add_argument("--scenarios", action="store_true", help="also run each package's offline mod.test.json scenario")
    parser.add_argument("--static", action="store_true", help="only the source checks; needs no omd-mod")
    parser.add_argument("packages", nargs="*", help="limit to these package directory names or mod IDs")
    args = parser.parse_args()
    inspect_sources(packages(args.packages))
    if args.static:
        report = {f"{path.parent.name}/{path.name}": found for path in packages(args.packages) if (found := static_problems(path))}
    else:
        if not args.omd_mod:
            parser.error("omd-mod not found; pass --omd-mod")
        every = packages([])
        providers = {manifest(path)["id"]: path for path in every}
        providers |= {service["name"]: path for path in every
                      for service in manifest(path).get("services", {}).get("exports", [])}
        with tempfile.TemporaryDirectory(prefix="omd-host-check-") as work:
            report = check(Host(Path(args.omd_mod).resolve(), Path(work)), packages(args.packages), providers, not args.no_commands, args.scenarios)
    for name, found in report.items():
        print(name)
        print("".join(f"  {line}\n" for line in found), end="")
    print(f"{len(report)} package groups with problems" if report else
          "no static problems" if args.static else "every package loads cleanly on the real host")
    return 1 if report else 0


if __name__ == "__main__":
    sys.exit(main())
