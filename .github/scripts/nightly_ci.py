#!/usr/bin/env python3
import argparse
import datetime
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
import build
import nightly
from scripts import package as release_package, profile_acceptance, release_lock


def command(*args):
    result = subprocess.run([str(arg) for arg in args], text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if result.returncode:
        raise RuntimeError(f"{args[0]} failed ({result.returncode}):\n{result.stdout[-6000:]}")
    return result.stdout.strip()


def v8():
    release_package.v8_prebuilt(build.batch_dir(nightly.BATCH) / "codex", build.V8, os.environ.copy())


def cargo_tests(suite):
    batch = build.batch_dir(nightly.BATCH)
    crates = ["-p", "codex-core"] if suite == "core" else nightly.CRATES
    packages = set(crates[1::2])
    metadata = json.loads(build.run("cargo", "metadata", "--locked", "--no-deps", "--format-version", "1", cwd=batch / "codex/codex-rs"))
    targets = set()
    for package in metadata["packages"]:
        if package["name"] in packages:
            for target in package["targets"]:
                if target["test"]:
                    if "lib" in target["kind"]:
                        targets.add(("--lib",))
                    elif target["kind"][0] in ("bin", "test"):
                        targets.add((f"--{target['kind'][0]}", target["name"]))
    targets.add(("--doc",))
    failed = False
    for index, flags in enumerate(sorted(targets)):
        args = ["test", "--locked", *crates, *flags, "--message-format=json-render-diagnostics", "--", "--test-threads=1"]
        if suite == "core":
            args += ["--skip", "shell_startup_credentials_are_brokered::filtered_host_additional_permissions"]
        log = nightly.WORK / "logs" / f"{suite}-{index}.cargo.log"
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


def package():
    batch = build.batch_dir(nightly.BATCH)
    shutil.rmtree(batch / "target")
    artifact_dir = batch / "artifacts"
    frozen = json.loads(release_lock.OUTPUT.read_text())
    base = frozen["version"].split("-", 1)[0]
    version = f"{base}-nightly.{datetime.datetime.now(datetime.UTC):%Y%m%d%H%M%S}.{os.environ['GITHUB_RUN_ID']}.{os.environ['GITHUB_RUN_ATTEMPT']}"
    command(sys.executable, "-m", "scripts.release_lock", "--artifact-dir", artifact_dir, "--write", "--version", version)
    output = nightly.WORK / "release"
    output.mkdir(parents=True, exist_ok=True)
    archive = output / f"oh-my-diff-{version}-aarch64-apple-darwin.tar.xz"
    command(sys.executable, "-m", "scripts.package", "pack", "--artifact-dir", artifact_dir, "--output", archive)
    if archive.stat().st_size > 150_000_000:
        raise ValueError("nightly archive exceeds the curl installer download limit")
    upstream = batch / "upstream-bin/codex"
    upstream.parent.mkdir(parents=True)
    pin = build.pin()
    command("curl", "--fail", "--silent", "--show-error", "--location", "--retry", "3",
            f"https://github.com/openai/codex/releases/download/{pin['tag']}/codex-aarch64-apple-darwin.tar.gz",
            "--output", upstream.with_suffix(".tar.gz"))
    command("tar", "-xzf", upstream.with_suffix(".tar.gz"), "-C", upstream.parent)
    (upstream.parent / "codex-aarch64-apple-darwin").rename(upstream)
    command(sys.executable, "-m", "scripts.profile_acceptance", "--artifact-dir", artifact_dir,
            "--upstream", upstream, "--output", nightly.WORK / "profile-acceptance.json")
    archive_acceptance(archive, upstream)
    provenance = {"schema": 1, "version": version, "commit": command("git", "rev-parse", "HEAD"),
                  "upstream_commit": pin["commit"], "upstream_tag": pin["tag"],
                  "patch_sha256": json.loads((build.ROOT / "runtime/patches/manifest.json").read_text())["patch"]["sha256"], "profile": "release",
                  "run_url": f"https://github.com/{os.environ['GITHUB_REPOSITORY']}/actions/runs/{os.environ['GITHUB_RUN_ID']}"}
    (output / "nightly-provenance.json").write_text(json.dumps(provenance, indent=2) + "\n")
    checksums = [f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}" for path in sorted(output.iterdir()) if path.is_file()]
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
        node = command("mise", "which", "node")
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        payload = release_package.checked_extract(archive, digest, base)
        for profile in ("platform", "full"):
            prefix, bin_dir = base / f"{profile}-prefix", base / f"{profile}-bin"
            install = [sys.executable, "-m", "scripts.package", "install", "--archive", archive,
                       "--sha256", digest, "--profile", profile, "--prefix", prefix, "--bin-dir", bin_dir,
                       "--store", base / f"{profile}-store", "--node", node, "--upstream", upstream]
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


def publish(directory):
    provenance = json.loads((directory / "nightly-provenance.json").read_text())
    manifest = json.loads((directory / "omd-release.json").read_text())
    if (provenance["commit"] != os.environ["GITHUB_SHA"] or provenance["version"] != manifest["version"]
            or not re.fullmatch(r"\d+\.\d+\.\d+-nightly\.\d+\.\d+\.\d+", manifest["version"])
            or provenance["profile"] != "release" or manifest["target"] != "aarch64-apple-darwin"
            or Path(manifest["archive"]).name != manifest["archive"]):
        raise ValueError("nightly provenance does not match the validated workflow commit")
    for line in (directory / "SHA256SUMS").read_text().splitlines():
        digest, name = line.split("  ", 1)
        if Path(name).name != name or hashlib.sha256((directory / name).read_bytes()).hexdigest() != digest:
            raise ValueError(f"nightly asset checksum mismatch: {name}")
    if hashlib.sha256((directory / manifest["archive"]).read_bytes()).hexdigest() != manifest["sha256"]:
        raise ValueError("nightly archive disagrees with the installer manifest")
    notes = directory.parent / "notes.md"
    notes.write_text(f"Nightly from `{provenance['commit']}`; pinned {provenance['upstream_tag']}.\n\n"
                     f"[Hosted validation]({provenance['run_url']}) passed on macOS and Linux. "
                     "Apple Silicon archive installs either OMD Core or OMD+.\n\n"
                     "Opt in with `sh install.sh --channel nightly` or `omd update channel nightly`. "
                     "Stable releases remain tag-only.\n")
    tag = "v" + manifest["version"]
    assets = [directory / manifest["archive"], directory / "omd-release.json", directory / "nightly-provenance.json", directory / "SHA256SUMS"]
    command("gh", "release", "create", tag, *assets, "--repo", os.environ["GITHUB_REPOSITORY"],
            "--target", provenance["commit"], "--title", f"Nightly {manifest['version']}",
            "--notes-file", notes, "--draft", "--prerelease", "--latest=false")
    command("gh", "release", "edit", tag, "--repo", os.environ["GITHUB_REPOSITORY"], "--draft=false")


def report():
    repo, run_id = os.environ["GITHUB_REPOSITORY"], os.environ["GITHUB_RUN_ID"]
    jobs = json.loads(command("gh", "api", f"repos/{repo}/actions/runs/{run_id}/attempts/{os.environ['GITHUB_RUN_ATTEMPT']}/jobs?per_page=100"))["jobs"]
    failures = [job for job in jobs if job["conclusion"] in ("failure", "timed_out", "action_required")]
    title = f"[nightly] Failed run {run_id}"
    issues = json.loads(command("gh", "issue", "list", "--repo", repo, "--state", "all", "--search", f"{run_id} in:title", "--json", "number,title,state"))
    issue = next((item for item in issues if item["title"] == title), None)
    if not failures:
        if issue and os.environ.get("NIGHTLY_VALIDATION_RESULT") == os.environ.get("NIGHTLY_PUBLICATION_RESULT") == "success":
            command("gh", "issue", "close", issue["number"], "--repo", repo)
        return
    body = Path("nightly-failure.md")
    lines = [f"Commit: `{os.environ['GITHUB_SHA']}`", "", f"[Run and downloadable logs](https://github.com/{repo}/actions/runs/{run_id})", ""]
    for job in failures:
        steps = ", ".join(step["name"] for step in job.get("steps", []) if step["conclusion"] == "failure")
        lines.append(f"- [{job['name']}]({job['html_url']}): {steps or job['conclusion']}")
    for path in sorted(Path("reports").rglob("report.md")):
        lines += ["", f"### {path.relative_to('reports').parts[0]}", "", path.read_text()[-12_000:]]
    body.write_text("\n".join(lines) + "\n")
    if issue:
        command("gh", "issue", "edit", issue["number"], "--repo", repo, "--body-file", body)
        if issue["state"] == "CLOSED":
            command("gh", "issue", "reopen", issue["number"], "--repo", repo)
    else:
        command("gh", "issue", "create", "--repo", repo, "--title", title, "--body-file", body)


def main():
    parser = argparse.ArgumentParser(description="Provision verified build inputs and publish passing hosted nightlies")
    parser.add_argument("command", choices=("v8", "tests", "package", "publish", "report"))
    parser.add_argument("--directory", type=Path, default=Path("release"))
    parser.add_argument("--suite", choices=("native", "core"))
    args = parser.parse_args()
    if args.command == "publish":
        publish(args.directory)
    elif args.command == "tests":
        if not args.suite:
            parser.error("tests requires --suite")
        cargo_tests(args.suite)
    else:
        {"v8": v8, "package": package, "report": report}[args.command]()


if __name__ == "__main__":
    main()
