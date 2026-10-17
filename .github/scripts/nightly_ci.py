#!/usr/bin/env python3
import argparse
import datetime
import json
import os
import re
import resource
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import tomllib
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
import build
from scripts import authority_broker, install_support as support, package as release_package, profile_acceptance, release_lock

WORK = Path(os.environ.get("OMD_NIGHTLY_ROOT", "/private/tmp/omd-nightly"))
BATCH = "nightly"
CRATES = ["codex-omd", "codex-omd-extension", "codex-tui", "codex-core-plugins", "codex-git-utils"]
RELEASE_ADVISORY = {"cargo test core integration"}
SOURCE_PATH = re.compile(r"--> ([^:\s]+):\d")


def cargo_step(log, *args):
    if args[0] in ("build", "test", "clippy"):
        args = (args[0], "--locked", *args[1:])
    return ["python3", ".github/scripts/build.py", "cargo", BATCH, str(WORK / "logs" / f"{log}.cargo.log"), *args]


def packages(names):
    return [flag for name in names for flag in ("-p", name)]


def drift(*paths):
    return ["git", "diff", "--exit-code", "--stat", "--", *paths]


def hosted_steps():
    artifact_dir = build.batch_dir(BATCH) / "artifacts"
    return [
        ("setup", ["python3", ".github/scripts/build.py", "setup", BATCH]),
        ("verified V8", ["python3", ".github/scripts/nightly_ci.py", "v8"]),
        ("patch sync", ["python3", ".github/scripts/build.py", "sync", BATCH]),
        ("patch matches checkout", drift("runtime", "upstream.lock.json")),
        ("test helper binaries", cargo_step("test-helpers", "build", "-p", "codex-rmcp-client", "-p", "codex-cli",
                                            "-p", "codex-code-mode-host", "--bins")),
        ("cargo test native crates", ["python3", ".github/scripts/nightly_ci.py", "tests", "--suite", "native"]),
        ("cargo test core", ["python3", ".github/scripts/nightly_ci.py", "tests", "--suite", "core"]),
        ("cargo test core integration", ["python3", ".github/scripts/nightly_ci.py", "tests", "--suite", "core-integration"]),
        ("clippy omd paths", cargo_step("clippy", "clippy", *packages(CRATES), "--tests")),
        ("rustfmt", cargo_step("fmt", "fmt", *packages([*CRATES, "codex-core"]), "--", "--check")),
        ("native ownership", ["mise", "run", "native:ownership"]),
        ("host binaries", ["python3", ".github/scripts/build.py", "artifacts", BATCH]),
        ("locks", ["python3", ".github/scripts/build.py", "locks"]),
        ("locks match checkout", drift(".", ":(exclude)runtime/release.lock.json")),
        ("mods install", ["pnpm", "--dir", "mods", "install", "--frozen-lockfile", "--prefer-offline"]),
        ("mods typecheck", ["mise", "run", "mods:check"]),
        ("mods tests", ["env", f"OMD_MOD_BIN={artifact_dir / 'omd-mod'}", "mise", "run", "mods:test"]),
        ("python tests", ["python3", "-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py"]),
        ("host check with scenarios", ["python3", "scripts/mod_host_check.py", "--omd-mod", str(artifact_dir / "omd-mod"), "--scenarios"]),
        ("client acceptance", ["python3", "-m", "scripts.client_acceptance", "--binaries", str(artifact_dir)]),
    ]


def raise_file_limit():
    soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
    target = 8192 if hard == resource.RLIM_INFINITY else min(8192, hard)
    if soft != resource.RLIM_INFINITY and soft < target:
        resource.setrlimit(resource.RLIMIT_NOFILE, (target, hard))


def node():
    return subprocess.check_output(["mise", "which", "node"], cwd=build.ROOT, text=True).strip()


