import itertools
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest import mock

from scripts.pr_ci import gate, needs_native

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / ".github/scripts"))
import build
import ci


def git(root, *args):
    return subprocess.check_output(["git", "-c", "user.name=Test", "-c", "user.email=test@example.com",
                                    "-c", "commit.gpgsign=false", *args],
                                   cwd=root, stderr=subprocess.PIPE).decode().strip()


class PullRequestChecks(unittest.TestCase):
    def test_selector_checks_deleted_side_of_rename_and_fails_on_missing_base(self):
        script = Path(__file__).resolve().parents[1] / "scripts/pr_ci.py"
        with TemporaryDirectory() as directory:
            root = Path(directory)
            git(root, "init", "-q")
            (root / "build-input").write_text("contents\n")
            git(root, "add", ".")
            git(root, "commit", "-qm", "base")
            base = git(root, "rev-parse", "HEAD")
            git(root, "mv", "build-input", "README.md")
            git(root, "commit", "-qm", "rename")
            output = root / "output"
            env = os.environ | {"PR_BASE_SHA": base, "GITHUB_OUTPUT": str(output)}
            result = subprocess.run([sys.executable, script, "select"], cwd=root, env=env, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(output.read_text(), "native=true\n")
            output.write_text("")
            result = subprocess.run([sys.executable, script, "select"], cwd=root,
                                    env=env | {"PR_BASE_SHA": "missing-base"}, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(output.read_text(), "")

    def test_native_selection_covers_shared_inputs_and_unknown_paths(self):
        for path in (
            "runtime/patches/codex.patch", "runtime/omd/src/lib.rs", "runtime/omd/README.md", "upstream.lock.json",
            "scripts/build_provenance.py", ".github/scripts/build.py", ".github/workflows/pr.yml",
            "mods/api.d.ts", "mods/pnpm-lock.yaml", "mods/conformance/host.json", "mise.toml",
            "build.py", "docker/Dockerfile", "new-build-input",
        ):
            with self.subTest(path=path):
                self.assertTrue(needs_native(["README.md", path]))
        self.assertFalse(needs_native([]))
        self.assertFalse(needs_native([
            "README.md", "docs/mod-authors/first-mod.md", "docs/contributing/ci.md",
            "mods/first-party/omd_logo/index.ts", "mods/examples/hello/index.ts",
            "plugins/omd-code-execution/plugin.json", "tests/test_package.py",
        ]))

    def test_gate_requires_all_selected_jobs_and_valid_selection(self):
        states = ("success", "failure", "cancelled", "skipped")
        for selected, changes, portable, native in itertools.product(("true", "false", "", "invalid"), states, states, states):
            results = {
                "changes": {"result": changes, "outputs": {"native": selected}},
                "portable": {"result": portable}, "native": {"result": native},
            }
            expected = changes == portable == "success" and (
                (selected, native) in (("true", "success"), ("false", "skipped"))
            )
            with self.subTest(results=results):
                self.assertEqual(gate(results), expected)

    def test_drift_reports_untracked_files(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            git(root, "init", "-q")
            (root / "runtime").mkdir()
            (root / "runtime/lib.rs").write_text("contents\n")
            git(root, "add", ".")
            git(root, "commit", "-qm", "base")
            self.assertEqual(subprocess.run(ci.drift("runtime"), cwd=root, capture_output=True).returncode, 0)
            (root / "runtime/new.rs").write_text("contents\n")
            self.assertNotEqual(subprocess.run(ci.drift("runtime"), cwd=root, capture_output=True).returncode, 0)


class HostedJobs(unittest.TestCase):
    def steps(self, job):
        with mock.patch.object(ci, "core_env", return_value={}):
            return {step.name: step for step in ci.job_steps(job)}

    def test_only_core_integration_is_advisory(self):
        advisory = [name for job in ("native", "core", "lint", "acceptance", "build")
                    for name, step in self.steps(job).items() if step.advisory]
        self.assertEqual(advisory, ["cargo test core integration"])

    def test_every_cargo_invocation_of_a_test_job_selects_the_same_packages(self):
        for job, suite in (("native", "native"), ("core", "core"), ("core", "core-integration")):
            helper = self.steps(job)["test helper binaries"].argv
            selected = [name for flag, name in zip(helper, helper[1:]) if flag == "-p"]
            with self.subTest(job=job, suite=suite):
                self.assertEqual(selected, ci.scope(suite))
                self.assertTrue(set(ci.SUITE_CRATES[suite]) <= set(selected))
                self.assertTrue(set(ci.HELPERS) <= set(selected))
        self.assertEqual(ci.scope("core"), ci.scope("core-integration"))

    def test_runner_is_built_with_the_packages_of_the_test_run(self):
        args = ["nextest", "run", "--locked", "-p", "codex-core", "-p", "codex-omd-runner", "--lib"]
        with mock.patch.object(build.subprocess, "run", return_value=mock.Mock(returncode=1)) as run:
            self.assertEqual(build.test_runner(Path("/work"), args, {}, None), 1)
        self.assertEqual(run.call_args.args[0], ["cargo", "build", "--locked", "-p", "codex-core", "-p", "codex-omd-runner",
                                                 "--bin", "omd-runner"])
        with mock.patch.object(build.subprocess, "run", return_value=mock.Mock(returncode=1)) as run:
            build.test_runner(Path("/work"), ["test", "--locked", "-p", "codex-core", "--doc"], {}, None)
        self.assertEqual(run.call_args.args[0], ["cargo", "build", "--locked", "-p", "codex-core", "-p", "codex-omd-runner",
                                                 "--bin", "omd-runner"])

    def test_compile_cache_is_opt_in(self):
        with mock.patch.object(build, "run", return_value=b"host: aarch64-apple-darwin\n"):
            with mock.patch.dict(os.environ, {"OMD_SCCACHE": "", "RUSTC_WRAPPER": ""}):
                self.assertFalse(build.cargo_env(Path("/work")).get("RUSTC_WRAPPER"))
            with mock.patch.dict(os.environ, {"OMD_SCCACHE": "1"}):
                self.assertEqual(build.cargo_env(Path("/work"))["RUSTC_WRAPPER"], "sccache")
