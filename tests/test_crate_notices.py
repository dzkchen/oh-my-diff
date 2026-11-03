import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest


class CrateNotices(unittest.TestCase):
    def test_cargo_failure_keeps_dependency_diagnostics(self):
        script = Path(__file__).resolve().parents[1] / "scripts/crate_notices.py"
        with TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "codex-rs").mkdir()
            cargo = root / "cargo"
            cargo.write_text("#!/bin/sh\necho 'error: failed to download dependency' >&2\nexit 101\n")
            cargo.chmod(0o755)
            result = subprocess.run([sys.executable, script, root, "--check"], capture_output=True, text=True,
                                    env=os.environ | {"PATH": str(root) + os.pathsep + os.environ["PATH"]})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("error: failed to download dependency", result.stderr)
