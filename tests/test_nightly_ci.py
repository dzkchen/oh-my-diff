import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from scripts import nightly_ci


class HostedNightlyTests(unittest.TestCase):
    def test_archive_reinstall_uses_a_new_generation_and_uninstalls_both(self):
        with tempfile.TemporaryDirectory() as temporary:
            archive = Path(temporary) / "package.tar.xz"
            archive.write_bytes(b"package")
            installed, removed = [], []

            def child(argv, **kwargs):
                prefix = Path(argv[argv.index("--prefix") + 1])
                if "install" in argv:
                    self.assertFalse(prefix.exists())
                    if "--previous" in argv:
                        self.assertTrue(Path(argv[argv.index("--previous") + 1]).exists())
                        self.assertIn("--attach-store", argv)
                    prefix.mkdir()
                    installed.append(prefix)
                else:
                    self.assertTrue(prefix.exists())
                    removed.append(prefix)

            with mock.patch.object(nightly_ci, "command", return_value="/usr/bin/node"), \
                    mock.patch.object(nightly_ci.subprocess, "run", side_effect=child):
                nightly_ci.archive_acceptance(archive, Path("/usr/bin/codex"))
            self.assertEqual(len(set(installed)), 4)
            self.assertEqual(set(installed), set(removed))

    def test_all_test_targets_run_serially_and_finished_executables_are_pruned(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            deps = root / "omd-bnightly/target/debug/deps"
            deps.mkdir(parents=True)
            library = deps / "libcore.rlib"
            library.write_text("keep")
            metadata = {"packages": [{"name": "codex-core", "targets": [
                {"name": "core", "kind": ["lib"], "test": True},
                {"name": "all", "kind": ["test"], "test": True},
                {"name": "helper", "kind": ["bin"], "test": True},
            ]}]}

            def cargo(batch, log, args):
                self.assertFalse((deps / "finished-test").exists())
                binary = deps / "finished-test"
                binary.write_text("test")
                binary.chmod(0o755)
                self.assertIn("--test-threads=1", args)
                return int("--test" in args)

            with mock.patch.object(nightly_ci.batch_tree, "TMP", root), \
                    mock.patch.object(nightly_ci.batch_tree, "run", return_value=json.dumps(metadata)), \
                    mock.patch.object(nightly_ci.batch_tree, "cargo_run", side_effect=cargo) as child:
                with self.assertRaises(SystemExit) as stopped:
                    nightly_ci.cargo_tests("core")
            self.assertEqual(stopped.exception.code, 1)
            self.assertEqual(len(child.call_args_list), 4)
            self.assertEqual({tuple(call.args[2][4:call.args[2].index("--")]) for call in child.call_args_list},
                             {("--lib",), ("--test", "all"), ("--bin", "helper"), ("--doc",)})
            self.assertTrue(library.exists())
            self.assertFalse((deps / "finished-test").exists())

    def test_v8_verifies_the_tracked_manifest_before_downloading_assets(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            tree = root / "omd-bnightly/codex"
            trusted = tree / "third_party/v8/rusty_v8_150_4_0_release_manifests.sha256"
            trusted.parent.mkdir(parents=True)
            profile = "ptrcomp_sandbox_release_x86_64-unknown-linux-gnu"
            manifest = f"rusty_v8_{profile}.sha256"
            files = {f"librusty_v8_{profile}.a.gz": b"archive", f"src_binding_{profile}.rs": b"bindings"}
            body = "\n".join(f"{hashlib.sha256(data).hexdigest()}  {name}" for name, data in files.items()).encode()
            trusted.write_text(f"{hashlib.sha256(body).hexdigest()}  {manifest}\n")

            def command(*args):
                if args[0] == "rustc":
                    return "host: x86_64-unknown-linux-gnu"
                if args[0] != "curl":
                    return "150.4.0"
                name = args[-3].rsplit("/", 1)[1]
                Path(args[-1]).write_bytes(body if name == manifest else files[name])
                return ""

            with mock.patch.multiple(nightly_ci.batch_tree, TMP=root, V8=root / "v8"), \
                    mock.patch.object(nightly_ci, "command", side_effect=command) as child:
                nightly_ci.v8()
                self.assertEqual(len(list((root / "v8").iterdir())), 3)
                trusted.write_text(f"{'0' * 64}  {manifest}\n")
                child.reset_mock()
                with self.assertRaisesRegex(ValueError, "checksum mismatch"):
                    nightly_ci.v8()
                self.assertEqual(sum(call.args[0] == "curl" for call in child.call_args_list), 1)

    def test_publish_checks_provenance_and_assets_before_creating_a_draft(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            version = "0.1.0-nightly.20261008070000.99.1"
            archive = root / "package.tar.xz"
            archive.write_bytes(b"verified package")
            provenance = {"commit": "a" * 40, "version": version, "profile": "release",
                          "upstream_tag": "rust-v0.161.0", "run_url": "https://example.test/run"}
            manifest = {"version": version, "archive": archive.name, "target": "aarch64-apple-darwin",
                        "sha256": hashlib.sha256(archive.read_bytes()).hexdigest()}
            (root / "nightly-provenance.json").write_text(json.dumps(provenance))
            (root / "omd-release.json").write_text(json.dumps(manifest))
            (root / "SHA256SUMS").write_text("\n".join(f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}" for path in root.iterdir()))
            environment = {"GITHUB_SHA": "a" * 40, "GITHUB_REPOSITORY": "dzkchen/oh-my-diff"}
            with mock.patch.dict(os.environ, environment), mock.patch.object(nightly_ci, "command") as gh:
                nightly_ci.publish(root)
                self.assertIn("--draft", gh.call_args_list[0].args)
                self.assertIn("--prerelease", gh.call_args_list[0].args)
                self.assertIn("--latest=false", gh.call_args_list[0].args)
                self.assertIn("--draft=false", gh.call_args_list[1].args)
                gh.reset_mock()
                archive.write_bytes(b"tampered")
                with self.assertRaisesRegex(ValueError, "checksum mismatch"):
                    nightly_ci.publish(root)
                gh.assert_not_called()
                with mock.patch.dict(os.environ, {"GITHUB_SHA": "b" * 40}), self.assertRaisesRegex(ValueError, "provenance"):
                    nightly_ci.publish(root)

    def test_failed_reruns_update_one_issue_and_recovered_runs_close_it(self):
        environment = {"GITHUB_RUN_ID": "99", "GITHUB_RUN_ATTEMPT": "2", "GITHUB_REPOSITORY": "dzkchen/oh-my-diff", "GITHUB_SHA": "a" * 40,
                       "NIGHTLY_VALIDATION_RESULT": "success", "NIGHTLY_PUBLICATION_RESULT": "success"}
        issue = {"number": 7, "title": "[nightly] Failed run 99", "state": "OPEN"}
        failed = {"name": "validate", "conclusion": "failure", "html_url": "https://example.test/job",
                  "steps": [{"name": "Full hosted validation", "conclusion": "failure"}]}
        with tempfile.TemporaryDirectory() as temporary, mock.patch.dict(os.environ, environment), \
                mock.patch.object(nightly_ci, "command", side_effect=[json.dumps({"jobs": [failed]}), json.dumps([issue]), ""]) as gh, \
                mock.patch.object(nightly_ci, "Path", side_effect=lambda name: Path(temporary) / name):
            nightly_ci.report()
            self.assertEqual(gh.call_args_list[-1].args[:4], ("gh", "issue", "edit", 7))
            self.assertIn("Full hosted validation", (Path(temporary) / "nightly-failure.md").read_text())
            gh.reset_mock()
            gh.side_effect = [json.dumps({"jobs": []}), json.dumps([issue]), ""]
            nightly_ci.report()
            self.assertEqual(gh.call_args_list[-1].args[:4], ("gh", "issue", "close", 7))


if __name__ == "__main__":
    unittest.main()
