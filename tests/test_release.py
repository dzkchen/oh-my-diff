import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from scripts import release


def host_crates(root, version):
    for name in release.HOST_CRATES:
        (root / name).parent.mkdir(parents=True, exist_ok=True)
        (root / name).write_text(f'[package]\nname = "crate"\nversion = "{version}"\n')
    (root / "catalog.json").write_text(json.dumps({"release_pin": {"codex": "0.1.0", "omd": version},
                                                   "packages": [{"compatibility": f"Codex 0.1.0; OMD {version}"}]}))


def repository(temporary):
    origin, root = Path(temporary) / "origin.git", Path(temporary) / "work"
    subprocess.run(["git", "init", "--bare", "-b", "main", origin], check=True, capture_output=True)
    subprocess.run(["git", "clone", origin, root], check=True, capture_output=True)
    git = lambda *args: subprocess.run(["git", *args], cwd=root, check=True, capture_output=True, text=True).stdout.strip()
    git("config", "user.email", "test@example.test")
    git("config", "user.name", "Test")
    return root, git


def paths(root):
    return mock.patch.multiple(release, ROOT=root, CHANGELOG=root / "release/changelog.json", MARKDOWN=root / "CHANGELOG.md",
                               LOCK=root / "lock.json", CATALOG=root / "catalog.json")