def step(name, argv):
    log = WORK / "logs" / (re.sub(r"\W+", "-", name) + ".log")
    started = time.monotonic()
    environment = os.environ | {"TMPDIR": "/private/tmp/"}
    if name.startswith("cargo test core"):
        home = WORK / "core-test-home"
        home.mkdir(exist_ok=True)
        environment.update(OMD_TEST_NODE=node(), HOME=str(home),
                           CARGO_HOME=os.environ.get("CARGO_HOME", str(Path.home() / ".cargo")),
                           RUSTUP_HOME=os.environ.get("RUSTUP_HOME", str(Path.home() / ".rustup")),
                           MISE_DATA_DIR=os.environ.get("MISE_DATA_DIR", str(Path.home() / ".local/share/mise")))
    with log.open("w") as output:
        status = subprocess.run(argv, cwd=build.ROOT, env=environment, stdout=output, stderr=subprocess.STDOUT).returncode
    text = log.read_text(errors="replace")
    if name == "clippy omd paths":
        cargo_log = WORK / "logs" / "clippy.cargo.log"
        files = json.loads((build.ROOT / "runtime/patches/manifest.json").read_text())["files"]
        paths = {path.removeprefix("codex-rs/") for path in files if path.endswith(".rs")}
        warnings = [line for line in (cargo_log.read_text(errors="replace") if cargo_log.is_file() else text).splitlines()
                    if (match := SOURCE_PATH.search(line)) and match[1] in paths]
        status = status or (1 if warnings else 0)
        text += "\n" + "\n".join(warnings)
    tail = [line for line in text.splitlines() if line.strip()][-6:]
    return {"name": name, "status": status, "seconds": round(time.monotonic() - started), "log": str(log), "tail": tail}


def validate(release):
    raise_file_limit()
    shutil.rmtree(WORK / "logs", ignore_errors=True)
    (WORK / "logs").mkdir(parents=True)
    commit = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=build.ROOT, capture_output=True, text=True, check=True).stdout.strip()
    subprocess.run(["mise", "trust", build.ROOT / "mise.toml"], cwd=build.ROOT, capture_output=True)
    steps = hosted_steps()
    results = []
    for name, argv in steps:
        results.append(step(name, argv))
        if name == "host binaries" and not results[-1]["status"]:
            manager = str(build.batch_dir(BATCH) / "artifacts/omd-mod")
            os.environ.update(OMD_TEST_MOD_BIN=manager, OMD_TEST_MANAGER=manager, OMD_TEST_NODE=node())
        if name in ("setup", "verified V8") and results[-1]["status"]:
            break
    failed = [result["name"] for result in results if result["status"]]
    advisory = [name for name in failed if release and name in RELEASE_ADVISORY]
    skipped = [name for name, _ in steps[len(results):]]
    stamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    lines = [f"# OMD nightly: {stamp} at `{commit}`", "",
             f"{len(results) - len(failed)}/{len(steps)} steps passed."
             + (f" Failed: {', '.join(failed)}." if failed else "") + (f" Skipped: {', '.join(skipped)}." if skipped else ""), "",
             "| Step | Result | Time | Log |", "| --- | --- | --- | --- |"]
    lines += [f"| {result['name']} | {'FAIL' if result['status'] else 'pass'} | {result['seconds']} s | `{result['log']}` |" for result in results]
    lines += [f"| {name} | skipped | | |" for name in skipped]
    for result in results:
        if result["status"]:
            lines += ["", f"## {result['name']}", "", "```", *result["tail"], "```"]
    lines += ["", "Known upstream baseline excluded: `filtered_host_additional_permissions`."]
    if advisory:
        lines += [f"Not required for a release: {', '.join(advisory)}."]
    report = "\n".join(lines) + "\n"
    (WORK / "report.md").write_text(report)
    print(report)
    return 1 if set(failed) - set(advisory) else 0


