import fcntl
import hashlib
import importlib.util
import io
import json
from contextlib import redirect_stdout
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("upstream_candidate", ROOT / "scripts/upstream_candidate.py")
candidate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(candidate)

LOCK = """version = 4

[[package]]
name = "codex-core"
version = "0.0.0"

[[package]]
name = "codex-tui"
version = "0.0.0"

[[package]]
name = "serde"
version = "1.0.0"
source = "registry+https://github.com/rust-lang/crates.io-index"
"""
SANDBOX = "fn one() {}\nfn two() {}\nfn three() {}\nfn four() {}\nfn five() {}\n"


def git(cwd, *args):
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


def write(root, files):
    for name, text in files.items():
        (root / name).parent.mkdir(parents=True, exist_ok=True)
        (root / name).write_text(text)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None


class UpstreamCandidateTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.base = Path(self.temporary.name).resolve()
        self.upstream = self.base / "upstream"
        self.repo = self.base / "repo"
        self.work = self.base / "work"
        self.make_upstream()
        self.make_repo()
        self.original = self.snapshot()

    def tearDown(self):
        self.temporary.cleanup()

    def commit_tag(self, tag, files):
        write(self.upstream, files)
        git(self.upstream, "add", "-A")
        git(self.upstream, "commit", "--quiet", "-m", tag)
        git(self.upstream, "tag", "-a", tag, "-m", tag)
        return git(self.upstream, "rev-parse", f"{tag}^{{commit}}")

    def make_upstream(self):
        self.upstream.mkdir()
        git(self.upstream, "init", "--quiet", "-b", "main")
        git(self.upstream, "config", "user.name", "upstream")
        git(self.upstream, "config", "user.email", "upstream@localhost")
        self.v1 = self.commit_tag("rust-v1.0.0", {
            "codex-rs/Cargo.lock": LOCK,
            "codex-rs/rust-toolchain.toml": '[toolchain]\nchannel = "1.95.0"\ncomponents = ["clippy"]\n',
            "codex-rs/core/src/lib.rs": "fn core() {}\n",
            "codex-rs/tui/src/lib.rs": "line one\nline two\nline three\n",
            "codex-rs/exec/src/sandbox.rs": SANDBOX,
        })
        self.v2 = self.commit_tag("rust-v1.1.0", {"codex-rs/core/src/lib.rs": "fn core() {}\nfn newer() {}\n"})
        git(self.upstream, "checkout", "--quiet", "-b", "conflict", "rust-v1.0.0")
        self.v3 = self.commit_tag("rust-v1.2.0", {"codex-rs/tui/src/lib.rs": "line one\nline two upstream\nline three\n"})
        git(self.upstream, "checkout", "--quiet", "-b", "authority", "rust-v1.0.0")
        self.v4 = self.commit_tag("rust-v1.3.0", {"codex-rs/exec/src/sandbox.rs": SANDBOX.replace("five", "five_upstream")})

    def make_repo(self):
        self.repo.mkdir()
        checkout = self.base / "build"
        git(self.base, "clone", "--quiet", str(self.upstream), str(checkout))
        git(checkout, "checkout", "--quiet", "rust-v1.0.0")
        raw = sha(checkout / "codex-rs/Cargo.lock")
        _, normalized, count = candidate.normalize_lock(checkout, "1.0.0")
        normalized_lock = (checkout / "codex-rs/Cargo.lock").read_text()
        git(checkout, "-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "--quiet", "-am", "normalize")
        omd = {
            "codex-rs/omd/src/mode.rs": 'pub const PINNED_UPSTREAM: &str = "rust-v1.0.0 / %s";\n' % self.v1,
            "codex-rs/omd/src/mods.rs": 'pub const CODEX_HOST_RELEASE: &str = "1.0.0";\n',
            "codex-rs/ext/omd/Cargo.toml": '[package]\nname = "codex-omd-extension"\nversion = "1.0.0"\n',
            "codex-rs/ext/omd/src/lib.rs": "pub fn extension() {}\n",
            "codex-rs/codex-api/src/request_observer.rs": "pub fn observe() {}\n",
            "codex-rs/tui/src/lib.rs": "line one\nline two omd\nline three\n",
            "codex-rs/exec/src/sandbox.rs": SANDBOX.replace("one", "one_omd"),
            "codex-rs/Cargo.lock": normalized_lock + '\n[[package]]\nname = "codex-omd-extension"\nversion = "1.0.0"\n',
        }
        write(checkout, omd)
        git(checkout, "add", "-A")
        patch = subprocess.run(["git", "diff", "--cached", "--binary"], cwd=checkout, capture_output=True, check=True).stdout
        files = {}
        for name in git(checkout, "diff", "--cached", "--name-only").splitlines():
            before = subprocess.run(["git", "show", f"HEAD:{name}"], cwd=checkout, capture_output=True)
            files[name] = {"before": hashlib.sha256(before.stdout).hexdigest() if before.returncode == 0 else None, "after": sha(checkout / name)}
        patch_name = "runtime/patches/controlled-contributor-1.0.0.patch"
        (self.repo / "runtime/patches").mkdir(parents=True)
        (self.repo / patch_name).write_bytes(patch)
        manifest = {"schema": 1, "upstream_commit": self.v1, "baseline": "normalize first", "patch": {"path": patch_name, "sha256": hashlib.sha256(patch).hexdigest()}, "files": files}
        tag_object = git(self.upstream, "rev-parse", "rust-v1.0.0")
        lock = {"repository": str(self.upstream), "tag": "rust-v1.0.0", "tag_object": tag_object, "commit": self.v1, "rust_toolchain": "1.95.0",
                "rust_components": ["clippy"], "verified_target": "aarch64-apple-darwin", "cargo_lock_sha256": raw,
                "normalized_cargo_lock_sha256": normalized, "normalized_workspace_packages": count, "lock_normalization": "fixture",
                "runtime_patches": [{"path": patch_name, "sha256": hashlib.sha256(patch).hexdigest()}], "compatibility_evidence": "fixture"}
        write(self.repo, {
            "upstream.lock.json": json.dumps(lock, indent=2) + "\n",
            "runtime/patches/manifest.json": json.dumps(manifest, indent=2) + "\n",
            "runtime/patches/controlled-contributor.patch": "historical frozen patch\n",
            "runtime/lean-candidate.lock.json": '{"frozen": true}\n',
            "runtime/omd/src/mode.rs": omd["codex-rs/omd/src/mode.rs"],
            "runtime/omd/src/mods.rs": omd["codex-rs/omd/src/mods.rs"],
            "runtime/native/Cargo.toml": omd["codex-rs/ext/omd/Cargo.toml"],
            "runtime/native/src/lib.rs": omd["codex-rs/ext/omd/src/lib.rs"],
            "runtime/native/src/request_observer.rs": omd["codex-rs/codex-api/src/request_observer.rs"],
            "mods/compatibility.json": '{\n  "host": {\n    "codex": "1.0.0"\n  }\n}\n',
            "docs.md": "Pinned Codex 1.0.0.\n",
        })
        (self.repo / "scripts").mkdir()
        for name in ("normalize_upstream_lock.py", "apply_runtime_patch.py"):
            shutil.copy2(ROOT / "scripts" / name, self.repo / "scripts" / name)
        git(self.repo, "init", "--quiet", "-b", "main")
        git(self.repo, "add", "-A")
        git(self.repo, "-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "--quiet", "-m", "active")

    def snapshot(self):
        return {str(p.relative_to(self.repo)): sha(p) for p in self.repo.rglob("*") if p.is_file() and ".git" not in p.parts and ".docs" not in p.parts}

    def releases(self, *tags):
        path = self.base / "releases.json"
        path.write_text(json.dumps([{"tag_name": tag, "prerelease": "alpha" in tag, "draft": False} for tag in (*tags, "rust-v9.0.0-alpha.1")]))
        return str(path)

    def run_candidate(self, *tags, extra=(), upstream=None):
        args = ["run", "--repo", str(self.repo), "--work-root", str(self.work), "--upstream-url", str(upstream or self.upstream),
                "--release-source", self.releases(*tags), *extra]
        output = io.StringIO()
        with redirect_stdout(output):
            code = candidate.main(args)
        summary = json.loads(output.getvalue().strip().splitlines()[-1])
        report = json.loads(Path(summary["candidate_dir"], "report.json").read_text()) if summary.get("candidate_dir") else None
        return code, summary, report

    def assert_active_unchanged(self):
        self.assertEqual(self.snapshot(), self.original)

    def test_no_new_release_is_a_no_op(self):
        code, summary, report = self.run_candidate("rust-v1.0.0")
        self.assertEqual((code, summary["status"], summary["lag_stable_releases"]), (0, "no_new_release", 0))
        self.assertIsNone(report)
        self.assert_active_unchanged()

    def test_clean_candidate_replays_and_rolls_back(self):
        code, summary, report = self.run_candidate("rust-v1.0.0", "rust-v1.1.0", extra=["--check-command", "true"])
        self.assertEqual((code, summary["status"], summary["target"]), (0, "green", "rust-v1.1.0"))
        self.assertEqual(report["lag_stable_releases"], 1)
        self.assertEqual(report["target"]["commit"], self.v2)
        self.assertEqual(report["replay"], {"fresh_apply": "pass", "second_apply": "no_op", "source_parity": "pass"})
        self.assertTrue(report["active_files_unchanged"])
        self.assertIn("docs.md", report["proposal"]["review_mentions_of_old_version"])
        proposal = Path(report["proposal"]["diff"])
        self.assertNotIn("runtime/lean-candidate.lock.json", report["proposal"]["files"])
        self.assertNotIn("runtime/patches/controlled-contributor.patch", report["proposal"]["files"])
        self.assert_active_unchanged()
        git(self.repo, "apply", str(proposal))
        lock = json.loads((self.repo / "upstream.lock.json").read_text())
        self.assertEqual((lock["tag"], lock["commit"]), ("rust-v1.1.0", self.v2))
        self.assertIn('"rust-v1.1.0 / %s"' % self.v2, (self.repo / "runtime/omd/src/mode.rs").read_text())
        self.assertIn('"codex": "1.1.0"', (self.repo / "mods/compatibility.json").read_text())
        fresh = self.base / "fresh"
        git(self.base, "clone", "--quiet", str(self.upstream), str(fresh))
        git(fresh, "checkout", "--quiet", self.v2)
        for script, expected in (("normalize_upstream_lock.py", "Normalized"), ("apply_runtime_patch.py", "Applied and verified"), ("apply_runtime_patch.py", "already applied")):
            output = subprocess.run(["python3", str(self.repo / "scripts" / script), str(fresh)], capture_output=True, text=True, check=True).stdout
            self.assertIn(expected, output)
        self.assertIn("line two omd", (fresh / "codex-rs/tui/src/lib.rs").read_text())
        self.assertIn("fn newer", (fresh / "codex-rs/core/src/lib.rs").read_text())
        git(self.repo, "apply", "-R", str(proposal))
        self.assert_active_unchanged()

    def test_duplicate_and_concurrent_runs_do_not_rebuild(self):
        first = self.run_candidate("rust-v1.0.0", "rust-v1.1.0", extra=["--check-command", "true"])
        second = self.run_candidate("rust-v1.0.0", "rust-v1.1.0", extra=["--check-command", "true"])
        self.assertEqual(first[1]["status"], "green")
        self.assertEqual((second[0], second[1]["status"], second[2]), (0, "duplicate", None))
        with open(self.work / ".lock", "w") as held:
            fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
            output = io.StringIO()
            with redirect_stdout(output):
                code = candidate.main(["run", "--repo", str(self.repo), "--work-root", str(self.work), "--upstream-url", str(self.upstream),
                                       "--release-source", self.releases("rust-v1.0.0", "rust-v1.1.0"), "--force", "--check-command", "true"])
        self.assertEqual((code, json.loads(output.getvalue())["status"]), (3, "concurrent"))
        self.assertEqual(len([p for p in self.work.iterdir() if p.is_dir() and p.name.startswith("rust-v1.1.0-")]), 1)
        self.assert_active_unchanged()

    def test_patch_conflict_reports_repair_and_keeps_pin(self):
        code, summary, report = self.run_candidate("rust-v1.0.0", "rust-v1.2.0", extra=["--check-command", "true"])
        self.assertEqual((code, summary["status"]), (1, "conflict"))
        self.assertEqual(report["conflicts"], ["codex-rs/tui/src/lib.rs"])
        self.assertIn("cherry-pick --continue", report["repair"])
        self.assertIn("## Conflicts", Path(summary["candidate_dir"], "report.md").read_text())
        self.assertNotIn("proposal", report)
        self.assert_active_unchanged()

    def test_failing_check_blocks_the_candidate(self):
        code, summary, report = self.run_candidate("rust-v1.0.0", "rust-v1.1.0", extra=["--check-command", "exit 7"])
        self.assertEqual((code, summary["status"]), (1, "check_failed"))
        self.assertEqual([c["exit"] for c in report["commands"] if c["name"] == "check-0"], [7])
        self.assert_active_unchanged()

    def test_authority_boundary_change_requires_review(self):
        code, summary, report = self.run_candidate("rust-v1.0.0", "rust-v1.3.0", extra=["--check-command", "true"])
        self.assertEqual((code, summary["status"]), (2, "review_required"))
        self.assertEqual(report["authority_boundary_changes"], ["codex-rs/exec/src/sandbox.rs"])
        self.assert_active_unchanged()

    def test_failed_fetch_leaves_the_pin(self):
        code, summary, _ = self.run_candidate("rust-v1.0.0", "rust-v1.1.0", upstream=self.base / "missing")
        self.assertEqual((code, summary["status"]), (1, "fetch_failed"))
        self.assert_active_unchanged()

    def test_schedule_plist_is_low_priority_and_opt_in(self):
        installed = candidate.plist_path().exists()
        output = io.StringIO()
        with redirect_stdout(output):
            self.assertEqual(candidate.main(["schedule", "print", "--work-root", str(self.work)]), 0)
        self.assertEqual(candidate.plist_path().exists(), installed)
        plist = candidate.plistlib.loads(output.getvalue().encode())
        self.assertEqual(plist["Label"], candidate.LABEL)
        self.assertEqual((plist["Nice"], plist["ProcessType"]), (10, "Background"))
        self.assertIn("run", plist["ProgramArguments"])


if __name__ == "__main__":
    unittest.main()
