import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import types
import unittest


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

    def test_channel_pin_compatibility_and_failures(self):
        self.published = [release("0.3.0-beta.1", prerelease=True), release("0.2.1", upstream_tag="rust-v0.161.0"),
                          release("0.2.0"), release("0.1.0"), {"tag_name": "nightly", "assets": []},
                          {**release("0.4.0"), "draft": True}]
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
        self.assertIn("digest disagrees", self.check()["error"])
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
        self.assertEqual(json.loads((self.root / "update/ready.json").read_text()), {"version": "0.2.0"})
        self.module.save(self.root, failed={"version": "0.2.0", "error": "SHA-256 mismatch", "at": 1})
        self.module.tick(args, self.root, self.current)
        self.module.save(self.root, failed=None, held={"version": "0.2.0"})
        self.module.tick(args, self.root, self.current)
        self.assertEqual(staged, ["0.2.0"])
        self.module.settled(self.root, "0.2.0", held=None)
        self.assertEqual({key: self.module.state(self.root)[key] for key in ("installed", "available", "held")},
                         {"installed": "0.2.0", "available": None, "held": None})

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