def v8():
    if os.environ.get("V8_FROM_SOURCE") or os.environ.get("RUSTY_V8_ARCHIVE"):
        return
    checkout, directory = build.batch_dir(BATCH) / "codex", build.V8
    lock = tomllib.loads((checkout / "codex-rs/Cargo.lock").read_text())
    (version,) = {package["version"] for package in lock["package"] if package["name"] == "v8"}
    target = support.output(["rustc", "-vV"], cwd=checkout / "codex-rs").split("host: ", 1)[1].split()[0]
    url = f"https://github.com/openai/codex/releases/download/rusty-v8-v{version}"
    manifest = f"rusty_v8_ptrcomp_sandbox_release_{target}.sha256"
    names = {"archive": f"librusty_v8_ptrcomp_sandbox_release_{target}.a.gz",
             "binding": f"src_binding_ptrcomp_sandbox_release_{target}.rs"}
    directory.mkdir(parents=True, exist_ok=True)

    def checksums(path):
        return dict(reversed(line.split()) for line in path.read_text().splitlines() if line.strip())

    expected = checksums(checkout / f"third_party/v8/rusty_v8_{version.replace('.', '_')}_release_manifests.sha256")
    for name in (manifest, *names.values()):
        with urllib.request.urlopen(f"{url}/{name}", timeout=120) as response, (directory / name).open("wb") as file:
            shutil.copyfileobj(response, file)
        if expected.get(name) != support.digest(directory / name):
            raise ValueError(f"V8 prebuilt checksum mismatch: {name}")
        if name == manifest:
            expected = checksums(directory / manifest)


def cargo_tests(suite):
    batch = build.batch_dir(BATCH)
    names = ["codex-core"] if suite.startswith("core") else CRATES
    metadata = json.loads(build.run("cargo", "metadata", "--locked", "--no-deps", "--format-version", "1", cwd=batch / "codex/codex-rs"))
    targets = set()
    for package in metadata["packages"]:
        if package["name"] in names:
            for target in package["targets"]:
                if target["test"]:
                    if "lib" in target["kind"]:
                        targets.add(("--lib",))
                    elif target["kind"][0] in ("bin", "test"):
                        targets.add((f"--{target['kind'][0]}", target["name"]))
    targets.add(("--doc",))
    if suite == "core-integration":
        targets = {("--test", "all")}
    elif suite == "core":
        targets.discard(("--test", "all"))
    failed = False
    for index, flags in enumerate(sorted(targets)):
        args = ["test", "--locked", "--no-fail-fast", *packages(names), *flags, "--message-format=json-render-diagnostics", "--", "--test-threads=1"]
        if suite.startswith("core"):
            args += ["--skip", "shell_startup_credentials_are_brokered::filtered_host_additional_permissions"]
        log = WORK / "logs" / f"{suite}-{index}.cargo.log"
        failed |= build.cargo_run(batch, log, args) != 0
        for line in log.read_text().splitlines():
            try:
                item = json.loads(line)
            except ValueError:
                continue
            if isinstance(item, dict) and item.get("reason") == "build-finished":
                break
            if (isinstance(item, dict) and item.get("reason") == "compiler-artifact"
                    and item.get("profile", {}).get("test") and item.get("executable")):
                path = Path(item["executable"])
                if path.resolve().parent == (batch / "target/debug/deps").resolve():
                    path.unlink(missing_ok=True)
    raise SystemExit(int(failed))


def nightly_version(frozen):
    base, _, prerelease = frozen.partition("-")
    if not prerelease:
        major, minor, patch = base.split(".")
        base = f"{major}.{minor}.{int(patch) + 1}"
    return f"{base}-nightly.{datetime.datetime.now(datetime.UTC):%Y%m%d%H%M%S}.{os.environ['GITHUB_RUN_ID']}.{os.environ['GITHUB_RUN_ATTEMPT']}"


