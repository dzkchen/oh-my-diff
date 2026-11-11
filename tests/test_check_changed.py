import contextlib
import io
import json
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest import mock

from scripts import check_changed


def git(root, *args):
    return subprocess.check_output([
        "git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", *args,
    ], cwd=root, stderr=subprocess.PIPE).decode().strip()


class ChangedChecks(unittest.TestCase):
    def test_selection_includes_commits_both_rename_paths_and_each_local_change(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            git(root, "init", "-q")
            for name in ("old.py", "staged.py", "unstaged.py", "deleted.py"):
                (root / name).write_text("before\n")
            (root / ".gitignore").write_text("ignored/\n")
            git(root, "add", ".")
            git(root, "commit", "-qm", "base")
            base = git(root, "rev-parse", "HEAD")
            branch = git(root, "branch", "--show-current")
            git(root, "mv", "old.py", "new.py")
            git(root, "commit", "-qm", "rename")
            git(root, "checkout", "-qb", "reference", base)
            (root / "upstream-only.md").write_text("another branch\n")
            git(root, "add", ".")
            git(root, "commit", "-qm", "upstream change")
            git(root, "checkout", "-q", branch)
            (root / "staged.py").write_text("staged\n")
            git(root, "add", "staged.py")
            (root / "staged.py").write_text("before\n")
            (root / "unstaged.py").write_text("unstaged\n")
            (root / "deleted.py").unlink()
            (root / "untracked file.py").write_text("new\n")
            (root / "ignored").mkdir()
            (root / "ignored/file.py").write_text("ignored\n")
            ancestor, paths = check_changed.changed_paths(root, "reference")
            self.assertEqual(ancestor, base)
            self.assertEqual(paths, ["deleted.py", "new.py", "old.py", "staged.py", "unstaged.py", "untracked file.py"])
            with self.assertRaises(subprocess.CalledProcessError), contextlib.redirect_stderr(io.StringIO()):
                check_changed.changed_paths(root, "missing-base")

    def test_docs_do_not_select_builds_and_changed_tests_respect_manual_classification(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "tests").mkdir()
            (root / "tests/suites.json").write_text(json.dumps({"optional": {
                "tests/manual.test.mjs": "Needs credentials", "tests/test_manual.py": "Needs credentials",
            }}))
            for name in ("test_example.py", "example.test.mjs", "manual.test.mjs", "test_manual.py"):
                (root / "tests" / name).write_text("")
            docs = check_changed.checks(root, "base", ["CONTRIBUTING.md", "docs/STYLEGUIDE.md"])
            self.assertEqual([command[1:] for command in docs if command[0] == sys.executable], [["scripts/release.py", "check"]])
            self.assertFalse(any(command[0] in ("mise", "node", "cargo") for command in docs))
            shipped_docs = check_changed.checks(root, "base", ["plugins/README.md"])
            self.assertIn([sys.executable, "-m", "scripts.plugin_lock"], shipped_docs)
            commands = check_changed.checks(root, "base", [
                "tests/test_example.py", "tests/test_deleted.py", "tests/test_manual.py", "tests/example.test.mjs", "tests/manual.test.mjs",
            ])
            self.assertIn([sys.executable, "-m", "unittest", "tests.test_example"], commands)
            self.assertIn(["node", "--test", "tests/example.test.mjs"], commands)
            self.assertFalse(any("cargo" in command for command in commands))

    def test_preview_executes_no_checks_and_a_failed_check_stops_the_run(self):
        with mock.patch.object(check_changed, "changed_paths", return_value=("1234567890abcdef", ["README.md"])), \
                mock.patch.object(check_changed, "checks", return_value=[["first"], ["second"]]), \
                mock.patch.object(check_changed.subprocess, "run") as run, \
                contextlib.redirect_stdout(io.StringIO()) as output:
            with mock.patch.object(sys, "argv", ["check_changed.py", "--list"]):
                self.assertEqual(check_changed.main(), 0)
            run.assert_not_called()
            self.assertNotIn("checks passed", output.getvalue())
            run.return_value.returncode = 7
            with mock.patch.object(sys, "argv", ["check_changed.py"]):
                self.assertEqual(check_changed.main(), 7)
            run.assert_called_once_with(["first"], cwd=check_changed.ROOT)


if __name__ == "__main__":
    unittest.main()
