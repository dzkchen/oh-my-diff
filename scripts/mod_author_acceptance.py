#!/usr/bin/env python3
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = Path(os.environ.get("OMD_AUTHOR_EVIDENCE", Path(tempfile.gettempdir()) / "omd-author-evidence"))


def run(logs, name, args, cwd=ROOT, env=None):
    result = subprocess.run(
        args,
        cwd=cwd,
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    logs[name] = {
        "command": args,
        "cwd": str(cwd),
        "exit": result.returncode,
        "output": result.stdout,
    }
    if result.returncode:
        raise RuntimeError(f"{name} failed\n{result.stdout}")
    return result.stdout


def main():
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    logs = {}
    engine = Path(os.environ.get("OMD_MOD_BIN", ROOT / "runtime/omd/target/debug/omd-mod"))
    if "OMD_MOD_BIN" not in os.environ:
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
    with tempfile.TemporaryDirectory(prefix="omd-author-acceptance-") as raw:
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
                    "name": "author-acceptance-tool",
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
                "OMD_MOD_BIN": str(engine),
                "OMD_MOD_NODE": node,
                "OMD_MOD_SDK_SPEC": f"file:{tarball}",
                "OMD_MOD_TYPESCRIPT_SPEC": f"link:{ROOT / 'mods/node_modules/typescript'}",
            }
        )
        examples = work / "examples"
        run(
            logs,
            "create-examples",
            ["pnpm", "exec", "omd-mod-author", "examples", str(examples)],
            cwd=tool,
            env=env,
        )
        run(logs, "install-examples", ["pnpm", "install", "--offline"], cwd=examples, env=env)
        run(logs, "check-examples", ["pnpm", "run", "check"], cwd=examples, env=env)
        run(logs, "test-examples", ["pnpm", "run", "test"], cwd=examples, env=env)
        run(
            logs,
            "debug-intentional-failure",
            ["pnpm", "run", "debug"],
            cwd=examples / "coordination",
            env=env,
        )
        if "index.ts" not in logs["debug-intentional-failure"]["output"]:
            raise RuntimeError("intentional failure did not retain an authored source location")
        run(logs, "package-examples", ["pnpm", "run", "package"], cwd=examples, env=env)
        minimal = work / "minimal"
        run(
            logs,
            "create-minimal",
            ["pnpm", "exec", "omd-mod-author", "create", str(minimal), "minimal"],
            cwd=tool,
            env=env,
        )
        run(logs, "install-minimal", ["pnpm", "install", "--offline"], cwd=minimal, env=env)
        for action in ["check", "test", "run", "debug", "package"]:
            run(logs, f"minimal-{action}", ["pnpm", "run", action], cwd=minimal, env=env)
        store = work / "watch-store"
        run(logs, "watch-store-init", [str(engine), "init", str(store), node], env=env)
        run(
            logs,
            "watch-reload",
            ["pnpm", "exec", "omd-mod-author", "watch", str(examples / "coordination"), str(store), "--once"],
            cwd=tool,
            env=env,
        )
        run(logs, "author-report", ["pnpm", "exec", "omd-mod-author", "report", str(store)], cwd=tool, env=env)
        run(logs, "event-precedence", ["pnpm", "exec", "omd-mod-author", "events", str(store)], cwd=tool, env=env)
        diagnostic = work / "diagnostics.json"
        run(
            logs,
            "diagnostic-bundle",
            ["pnpm", "exec", "omd-mod-author", "diagnostics", str(store), str(diagnostic)],
            cwd=tool,
            env=env,
        )
        bundle = diagnostic.read_text()
        if str(work) in bundle or str(examples / "coordination") in bundle:
            raise RuntimeError("diagnostic bundle retained an absolute author path")
        shutil.copy2(diagnostic, EVIDENCE / "diagnostics.json")
        packaged = sorted(str(path.relative_to(work)) for path in work.glob("**/dist/*/package-report.json"))
        summary = {
            "schema": 1,
            "sdk": "@oh-my-diff/mod-api@" + json.loads((ROOT / "mods/package.json").read_text())["version"],
            "sdk_tarball_sha256": hashlib.sha256(tarball.read_bytes()).hexdigest(),
            "node": node,
            "engine": "omd-mod built from the selected checkout",
            "clean_root": str(work),
            "offline_install": True,
            "paid_requests": 0,
            "examples": sorted(path.name for path in examples.iterdir() if (path / "mod.json").is_file()),
            "packaged_reports": packaged,
            "commands": {name: value["exit"] for name, value in logs.items()},
        }
        (EVIDENCE / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    (EVIDENCE / "commands.json").write_text(json.dumps(logs, indent=2) + "\n")
    print(json.dumps({"evidence": str(EVIDENCE), "commands": len(logs), "paid_requests": 0}, indent=2))


if __name__ == "__main__":
    main()
