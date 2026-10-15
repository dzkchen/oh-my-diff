import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from scripts import extension_index
from scripts.install_support import package_digest


class PublishedSourceTests(unittest.TestCase):
    def test_published_sources_must_match_their_sha256_and_revision(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            git = lambda *argv: subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", *argv], cwd=root, check=True, capture_output=True, text=True).stdout.strip()
            mod = root / "mods/ports/m"
            mod.mkdir(parents=True)
            (mod / "mod.json").write_text(json.dumps({"id": "m", "assets": ["a.ts"]}))
            (mod / "index.ts").write_text("export default () => {};\n")
            (mod / "a.ts").write_text("export const a = 1;\n")
            git("init", "-q")
            git("add", "mods/ports/m/mod.json", "mods/ports/m/index.ts")
            git("commit", "-q", "-m", "m")
            published = {"repository": "https://example.com/m", "revision": git("rev-parse", "HEAD"), "sha256": package_digest(mod)}
            check = lambda value: extension_index.check_published("m", "mods/ports/m", value, root)
            with self.assertRaisesRegex(ValueError, "published revision lacks a.ts"):
                check(published)
            git("add", "mods/ports/m/a.ts")
            git("commit", "-q", "-m", "a")
            with self.assertRaisesRegex(ValueError, "published revision lacks a.ts"):
                check(published)
            check({**published, "revision": git("rev-parse", "HEAD")})
            with self.assertRaisesRegex(ValueError, "source digest differs from the published sha256"):
                check({**published, "revision": git("rev-parse", "HEAD"), "sha256": "0" * 64})
            with self.assertRaisesRegex(ValueError, "published revision is unavailable"):
                check({**published, "revision": "1" * 40})


if __name__ == "__main__":
    unittest.main()