def package(version=None):
    batch = build.batch_dir(BATCH)
    shutil.rmtree(batch / "target")
    artifact_dir = batch / "artifacts"
    frozen = json.loads(release_lock.OUTPUT.read_text())["version"]
    if version is None:
        version = nightly_version(frozen)
    elif version != frozen:
        raise ValueError(f"release {version} does not match the committed release lock version {frozen}")
    support.output([sys.executable, "-m", "scripts.release_lock", "--artifact-dir", artifact_dir, "--write", "--version", version])
    output = WORK / "release"
    output.mkdir(parents=True, exist_ok=True)
    archive = output / f"oh-my-diff-{version}-aarch64-apple-darwin.tar.xz"
    support.output([sys.executable, "-m", "scripts.package", "pack", "--artifact-dir", artifact_dir, "--output", archive])
    if archive.stat().st_size > 150_000_000:
        raise ValueError("nightly archive exceeds the curl installer download limit")
    upstream = batch / "upstream-bin/codex"
    upstream.parent.mkdir(parents=True)
    pin = build.pin()
    support.output(["curl", "--fail", "--silent", "--show-error", "--location", "--retry", "3",
                    f"https://github.com/openai/codex/releases/download/{pin['tag']}/codex-aarch64-apple-darwin.tar.gz",
                    "--output", upstream.with_suffix(".tar.gz")])
    support.output(["tar", "-xzf", upstream.with_suffix(".tar.gz"), "-C", upstream.parent])
    (upstream.parent / "codex-aarch64-apple-darwin").rename(upstream)
    support.output([sys.executable, "-m", "scripts.profile_acceptance", "--artifact-dir", artifact_dir,
                    "--upstream", upstream, "--output", WORK / "profile-acceptance.json"])
    archive_acceptance(archive, upstream)
    provenance = {"schema": 1, "version": version, "commit": support.output(["git", "rev-parse", "HEAD"]),
                  "upstream_commit": pin["commit"], "upstream_tag": pin["tag"],
                  "patch_sha256": json.loads((build.ROOT / "runtime/patches/manifest.json").read_text())["patch"]["sha256"], "profile": "release",
                  "run_url": f"https://github.com/{os.environ['GITHUB_REPOSITORY']}/actions/runs/{os.environ['GITHUB_RUN_ID']}"}
    (output / "provenance.json").write_text(json.dumps(provenance, indent=2) + "\n")
    shutil.copy2(build.ROOT / "install.sh", output / "install.sh")
    support.output(["git", "archive", "--format=tar.gz", f"--prefix=oh-my-diff-{version}/",
                    "--output", output / f"oh-my-diff-{version}-source.tar.gz", "HEAD"], cwd=build.ROOT)
    checksums = [f"{support.digest(path)}  {path.name}" for path in sorted(output.iterdir()) if path.is_file()]
    (output / "SHA256SUMS").write_text("\n".join(checksums) + "\n")


def archive_acceptance(archive, upstream):
    archive, upstream = archive.resolve(), upstream.resolve()
    with tempfile.TemporaryDirectory(prefix="omd-nightly-install-", dir="/private/tmp") as temporary:
        base = Path(temporary)
        home = base / "home"
        home.mkdir()
        sentinel = home / "config.toml"
        sentinel.write_text('model = "preserve-user-choice"\n')
        environment = profile_acceptance.isolated_environment(base, home, upstream)
        digest = support.digest(archive)
        payload = release_package.checked_extract(archive, digest, base)
        for profile in ("platform", "full"):
            prefix, bin_dir = base / f"{profile}-prefix", base / f"{profile}-bin"
            install = [sys.executable, "-m", "scripts.package", "install", "--archive", archive,
                       "--sha256", digest, "--profile", profile, "--prefix", prefix, "--bin-dir", bin_dir,
                       "--store", base / f"{profile}-store", "--node", node(), "--upstream", upstream]
            subprocess.run(list(map(str, install)), cwd=payload, env=environment, check=True)
            next_prefix, next_bin = base / f"{profile}-next-prefix", base / f"{profile}-next-bin"
            reinstall = list(install)
            reinstall[reinstall.index("--prefix") + 1] = next_prefix
            reinstall[reinstall.index("--bin-dir") + 1] = next_bin
            subprocess.run(list(map(str, [*reinstall, "--attach-store", "--previous", prefix])), cwd=payload, env=environment, check=True)
            for installed, launchers in ((next_prefix, next_bin), (prefix, bin_dir)):
                subprocess.run([sys.executable, "-m", "scripts.profiles", "--prefix", str(installed),
                                "--bin-dir", str(launchers), "uninstall"], cwd=payload, env=environment, check=True)
            if sentinel.read_text() != 'model = "preserve-user-choice"\n':
                raise ValueError("archive installation changed shared Codex configuration")


