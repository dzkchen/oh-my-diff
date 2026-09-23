#!/usr/bin/env python3
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / ".docs/audits/evidence/full-api-conformance-20260921"
SOURCES = ROOT / "mods/exercise"
FIXTURES = {"counter": "counter", "service_provider": "service-provider"}
AUTHORED = ("atlas_policy", "atlas_console")
PACKAGE_FILES = ("mod.json", "index.ts", "mod.test.json", "debug.test.json")
SETTINGS = {"atlas_policy": {"mode": "solo", "focus": ["solution.py"]}}
FINDINGS = [
    {
        "gap": "The scaffold from `omd-mod-author create` omitted `license` and `provenance`, so a new package "
        "was rejected by `omd-mod package-plan` before it could ever be installed.",
        "resolution": "The published scaffold now emits both fields with explicit placeholders.",
        "generic": True,
    },
    {
        "gap": "Every shipped SDK example omitted the same two fields, so no published example could be "
        "installed through the supported package lifecycle.",
        "resolution": "All twelve example manifests now declare `license` and `provenance`.",
        "generic": True,
    },
    {
        "gap": "An offline `mod.test.json` could not supply a mod's settings, so a settings-driven policy or "
        "terminal mod had no way to test its configured behaviour without a real store.",
        "resolution": "Scenarios accept a `settings` map keyed by mod ID, applied through the existing "
        "`omd-mod settings` command before the run.",
        "generic": True,
    },
    {
        "gap": "A mod that failed to activate reported only `mod_failed: explicitly reload to recover`, hiding "
        "the retained cause from the author runner.",
        "resolution": "The host now includes the retained activation error in that failure.",
        "generic": True,
    },
    {
        "gap": "`package-rollback` repoints the managed selection at the immutable store cache, so an author "
        "cannot keep editing the rolled-back source in place.",
        "resolution": "Documented as intended behaviour; returning to editable development is a fresh local "
        "install of the rolled-back source.",
        "generic": True,
    },
]


