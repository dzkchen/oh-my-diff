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

from scripts import build_provenance, release_lock
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
            event = root / "event.json"
            for event_name in ("push", "merge_group"):
                for revision in (base, "missing-base"):
                    with self.subTest(event=event_name, revision=revision):
                        event.write_text(ci.json.dumps({"before": revision} if event_name == "push"
                                                       else {"merge_group": {"base_sha": revision}}))
                        output.write_text("")
                        env = os.environ | {"GITHUB_EVENT_NAME": event_name, "GITHUB_EVENT_PATH": str(event),
                                            "GITHUB_OUTPUT": str(output)}
                        result = subprocess.run([sys.executable, script, "select"], cwd=root, env=env, capture_output=True)
                        if revision == base:
                            self.assertEqual(result.returncode, 0, result.stderr)
                            self.assertEqual(output.read_text(), "native=true\n")
                        else:
                            self.assertNotEqual(result.returncode, 0)
                            self.assertEqual(output.read_text(), "")

    def test_pr_synchronize_selects_all_native_changes_from_a_shallow_merge(self):
        script = Path(__file__).resolve().parents[1] / "scripts/pr_ci.py"
        with TemporaryDirectory() as directory:
            root = Path(directory)
            origin, checkout = root / "origin", root / "checkout"
            origin.mkdir()
            git(origin, "init", "-q", "-b", "main")
            (origin / "README.md").write_text("base\n")
            git(origin, "add", ".")
            git(origin, "commit", "-qm", "base")
            git(origin, "checkout", "-qb", "feature")
            (origin / "runtime").mkdir()
            (origin / "runtime/input.rs").write_text("native change\n")
            git(origin, "add", ".")
            git(origin, "commit", "-qm", "native change")
            before = git(origin, "rev-parse", "HEAD")
            (origin / "README.md").write_text("docs followup\n")
            git(origin, "commit", "-qam", "docs followup")
            git(origin, "checkout", "-qb", "pr-merge", "main")
            git(origin, "merge", "--no-ff", "-qm", "Merge PR", "feature")
            git(root, "clone", "-q", "--depth", "2", "--branch", "pr-merge", origin.as_uri(), str(checkout))
            event, output = root / "event.json", root / "output"
            event.write_text(ci.json.dumps({"action": "synchronize", "before": before,
                                            "after": git(origin, "rev-parse", "feature")}))
            env = os.environ | {"GITHUB_EVENT_NAME": "pull_request", "GITHUB_EVENT_PATH": str(event),
                                "GITHUB_OUTPUT": str(output)}
            result = subprocess.run([sys.executable, script, "select"], cwd=checkout, env=env, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(output.read_text(), "native=true\n")

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
            "README.md", "runtime/README.md", "docs/mod-authors/first-mod.md", "docs/contributing/ci.md",
            "mods/first-party/omd_logo/index.ts", "mods/examples/hello/index.ts",
            "plugins/omd-code-execution/plugin.json", "tests/test_package.py",
        ]))

    def test_native_fingerprint_tracks_inputs_across_main_syncs(self):
        script = Path(__file__).resolve().parents[1] / "scripts/pr_ci.py"
        with TemporaryDirectory() as directory:
            root = Path(directory)
            git(root, "init", "-q")
            files = ("runtime/patches/native.patch", "upstream.lock.json", "mise.toml",
                     ".github/workflows/pr.yml", "scripts/build.py", "mods/api.d.ts", "unknown-input")
            for name in files:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("original\n")
            git(root, "add", ".")
            git(root, "commit", "-qm", "base")
            output = root / "output"

            def fingerprint():
                output.write_text("")
                subprocess.run([sys.executable, script, "fingerprint"], cwd=root, check=True,
                               env=os.environ | {"GITHUB_OUTPUT": str(output)})
                return output.read_text()

            initial = fingerprint()
            for name in ("README.md", "mods/first-party/example/index.ts", "tests/test_example.py",
                         "runtime/mods.lock.json", "runtime/plugins.lock.json", "runtime/release.lock.json"):
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("unrelated update\n")
                git(root, "add", name)
                git(root, "commit", "-qm", name)
                self.assertEqual(fingerprint(), initial, name)
            for name in files:
                path = root / name
                path.write_text("changed\n")
                git(root, "add", name)
                git(root, "commit", "-qm", name)
                self.assertNotEqual(fingerprint(), initial, name)
                git(root, "revert", "--no-edit", "HEAD")
                self.assertEqual(fingerprint(), initial)
            git(root, "rm", "unknown-input")
            git(root, "commit", "-qm", "delete input")
            self.assertNotEqual(fingerprint(), initial)

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

    def test_jobs_build_only_the_required_test_helpers(self):
        expected = {"omd-runner", "codex", "codex-code-mode-host", "rmcp_test_server", "test_stdio_server",
                    "test_streamable_http_server", "test_mcp_2026_stdio_server", "test_mcp_2026_discovery_stdio_server"}
        for job in ("native", "core"):
            args = self.steps(job)["test helper binaries"].argv
            selected = {name for flag, name in zip(args, args[1:]) if flag == "--bin"}
            self.assertEqual(selected, expected)
            self.assertNotIn("--bins", args)

    def test_release_artifacts_are_built_copied_and_signed(self):
        expected = ("codex", "codex-code-mode-host", "omd-mod", "omd", "omd-contract", "omd-broker", "omd-runner")
        with TemporaryDirectory() as temporary:
            work = Path(temporary)
            built = work / "target/release"
            built.mkdir(parents=True)
            for name in expected:
                (built / name).write_text(name)
            unsigned = {"unsigned": build_provenance.hashes(built)}
            with mock.patch.object(build, "work_dir", return_value=work), \
                    mock.patch.object(build, "cargo_env", return_value={}), \
                    mock.patch.object(build, "cargo_run", return_value=0) as compiled, \
                    mock.patch.object(build_provenance, "inputs", return_value={}), \
                    mock.patch.object(build_provenance, "record_build"), \
                    mock.patch.object(build_provenance, "verify", return_value=unsigned), \
                    mock.patch.object(build_provenance, "record_signing"), \
                    mock.patch.object(release_lock, "sign") as sign, \
                    mock.patch.object(build, "pack_sdk") as packed, contextlib.redirect_stdout(io.StringIO()):
                build.artifacts(argparse.Namespace(name="release"))
            arguments = compiled.call_args.args[2]
            self.assertEqual(arguments[:3], ["build", "--locked", "--release"])
            self.assertCountEqual([name for flag, name in zip(arguments, arguments[1:]) if flag == "--bin"], expected)
            self.assertCountEqual([name for flag, name in zip(arguments, arguments[1:]) if flag == "-p"],
                                  ["codex-cli", "codex-code-mode-host", "codex-omd-extension", "codex-omd", "codex-omd-runner"])
            self.assertNotIn("--bins", arguments)
            self.assertEqual({path.name: path.read_text() for path in (work / "artifacts").iterdir()},
                             {name: name for name in expected})
            self.assertEqual([call.args[0].name for call in sign.call_args_list],
                             ["codex", "omd-mod", "omd", "omd-contract", "omd-broker"])
            packed.assert_called_once_with(work / "artifacts")

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

    def test_release_dry_runs_print_the_commands_without_signing(self):
        with TemporaryDirectory() as temporary:
            directory = Path(temporary)
            (directory / "omd.tar.xz").write_bytes(b"archive")
            digest = ci.support.digest(directory / "omd.tar.xz")
            (directory / "SHA256SUMS").write_text(f"{digest}  omd.tar.xz\n")
            (directory / "omd-release.json").write_text(ci.json.dumps(
                {"version": "1.2.3", "target": "aarch64-apple-darwin", "archive": "omd.tar.xz", "sha256": digest}))
            (directory / "provenance.json").write_text(ci.json.dumps({"commit": "c" * 40, "version": "1.2.3", "profile": "release"}))
            environment = {"GITHUB_SHA": "c" * 40, "GITHUB_REPOSITORY": "example/omd"}
            for key in (None, "present"):
                configured = environment | ({"OMD_RELEASE_SIGNING_KEY": key} if key else {})
                with self.subTest(signing_key=key), mock.patch.dict(os.environ, configured, clear=True), \
                        mock.patch("builtins.print") as printed, \
                        mock.patch.object(ci, "sign", side_effect=AssertionError("dry run signed")):
                    ci.publish(directory, directory / "notes.md", dry_run=True, expected_version="1.2.3")
                self.assertIn("omd-release.json.sig", printed.call_args_list[0].args[1])

    def test_publication_rejects_a_reused_package_with_wrong_version_commit_or_checksum(self):
        with TemporaryDirectory() as temporary:
            directory = Path(temporary)
            (directory / "omd.tar.xz").write_bytes(b"archive")
            digest = ci.support.digest(directory / "omd.tar.xz")
            manifest = {"version": "1.2.3", "target": "aarch64-apple-darwin", "archive": "omd.tar.xz", "sha256": digest}
            provenance = {"commit": "c" * 40, "version": "1.2.3", "profile": "release"}
            environment = {"GITHUB_SHA": "c" * 40, "GITHUB_REPOSITORY": "example/omd", "GITHUB_REF": "refs/tags/v1.2.3"}
            for mismatch in ("version", "commit", "checksum"):
                with self.subTest(mismatch=mismatch), mock.patch.dict(os.environ, environment, clear=True), \
                        mock.patch.object(ci, "sign") as sign, mock.patch.object(ci.support, "output") as publish:
                    (directory / "omd-release.json").write_text(ci.json.dumps(manifest))
                    (directory / "provenance.json").write_text(ci.json.dumps(
                        provenance | ({"commit": "d" * 40} if mismatch == "commit" else {})))
                    (directory / "SHA256SUMS").write_text(f"{'0' * 64 if mismatch == 'checksum' else digest}  omd.tar.xz\n")
                    with self.assertRaises(ValueError):
                        ci.publish(directory, directory / "notes.md", expected_version="1.2.4" if mismatch == "version" else "1.2.3")
                    sign.assert_not_called()
                    publish.assert_not_called()


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