class ReleaseTests(unittest.TestCase):
    def test_check_ties_lock_changelog_and_links_to_the_release_version(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            entries = [{"version": "1.0.0", "date": "2026-10-17", "title": "Oh My Diff 1.0.0", "summary": "First release.",
                        "sections": [{"label": "New", "items": ["Installer"]}, {"label": "Fixed", "items": ["Update path"]}],
                        "commits": ["abcdef1"]},
                       {"date": "2026-10-08", "title": "Launch scope", "summary": "Smaller launch.",
                        "sections": [{"label": "Changed", "items": ["Waves"]}], "commits": ["1234567"]}]
            (root / "release").mkdir()
            (root / "release/changelog.json").write_text(json.dumps(entries))
            (root / "CHANGELOG.md").write_text(release.render(entries))
            (root / "lock.json").write_text(json.dumps({"version": "1.0.0"}))
            host_crates(root, "1.0.0")
            (root / "README.md").write_text("[changelog](CHANGELOG.md) [site](https://example.test)\n")
            with paths(root), mock.patch.object(release, "history", return_value=[]), \
                    mock.patch.object(release, "run", return_value="README.md\nCHANGELOG.md"):
                release.check("1.0.0")
                notes = release.notes(entries, "1.0.0")
                self.assertIn("### Fixed\n\n- Update path", notes)
                self.assertIn("v1.0.0/install.sh | sh -s -- --profile full", notes)
                (root / "catalog.json").write_text(json.dumps({"release_pin": {"codex": "0.1.0", "omd": "1.0.0"},
                                                               "packages": [{"compatibility": "Codex 0.1.0; OMD 0.9.0"}]}))
                with self.assertRaisesRegex(SystemExit, "must pin and name OMD 1.0.0 and Codex 0.1.0 throughout"):
                    release.check("1.0.0")
                host_crates(root, "1.0.0")
                with self.assertRaisesRegex(SystemExit, "release.lock.json is 1.0.0, not 1.0.1"):
                    release.check("1.0.1")
                (root / release.HOST_CRATES[1]).write_text('[package]\nversion = "0.9.0"\n')
                with self.assertRaisesRegex(SystemExit, "OMD host crates are 0.9.0, 1.0.0, not 1.0.0"):
                    release.check("1.0.0")
                host_crates(root, "1.0.0")
                (root / "README.md").write_text("[guide](docs/missing.md) [first](CHANGELOG.md#100--2026-10-17) [gone](CHANGELOG.md#nope) <a href=\"docs/html.md\">x</a>\n")
                entries[1]["commits"] = ["abcdef1"]
                (root / "release/changelog.json").write_text(json.dumps(entries))
                with self.assertRaises(SystemExit) as failure:
                    release.check()
                self.assertIn("repeated commit abcdef1", str(failure.exception))
                self.assertIn("broken link README.md: docs/missing.md", str(failure.exception))
                self.assertIn("broken link README.md: CHANGELOG.md#nope", str(failure.exception))
                self.assertNotIn("#100", str(failure.exception))
                self.assertIn("broken link README.md: docs/html.md", str(failure.exception))

    def test_reference_must_be_the_topic_pages_in_index_order(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "reference").mkdir()
            (root / "reference/README.md").write_text("| [A](a.md) | first |\n| [B](b.md) | second |\n")
            (root / "reference/a.md").write_text("# A\n\nalpha [x](b.md#y)\n")
            (root / "reference/b.md").write_text("# B\n\nbeta\n")
            reference = root / "REFERENCE.md"
            with mock.patch.object(release, "REFERENCE", reference):
                reference.write_text("# Mod API reference\n\n## A\n\nalpha [x](#y)\n\n## B\n\nbeta\n")
                self.assertIsNone(release.reference_drift())
                reference.write_text("# Mod API reference\n\n## B\n\nbeta\n\n## A\n\nalpha [x](#y)\n")
                self.assertIn("reference/a.md", release.reference_drift())
                reference.write_text("# Mod API reference\n\n## A\n\nalpha [x](#y)\n\n## B\n\nbeta\n\nstale\n")
                self.assertIn("has 5 lines after the topic pages begin", release.reference_drift())
                (root / "reference/c.md").write_text("# C\n")
                self.assertEqual(release.reference_drift(), "mods/reference/README.md does not list c.md")

    def test_refresh_merges_main_and_adds_new_commits_after_the_curated_text(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, git = repository(temporary)
            (root / "a.txt").write_text("a\n")
            (root / "release").mkdir()
            shutil.copy(release.ROOT / "release/cliff.toml", root / "release")
            git("add", "a.txt", "release/cliff.toml")
            git("commit", "-m", "feat: a")
            first = git("rev-parse", "--short=7", "HEAD")
            git("push", "origin", "main")
            git("switch", "-c", "release/v1.0.0")
            entries = [{"version": "1.0.0", "date": "2026-10-17", "title": "Oh My Diff 1.0.0", "summary": "First.",
                        "sections": [{"label": "New", "items": ["Curated line"]}], "commits": [first]}]
            (root / "release/changelog.json").write_text(json.dumps(entries))
            (root / "CHANGELOG.md").write_text(release.render(entries))
            (root / "lock.json").write_text(json.dumps({"version": "1.0.0"}))
            host_crates(root, "1.0.0")
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
            with paths(root), mock.patch("builtins.print"):
                release.refresh("1.0.0", "release/v1.0.0")
            published = json.loads(git("show", "origin/release/v1.0.0:release/changelog.json"))
            self.assertEqual(published[0]["commits"], [first, second])
            self.assertEqual(published[0]["sections"], [{"label": "New", "items": ["Curated line"]},
                                                        {"label": "Fixed", "items": ["B (#7)"]}])
            self.assertTrue((root / "b.txt").exists())

    def test_tag_goes_on_the_release_commit_and_check_requires_every_commit_since_the_previous_release(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, git = repository(temporary)
            commit = lambda message: (git("add", "."), git("commit", "-m", message), git("rev-parse", "--short=7", "HEAD"))[-1]
            (root / "a.txt").write_text("a\n")
            commit("feat: before the previous release")
            git("tag", "v0.9.0")
            (root / "b.txt").write_text("b\n")
            fixed = commit("fix: b")
            entries = [{"version": "1.0.0", "commits": [fixed]}, {"version": "0.9.0", "commits": []}]
            (root / "release").mkdir()
            (root / "release/changelog.json").write_text(json.dumps(entries))
            (root / "runtime").mkdir()
            (root / "runtime/release.lock.json").write_text(json.dumps({"version": "1.0.0"}))
            host_crates(root, "1.0.0")
            tagged = commit("chore(release): 1.0.0 (#3)")
            (root / "d.txt").write_text("d\n")
            later = commit("fix: merged after the release pull request")
            git("push", "--tags", "origin", "main")
            with paths(root), mock.patch("builtins.print"):
                release.prepare("1.0.0", None)
                self.assertEqual(git("ls-remote", "origin", "refs/tags/v1.0.0^{}")[:7], tagged)
                self.assertEqual(release.history(entries, "1.0.0"), [f"v1.0.0 already tags {tagged}, not {later}"])
                git("switch", "--detach", "v1.0.0")
                self.assertEqual(release.history(entries, "1.0.0"), [])
                git("tag", "-d", "v1.0.0")
                git("switch", "main")
                self.assertEqual(release.history(entries, "1.0.0"), [f"no changelog entry covers {tagged}, {later}"])

    def test_rollback_drafts_the_release_and_restores_the_previous_stable_as_latest(self):
        listed = json.dumps([{"tagName": "v1.1.0"}, {"tagName": "v1.0.0"}])
        with mock.patch.object(release, "run", return_value=listed) as run, mock.patch("builtins.print"):
            release.rollback("1.1.0", dry_run=True)
            self.assertEqual(run.call_count, 1)
            release.rollback("1.1.0")
        edits = [call.args for call in run.call_args_list[2:]]
        self.assertEqual(edits, [("gh", "release", "edit", "v1.1.0", "--repo", release.REPOSITORY, "--draft=true"),
                                 ("gh", "release", "edit", "v1.0.0", "--repo", release.REPOSITORY, "--latest")])


if __name__ == "__main__":
    unittest.main()
