import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import types
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]


def installer():
    code = (ROOT / "install.sh").read_text().split("<<'PY'\n", 1)[1].rsplit("\nPY", 1)[0]
    module = types.ModuleType("omd_installer")
    exec(compile(code, "install.sh", "exec"), module.__dict__)
    return module


def release(version, prerelease=False, **manifest):
    name = f"oh-my-diff-{version}.tar.xz"
    return {"tag_name": f"v{version}", "draft": False, "prerelease": prerelease, "body": f"notes {version}",
            "html_url": f"https://example.test/{version}", "assets": [
                {"name": "omd-release.json", "browser_download_url": f"https://example.test/{version}/omd-release.json"},
                {"name": name, "browser_download_url": f"https://example.test/{version}/{name}",
                 "digest": f"sha256:{manifest.get('sha256', 'a' * 64)}"}],
            "manifest": {"schema": 1, "version": version, "target": "aarch64-apple-darwin", "upstream_tag": "rust-v0.160.1",
                         "mod_api": "0.2.0-experimental.5", "node": "24.18.0", "archive": name, "sha256": "a" * 64, **manifest}}


class UpdateSelection(unittest.TestCase):
    def setUp(self):
        self.module = installer()
        self.temporary = tempfile.TemporaryDirectory(prefix="omd-update-test-", dir="/private/tmp")
        self.root = Path(self.temporary.name).resolve()
        self.current = self.root / "releases" / ("0" * 32)
        store = self.root / "stores/platform"
        (store / "sources/omd_update").mkdir(parents=True)
        shutil.copy2(ROOT / "mods/first-party/omd_update/mod.json", store / "sources/omd_update/mod.json")
        self.settings = {}
        self.write_settings()
        (self.current / "prefix").mkdir(parents=True)
        (self.root / "current").symlink_to(self.current)
        (self.current / "receipt.json").write_text(json.dumps({"schema": 1, "generation": self.current.name, "profile": "platform",
                                                               "releases_url": "https://example.test/releases"}))
        (self.current / "prefix/install.json").write_text(json.dumps({"version": "0.1.0", "store": str(store), "packages": {},
                                                                      "author": {"node": "/usr/bin/true"}}))
        self.published = []
        self.module.fetch_json = self.fetch
        self.module.user_mods = lambda record, store, mod_api: []
        self.module.node_binary = lambda *arguments: Path("/usr/bin/true")
        self.module.upstream_binary = self.upstream

    def tearDown(self):
        self.temporary.cleanup()

    def write_settings(self):
        store = self.root / "stores/platform"
        (store / "mods.json").write_text(json.dumps({"mods": [{"path": str(store / "sources/omd_update"), "settings": self.settings}]}))

    def upstream(self, args, current, minor=None):
        if minor and minor != "0.160":
            raise ValueError(f"upstream Codex {minor}.x is required; found codex-cli 0.160.1")
        return {"path": "/usr/bin/true", "version": "codex-cli 0.160.1"}

    def fetch(self, url, limit):
        if url == "https://example.test/releases":
            if isinstance(self.published, Exception):
                raise self.published
            return [{key: value for key, value in item.items() if key != "manifest"} for item in self.published]
        return next(item["manifest"] for item in self.published if url == item["assets"][0]["browser_download_url"])

    def check(self, **settings):
        self.settings = settings
        self.write_settings()
        return self.module.check(types.SimpleNamespace(), self.root, self.current)

    def test_versions_order_by_semantic_precedence(self):
        ordered = ["0.1.0-alpha.1", "0.1.0-alpha.2", "0.1.0-alpha.10", "0.1.0-beta", "0.1.0", "0.1.1", "0.10.0"]
        self.assertEqual(sorted(reversed(ordered), key=self.module.version_key), ordered)
        self.assertIsNone(self.module.version_key("v1.0"))

    def test_first_install_restores_launchers_after_partial_failure_and_interruption(self):
        for interrupted in (False, True):
            for failed_name in self.module.LINKS:
                with self.subTest(interrupted=interrupted, failed_name=failed_name), tempfile.TemporaryDirectory(dir=self.root) as temporary:
                    root = Path(temporary)
                    bin_dir = root / "bin"
                    bin_dir.mkdir()
                    originals = {}
                    for index, name in enumerate(self.module.LINKS):
                        path = bin_dir / name
                        if index == 5:
                            originals[name] = None
                            continue
                        body = f"#!/bin/sh\nprintf '%s' 'original {name}'\n"
                        if index % 2:
                            target = root / f"original-{name}"
                            target.write_text(body)
                            target.chmod(0o755)
                            path.symlink_to(target)
                        else:
                            path.write_text(body)
                            path.chmod(0o755)
                        originals[name] = (path.is_symlink(), os.readlink(path) if path.is_symlink() else path.read_text())
                    args = types.SimpleNamespace(bin_dir=bin_dir, session=None, releases_url=None)
                    generation = root / "releases" / ("1" * 32)
                    real_link = self.module.atomic_symlink

                    def link(path, target):
                        real_link(path, target)
                        if path == bin_dir / failed_name:
                            raise OSError("launcher creation failed")

                    def installed(*arguments, **keywords):
                        command = arguments[0]
                        installed_generation = Path(command[command.index("--prefix") + 1])
                        installed_generation.mkdir()
                        (installed_generation / "install.json").write_text('{"version":"0.2.0"}')

                    with patch.object(self.module, "extract", return_value=root), patch.object(self.module, "run", side_effect=installed), \
                            patch.object(self.module, "status", return_value={}), patch.object(self.module, "atomic_symlink", side_effect=link):
                        if interrupted:
                            generation.mkdir(parents=True)
                            self.module.journaled(root, generation, None)
                            with self.assertRaisesRegex(OSError, "launcher creation failed"):
                                self.module.set_links(root, bin_dir)
                        else:
                            with self.assertRaisesRegex(OSError, "launcher creation failed"):
                                self.module.transaction(args, root, None, root / "archive", "https://example.test/archive", "a" * 64,
                                                        "platform", {"path": "/usr/bin/true"}, "/usr/bin/true")
                    if interrupted:
                        self.module.recover(args, root, None)
                    for name, original in originals.items():
                        path = bin_dir / name
                        if original is None:
                            self.assertFalse(path.exists() or path.is_symlink())
                        else:
                            self.assertEqual((path.is_symlink(), os.readlink(path) if path.is_symlink() else path.read_text()), original)
                            self.assertEqual(subprocess.run([path], capture_output=True, text=True, check=True).stdout, f"original {name}")
                        self.assertFalse((bin_dir / f"{name}.before-omd").is_symlink())
                        self.assertFalse((bin_dir / f"{name}.before-omd").exists())
                    self.assertFalse((root / "current").is_symlink())
                    self.assertFalse((root / "update/journal.json").exists())
        with tempfile.TemporaryDirectory(dir=self.root) as temporary:
            root = Path(temporary)
            bin_dir = root / "bin"
            bin_dir.mkdir()
            (bin_dir / "codex").write_text("original codex")
            args = types.SimpleNamespace(bin_dir=bin_dir)
            self.module.journaled(root, None, None)
            self.module.set_links(root, bin_dir)
            with patch.object(self.module, "restore_displaced", side_effect=OSError("restore failed")):
                self.module.abandon(root, None, None, bin_dir)
            self.assertTrue((root / "update/journal.json").exists(), "failed cleanup keeps recovery pending")
            self.module.recover(args, root, None)
            self.assertEqual((bin_dir / "codex").read_text(), "original codex")
            self.assertFalse((root / "update/journal.json").exists())

    def test_channel_pin_compatibility_and_failures(self):
        self.published = [release("0.3.0-beta.1", prerelease=True), release("0.2.1", upstream_tag="rust-v0.161.0"),
                          release("0.2.0"), release("0.1.0"), release("0.1.5"),
                          {"tag_name": "nightly", "assets": []}, {**release("0.4.0"), "draft": True}]
        stable = self.check()
        self.assertEqual(stable["available"]["version"], "0.2.0")
        self.assertEqual(stable["blocked"]["version"], "0.2.1")
        self.assertIn("0.161.x", stable["blocked"]["reasons"][0])
        self.assertEqual(stable["available"]["manifest"]["url"], "https://example.test/0.2.0/oh-my-diff-0.2.0.tar.xz")
        self.assertEqual(self.check(channel="beta")["available"]["version"], "0.3.0-beta.1")
        self.assertEqual(self.check(pin="0.1.0")["available"], None)
        self.assertEqual(self.check(pin="0.9.9")["error"], "pinned version 0.9.9 is not published")
        self.settings = {}
        self.published[2]["manifest"]["sha256"] = "b" * 64
        skipped = self.check()
        self.assertIn("digest disagrees", skipped["error"])
        self.assertEqual(skipped["available"]["version"], "0.1.5")
        self.published[2]["manifest"]["sha256"] = "a" * 64
        self.check()
        self.published = OSError("network is unreachable")
        offline = self.check()
        self.assertEqual((offline["available"]["version"], offline["error"]), ("0.2.0", "network is unreachable"))
        self.assertEqual(json.loads((self.root / "update/state.json").read_text())["installed"], "0.1.0")

    def test_tick_respects_checks_and_does_not_retry_a_failed_release(self):
        self.published = [release("0.2.0")]
        staged = []
        self.module.stage = lambda root, available: staged.append(available["version"])
        args = types.SimpleNamespace()
        self.settings = {"checks": "off", "auto": "on"}
        self.write_settings()
        self.module.tick(args, self.root, self.current)
        self.assertFalse((self.root / "update/state.json").exists())
        self.assertGreater((self.root / "update/next").stat().st_mtime, time.time() + 80_000)
        self.settings = {"auto": "on"}
        self.write_settings()
        self.module.tick(args, self.root, self.current)
        self.assertEqual(staged, ["0.2.0"])
        self.assertEqual(json.loads((self.root / "update/ready.json").read_text()), {"version": "0.2.0", "automatic": True})
        replaced = self.root / "releases" / ("1" * 32)
        replaced.mkdir()
        self.module.atomic_symlink(self.root / "current", replaced)
        before = self.module.state(self.root)
        self.module.tick(args, self.root, self.current)
        self.assertEqual(self.module.state(self.root), before)
        self.module.atomic_symlink(self.root / "current", self.current)
        self.module.save(self.root, failed={"version": "0.2.0", "error": "SHA-256 mismatch", "at": 1})
        self.module.tick(args, self.root, self.current)
        self.module.save(self.root, failed=None, held={"version": "0.2.0"})
        self.module.tick(args, self.root, self.current)
        self.assertEqual(staged, ["0.2.0"])
        self.module.settled(self.root, "0.2.0", held=None)
        self.assertEqual({key: self.module.state(self.root)[key] for key in ("installed", "available", "held")},
                         {"installed": "0.2.0", "available": None, "held": None})

    def test_offline_checks_do_not_reuse_a_release_excluded_by_current_policy(self):
        for changes in ({"pin": "0.1.0"}, {"channel": "stable"}):
            with self.subTest(changes=changes):
                self.published = [release("0.2.0-beta.1", prerelease=True)]
                self.assertEqual(self.check(channel="beta")["available"]["version"], "0.2.0-beta.1")
                self.published = OSError("offline")
                self.assertIsNone(self.check(**changes)["available"])

    def test_launch_rechecks_staged_release_policy_and_compatibility(self):
        applied = []
        self.module.stage = lambda *arguments: None
        self.module.mod_request = lambda *arguments: None
        self.module.apply = lambda args, root, current, available: applied.append(available["version"])
        args = types.SimpleNamespace(session=os.getpid())
        for changes in ({"auto": "off"}, {"pin": "0.1.0"}, {"auto": "off", "pin": "0.1.0"}, {"channel": "stable"},
                        {"incompatible": True}, {"user_mods": True}, {"held": True}, {"failed": True}, {}):
            with self.subTest(changes=changes):
                self.settings = {"auto": "on", "channel": "beta"}
                self.write_settings()
                beta = "channel" in changes
                version = "0.2.0-beta.1" if beta else "0.2.0"
                self.published = [release(version, prerelease=beta)]
                self.module.save(self.root, held=None, failed=None)
                self.module.tick(args, self.root, self.current)
                self.assertTrue((self.root / "update/ready.json").is_file())
                self.settings.update({key: value for key, value in changes.items() if key in self.settings or key == "pin"})
                self.write_settings()
                self.module.upstream_binary = (lambda *arguments: self.upstream(args, self.current, "0.161")) if changes.get("incompatible") else self.upstream
                self.module.user_mods = lambda *arguments: ["custom"] if changes.get("user_mods") else []
                for key in ("held", "failed"):
                    if changes.get(key):
                        self.module.save(self.root, **{key: {"version": version}})
                applied.clear()
                self.module.launch(args, self.root, self.current)
                self.assertEqual(applied, [] if changes else [version])
                if changes:
                    self.assertFalse((self.root / "update/ready.json").exists())
                    self.assertIsNone(self.module.state(self.root)["pending"])
                self.module.upstream_binary = self.upstream
                self.module.user_mods = lambda *arguments: []

    def test_launch_preserves_explicit_updates_with_auto_disabled(self):
        self.published = [release("0.2.0")]
        available = self.check(auto="off")["available"]
        self.module.stage = lambda *arguments: None
        applied = []
        self.module.apply = lambda args, root, current, available: applied.append(available["version"])
        args = types.SimpleNamespace(session=os.getpid())
        for request in (None, {"id": "manual-request", "version": "0.2.0"}):
            with self.subTest(request=request):
                self.module.mod_request = lambda *arguments: request
                self.module.deferred(self.root, available)
                self.module.launch(args, self.root, self.current)
        self.assertEqual(applied, ["0.2.0", "0.2.0"])

    def test_node_falls_back_to_mise_when_the_recorded_node_is_too_old(self):
        module = installer()
        tools = self.root / "tools"
        tools.mkdir()
        for name, body in (("old-node", "echo v24.18.0"), ("node", "echo v24.20.1"), ("mise", f"echo {tools / 'node'}")):
            (tools / name).write_text(f"#!/bin/sh\n{body}\n")
            (tools / name).chmod(0o755)
        args = types.SimpleNamespace(node=None)
        environment = os.environ.copy()
        os.environ["PATH"] = f"{tools}{os.pathsep}{environment['PATH']}"
        try:
            self.assertEqual(module.node_binary(args, "24.20.0", tools / "old-node"), tools / "node")
            with self.assertRaisesRegex(ValueError, "Node 24.21"):
                module.node_binary(args, "24.21.0", tools / "old-node")
        finally:
            os.environ["PATH"] = environment["PATH"]

    def test_session_markers_count_only_live_codex_processes(self):
        sessions = self.root / "sessions"
        sessions.mkdir()
        codex = self.root / "codex"
        shutil.copyfile("/bin/sleep", codex)
        codex.chmod(0o755)
        live = subprocess.Popen([codex, "30"])
        idle = subprocess.Popen(["/bin/sleep", "30"])
        try:
            for pid in (live.pid, idle.pid, os.getpid(), 999_999):
                (sessions / str(pid)).touch()
            old = time.time() - 120
            os.utime(sessions / str(idle.pid), (old, old))
            self.assertEqual(self.module.sessions(self.root, os.getpid()), [live.pid])
            self.assertEqual(sorted(path.name for path in sessions.iterdir()), sorted([str(live.pid), str(os.getpid())]))
        finally:
            live.kill()
            idle.kill()
            live.wait()
            idle.wait()


if __name__ == "__main__":
    unittest.main()
