import argparse
import contextlib
import io
import itertools
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest import mock

from scripts import build_provenance
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

    def test_build_targets_match_shipped_binaries_and_required_test_helpers(self):
        shipped = [name for flag, name in zip(build.BUILD, build.BUILD[1:]) if flag == "--bin"]
        self.assertCountEqual(shipped, build_provenance.BINARIES)
        self.assertNotIn("--bins", build.BUILD)
        expected = {"omd-runner", "codex", "codex-code-mode-host", "rmcp_test_server", "test_stdio_server",
                    "test_streamable_http_server", "test_mcp_2026_stdio_server", "test_mcp_2026_discovery_stdio_server"}
        for job in ("native", "core"):
            args = self.steps(job)["test helper binaries"].argv
            selected = {name for flag, name in zip(args, args[1:]) if flag == "--bin"}
            self.assertEqual(selected, expected)
            self.assertNotIn("--bins", args)

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


class DeveloperBuilds(unittest.TestCase):
    def environment(self, values, args=()):
        with mock.patch.dict(os.environ, values, clear=True), mock.patch.object(
                build, "run", return_value=b"host: aarch64-apple-darwin\n"):
            return build.cargo_env(Path("/work"), args) if args else build.cargo_env(Path("/work"))

    def test_low_resource_jobs_and_explicit_overrides(self):
        self.assertNotIn("CARGO_BUILD_JOBS", self.environment({}))
        self.assertEqual(self.environment({"OMD_LOW_RESOURCE": "1"})["CARGO_BUILD_JOBS"], "3")
        self.assertEqual(self.environment({"OMD_LOW_RESOURCE": "1", "CARGO_BUILD_JOBS": "2"})["CARGO_BUILD_JOBS"], "2")
        for flags in (["-j", "1"], ["-j1"], ["-j=1"], ["--jobs=1"], ["--jobs", "1"]):
            with self.subTest(flags=flags):
                self.assertEqual(self.environment({"OMD_LOW_RESOURCE": "1", "CARGO_BUILD_JOBS": "2"},
                                                  ["test", *flags])["CARGO_BUILD_JOBS"], "1")
        self.assertEqual(self.environment({"OMD_LOW_RESOURCE": "1"}, ["test", "--", "-j8"])["CARGO_BUILD_JOBS"], "3")

    def test_nextest_separates_test_threads_from_build_jobs(self):
        for flags in (["-j", "num-cpus"], ["-jnum-cpus"], ["-j=num-cpus"], ["--jobs", "num-cpus"],
                      ["--jobs=num-cpus"], ["--test-threads", "num-cpus"], ["-j", "8"]):
            with self.subTest(flags=flags):
                args = ["nextest", "run", *flags]
                self.assertNotIn("CARGO_BUILD_JOBS", self.environment({}, args))
                self.assertEqual(self.environment({"OMD_LOW_RESOURCE": "1", "CARGO_BUILD_JOBS": "2"}, args)[
                    "CARGO_BUILD_JOBS"], "2")
        for flags in (["--build-jobs", "1"], ["--build-jobs=1"]):
            for args in (["nextest", "run", "-j", "num-cpus", *flags],
                         ["nextest", "run", *flags, "--jobs=num-cpus"]):
                with self.subTest(args=args):
                    self.assertEqual(self.environment({"OMD_LOW_RESOURCE": "1", "CARGO_BUILD_JOBS": "2"}, args)[
                        "CARGO_BUILD_JOBS"], "1")
        self.assertEqual(self.environment({"OMD_LOW_RESOURCE": "1"},
                                          ["nextest", "run", "--", "--build-jobs=8"])["CARGO_BUILD_JOBS"], "3")

    def test_cache_modes_disable_incremental_and_explain_conflicts(self):
        self.assertEqual(self.environment({})["CARGO_INCREMENTAL"], "1")
        self.assertNotIn("RUSTC_WRAPPER", self.environment({}))
        self.assertNotIn("RUSTC_WRAPPER", self.environment({"OMD_SCCACHE": "0"}))
        cached = self.environment({"OMD_SCCACHE": "1"})
        self.assertEqual(cached["CARGO_INCREMENTAL"], "0")
        self.assertEqual(cached["RUSTC_WRAPPER"], "sccache")
        self.assertEqual(self.environment({"RUSTC_WRAPPER": "/tools/sccache"})["CARGO_INCREMENTAL"], "0")
        self.assertEqual(self.environment({"CARGO_INCREMENTAL": "0"})["CARGO_INCREMENTAL"], "0")
        for values, message in (({"OMD_SCCACHE": "1", "CARGO_INCREMENTAL": "1"}, "CARGO_INCREMENTAL=0"),
                                ({"OMD_SCCACHE": "1", "RUSTC_WRAPPER": "other"}, "RUSTC_WRAPPER"),
                                ({"OMD_SCCACHE": "1", "RUSTC_WORKSPACE_WRAPPER": "other"}, "RUSTC_WORKSPACE_WRAPPER")):
            with self.subTest(values=values), self.assertRaisesRegex(SystemExit, message):
                self.environment(values)

    def test_skip_runner_is_explicit_and_propagates_test_failure(self):
        for subcommand in ("test", "nextest"):
            with self.subTest(subcommand=subcommand), TemporaryDirectory() as temporary:
                work = Path(temporary)
                with mock.patch.object(build, "test_runner", return_value=0) as runner, mock.patch.object(
                        build, "cargo_env", return_value={}), mock.patch.object(
                        build.subprocess, "run", return_value=mock.Mock(returncode=7)) as run, contextlib.redirect_stdout(io.StringIO()):
                    status = build.cargo_run(work, work / "test.log", [subcommand], skip_runner=True)
                    self.assertEqual(status, 7)
                    runner.assert_not_called()
                    self.assertEqual(run.call_args.args[0], ["cargo", subcommand])
                    build.cargo_run(work, work / "test.log", [subcommand])
                    runner.assert_called_once()

    def test_storage_and_clean_only_selected_targets_preserving_source_and_logs(self):
        with TemporaryDirectory() as temporary, mock.patch.object(build, "TMP", Path(temporary)):
            for name in ("first", "second"):
                work = build.work_dir(name)
                for directory in ("codex", "target", "logs", "artifacts"):
                    (work / directory).mkdir(parents=True)
                    (work / directory / "keep").write_text("contents")
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                build.storage(argparse.Namespace())
                build.clean(argparse.Namespace(names=["first"]))
            self.assertIn(str(build.work_dir("second") / "target"), output.getvalue())
            self.assertFalse((build.work_dir("first") / "target").exists())
            self.assertTrue((build.work_dir("second") / "target/keep").is_file())
            for directory in ("codex", "logs", "artifacts"):
                self.assertTrue((build.work_dir("first") / directory / "keep").is_file())
            for name in ("../outside", "a/b", ".", ""):
                with self.subTest(name=name), self.assertRaises(SystemExit):
                    build.clean(argparse.Namespace(names=[name]))
            (build.work_dir("first") / "target").symlink_to(build.work_dir("second") / "target")
            with self.assertRaises(SystemExit):
                build.clean(argparse.Namespace(names=["second", "first"]))
            self.assertTrue((build.work_dir("second") / "target/keep").is_file())
