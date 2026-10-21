import itertools
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest

from scripts.pr_ci import gate, needs_native


class PullRequestChecks(unittest.TestCase):
    def test_selector_checks_deleted_side_of_rename_and_fails_on_missing_base(self):
        script = Path(__file__).resolve().parents[1] / "scripts/pr_ci.py"
        with TemporaryDirectory() as directory:
            root = Path(directory)

            def git(*args):
                return subprocess.check_output(["git", *args], cwd=root, stderr=subprocess.PIPE).decode().strip()

            git("init", "-q")
            (root / "build-input").write_text("contents\n")
            git("add", ".")
            git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "base")
            base = git("rev-parse", "HEAD")
            git("mv", "build-input", "README.md")
            git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "rename")
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
            "build.py", "Dockerfile", "new-build-input",
        ):
            with self.subTest(path=path):
                self.assertTrue(needs_native(["README.md", path]))
        self.assertFalse(needs_native([]))
        self.assertFalse(needs_native([
            "README.md", "docs/write-a-mod.md", ".github/WORKFLOWS.md",
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
