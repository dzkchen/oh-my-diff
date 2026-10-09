import json
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
                self.assertIn("### Fixed\n\n- Update path", release.notes(entries, "1.0.0"))
                with self.assertRaisesRegex(SystemExit, "lean-release.lock.json is 1.0.0, not 1.0.1"):
                    release.check("1.0.1")
                (root / "README.md").write_text("[guide](docs/missing.md) [first](CHANGELOG.md#100--2026-10-17) [gone](CHANGELOG.md#nope)\n")
                entries[1]["commits"] = ["abcdef1"]
                (root / "changelog.json").write_text(json.dumps(entries))
                with self.assertRaises(SystemExit) as failure:
                    release.check()
                self.assertIn("repeated commit abcdef1", str(failure.exception))
                self.assertIn("broken link README.md: docs/missing.md", str(failure.exception))
                self.assertIn("broken link README.md: CHANGELOG.md#nope", str(failure.exception))
                self.assertNotIn("#100", str(failure.exception))

    def test_pull_request_titles_follow_conventional_commits(self):
        self.assertTrue(release.TITLE.fullmatch("feat(mods): add a launch picker"))
        self.assertTrue(release.TITLE.fullmatch("fix!: refuse unsigned archives"))
        self.assertFalse(release.TITLE.fullmatch("code review fixes"))
        self.assertFalse(release.TITLE.fullmatch("feature: add x"))


if __name__ == "__main__":
    unittest.main()