def run(logs, name, args, cwd=ROOT, env=None, expect_failure=False):
    result = subprocess.run(
        args,
        cwd=cwd,
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    logs[name] = {
        "command": [str(arg) for arg in args],
        "cwd": str(cwd),
        "exit": result.returncode,
        "output": result.stdout,
    }
    if bool(result.returncode) != expect_failure:
        raise RuntimeError(f"{name} unexpected exit {result.returncode}\n{result.stdout}")
    return result.stdout


def engine(logs, name, binary, args, env, expect_failure=False):
    output = run(logs, name, [str(binary), *args], env=env, expect_failure=expect_failure)
    return output if expect_failure else json.loads(output)


def install_request(path, identifier, capabilities, activate=True):
    request = {
        "source": {"kind": "local", "path": str(path)},
        "activate": activate,
        "trust": {"packages": {identifier: {"capabilities": capabilities}}},
    }
    if identifier in SETTINGS:
        request["settings"] = {identifier: SETTINGS[identifier]}
    return json.dumps(request)


def apply_package(logs, label, binary, store, request, env):
    plan = engine(logs, f"{label}-plan", binary, ["package-plan", store, request], env)
    lock = engine(
        logs,
        f"{label}-apply",
        binary,
        ["package-apply", store, request, plan["confirmation"]],
        env,
    )
    return plan, lock


def copy_version(identifier, version, destination):
    source = SOURCES / identifier / version
    for name in PACKAGE_FILES:
        shutil.copy2(source / name, destination / name)
    return json.loads((source / "mod.json").read_text())


def author_checks(logs, project, identifier, version, env, actions=("check", "test", "debug", "package")):
    for action in actions:
        run(logs, f"{identifier}-{version}-{action}", ["pnpm", "run", action], cwd=project, env=env)


def main():
    if EVIDENCE.exists():
        shutil.rmtree(EVIDENCE)
    EVIDENCE.mkdir(parents=True)
    logs = {}
    binary = ROOT / "runtime/omd/target/debug/omd-mod"
    run(
        logs,
        "build-engine",
        ["cargo", "+1.95.0", "build", "--manifest-path", "runtime/omd/Cargo.toml", "--bin", "omd-mod"],
    )
    node = run(
        logs,
        "resolve-node",
        ["mise", "exec", "node@24.18.0", "--", "node", "-p", "process.execPath"],
    ).strip()
    with tempfile.TemporaryDirectory(prefix="omd-full-api-exercise-") as raw:
        work = Path(raw)
        pack = work / "pack"
        pack.mkdir()
        run(logs, "pack-sdk", ["pnpm", "--dir", "mods", "pack", "--pack-destination", str(pack)])
        tarball = next(pack.glob("*.tgz"))
        tool = work / "tool"
        tool.mkdir()
        (tool / "package.json").write_text(
            json.dumps(
                {
                    "name": "full-api-exercise-tool",
                    "private": True,
                    "devDependencies": {"@oh-my-diff/mod-api": f"file:{tarball}"},
                },
                indent=2,
            )
            + "\n"
        )
        run(logs, "install-packed-sdk", ["pnpm", "install", "--offline"], cwd=tool)
        env = os.environ.copy()
        env.update(
            {
                "OMD_MOD_BIN": str(binary),
                "OMD_MOD_NODE": node,
                "OMD_MOD_SDK_SPEC": f"file:{tarball}",
            }
        )
        author = ["pnpm", "exec", "omd-mod-author"]

        fixture_scenarios = {
            "counter": {
                "schema": 1,
                "steps": [{"type": "invoke", "mod": "counter", "event": "tool", "name": "count", "payload": {}, "expect": {"count": 1}}],
            },
            "service_provider": {"schema": 1, "steps": [{"type": "status"}]},
        }
        for identifier, example in FIXTURES.items():
            project = work / identifier
            run(logs, f"{identifier}-scaffold", [*author, "create", str(project), identifier], cwd=tool, env=env)
            source = ROOT / "mods/examples" / example
            shutil.copy2(source / "mod.json", project / "mod.json")
            shutil.copy2(source / "index.ts", project / "index.ts")
            (project / "mod.test.json").write_text(json.dumps(fixture_scenarios[identifier], indent=2) + "\n")
            run(logs, f"{identifier}-install", ["pnpm", "install", "--offline"], cwd=project, env=env)
            author_checks(logs, project, identifier, "fixture", env, ("check", "test", "package"))

        manifests = {}
        for identifier in AUTHORED:
            project = work / identifier
            run(logs, f"{identifier}-create", [*author, "create", str(project), identifier], cwd=tool, env=env)
            manifests[identifier] = copy_version(identifier, "1.0.0", project)
            run(logs, f"{identifier}-install", ["pnpm", "install", "--offline"], cwd=project, env=env)
            author_checks(logs, project, identifier, "1.0.0", env)

        store = work / "store"
        engine(logs, "store-init", binary, ["init", str(store), node], env)
        for identifier in (*FIXTURES, *AUTHORED):
            project = work / identifier
            declared = json.loads((project / "mod.json").read_text())
            manifests[identifier] = declared
            apply_package(
                logs,
                f"{identifier}-install-v1",
                binary,
                str(store),
                install_request(project, identifier, declared["capabilities"]),
                env,
            )

        combined_one = engine(
            logs,
            "combined-v1",
            binary,
            ["test", str(store), str(SOURCES / "combined-v1.test.json")],
            env,
        )
        events = engine(logs, "events-v1", binary, ["events", str(store)], env)
        report = engine(logs, "report-v1", binary, ["report", str(store)], env)

        for identifier in AUTHORED:
            project = work / identifier
            manifests[identifier] = copy_version(identifier, "2.0.0", project)
            author_checks(logs, project, identifier, "2.0.0", env)

        blocked = {}
        migrated = {}
        for identifier in AUTHORED:
            project = work / identifier
            declared = manifests[identifier]
            request = install_request(project, identifier, declared["capabilities"])
            plan, lock = apply_package(logs, f"{identifier}-upgrade", binary, str(store), request, env)
            entry = lock["packages"][identifier]
            blocked[identifier] = {
                "version": entry["version"],
                "enabled": entry["enabled"],
                "state_version": entry["state_version"],
                "settings": entry["settings"],
            }
            migrated[identifier] = engine(
                logs, f"{identifier}-migrate", binary, ["migrate", str(store), str(project)], env
            )
            apply_package(logs, f"{identifier}-reactivate", binary, str(store), request, env)

        combined_two = engine(
            logs,
            "combined-v2",
            binary,
            ["test", str(store), str(SOURCES / "combined-v2.test.json")],
            env,
        )

        rollback_plan = engine(
            logs, "console-rollback-plan", binary, ["package-rollback-plan", str(store), "atlas_console"], env
        )
        rollback = engine(
            logs,
            "console-rollback",
            binary,
            ["package-rollback", str(store), "atlas_console", rollback_plan["confirmation"]],
            env,
        )
        console = work / "atlas_console"
        cached = rollback["packages"]["atlas_console"]["path"]
        state_backups = sorted(store.glob("state-atlas_console.json-backup-*"))
        state_rollback = engine(
            logs,
            "console-state-rollback",
            binary,
            ["rollback", str(store), cached, str(state_backups[-1])],
            env,
        )
        copy_version("atlas_console", "1.0.0", console)
        apply_package(
            logs,
            "console-restore-v1",
            binary,
            str(store),
            install_request(console, "atlas_console", json.loads((console / "mod.json").read_text())["capabilities"]),
            env,
        )
        restored = engine(
            logs,
            "combined-restored",
            binary,
            ["test", str(store), str(SOURCES / "combined-restored.test.json")],
            env,
        )

        copy_version("atlas_console", "2.0.0", console)
        request = install_request(console, "atlas_console", manifests["atlas_console"]["capabilities"])
        apply_package(logs, "console-reupgrade", binary, str(store), request, env)
        engine(logs, "console-remigrate", binary, ["migrate", str(store), str(console)], env)
        apply_package(logs, "console-reactivate", binary, str(store), request, env)

        final_lock = engine(logs, "package-lock", binary, ["package-lock", str(store)], env)
        final_status = engine(logs, "status", binary, ["status", str(store)], env)
        declarations = engine(logs, "declarations", binary, ["declarations", str(store)], env)
        diagnostic = work / "diagnostics.json"
        engine(logs, "diagnostics", binary, ["diagnostics", str(store), str(diagnostic)], env)
        bundle = diagnostic.read_text()
        if str(work) in bundle:
            raise RuntimeError("diagnostic bundle retained an absolute author path")
        shutil.copy2(diagnostic, EVIDENCE / "diagnostics.json")

        for name, value in (
            ("events.json", events),
            ("report.json", report),
            ("package-lock.json", final_lock),
            ("status.json", final_status),
            ("declarations.json", declarations),
            ("combined-v1.json", combined_one),
            ("combined-v2.json", combined_two),
            ("combined-restored.json", restored),
        ):
            (EVIDENCE / name).write_text(json.dumps(value, indent=2) + "\n")

        errors = {mod["id"]: mod["error"] for mod in final_status["mods"]}
        if any(errors.values()) or final_status["rejected"]:
            raise RuntimeError(f"combined store did not settle cleanly: {errors} {final_status['rejected']}")
        if {mod["id"] for mod in final_status["mods"]} != {*FIXTURES, *AUTHORED}:
            raise RuntimeError("the four separately packaged mods are not all active")

        scratch = work / "scratch-store"
        engine(logs, "scratch-init", binary, ["init", str(scratch), node], env)
        policy = work / "atlas_policy"
        inspected = engine(logs, "scratch-inspect", binary, ["inspect", str(policy)], env)
        engine(
            logs,
            "scratch-trust",
            binary,
            ["trust", str(scratch), inspected["path"], inspected["sha256"], ",".join(inspected["manifest"]["capabilities"])],
            env,
        )
        engine(logs, "scratch-enable", binary, ["enable", str(scratch), inspected["path"]], env)
        negative = engine(
            logs,
            "missing-provider-diagnosis",
            binary,
            ["test", str(scratch), str(SOURCES / "atlas_policy/2.0.0/debug.test.json")],
            env,
            expect_failure=True,
        ).strip()
        if "service_provider_missing: atlas_policy requires example.formatter" not in negative:
            raise RuntimeError(f"the author runner still hides the activation cause: {negative}")

        parity = private_symbol_parity()
        summary = {
            "schema": 1,
            "exercise": "full-API conformance author exercise",
            "author": {
                "identity": "Maintainer-run (dzkchen), assisted by Claude Opus 5 in Claude Code",
                "independent": False,
                "establishes": "feasibility and API/documentation gaps only, never adoption or usability evidence",
            },
            "sdk": json.loads((ROOT / "mods/package.json").read_text())["version"],
            "sdk_tarball_sha256": hashlib.sha256(tarball.read_bytes()).hexdigest(),
            "node": node,
            "clean_root": str(work),
            "offline_install": True,
            "paid_requests": 0,
            "packages": {
                identifier: {
                    "version": manifests[identifier]["version"],
                    "api": manifests[identifier]["api"],
                    "capabilities": manifests[identifier]["capabilities"],
                }
                for identifier in (*FIXTURES, *AUTHORED)
            },
            "upgrade": {
                "from_api": "0.1.0-experimental.5",
                "to_api": "0.1.0-experimental.6",
                "blocked_until_migration": blocked,
                "migrations": migrated,
                "package_rollback": {
                    "id": rollback_plan["root"],
                    "to_version": rollback["packages"]["atlas_console"]["version"],
                },
                "state_rollback": state_rollback,
            },
            "composition": {
                "order": final_status["order"],
                "replacements": {
                    entry["id"]: entry["replacements"] for entry in events["events"]
                },
            },
            "parity": parity,
            "missing_apis": [],
            "findings": FINDINGS,
            "negative_control": negative,
            "commands": {name: value["exit"] for name, value in logs.items()},
        }
        (EVIDENCE / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    (EVIDENCE / "commands.json").write_text(json.dumps(logs, indent=2) + "\n")
    print(json.dumps({"evidence": str(EVIDENCE), "commands": len(logs), "paid_requests": 0}, indent=2))


def private_symbol_parity():
    sources = [
        path.read_text()
        for identifier in AUTHORED
        for path in (SOURCES / identifier).glob("*/index.ts")
    ]
    imports = sorted({
        line.split("from")[-1].strip().strip("';")
        for source in sources
        for line in source.splitlines()
        if line.startswith("import ")
    })
    rust = "\n".join(
        path.read_text()
        for path in (*(ROOT / "runtime/omd/src").rglob("*.rs"), *(ROOT / "runtime/native/src").rglob("*.rs"))
    )
    named = [identifier for identifier in AUTHORED if identifier in rust]
    return {
        "imports": imports,
        "per_mod_rust_symbols": named,
        "public_types_only": imports == ["@oh-my-diff/mod-api"],
    }


if __name__ == "__main__":
    main()
