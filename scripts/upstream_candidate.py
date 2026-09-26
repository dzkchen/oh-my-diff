#!/usr/bin/env python3
import argparse
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import sys
import time
import tomllib
import urllib.request


ROOT = Path(__file__).resolve().parents[1]
UPSTREAM = "https://github.com/openai/codex.git"
RELEASES_API = "https://api.github.com/repos/openai/codex/releases?per_page=100"
DEFAULT_WORK_ROOT = Path("/private/tmp/omd-upstream-candidates")
LABEL = "dev.ohmydiff.upstream-candidate"
STABLE_TAG = re.compile(r"^rust-v(\d+)\.(\d+)\.(\d+)$")
AUTHORITY = re.compile(
    r"(sandbox|exec_policy|execpolicy|permission|approval|login/|auth|keyring|secrets|network[-_]proxy"
    r"|request_observer|tools/registry|tools/orchestrator|hook_runtime|extension-api)"
)
MIRRORS = (("codex-rs/omd", "runtime/omd"), ("codex-rs/ext/omd", "runtime/native"))
MIRROR_SKIP = {"target", "Cargo.lock", ".DS_Store", "examples", "tests"}
UNSUPPORTED = [
    "physical-terminal selection, clipboard, resize and restoration checks",
    "live provider requests and paid or subscription model behavior",
    "Linux and non-Apple-Silicon targets",
    "release archives, installers and prebuilt package paths",
    "snapshot changes that need human review before acceptance",
]
EXIT = {"no_new_release": 0, "duplicate": 0, "green": 0, "review_required": 2, "concurrent": 3}


class CandidateError(Exception):
    def __init__(self, status, detail, **extra):
        super().__init__(detail)
        self.status = status
        self.detail = detail
        self.extra = extra


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def file_sha(path):
    return sha256(path.read_bytes()) if path.is_file() else None


def git(cwd, *args, check=True):
    result = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True)
    if check and result.returncode:
        raise CandidateError("git_failed", f"git {' '.join(args)}: {result.stderr.strip()[-2000:]}")
    return result.stdout.strip()


def version_key(tag):
    return tuple(int(part) for part in STABLE_TAG.match(tag).groups())


def stable_releases(source):
    if source:
        releases = json.loads(Path(source).read_text())
    else:
        request = urllib.request.Request(RELEASES_API, headers={"Accept": "application/vnd.github+json", "User-Agent": "omd-upstream-candidate"})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                releases = json.load(response)
        except OSError as error:
            raise CandidateError("fetch_failed", f"release list unavailable: {error}")
    stable = [r["tag_name"] for r in releases if not r.get("prerelease") and not r.get("draft") and STABLE_TAG.match(r.get("tag_name", ""))]
    if not stable:
        raise CandidateError("fetch_failed", "no stable rust-v release found")
    return sorted(set(stable), key=version_key)


def remote_tag(url, tag):
    try:
        output = git(ROOT, "ls-remote", url, f"refs/tags/{tag}", f"refs/tags/{tag}^{{}}")
    except CandidateError as error:
        raise CandidateError("fetch_failed", error.detail)
    refs = dict(reversed(line.split("\t")) for line in output.splitlines() if line)
    if f"refs/tags/{tag}" not in refs:
        raise CandidateError("fetch_failed", f"{tag} is absent from {url}")
    peeled = refs.get(f"refs/tags/{tag}^{{}}")
    return (refs[f"refs/tags/{tag}"], peeled) if peeled else (None, refs[f"refs/tags/{tag}"])


def normalize_lock(checkout, version):
    path = checkout / "codex-rs/Cargo.lock"
    original = path.read_bytes()
    sections = original.decode().split("[[package]]")
    count = 0
    for index in range(1, len(sections)):
        package = tomllib.loads("[[package]]" + sections[index])["package"][0]
        if "source" not in package and package["version"] == "0.0.0":
            sections[index] = sections[index].replace('version = "0.0.0"', f'version = "{version}"', 1)
            count += 1
    normalized = "[[package]]".join(sections).encode()
    path.write_bytes(normalized)
    return sha256(original), sha256(normalized), count


