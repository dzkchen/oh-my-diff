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
from scripts import authority_broker, package as release_package, profile_acceptance, release_lock


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


def nightly_version(frozen):
    base, _, prerelease = frozen.partition("-")
    if not prerelease:
        major, minor, patch = base.split(".")
        base = f"{major}.{minor}.{int(patch) + 1}"
    return f"{base}-nightly.{datetime.datetime.now(datetime.UTC):%Y%m%d%H%M%S}.{os.environ['GITHUB_RUN_ID']}.{os.environ['GITHUB_RUN_ATTEMPT']}"


def package(version=None):
    batch = build.batch_dir(nightly.BATCH)
    shutil.rmtree(batch / "target")
    artifact_dir = batch / "artifacts"
    frozen = json.loads(release_lock.OUTPUT.read_text())["version"]
    if version is None:
        version = nightly_version(frozen)
    elif version != frozen:
        raise ValueError(f"release {version} does not match the committed release lock version {frozen}")
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
    (output / "provenance.json").write_text(json.dumps(provenance, indent=2) + "\n")
    shutil.copy2("install.sh", output / "install.sh")
    command("git", "archive", "--format=tar.gz", f"--prefix=oh-my-diff-{version}/",
            "--output", output / f"oh-my-diff-{version}-source.tar.gz", "HEAD")
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


def sign(manifest):
    key = os.environ.get("OMD_RELEASE_SIGNING_KEY")
    if not key:
        raise ValueError("OMD_RELEASE_SIGNING_KEY is required to sign omd-release.json")
    with tempfile.TemporaryDirectory() as temporary:
        private = Path(temporary) / "key"
        private.write_text(key.strip() + "\n")
        private.chmod(0o600)
        command("ssh-keygen", "-Y", "sign", "-q", "-f", private, "-n", authority_broker.SIGNING_NAMESPACE, manifest)
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
    sums = (directory / "SHA256SUMS").read_text().splitlines()
    for line in sums:
        digest, name = line.split("  ", 1)
        if Path(name).name != name or hashlib.sha256((directory / name).read_bytes()).hexdigest() != digest:
            raise ValueError(f"release asset checksum mismatch: {name}")
    if hashlib.sha256((directory / manifest["archive"]).read_bytes()).hexdigest() != manifest["sha256"]:
        raise ValueError("release archive disagrees with the installer manifest")
    assets = [directory / line.split("  ", 1)[1] for line in sums] + [directory / "SHA256SUMS", sign(directory / "omd-release.json")]
    if not notes:
        notes = directory.parent / "notes.md"
        notes.write_text(f"Nightly from `{provenance['commit']}`; pinned {provenance['upstream_tag']}.\n\n"
                         f"[Hosted validation]({provenance['run_url']}) passed on macOS and Linux. "
                         "Apple Silicon archive installs either OMD Core or OMD+.\n\n"
                         "Opt in with `sh install.sh --channel nightly` or `omd update channel nightly`. "
                         "Stable releases remain tag-only.\n")
        title, latest = f"Nightly {version}", ["--prerelease", "--latest=false"]
    else:
        title, latest = f"Oh My Diff {version}", ["--prerelease", "--latest=false"] if "-" in version else ["--latest"]
    create = ["gh", "release", "create", tag, *assets, "--repo", os.environ["GITHUB_REPOSITORY"],
              "--target", provenance["commit"], "--title", title, "--notes-file", notes, "--draft", *latest]
    edit = ["gh", "release", "edit", tag, "--repo", os.environ["GITHUB_REPOSITORY"], "--draft=false", latest[-1]]
    if dry_run:
        print("dry run verified", ", ".join(path.name for path in assets))
        print(*map(str, create))
        print(*map(str, edit))
        return
    command(*create)
    command(*edit)


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
    parser = argparse.ArgumentParser(description="Provision verified build inputs and publish passing hosted nightlies and tagged releases")
    parser.add_argument("command", choices=("v8", "tests", "package", "publish", "report"))
    parser.add_argument("--directory", type=Path, default=Path("release"))
    parser.add_argument("--suite", choices=("native", "core"))
    parser.add_argument("--version", help="package this stable release version instead of a nightly")
    parser.add_argument("--notes", type=Path, help="publish a stable release with these notes")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if args.command == "publish":
        publish(args.directory, args.notes, args.dry_run)
    elif args.command == "package":
        package(args.version)
    elif args.command == "tests":
        if not args.suite:
            parser.error("tests requires --suite")
        cargo_tests(args.suite)
    else:
        {"v8": v8, "report": report}[args.command]()


if __name__ == "__main__":
    main()
