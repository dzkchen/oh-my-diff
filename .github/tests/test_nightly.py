import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
import nightly


class SummarizeTests(unittest.TestCase):
    def test_hosted_steps_use_existing_script_entrypoints(self):
        for name, argv in nightly.hosted_steps():
            if argv[0] == "python3" and argv[1].endswith(".py"):
                with self.subTest(step=name):
                    self.assertTrue((nightly.ROOT / argv[1]).is_file(), argv[1])

    def test_core_tests_resolve_node_before_isolating_home(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "logs").mkdir()
            original = Path.home()
            with mock.patch.multiple(nightly, WORK=root, REPO=root), \
                    mock.patch.object(nightly.subprocess, "check_output", return_value="/real/node\n") as node, \
                    mock.patch.object(nightly.subprocess, "run", return_value=SimpleNamespace(returncode=0)) as child:
                nightly.run("cargo test core", ["cargo", "test"])
            environment = child.call_args.kwargs["env"]
            self.assertEqual(environment["HOME"], str(root / "core-test-home"))
            self.assertNotEqual(environment["HOME"], str(original))
            self.assertEqual(environment["OMD_TEST_NODE"], "/real/node")
            self.assertEqual(node.call_args.args[0], ["mise", "which", "node"])

    def test_hosted_consumers_use_the_configured_batch_root(self):
        import build
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with mock.patch.object(build, "TMP", root / "batches"), \
                    mock.patch.multiple(nightly, ROOT=root, WORK=root / "work", REPO=root), \
                    mock.patch("sys.argv", ["nightly"]), \
                    mock.patch.object(nightly.subprocess, "run", return_value=SimpleNamespace(stdout="23b63db\n")), \
                    mock.patch.object(nightly.subprocess, "check_output", return_value="/real/node\n"), \
                    mock.patch.object(nightly, "run", side_effect=lambda name, _: {
                        "name": name, "status": 0, "seconds": 0, "log": name, "tail": [],
                    }) as child, mock.patch.dict(os.environ), mock.patch("builtins.print"):
                self.assertEqual(nightly.main(), 0)
                manager = root / "batches/omd-bnightly/artifacts/omd-mod"
                self.assertEqual(os.environ["OMD_TEST_MOD_BIN"], str(manager))
                self.assertEqual(os.environ["OMD_TEST_MANAGER"], str(manager))
                calls = {call.args[0]: call.args[1] for call in child.call_args_list}
                self.assertEqual(calls["host check with scenarios"][calls["host check with scenarios"].index("--omd-mod") + 1], str(manager))
                self.assertEqual(calls["client acceptance"][-1], str(manager.parent))
                self.assertEqual(calls["host binaries"][-1], "--release")

    def test_hosted_validation_keeps_the_checkout_and_reports_skipped_steps(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with mock.patch.multiple(nightly, ROOT=root, WORK=root / "work", REPO=root / "unused"), \
                    mock.patch("sys.argv", ["nightly"]), \
                    mock.patch.object(nightly.subprocess, "run", return_value=SimpleNamespace(stdout="23b63db\n")) as child, \
                    mock.patch.object(nightly, "run", return_value={"name": "setup", "status": 1, "seconds": 0, "log": "setup", "tail": []}), \
                    mock.patch("builtins.print"):
                self.assertEqual(nightly.main(), 1)
                self.assertEqual(nightly.REPO, root)
                self.assertFalse(any("worktree" in call.args[0] or "clean" in call.args[0] for call in child.call_args_list))
            report = (root / "work/report.md").read_text()
            self.assertIn("Skipped:", report)
            self.assertIn("filtered_host_additional_permissions", report)

    def test_clippy_covers_patched_sources_and_preserves_cargo_failures(self):
        paths = ["omd/src/mods.rs", "ext/omd/src/lib.rs", "tui/src/mod_components.rs", "core/src/compact_remote_v2.rs"]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "logs").mkdir()
            (root / "runtime/patches").mkdir(parents=True)
            (root / "runtime/patches/manifest.json").write_text(json.dumps({
                "files": {f"codex-rs/{path}": {} for path in paths},
            }))
            with mock.patch.multiple(nightly, WORK=root, REPO=root), \
                 mock.patch.object(nightly.subprocess, "run", return_value=SimpleNamespace(returncode=0)) as child:
                for path in [*paths, "core/src/unpatched.rs", "/registry/dependency/src/lib.rs"]:
                    with self.subTest(path=path):
                        (root / "logs/clippy.cargo.log").write_text(f"warning: fixture\n   --> {path}:167:1\n")
                        result = nightly.run("clippy omd paths", ["cargo", "clippy"])
                        self.assertEqual(result["status"], int(path in paths))
                child.return_value.returncode = 101
                self.assertEqual(nightly.run("clippy omd paths", ["cargo", "clippy"])["status"], 101)

    def test_launchd_limits_are_raised_for_children_without_exceeding_the_hard_limit(self):
        for hard, target in ((nightly.resource.RLIM_INFINITY, 8192), (1024, 1024)):
            with self.subTest(hard=hard), mock.patch.object(nightly.resource, "getrlimit", return_value=(256, hard)), \
                 mock.patch.object(nightly.resource, "setrlimit") as changed, mock.patch("builtins.print"):
                nightly.prepare_resources()
                changed.assert_called_once_with(nightly.resource.RLIMIT_NOFILE, (target, hard))
        with mock.patch.object(nightly.resource, "getrlimit", return_value=(16384, 16384)), \
             mock.patch.object(nightly.resource, "setrlimit") as changed, mock.patch("builtins.print"):
            nightly.prepare_resources()
            changed.assert_not_called()
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(nightly, "WORK", Path(directory)), \
             mock.patch.object(nightly.subprocess, "run", return_value=SimpleNamespace(returncode=0)) as child:
            (Path(directory) / "logs").mkdir()
            nightly.run("fixture", ["true"])
            self.assertEqual(child.call_args.kwargs["env"]["TMPDIR"], "/private/tmp/")
        before = nightly.resource.getrlimit(nightly.resource.RLIMIT_NOFILE)
        code = (
            "import resource, subprocess, sys; sys.path.insert(0, '.github/scripts'); import nightly; "
            "soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE); "
            "resource.setrlimit(resource.RLIMIT_NOFILE, (min(256, hard) if hard != resource.RLIM_INFINITY else 256, hard)); "
            "nightly.prepare_resources(); "
            "print(subprocess.check_output([sys.executable, '-c', "
            "'import resource; print(resource.getrlimit(resource.RLIMIT_NOFILE)[0])'], text=True).strip())"
        )
        result = subprocess.run([sys.executable, "-c", code], cwd=nightly.ROOT, capture_output=True, text=True, check=True)
        expected = 8192 if before[1] == nightly.resource.RLIM_INFINITY else min(8192, before[1])
        self.assertEqual(int(result.stdout.splitlines()[-1]), expected)
        self.assertEqual(nightly.resource.getrlimit(nightly.resource.RLIMIT_NOFILE), before)

    def test_a_failed_setup_keeps_unrun_failures_and_reports_them_as_skipped(self):
        summary = nightly.summarize([{"name": "setup", "status": 1}], ["mods tests"])
        self.assertEqual(summary["fixed"], [])
        self.assertEqual(summary["new"], ["setup"])
        self.assertEqual(summary["unresolved"], ["setup", "mods tests"])
        self.assertEqual(summary["skipped"], [name for name, _ in nightly.hosted_steps()[1:]])

    def test_only_rerun_steps_count_as_fixed(self):
        results = [{"name": name, "status": 0} for name, _ in nightly.hosted_steps()]
        summary = nightly.summarize(results, ["mods tests"])
        self.assertEqual((summary["fixed"], summary["unresolved"], summary["skipped"]), (["mods tests"], [], []))


if __name__ == "__main__":
    unittest.main()
