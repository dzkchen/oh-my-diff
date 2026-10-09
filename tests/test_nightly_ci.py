import hashlib
import io
import json
import os
from pathlib import Path
import tempfile
import tarfile
import unittest
from unittest import mock

from scripts import nightly_ci


class HostedNightlyTests(unittest.TestCase):
    def test_archive_reinstall_uses_a_new_generation_and_uninstalls_both(self):
        with tempfile.TemporaryDirectory() as temporary:
            archive = Path(temporary) / "package.tar.xz"
            script = (
                "import argparse\nfrom pathlib import Path\n"
                "parser = argparse.ArgumentParser()\nparser.add_argument('command')\nparser.add_argument('--prefix')\n"
                "args, _ = parser.parse_known_args()\nprefix = Path(args.prefix)\n"
                "if args.command == 'install':\n    prefix.mkdir()\n    (prefix / 'installer').write_text(__file__)\n"
                "else:\n    (prefix / 'installer').unlink()\n    prefix.rmdir()\n"
            ).encode()
            files = {"scripts/lean_package.py": script, "scripts/lean_profiles.py": script}
            manifest = {"schema": 1, "files": {name: {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}
                                               for name, data in files.items()}}
            files["package-manifest.json"] = json.dumps(manifest).encode()
            with tarfile.open(archive, "w:xz") as packed:
                for name, data in files.items():
                    member = tarfile.TarInfo(f"payload/{name}")
                    member.size = len(data)
                    packed.addfile(member, io.BytesIO(data))
            installed, removed = [], []
            run = nightly_ci.subprocess.run

            def child(argv, **kwargs):
                payload = Path(kwargs["cwd"])
                self.assertEqual((payload / "scripts/lean_package.py").read_bytes(), script)
                if "install" in argv:
                    self.assertTrue(Path(argv[argv.index("--archive") + 1]).is_absolute())
                    self.assertTrue(Path(argv[argv.index("--upstream") + 1]).is_absolute())
                prefix = Path(argv[argv.index("--prefix") + 1])
                if "install" in argv:
                    self.assertFalse(prefix.exists())
                    if "--previous" in argv:
                        self.assertTrue(Path(argv[argv.index("--previous") + 1]).exists())
                        self.assertIn("--attach-store", argv)
                    run(argv, **kwargs)
                    self.assertEqual((prefix / "installer").read_text(), str(payload / "scripts/lean_package.py"))
                    installed.append(prefix)
                else:
                    self.assertTrue(prefix.exists())
                    run(argv, **kwargs)
                    self.assertFalse(prefix.exists())
                    removed.append(prefix)

            with mock.patch.object(nightly_ci, "command", return_value="/usr/bin/node"), \
                    mock.patch.object(nightly_ci.subprocess, "run", side_effect=child):
                nightly_ci.archive_acceptance(Path(os.path.relpath(archive)), Path("fixtures/codex"))
            self.assertEqual(len(set(installed)), 4)
            self.assertEqual(set(installed), set(removed))

    def test_workflow_concurrency_keeps_dispatch_refs_independent(self):
        workflow = (Path(__file__).resolve().parents[1] / ".github/workflows/nightly.yml").read_text()
        group = next(line.split("group:", 1)[1].strip() for line in workflow.splitlines() if "group:" in line)
        main = group.replace("${{ github.ref }}", "refs/heads/main")
        branch = group.replace("${{ github.ref }}", "refs/heads/ci/nightly")
        self.assertNotEqual(main, branch)

    def test_all_test_targets_run_serially_and_finished_executables_are_pruned(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            deps = root / "omd-bnightly/target/debug/deps"
            deps.mkdir(parents=True)
            library = deps / "libcore.rlib"
            library.write_text("keep")
            helper = deps / "helper-abcdef"
            helper.write_text("required binary")
            helper.chmod(0o755)
            outside = root / "unrelated-executable"
            outside.write_text("keep")
            metadata = {"packages": [{"name": "codex-core", "targets": [
                {"name": "core", "kind": ["lib"], "test": True},
                {"name": "all", "kind": ["test"], "test": True},
                {"name": "helper", "kind": ["bin"], "test": True},
            ]}]}

            def cargo(batch, log, args):
                self.assertTrue(helper.exists(), "ordinary bin outputs must survive each target")
                self.assertFalse((deps / "finished-test").exists())
                binary = deps / "finished-test"
                binary.write_text("test")
                binary.chmod(0o755)
                self.assertIn("--test-threads=1", args)
                log.parent.mkdir(parents=True, exist_ok=True)
                records = [{"reason": "compiler-artifact", "profile": {"test": False}, "executable": str(helper)},
                           {"reason": "compiler-artifact", "profile": {"test": True}, "executable": str(binary)},
                           {"reason": "compiler-artifact", "profile": {"test": True}, "executable": str(outside)},
                           {"reason": "build-finished", "success": True},
                           {"reason": "compiler-artifact", "profile": {"test": True}, "executable": str(helper)}]
                log.write_text("\n".join(map(json.dumps, records)) + "\n")
                return int("--test" in args)

            with mock.patch.object(nightly_ci.batch_tree, "TMP", root), \
                    mock.patch.object(nightly_ci.nightly, "WORK", root / "work"), \
                    mock.patch.object(nightly_ci.batch_tree, "run", return_value=json.dumps(metadata)), \
                    mock.patch.object(nightly_ci.batch_tree, "cargo_run", side_effect=cargo) as child:
                with self.assertRaises(SystemExit) as stopped:
                    nightly_ci.cargo_tests("core")
            self.assertEqual(stopped.exception.code, 1)
            self.assertEqual(len(child.call_args_list), 4)
            self.assertEqual({tuple(arg for arg in call.args[2][4:call.args[2].index("--")] if not arg.startswith("--message-format="))
                              for call in child.call_args_list},
                             {("--lib",), ("--test", "all"), ("--bin", "helper"), ("--doc",)})
            self.assertTrue(library.exists())
            self.assertTrue(helper.exists())
            self.assertTrue(outside.exists())
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
            (root / "provenance.json").write_text(json.dumps(provenance))
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

    def test_stable_release_publishes_only_from_its_tag_and_dry_run_publishes_nothing(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "release"
            root.mkdir()
            notes = Path(temporary) / "notes.md"
            notes.write_text("notes\n")
            archive = root / "oh-my-diff-1.0.0-aarch64-apple-darwin.tar.xz"
            archive.write_bytes(b"verified package")
            (root / "provenance.json").write_text(json.dumps({"commit": "a" * 40, "version": "1.0.0", "profile": "release"}))
            (root / "omd-release.json").write_text(json.dumps({"version": "1.0.0", "archive": archive.name, "target": "aarch64-apple-darwin",
                                                               "sha256": hashlib.sha256(archive.read_bytes()).hexdigest()}))
            (root / "SHA256SUMS").write_text("\n".join(f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}" for path in root.iterdir()))
            environment = {"GITHUB_SHA": "a" * 40, "GITHUB_REPOSITORY": "dzkchen/oh-my-diff", "GITHUB_REF": "refs/heads/main"}
            with mock.patch.dict(os.environ, environment), mock.patch.object(nightly_ci, "command") as gh:
                with self.assertRaisesRegex(ValueError, "must be published from tag v1.0.0"):
                    nightly_ci.publish(root, notes)
                nightly_ci.publish(root, notes, dry_run=True)
                gh.assert_not_called()
                with mock.patch.dict(os.environ, {"GITHUB_REF": "refs/tags/v1.0.0"}):
                    nightly_ci.publish(root, notes)
                create, edit = (call.args for call in gh.call_args_list)
                self.assertIn("--latest", create)
                self.assertNotIn("--prerelease", create)
                self.assertIn(archive, create)
                self.assertEqual(edit[-2:], ("--draft=false", "--latest"))

    def test_nightly_base_follows_the_committed_release(self):
        with mock.patch.dict(os.environ, {"GITHUB_RUN_ID": "7", "GITHUB_RUN_ATTEMPT": "1"}):
            self.assertTrue(nightly_ci.nightly_version("1.0.0").startswith("1.0.1-nightly."))
            self.assertTrue(nightly_ci.nightly_version("1.1.0-rc.2").startswith("1.1.0-nightly."))

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
