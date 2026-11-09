import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("omd_build", ROOT / ".github/scripts/build.py")
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


class ScratchRepoTests(unittest.TestCase):
    def test_scratch_repo_survives_the_tmp_cleaner_purging_head_and_config(self):
        with tempfile.TemporaryDirectory() as temporary:
            upstream, scratch = Path(temporary) / "upstream", Path(temporary) / "scratch"
            git = lambda tree, *args: subprocess.run(["git", *args], cwd=tree, check=True, capture_output=True, text=True).stdout.strip()
            upstream.mkdir()
            git(upstream, "init", "--quiet")
            (upstream / "file").write_text("x")
            git(upstream, "add", "file")
            git(upstream, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "pin")
            git(upstream, "tag", "rust-v0.0.1")
            commit = git(upstream, "rev-parse", "HEAD")
            lock = {"tag": "rust-v0.0.1", "commit": commit, "repository": str(upstream)}
            original = build.SCRATCH, build.pin
            build.SCRATCH, build.pin = scratch, lambda: lock
            try:
                self.assertEqual(build.scratch_repo(), commit)
                for purged in ("HEAD", "config"):
                    (scratch / ".git" / purged).unlink()
                self.assertEqual(build.scratch_repo(), commit)
                self.assertEqual(git(scratch, "tag", "-l", "rust-v0.0.1"), "rust-v0.0.1")
                self.assertEqual(git(scratch, "config", "core.ignorecase"), "true")
            finally:
                build.SCRATCH, build.pin = original


if __name__ == "__main__":
    unittest.main()