def substitute(path, pattern, replacement, required=True):
    if not path.is_file():
        if required:
            raise CandidateError("review_required", f"expected pin constant file is missing: {path.name}")
        return 0
    text = path.read_text()
    updated, count = re.subn(pattern, replacement, text, flags=re.M)
    if required and count != 1:
        raise CandidateError("review_required", f"expected one pin constant in {path}, found {count}")
    path.write_text(updated)
    return count


def bump_constants(rs, tag, commit):
    version = tag.removeprefix("rust-v")
    substitute(rs / "omd/src/mode.rs", r'(pub const PINNED_UPSTREAM: &str = ")[^"]*(";)', rf"\g<1>{tag} / {commit}\g<2>")
    substitute(rs / "omd/src/mods.rs", r'(pub const CODEX_HOST_RELEASE: &str = ")[^"]*(";)', rf"\g<1>{version}\g<2>")
    substitute(rs / "ext/omd/Cargo.toml", r'^(version = ")[^"]*(")', rf"\g<1>{version}\g<2>")
    substitute(rs / "Cargo.lock", r'(name = "codex-omd-extension"\nversion = ")[^"]*(")', rf"\g<1>{version}\g<2>")


class Candidate:
    def __init__(self, args):
        self.repo = Path(args.repo).resolve()
        self.work_root = Path(args.work_root).resolve()
        self.url = args.upstream_url
        self.args = args
        self.commands = []
        self.report = {"schema": 1, "started": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")}
        self.active = json.loads((self.repo / "upstream.lock.json").read_text())
        self.manifest = json.loads((self.repo / "runtime/patches/manifest.json").read_text())

    def run(self, name, command, cwd, env=None, log=None):
        started = time.monotonic()
        result = subprocess.run(command, cwd=cwd, env={**os.environ, **(env or {})}, capture_output=True, text=True)
        entry = {"name": name, "command": command if isinstance(command, str) else " ".join(map(str, command)), "exit": result.returncode, "seconds": round(time.monotonic() - started, 1)}
        if log:
            log.write_text(result.stdout + result.stderr)
            entry["log"] = str(log)
        self.commands.append(entry)
        return result

    def protected_hashes(self):
        roots = [self.repo / "upstream.lock.json", self.repo / "mods/compatibility.json", *(self.repo / "runtime").glob("*.json"),
                 *(self.repo / "runtime/patches").glob("*"), self.repo / "mods/first-party/omd_typed_tasks/.omd/active-host.d.ts"]
        for _, mirror in MIRRORS:
            roots += [p for p in (self.repo / mirror).rglob("*") if not MIRROR_SKIP & set(p.relative_to(self.repo / mirror).parts)]
        return {str(p.relative_to(self.repo)): file_sha(p) for p in roots if p.is_file()}

    def execute(self):
        before = self.protected_hashes()
        try:
            return self.prepare()
        finally:
            self.report["active_files_unchanged"] = self.protected_hashes() == before

    def prepare(self):
        releases = stable_releases(self.args.release_source)
        target = self.args.release or releases[-1]
        if not STABLE_TAG.match(target):
            raise CandidateError("fetch_failed", f"{target} is not a stable rust-v release tag")
        pin = self.active["tag"]
        self.report.update(active={"tag": pin, "commit": self.active["commit"]}, target={"tag": target},
                           lag_stable_releases=len([t for t in releases if version_key(t) > version_key(pin)]))
        tag_object, commit = remote_tag(self.url, target)
        self.report["target"].update(tag_object=tag_object, commit=commit)
        if target == pin and commit == self.active["commit"]:
            return "no_new_release"
        if version_key(target) <= version_key(pin):
            raise CandidateError("review_required", f"{target} is not newer than the active pin {pin}")
        self.work_root.mkdir(parents=True, exist_ok=True)
        inputs = sha256(json.dumps([self.active, self.manifest["patch"]["sha256"], target, commit, file_sha(Path(__file__))]).encode())
        self.report["inputs_sha256"] = inputs
        marker = self.work_root / f"{target}.{inputs[:16]}.json"
        if marker.exists() and not self.args.force:
            previous = json.loads(marker.read_text())
            self.report.update(previous_report=previous.get("report"), previous_status=previous.get("status"))
            return "duplicate"
        self.marker = marker
        stamp = datetime.datetime.now().strftime("%Y%m%dT%H%M%S")
        self.dir = self.work_root / f"{target}-{stamp}"
        self.dir.mkdir()
        self.report["candidate_dir"] = str(self.dir)
        return self.build_candidate(target, tag_object, commit)

    def fetch(self, target):
        mirror = self.work_root / "mirror.git"
        if not mirror.exists():
            if self.run("mirror", ["git", "clone", "--quiet", "--bare", self.url, str(mirror)], self.work_root).returncode:
                shutil.rmtree(mirror, ignore_errors=True)
                raise CandidateError("fetch_failed", "could not create the upstream mirror")
        refs = [f"refs/tags/{t}:refs/tags/{t}" for t in {target, self.active["tag"]}]
        if self.run("fetch", ["git", "fetch", "--no-tags", "--force", self.url, *refs], mirror).returncode:
            raise CandidateError("fetch_failed", "could not fetch the active and target tags")
        return mirror

    def build_candidate(self, target, tag_object, commit):
        mirror = self.fetch(target)
        checkout = self.dir / "codex"
        git(self.dir, "clone", "--quiet", "--shared", "--no-checkout", str(mirror), str(checkout))
        if git(checkout, "rev-parse", f"{target}^{{commit}}") != commit:
            raise CandidateError("fetch_failed", f"fetched {target} does not match the remote commit {commit}")
        if tag_object and git(checkout, "rev-parse", target) != tag_object:
            raise CandidateError("fetch_failed", f"fetched {target} tag object differs from the remote")
        git(checkout, "config", "user.name", "omd-upstream-candidate")
        git(checkout, "config", "user.email", "omd-upstream-candidate@localhost")
        base = self.base_commit(checkout)
        new_version = target.removeprefix("rust-v")
        git(checkout, "checkout", "--quiet", "-b", "candidate", commit)
        raw, normalized, count = normalize_lock(checkout, new_version)
        git(checkout, "commit", "--quiet", "-am", f"normalize {target} lock")
        normalized_commit = git(checkout, "rev-parse", "HEAD")
        self.report["lock"] = {"cargo_lock_sha256": raw, "normalized_cargo_lock_sha256": normalized, "normalized_workspace_packages": count}
        changed = git(checkout, "diff", "--name-only", self.active["commit"], commit).splitlines()
        destinations = set(self.manifest["files"])
        overlap = sorted(set(changed) & destinations)
        self.report["upstream_changes"] = {"paths": len(changed), "patch_destinations_changed": overlap}
        picked = subprocess.run(["git", "cherry-pick", base], cwd=checkout, capture_output=True, text=True)
        if picked.returncode:
            conflicts = git(checkout, "diff", "--name-only", "--diff-filter=U").splitlines()
            raise CandidateError("conflict", f"{len(conflicts)} patch destination(s) conflict with {target}", conflicts=conflicts,
                                 repair=f"resolve the conflicts in {checkout} (git status), then `git cherry-pick --continue` and rerun with --release {target} --force after updating the active patch")
        self.report["resolved_patch_hunks"] = {"auto_merged_files": overlap, "conflicts": []}
        rs = checkout / "codex-rs"
        bump_constants(rs, target, commit)
        git(checkout, "commit", "--quiet", "-am", "bump OMD pin constants")
        authority = [path for path in overlap if AUTHORITY.search(path)]
        self.report["authority_boundary_changes"] = authority
        proposal = self.write_proposal(checkout, normalized_commit, target, tag_object, commit, raw, normalized, count)
        self.replay(proposal, mirror, commit, checkout)
        failed = self.checks(checkout, changed)
        if failed:
            raise CandidateError("check_failed", f"{len(failed)} check(s) failed: {', '.join(failed)}")
        return "review_required" if authority else "green"

    def base_commit(self, checkout):
        pin = self.active
        git(checkout, "checkout", "--quiet", "-b", "active", pin["commit"])
        raw, normalized, _ = normalize_lock(checkout, pin["tag"].removeprefix("rust-v"))
        if raw != pin["cargo_lock_sha256"] or normalized != pin["normalized_cargo_lock_sha256"]:
            raise CandidateError("review_required", "the active pin's Cargo.lock no longer matches upstream.lock.json")
        git(checkout, "commit", "--quiet", "-am", "normalize active lock")
        patch = self.repo / self.manifest["patch"]["path"]
        if file_sha(patch) != self.manifest["patch"]["sha256"]:
            raise CandidateError("review_required", "the active runtime patch hash differs from its manifest")
        git(checkout, "apply", "--binary", str(patch))
        for name, hashes in self.manifest["files"].items():
            if file_sha(checkout / name) != hashes["after"]:
                raise CandidateError("review_required", f"active patch does not reproduce manifest hash for {name}")
        git(checkout, "add", "-A")
        git(checkout, "commit", "--quiet", "-m", "active OMD patch")
        return git(checkout, "rev-parse", "HEAD")

    def write_proposal(self, checkout, normalized_commit, target, tag_object, commit, raw, normalized, count):
        version = target.removeprefix("rust-v")
        proposed = self.dir / "proposed"
        patch_name = f"runtime/patches/controlled-contributor-{version}.patch"
        patch_bytes = subprocess.run(["git", "diff", "--binary", normalized_commit, "HEAD"], cwd=checkout, capture_output=True, check=True).stdout
        files = {}
        for name in git(checkout, "diff", "--name-only", "--no-renames", normalized_commit, "HEAD").splitlines():
            before = subprocess.run(["git", "show", f"{normalized_commit}:{name}"], cwd=checkout, capture_output=True)
            files[name] = {"before": sha256(before.stdout) if before.returncode == 0 else None, "after": file_sha(checkout / name)}
        overlay = {patch_name: patch_bytes}
        manifest = {"schema": 1, "upstream_commit": commit, "baseline": self.manifest["baseline"],
                    "patch": {"path": patch_name, "sha256": sha256(patch_bytes)}, "files": dict(sorted(files.items()))}
        overlay["runtime/patches/manifest.json"] = (json.dumps(manifest, indent=2) + "\n").encode()
        toolchain = tomllib.loads((checkout / "codex-rs/rust-toolchain.toml").read_text())["toolchain"]
        lock = dict(self.active)
        lock.update(tag=target, tag_object=tag_object, commit=commit, rust_toolchain=toolchain["channel"],
                    rust_components=toolchain.get("components", lock.get("rust_components")),
                    cargo_lock_sha256=raw, normalized_cargo_lock_sha256=normalized, normalized_workspace_packages=count,
                    lock_normalization=f"{count} source-less workspace package versions: 0.0.0 -> {version}; external dependencies unchanged",
                    runtime_patches=[{"path": patch_name, "sha256": sha256(patch_bytes)}],
                    compatibility_evidence=f".docs/audits/evidence/upstream-candidates/{target}/report.json")
        overlay["upstream.lock.json"] = (json.dumps(lock, indent=2) + "\n").encode()
        for source, mirror in MIRRORS:
            for path in (checkout / source).rglob("*"):
                relative = path.relative_to(checkout / source)
                if path.is_file() and not MIRROR_SKIP & set(relative.parts):
                    destination = f"{mirror}/{relative}"
                    if file_sha(self.repo / destination) != file_sha(path):
                        overlay[destination] = path.read_bytes()
        observer = checkout / "codex-rs/codex-api/src/request_observer.rs"
        if file_sha(observer) != file_sha(self.repo / "runtime/native/src/request_observer.rs"):
            overlay["runtime/native/src/request_observer.rs"] = observer.read_bytes()
        old = self.active["tag"].removeprefix("rust-v")
        for name, pattern in (("mods/compatibility.json", rf'("codex": ")' + re.escape(old) + '(")'),
                              ("mods/first-party/omd_typed_tasks/.omd/active-host.d.ts", r"(ActiveCodexRelease = ')" + re.escape(old) + "(')")):
            text = (self.repo / name).read_text() if (self.repo / name).is_file() else None
            if text is not None:
                overlay[name] = re.sub(pattern, rf"\g<1>{version}\g<2>", text).encode()
        for name, data in overlay.items():
            (proposed / name).parent.mkdir(parents=True, exist_ok=True)
            (proposed / name).write_bytes(data)
        diff = self.dir / "proposal.diff"
        staging = self.dir / "proposal-staging"
        git(self.dir, "init", "--quiet", str(staging))
        for name in overlay:
            if (self.repo / name).is_file():
                (staging / name).parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(self.repo / name, staging / name)
        git(staging, "add", "-A")
        git(staging, "-c", "user.name=omd", "-c", "user.email=omd@localhost", "commit", "--quiet", "--allow-empty", "-m", "active")
        for name, data in overlay.items():
            (staging / name).parent.mkdir(parents=True, exist_ok=True)
            (staging / name).write_bytes(data)
        git(staging, "add", "-A")
        diff.write_bytes(subprocess.run(["git", "diff", "--cached", "--binary", "HEAD"], cwd=staging, capture_output=True, check=True).stdout)
        shutil.rmtree(staging)
        check = self.run("proposal-apply-check", ["git", "apply", "--check", str(diff)], self.repo)
        if check.returncode:
            raise CandidateError("review_required", f"proposal does not apply to the working tree: {check.stderr.strip()}")
        mentions = self.run("stale-mentions", ["git", "grep", "-l", "-F", old, "--", ".", ":!runtime/patches", ":!*.lock.json"], self.repo)
        self.report["proposal"] = {"diff": str(diff), "files": sorted(overlay), "patch_sha256": sha256(patch_bytes), "destinations": len(files),
                                   "review_mentions_of_old_version": [l for l in mentions.stdout.splitlines() if l not in overlay]}
        return proposed

    def replay(self, proposed, mirror, commit, candidate):
        root = self.dir / "replay-root"
        for name in ("scripts/normalize_upstream_lock.py", "scripts/apply_runtime_patch.py"):
            (root / name).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(self.repo / name, root / name)
        shutil.copytree(proposed / "runtime", root / "runtime", dirs_exist_ok=True)
        shutil.copy2(proposed / "upstream.lock.json", root / "upstream.lock.json")
        fresh = self.dir / "replay"
        git(self.dir, "clone", "--quiet", "--shared", "--no-checkout", str(mirror), str(fresh))
        git(fresh, "checkout", "--quiet", commit)
        steps = [("replay-normalize", "normalize_upstream_lock.py", None), ("replay-apply", "apply_runtime_patch.py", "Applied and verified"),
                 ("replay-second-apply", "apply_runtime_patch.py", "already applied")]
        for name, script, expected in steps:
            result = self.run(name, [sys.executable, str(root / "scripts" / script), str(fresh)], self.dir)
            if result.returncode or (expected and expected not in result.stdout):
                raise CandidateError("review_required", f"{name} failed: {(result.stdout + result.stderr).strip()[-500:]}")
        drift = self.parity(fresh, candidate)
        self.report["replay"] = {"fresh_apply": "pass", "second_apply": "no_op", "source_parity": "pass" if not drift else drift}
        if drift:
            raise CandidateError("review_required", f"replayed tree differs from the candidate: {drift[:5]}")

    def parity(self, fresh, candidate):
        names = git(candidate, "ls-files").splitlines()
        return [name for name in names if file_sha(fresh / name) != file_sha(candidate / name)]

    def checks(self, checkout, changed):
        if self.args.check_command:
            results = [self.run(f"check-{i}", command, checkout / "codex-rs", log=self.dir / f"check-{i}.log") for i, command in enumerate(self.args.check_command)]
            return [f"check-{i}" for i, r in enumerate(results) if r.returncode]
        if self.args.skip_checks:
            self.report["checks_skipped"] = True
            return []
        rs = checkout / "codex-rs"
        env = {"CARGO_TARGET_DIR": str(self.work_root / "target"), "CARGO_INCREMENTAL": "0", "RUST_MIN_STACK": "8388608"}
        node = subprocess.run(["mise", "which", "node"], cwd=self.repo, capture_output=True, text=True)
        if node.returncode == 0:
            env["OMD_TEST_NODE"] = node.stdout.strip()
        toolchain = "+" + tomllib.loads((rs / "rust-toolchain.toml").read_text())["toolchain"]["channel"]
        crates = {}
        for path in changed + list(self.manifest["files"]):
            parts = Path(path).parts
            for depth in (3, 2):
                manifest = checkout.joinpath(*parts[:depth], "Cargo.toml") if len(parts) > depth else None
                if manifest and manifest.is_file() and parts[0] == "codex-rs":
                    name = tomllib.loads(manifest.read_text()).get("package", {}).get("name")
                    if name:
                        crates.setdefault(name, set()).add("upstream" if path in changed else "patch")
                        break
        scoped = sorted(name for name, sides in crates.items() if sides == {"upstream", "patch"} and name not in ("codex-tui", "codex-core"))
        plan = [("build", ["cargo", toolchain, "build", "--locked", "-p", "codex-cli", "--bin", "codex", "-p", "codex-omd", "--bin", "omd-mod"]),
                ("fmt", ["cargo", toolchain, "fmt", "--all", "--", "--check"]),
                ("omd-tests", ["cargo", toolchain, "test", "--locked", "--no-fail-fast", "-p", "codex-omd", "-p", "codex-omd-extension"])]
        if "codex-tui" in crates:
            plan.append(("tui-tests", ["cargo", toolchain, "test", "--locked", "--no-fail-fast", "-p", "codex-tui", "--lib"]))
        if "codex-core" in crates:
            plan.append(("core-tests", ["cargo", toolchain, "test", "--locked", "--no-fail-fast", "-p", "codex-core", "--lib", "--", "thread_manager", "tools::", "compact", "unified_exec"]))
        if scoped:
            plan.append(("crate-tests", ["cargo", toolchain, "test", "--locked", "--no-fail-fast", *[a for c in scoped for a in ("-p", c)]]))
        self.report["scoped_crates"] = scoped
        failed = []
        for name, command in plan:
            if self.run(name, ["nice", "-n", "10", *command], rs, env=env, log=self.dir / f"{name}.log").returncode:
                failed.append(name)
        return failed

    def finish(self, status, detail=None, extra=None):
        self.report.update(status=status, commands=self.commands, unsupported_coverage=UNSUPPORTED,
                           finished=datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"))
        if detail:
            self.report["detail"] = detail
        self.report.update(extra or {})
        directory = getattr(self, "dir", None)
        if getattr(self, "marker", None):
            self.marker.write_text(json.dumps({"status": status, "report": str(directory / "report.json")}))
        if directory:
            (directory / "report.json").write_text(json.dumps(self.report, indent=2) + "\n")
            (directory / "report.md").write_text(markdown(self.report))
            evidence = self.repo / ".docs/audits/evidence/upstream-candidates" / self.report["target"]["tag"]
            if (self.repo / ".docs").is_dir() and status in ("green", "review_required"):
                evidence.mkdir(parents=True, exist_ok=True)
                shutil.copy2(directory / "report.json", evidence / "report.json")
        return self.report


def markdown(report):
    lines = [f"# Upstream candidate {report['target']['tag']}: {report['status']}", ""]
    lines.append(f"Active pin `{report['active']['tag']}` ({report['active']['commit']}); target commit `{report['target'].get('commit')}`; "
                 f"{report.get('lag_stable_releases', 0)} newer stable release(s).")
    if report.get("detail"):
        lines += ["", f"**Detail:** {report['detail']}"]
    if report.get("conflicts"):
        lines += ["", "## Conflicts", *[f"- `{name}`" for name in report["conflicts"]], "", f"Repair: {report.get('repair')}"]
    changes = report.get("upstream_changes")
    if changes:
        lines += ["", f"## Upstream changes", f"{changes['paths']} changed paths; {len(changes['patch_destinations_changed'])} are OMD patch destinations."]
        lines += [f"- `{name}`" for name in changes["patch_destinations_changed"]]
    if report.get("authority_boundary_changes"):
        lines += ["", "## Authority boundary review required", *[f"- `{name}`" for name in report["authority_boundary_changes"]]]
    if report.get("proposal"):
        lines += ["", "## Proposal", f"`{report['proposal']['diff']}` changes {len(report['proposal']['files'])} file(s); "
                  "review, then apply with `git apply` and run the pin acceptance gates. Review these files for the old version:"]
        lines += [f"- `{name}`" for name in report["proposal"]["review_mentions_of_old_version"]]
    lines += ["", "## Commands", "| Step | Exit | Seconds | Command |", "| --- | --- | --- | --- |"]
    lines += [f"| {c['name']} | {c['exit']} | {c['seconds']} | `{c['command']}` |" for c in report.get("commands", [])]
    lines += ["", "## Not covered", *[f"- {item}" for item in report["unsupported_coverage"]], ""]
    return "\n".join(lines)


def run(args):
    work_root = Path(args.work_root)
    work_root.mkdir(parents=True, exist_ok=True)
    with open(work_root / ".lock", "w") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print(json.dumps({"status": "concurrent", "detail": "another candidate run holds the lock"}))
            return EXIT["concurrent"]
        candidate = Candidate(args)
        try:
            status, detail, extra = candidate.execute(), None, None
        except CandidateError as error:
            status, detail, extra = error.status, error.detail, error.extra
        report = candidate.finish(status, detail, extra)
    summary = {key: report.get(key) for key in ("status", "detail", "candidate_dir", "lag_stable_releases")}
    summary["target"] = report.get("target", {}).get("tag")
    print(json.dumps(summary))
    return EXIT.get(status, 1)


def plist_path():
    return Path.home() / "Library/LaunchAgents" / f"{LABEL}.plist"


def schedule(args):
    path = plist_path()
    if args.action == "status":
        print(json.dumps({"installed": path.exists(), "plist": str(path)}))
        return 0
    if args.action == "uninstall":
        subprocess.run(["launchctl", "bootout", f"gui/{os.getuid()}", str(path)], capture_output=True)
        path.unlink(missing_ok=True)
        print(json.dumps({"installed": False}))
        return 0
    logs = Path(args.work_root) / "logs"
    logs.mkdir(parents=True, exist_ok=True)
    mise = shutil.which("mise") or "mise"
    config = {"Label": LABEL, "ProgramArguments": [mise, "exec", "--", sys.executable, str(Path(__file__).resolve()), "run", "--work-root", str(args.work_root)],
              "WorkingDirectory": str(ROOT), "StartCalendarInterval": {"Hour": args.hour, "Minute": args.minute},
              "LowPriorityIO": True, "ProcessType": "Background", "Nice": 10,
              "StandardOutPath": str(logs / "launchd.out"), "StandardErrorPath": str(logs / "launchd.err")}
    data = plistlib.dumps(config)
    if args.action == "print":
        sys.stdout.write(data.decode())
        return 0
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    subprocess.run(["launchctl", "bootout", f"gui/{os.getuid()}", str(path)], capture_output=True)
    loaded = subprocess.run(["launchctl", "bootstrap", f"gui/{os.getuid()}", str(path)], capture_output=True, text=True)
    print(json.dumps({"installed": loaded.returncode == 0, "plist": str(path), "error": loaded.stderr.strip() or None}))
    return loaded.returncode


def main(argv=None):
    parser = argparse.ArgumentParser(description="Prepare an isolated, reviewable OMD candidate for the latest stable Codex release.")
    sub = parser.add_subparsers(dest="command", required=True)
    candidate = sub.add_parser("run", help="compare the active pin with the latest stable release and prepare a candidate")
    candidate.add_argument("--repo", default=str(ROOT))
    candidate.add_argument("--work-root", default=str(DEFAULT_WORK_ROOT))
    candidate.add_argument("--upstream-url", default=UPSTREAM)
    candidate.add_argument("--release", help="stable tag to prepare instead of the latest")
    candidate.add_argument("--release-source", help="JSON release list used instead of the GitHub API")
    candidate.add_argument("--check-command", action="append", help="replace the scoped checks with this shell command (repeatable)")
    candidate.add_argument("--skip-checks", action="store_true")
    candidate.add_argument("--force", action="store_true", help="prepare again even when identical inputs already have a report")
    timer = sub.add_parser("schedule", help="manage the opt-in launchd schedule")
    timer.add_argument("action", choices=("install", "uninstall", "status", "print"))
    timer.add_argument("--hour", type=int, default=9)
    timer.add_argument("--minute", type=int, default=30)
    timer.add_argument("--work-root", default=str(DEFAULT_WORK_ROOT))
    args = parser.parse_args(argv)
    if args.command == "run":
        if args.check_command:
            args.check_command = [["/bin/sh", "-c", command] for command in args.check_command]
        return run(args)
    return schedule(args)


if __name__ == "__main__":
    sys.exit(main())
