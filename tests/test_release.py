import copy
import json
import os
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
        listed = json.dumps([{"tagName": "v1.1.0"}, {"tagName": "mods-1.0.0-2"}, {"tagName": "v1.0.0"}])
        with mock.patch.object(release, "run", return_value=listed) as run, mock.patch("builtins.print"):
            release.rollback("1.1.0", dry_run=True)
            self.assertEqual(run.call_count, 1)
            release.rollback("1.1.0")
        edits = [call.args for call in run.call_args_list[2:]]
        self.assertEqual(edits, [("gh", "release", "edit", "v1.1.0", "--repo", release.REPOSITORY, "--draft=true"),
                                 ("gh", "release", "edit", "v1.0.0", "--repo", release.REPOSITORY, "--latest")])


class ReleaseValidationReuseTests(unittest.TestCase):
    def setUp(self):
        self.commit = "a" * 40
        self.run_id, self.artifact_id = 42, 73
        self.candidate = {"id": self.run_id, "run_attempt": 1, "path": ".github/workflows/release.yml",
                          "event": "workflow_dispatch", "head_sha": self.commit, "head_branch": "main",
                          "status": "completed", "conclusion": "success",
                          "repository": {"full_name": release.REPOSITORY}, "head_repository": {"full_name": release.REPOSITORY}}
        self.jobs = {"jobs": [{"name": name, "status": "completed", "conclusion": "success", "head_sha": self.commit,
                               "run_id": self.run_id, "run_attempt": 1} for name in sorted(release.REUSE_JOBS)],
                     "total_count": len(release.REUSE_JOBS)}
        self.artifacts = {"total_count": 1, "artifacts": [{"id": self.artifact_id, "name": "package", "expired": False,
                           "size_in_bytes": 100, "workflow_run": {"id": self.run_id, "head_sha": self.commit}}]}
        self.empty = {"reuse_run_id": "", "reuse_artifact_id": ""}
        self.environment = {"GITHUB_SHA": self.commit, "GITHUB_REPOSITORY": release.REPOSITORY, "GITHUB_RUN_ID": "99"}
        self.enterContext(mock.patch.dict(os.environ, self.environment, clear=True))
        self.enterContext(mock.patch.object(release, "lock_version", return_value="1.0.0"))
        self.enterContext(mock.patch("builtins.print"))

    def responses(self, candidate=None, jobs=None, artifacts=None):
        return [{"workflow_runs": [self.candidate if candidate is None else candidate]},
                self.jobs if jobs is None else jobs, self.artifacts if artifacts is None else artifacts]

    def test_reuses_only_the_successful_attempt_and_pins_its_package_artifact(self):
        with mock.patch.object(release, "github_json", side_effect=self.responses()) as api:
            self.assertEqual(release.reusable_validation("1.0.0"), {"reuse_run_id": "42", "reuse_artifact_id": "73"})
        self.assertIn(f"head_sha={self.commit}", api.call_args_list[0].args[0])
        self.assertIn("/runs/42/attempts/1/jobs?", api.call_args_list[1].args[0])
        self.assertIn("/runs/42/artifacts?name=package", api.call_args_list[2].args[0])

    def test_other_commits_branches_events_repositories_and_unfinished_runs_do_not_qualify(self):
        variants = [{"head_sha": "b" * 40}, {"head_branch": "release/v1.0.0"}, {"event": "push"},
                    {"path": ".github/workflows/nightly.yml"}, {"status": "in_progress"}, {"conclusion": "failure"},
                    {"repository": {"full_name": "someone/fork"}}, {"head_repository": {"full_name": "someone/fork"}},
                    {"id": 99}, {"id": "42"}, {"run_attempt": 0}]
        for changed in variants:
            with self.subTest(changed=changed), mock.patch.object(
                    release, "github_json", side_effect=self.responses(candidate=self.candidate | changed)) as api:
                self.assertEqual(release.reusable_validation("1.0.0"), self.empty)
                self.assertEqual(api.call_count, 1)

    def test_every_validation_job_must_pass_for_the_same_commit_and_attempt(self):
        variants = []
        for job_name in release.REUSE_JOBS:
            for fields in ({"conclusion": "failure"}, {"conclusion": "skipped"}, {"status": "in_progress"},
                           {"head_sha": "b" * 40}, {"run_attempt": 2}, {"run_id": 41}):
                jobs = copy.deepcopy(self.jobs)
                next(job for job in jobs["jobs"] if job["name"] == job_name).update(fields)
                variants.append(jobs)
        missing = copy.deepcopy(self.jobs)
        missing["jobs"].pop()
        missing["total_count"] -= 1
        duplicate = copy.deepcopy(self.jobs)
        duplicate["jobs"][0] = duplicate["jobs"][1].copy()
        variants += [missing, duplicate, self.jobs | {"total_count": 101}]
        for jobs in variants:
            with self.subTest(jobs=jobs), mock.patch.object(release, "github_json", side_effect=self.responses(jobs=jobs)) as api:
                self.assertEqual(release.reusable_validation("1.0.0"), self.empty)
                self.assertEqual(api.call_count, 2)

    def test_missing_expired_ambiguous_or_wrong_commit_packages_do_not_qualify(self):
        variants = [{"total_count": 0, "artifacts": []},
                    {"total_count": 2, "artifacts": self.artifacts["artifacts"] * 2},
                    self.artifacts | {"total_count": 101}]
        for fields in ({"expired": True}, {"expired": None}, {"name": "host-binaries"}, {"size_in_bytes": 0},
                       {"id": "73"}, {"workflow_run": {"id": 41, "head_sha": self.commit}},
                       {"workflow_run": {"id": 42, "head_sha": "b" * 40}}):
            variants.append({"total_count": 1, "artifacts": [self.artifacts["artifacts"][0] | fields]})
        for artifacts in variants:
            with self.subTest(artifacts=artifacts), mock.patch.object(
                    release, "github_json", side_effect=self.responses(artifacts=artifacts)):
                self.assertEqual(release.reusable_validation("1.0.0"), self.empty)

    def test_api_failures_and_incomplete_responses_fall_back_to_full_validation(self):
        for response in (SystemExit("API unavailable"), OSError("gh is absent"), ValueError("invalid JSON"), {},
                         {"workflow_runs": [{"id": 42}]}, {"workflow_runs": None}):
            with self.subTest(response=response), mock.patch.object(release, "github_json", side_effect=[response]):
                self.assertEqual(release.reusable_validation("1.0.0"), self.empty)

    def test_version_or_missing_github_context_never_queries_earlier_runs(self):
        with mock.patch.object(release, "github_json") as api:
            for version in ("1.0.1", "v1.0.0"):
                with self.assertRaisesRegex(SystemExit, "committed release version"):
                    release.reusable_validation(version)
            for environment in ({"GITHUB_REPOSITORY": "someone/fork"}, {"GITHUB_SHA": "not-a-commit"}):
                with mock.patch.dict(os.environ, environment):
                    self.assertEqual(release.reusable_validation("1.0.0"), self.empty)
            api.assert_not_called()

    def test_cli_appends_reuse_ids_to_the_workflow_output_file(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "outputs"
            output.write_text("version=1.0.0\n")
            with mock.patch("sys.argv", ["release.py", "reuse", "1.0.0", "--github-output", str(output)]), \
                    mock.patch.object(release, "github_json", side_effect=self.responses()):
                release.main()
            self.assertEqual(output.read_text(), "version=1.0.0\nreuse_run_id=42\nreuse_artifact_id=73\n")


if __name__ == "__main__":
    unittest.main()
