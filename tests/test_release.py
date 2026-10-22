import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from scripts import release


class ReleaseTests(unittest.TestCase):
    def test_check_ties_lock_changelog_and_links_to_the_release_version(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            entries = [{"version": "1.0.0", "date": "2026-10-17", "title": "Oh My Diff 1.0.0", "summary": "First release.",
                        "sections": [{"label": "New", "items": ["Installer"]}, {"label": "Fixed", "items": ["Update path"]}],
                        "commits": ["abcdef1"]},
                       {"date": "2026-10-08", "title": "Launch scope", "summary": "Smaller launch.",
                        "sections": [{"label": "Decided", "items": ["Waves"]}], "commits": ["1234567"]}]
            (root / "changelog.json").write_text(json.dumps(entries))
            (root / "CHANGELOG.md").write_text(release.render(entries))
            (root / "lock.json").write_text(json.dumps({"version": "1.0.0"}))
            (root / "README.md").write_text("[changelog](CHANGELOG.md) [site](https://example.test)\n")
            with mock.patch.multiple(release, ROOT=root, CHANGELOG=root / "changelog.json", MARKDOWN=root / "CHANGELOG.md",
                                     LOCK=root / "lock.json"), \
                    mock.patch.object(release, "run", return_value="README.md\nCHANGELOG.md"):
                release.check("1.0.0")
                notes = release.notes(entries, "1.0.0")
                self.assertIn("### Fixed\n\n- Update path", notes)
                self.assertIn("v1.0.0/install.sh | sh -s -- --profile full", notes)
                with self.assertRaisesRegex(SystemExit, "release.lock.json is 1.0.0, not 1.0.1"):
                    release.check("1.0.1")
                (root / "README.md").write_text("[guide](docs/missing.md) [first](CHANGELOG.md#100--2026-10-17) [gone](CHANGELOG.md#nope) <a href=\"docs/html.md\">x</a>\n")
                entries[1]["commits"] = ["abcdef1"]
                (root / "changelog.json").write_text(json.dumps(entries))
                with self.assertRaises(SystemExit) as failure:
                    release.check()
                self.assertIn("repeated commit abcdef1", str(failure.exception))
                self.assertIn("broken link README.md: docs/missing.md", str(failure.exception))
                self.assertIn("broken link README.md: CHANGELOG.md#nope", str(failure.exception))
                self.assertNotIn("#100", str(failure.exception))
                self.assertIn("broken link README.md: docs/html.md", str(failure.exception))

    def test_refresh_merges_main_and_adds_new_commits_after_the_curated_text(self):
        with tempfile.TemporaryDirectory() as temporary:
            origin, root = Path(temporary) / "origin.git", Path(temporary) / "work"
            git = lambda *args: subprocess.run(["git", *args], cwd=root, check=True, capture_output=True, text=True).stdout.strip()
            subprocess.run(["git", "init", "--bare", "-b", "main", origin], check=True, capture_output=True)
            subprocess.run(["git", "clone", origin, root], check=True, capture_output=True)
            git("config", "user.email", "test@example.test")
            git("config", "user.name", "Test")
            (root / "a.txt").write_text("a\n")
            shutil.copy(release.ROOT / "cliff.toml", root)
            git("add", "a.txt", "cliff.toml")
            git("commit", "-m", "feat: a")
            first = git("rev-parse", "--short=7", "HEAD")
            git("push", "origin", "main")
            git("switch", "-c", "release/v1.0.0")
            entries = [{"version": "1.0.0", "date": "2026-10-17", "title": "Oh My Diff 1.0.0", "summary": "First.",
                        "sections": [{"label": "New", "items": ["Curated line"]}], "commits": [first]}]
            (root / "changelog.json").write_text(json.dumps(entries))
            (root / "CHANGELOG.md").write_text(release.render(entries))
            (root / "lock.json").write_text(json.dumps({"version": "1.0.0"}))
            git("add", ".")
            git("commit", "-m", "chore(release): 1.0.0")
            git("push", "origin", "release/v1.0.0")
            git("switch", "-c", "someone/b", "main")
            (root / "b.txt").write_text("b\n")
            git("add", "b.txt")
            git("commit", "-m", "wip")
            git("switch", "main")
            git("merge", "--no-ff", "someone/b", "-m", "Merge pull request #7 from someone/b\n\nfix: b")
            second = git("rev-parse", "--short=7", "HEAD")
            git("push", "origin", "main")
            with mock.patch.multiple(release, ROOT=root, CHANGELOG=root / "changelog.json", MARKDOWN=root / "CHANGELOG.md",
                                     LOCK=root / "lock.json"), mock.patch("builtins.print"):
                release.refresh("1.0.0", "release/v1.0.0")
            published = json.loads(git("show", "origin/release/v1.0.0:changelog.json"))
            self.assertEqual(published[0]["commits"], [first, second])
            self.assertEqual(published[0]["sections"], [{"label": "New", "items": ["Curated line"]},
                                                        {"label": "Fixed", "items": ["B (#7)"]}])
            self.assertTrue((root / "b.txt").exists())

    def test_rollback_drafts_the_release_and_restores_the_previous_stable_as_latest(self):
        listed = json.dumps([{"tagName": "v1.1.0"}, {"tagName": "v1.0.0"}])
        with mock.patch.object(release, "run", return_value=listed) as run, mock.patch("builtins.print") as printed:
            release.rollback("1.1.0", dry_run=True)
            self.assertEqual(run.call_count, 1)
            release.rollback("1.1.0")
        edits = [call.args for call in run.call_args_list[2:]]
        self.assertEqual(edits, [("gh", "release", "edit", "v1.1.0", "--repo", release.REPOSITORY, "--draft=true"),
                                 ("gh", "release", "edit", "v1.0.0", "--repo", release.REPOSITORY, "--latest")])
        self.assertIn("v1.0.0 is the latest", printed.call_args.args[0])


if __name__ == "__main__":
    unittest.main()