def sign(manifest):
    key = os.environ.get("OMD_RELEASE_SIGNING_KEY")
    if not key:
        raise ValueError("OMD_RELEASE_SIGNING_KEY is required to sign omd-release.json")
    with tempfile.TemporaryDirectory() as temporary:
        private = Path(temporary) / "key"
        private.write_text(key.strip() + "\n")
        private.chmod(0o600)
        support.output(["ssh-keygen", "-Y", "sign", "-q", "-f", private, "-n", authority_broker.SIGNING_NAMESPACE, manifest])
    authority_broker.signed_hashes([manifest])
    return manifest.with_name(manifest.name + ".sig")


def publish(directory, notes=None, dry_run=False):
    provenance = json.loads((directory / "provenance.json").read_text())
    manifest = json.loads((directory / "omd-release.json").read_text())
    version = manifest["version"]
    pattern = r"\d+\.\d+\.\d+(?:-rc\.\d+)?" if notes else r"\d+\.\d+\.\d+-nightly\.\d+\.\d+\.\d+"
    if (provenance["commit"] != os.environ["GITHUB_SHA"] or provenance["version"] != version
            or not re.fullmatch(pattern, version)
            or provenance["profile"] != "release" or manifest["target"] != "aarch64-apple-darwin"
            or Path(manifest["archive"]).name != manifest["archive"]):
        raise ValueError("release provenance does not match the validated workflow commit")
    tag = "v" + version
    if notes and not dry_run and os.environ.get("GITHUB_REF") != f"refs/tags/{tag}":
        raise ValueError(f"release {version} must be published from tag {tag}")
    sums = [line.split("  ", 1) for line in (directory / "SHA256SUMS").read_text().splitlines()]
    for digest, name in sums:
        if Path(name).name != name or support.digest(directory / name) != digest:
            raise ValueError(f"release asset checksum mismatch: {name}")
    if support.digest(directory / manifest["archive"]) != manifest["sha256"]:
        raise ValueError("release archive disagrees with the installer manifest")
    assets = [directory / name for _, name in sums] + [directory / "SHA256SUMS", sign(directory / "omd-release.json")]
    if not notes:
        notes = directory.parent / "notes.md"
        notes.write_text(f"Nightly from `{provenance['commit']}`; pinned {provenance['upstream_tag']}.\n\n"
                         f"[Hosted validation]({provenance['run_url']}) passed on macOS. "
                         "Apple Silicon archive installs either OMD Core or OMD+.\n\n"
                         "Opt in with `sh install.sh --channel nightly` or `omd update channel nightly`. "
                         "Stable releases remain tag-only.\n")
        title = f"Nightly {version}"
    else:
        title = f"Oh My Diff {version}"
    prerelease = "-" in version
    create = ["gh", "release", "create", tag, *assets, "--repo", os.environ["GITHUB_REPOSITORY"],
              "--target", provenance["commit"], "--title", title, "--notes-file", notes, "--draft",
              *(["--prerelease"] if prerelease else [])]
    edit = ["gh", "release", "edit", tag, "--repo", os.environ["GITHUB_REPOSITORY"], "--draft=false", "--latest=false" if prerelease else "--latest"]
    if dry_run:
        print("dry run verified", ", ".join(path.name for path in assets))
        print(*map(str, create))
        print(*map(str, edit))
        return
    support.output(create)
    support.output(edit)


def main():
    parser = argparse.ArgumentParser(description="Hosted validation, packaging and publication for nightlies and tagged releases")
    parser.add_argument("command", choices=("validate", "v8", "tests", "package", "publish"))
    parser.add_argument("--directory", type=Path, default=Path("release"))
    parser.add_argument("--suite", choices=("native", "core", "core-integration"))
    parser.add_argument("--release", action="store_true", help="validate: the core integration suite reports but does not gate")
    parser.add_argument("--version", help="package this stable release version instead of a nightly")
    parser.add_argument("--notes", type=Path, help="publish a stable release with these notes")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if args.command == "validate":
        raise SystemExit(validate(args.release))
    if args.command == "publish":
        publish(args.directory, args.notes, args.dry_run)
    elif args.command == "package":
        package(args.version)
    elif args.command == "tests":
        if not args.suite:
            parser.error("tests requires --suite")
        cargo_tests(args.suite)
    else:
        v8()


if __name__ == "__main__":
    main()
