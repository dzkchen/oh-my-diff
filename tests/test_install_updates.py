import json
import os
from pathlib import Path
import pty
import select
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import types
import urllib.error
import unittest
from unittest.mock import patch

from tests.test_authority_broker import signed, signing_key


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
                {"name": "omd-release.json.sig", "browser_download_url": f"https://example.test/{version}/omd-release.json.sig"},
                {"name": name, "browser_download_url": f"https://example.test/{version}/{name}",
                 "digest": f"sha256:{manifest.get('sha256', 'a' * 64)}"}],
            "manifest": {"schema": 1, "version": version, "target": "aarch64-apple-darwin", "upstream_tag": "rust-v0.162.0",
                         "mod_api": "1.0.0", "node": "24.18.0", "archive": name, "sha256": "a" * 64,
                         "artifacts": {"codex": "c" * 64}, **manifest}}


class UpdateSelection(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.keys = tempfile.TemporaryDirectory(prefix="omd-release-keys-")
        cls.key, cls.public = signing_key(Path(cls.keys.name) / "release")
        cls.forger = signing_key(Path(cls.keys.name) / "forger")[0]

    @classmethod
    def tearDownClass(cls):
        cls.keys.cleanup()

    def setUp(self):
        self.module = installer()
        self.temporary = tempfile.TemporaryDirectory(prefix="omd-update-test-", dir="/private/tmp")
        self.root = Path(self.temporary.name).resolve()
        self.current = self.root / "releases" / ("0" * 32)
        store = self.root / "stores/platform"
        (store / "sources/omd_update").mkdir(parents=True)
        shutil.copy2(ROOT / "mods/first-party/omd_update/mod.json", store / "sources/omd_update/mod.json")
        self.settings = {}
        self.enabled = True
        self.write_settings()
        (self.current / "prefix").mkdir(parents=True)
        (self.root / "current").symlink_to(self.current)
        (self.current / "receipt.json").write_text(json.dumps({"schema": 1, "generation": self.current.name, "profile": "platform",
                                                               "releases_url": "https://localhost/releases"}))
        (self.current / "prefix/install.json").write_text(json.dumps({"version": "0.1.0", "store": str(store), "packages": {},
                                                                      "author": {"node": "/usr/bin/true"}}))
        self.published = []
        self.module.RELEASE_KEY = self.public
        self.signing = self.key
        self.module.fetch_json = self.fetch
        self.module.fetch_bytes = self.fetch_bytes
        self.module.user_mods = lambda record, store, mod_api: []
        self.module.node_binary = lambda *arguments: Path("/usr/bin/true")
        self.module.upstream_binary = self.upstream

    def tearDown(self):
        self.temporary.cleanup()

    def write_settings(self):
        store = self.root / "stores/platform"
        (store / "mods.json").write_text(json.dumps({"mods": [{"path": str(store / "sources/omd_update"), "enabled": self.enabled, "settings": self.settings}]}))

    def upstream(self, args, current, minor=None):
        if minor and minor != "0.162":
            raise ValueError(f"upstream Codex {minor}.x is required; found codex-cli 0.162.0")
        return {"path": "/usr/bin/true", "version": "codex-cli 0.162.0"}

    def fetch(self, url, limit):
        if url == "https://localhost/releases":
            if isinstance(self.published, Exception):
                raise self.published
            return [{key: value for key, value in item.items() if key != "manifest"} for item in self.published]
        self.fail(f"unexpected metadata fetch: {url}")

    def fetch_bytes(self, url, limit):
        manifest = url.removesuffix(".sig")
        body = json.dumps(next(item["manifest"] for item in self.published
                               if manifest == item["assets"][0]["browser_download_url"])).encode()
        if url == manifest:
            return body
        return signed(self.signing, Path(self.keys.name) / "omd-release.json", body).with_suffix(".json.sig").read_bytes()

    def check(self, **settings):
        self.settings = settings
        self.write_settings()
        return self.module.check(types.SimpleNamespace(), self.root, self.current)

    def test_versions_order_by_semantic_precedence(self):
        ordered = ["0.1.0-alpha.1", "0.1.0-alpha.2", "0.1.0-alpha.10", "0.1.0-beta", "0.1.0", "0.1.1", "0.10.0"]
        self.assertEqual(sorted(reversed(ordered), key=self.module.version_key), ordered)
        self.assertIsNone(self.module.version_key("v1.0"))

    def test_nightly_is_explicit_and_cached_nightlies_follow_channel_changes(self):
        self.published = [release("0.1.0-nightly.20261009070000.100.1", prerelease=True),
                          release("0.1.0-nightly.20261008070000.99.1", prerelease=True),
                          release("0.2.0-rc.1", prerelease=True), release("0.1.1")]
        self.assertEqual(self.check()["available"]["version"], "0.1.1")
        self.assertEqual(self.check(channel="prerelease")["available"]["version"], "0.2.0-rc.1")
        self.assertEqual(self.check(channel="nightly")["available"]["version"], "0.1.0-nightly.20261009070000.100.1")

    def test_install_keeps_saved_channel_and_explicit_stable_replaces_it(self):
        self.published = [release("0.1.0-nightly.20261008070000.99.1", prerelease=True), release("0.1.1")]
        self.settings = {"channel": "nightly"}
        self.write_settings()
        for channel, selected, saved in ((None, "nightly", []), ("stable", "stable", [("channel", "stable")])):
            with self.subTest(channel=channel):
                args = types.SimpleNamespace(asset_url=None, asset_sha256=None, releases_url="https://localhost/releases",
                                             channel=channel, session=None, json=True)
                with patch.object(self.module.platform, "system", return_value="Darwin"), \
                        patch.object(self.module.platform, "machine", return_value="arm64"), \
                        patch.object(self.module, "profile_choice", return_value="platform"), \
                        patch.object(self.module, "refuse_sessions"), patch.object(self.module, "download", return_value=0) as download, \
                        patch.object(self.module, "transaction", return_value={}), patch.object(self.module, "set_policy") as policy, \
                        patch("builtins.print"):
                    self.module.install(args, self.root, self.current)
                expected = self.published[0 if selected == "nightly" else 1]
                self.assertEqual(download.call_args.args[0], expected["assets"][-1]["browser_download_url"])
                self.assertEqual([call.args[-2:] for call in policy.call_args_list], saved)

    def test_channel_changes_reject_older_bases_and_allow_same_base_transitions(self):
        for channel, candidate, installed, expected in (
                ("nightly", "0.1.0-nightly.20261008.99.1", "0.2.0", False),
                ("nightly", "0.2.0-nightly.20261008.99.1", "0.2.0", True),
                ("prerelease", "0.2.0-rc.1", "0.2.0-nightly.20261008.99.1", True),
                ("prerelease", "0.1.0-rc.1", "0.2.0-nightly.20261008.99.1", False),
                ("stable", "0.2.0", "0.2.0-nightly.20261008.99.1", True),
                ("nightly", "0.2.0-nightly.20261008.99.1", "0.2.0-nightly.20261009.100.1", False)):
            with self.subTest(channel=channel, candidate=candidate, installed=installed):
                self.assertEqual(self.module.eligible({"channel": channel},
                                                     {"version": candidate, "prerelease": "-" in candidate}, installed), expected)

    def test_old_pins_and_beta_releases_are_not_hidden_by_stable_or_nightly_history(self):
        url = "https://api.github.com/repos/example/omd/releases?per_page=20"
        versions = ["0.3.0-rc.1", "0.2.0", "0.1.0"]
        refs = [{"ref": f"refs/tags/v0.4.0-nightly.20261008.{number}.1"} for number in range(300)]
        refs += [{"ref": f"refs/tags/v{version}"} for version in versions]
        def fetch(address, limit):
            if "/git/matching-refs/" in address:
                return refs
            if "/releases/tags/" in address:
                version = address.rsplit("/v", 1)[1]
                if version == "0.9.9":
                    raise urllib.error.HTTPError(address, 404, "not found", {}, None)
                return release(version, prerelease="-" in version)
            self.fail(f"unexpected history scan: {address}")
        with patch.object(self.module, "fetch_json", side_effect=fetch) as fetched:
            self.assertEqual([item["version"] for item in self.module.releases(url, channel="prerelease")], versions)
            self.assertEqual(fetched.call_count, 4)
            fetched.reset_mock()
            self.assertEqual(self.module.releases(url, pin="0.1.0")[0]["version"], "0.1.0")
            self.assertEqual(fetched.call_count, 1)
            self.assertEqual(self.module.releases(url, pin="0.9.9"), [])
            with self.assertRaisesRegex(ValueError, "pinned version is malformed"):
                self.module.releases(url, pin="bad pin")

    def test_installer_accepts_the_pinned_upstream_minor(self):
        module = installer()
        version = json.loads((ROOT / "upstream.lock.json").read_text())["tag"].removeprefix("rust-v")
        major, minor, _ = map(int, version.split("."))
        codex = self.root / "codex"
        args = types.SimpleNamespace(upstream=codex, bin_dir=self.root / "bin")
        for candidate, accepted in ((version, True), (f"{major}.{minor}.99", True),
                                    (f"{major}.{minor - 1}.0", False), (f"{major}.{minor + 1}.0", False)):
            with self.subTest(version=candidate):
                codex.write_text(f"#!/bin/sh\nprintf '%s\\n' 'codex-cli {candidate}'\n")
                codex.chmod(0o755)
                if accepted:
                    self.assertEqual(module.upstream_binary(args, None, module.UPSTREAM_MINOR)["version"],
                                     f"codex-cli {candidate}")
                else:
                    with self.assertRaisesRegex(ValueError, "upstream Codex"):
                        module.upstream_binary(args, None, module.UPSTREAM_MINOR)

    def test_install_warns_when_upstream_codex_precedes_the_launcher(self):
        upstream, bin_dir = self.root / "upstream", self.root / "bin"
        for directory in (upstream, bin_dir):
            directory.mkdir()
            (directory / "codex").write_text("#!/bin/sh\n")
            (directory / "codex").chmod(0o755)
        with patch.dict(os.environ, {"PATH": f"{upstream}:{bin_dir}"}):
            warning = self.module.path_warning(bin_dir)
        self.assertIn(str(upstream / "codex"), warning)
        self.assertIn(f'export PATH="{bin_dir}:$PATH"', warning)
        with patch.dict(os.environ, {"PATH": f"{bin_dir}:{upstream}"}):
            self.assertIsNone(self.module.path_warning(bin_dir))

    def test_first_install_restores_launchers_after_partial_failure_and_interruption(self):
        for interrupted in (False, True):
            for failed_name in (list(self.module.LINKS)[0], list(self.module.LINKS)[-1]):
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
        self.published = [release("0.3.0-rc.1", prerelease=True), release("0.2.1", upstream_tag="rust-v0.163.0"),
                          release("0.2.0"), release("0.1.0"), release("0.1.5"),
                          {"tag_name": "nightly", "assets": []}, {**release("0.4.0"), "draft": True}]
        stable = self.check()
        self.assertEqual(stable["available"]["version"], "0.2.0")
        self.assertEqual(stable["blocked"]["version"], "0.2.1")
        self.assertIn("0.163.x", stable["blocked"]["reasons"][0])
        self.assertEqual(stable["available"]["manifest"]["url"], "https://example.test/0.2.0/oh-my-diff-0.2.0.tar.xz")
        self.assertEqual(self.check(channel="prerelease")["available"]["version"], "0.3.0-rc.1")
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

    def test_unsigned_or_forged_manifests_are_refused_before_any_download(self):
        self.module.download = lambda *arguments: self.fail("downloaded an unverified release")
        self.settings = {"auto": "on"}
        self.write_settings()
        unsigned = release("0.2.0")
        unsigned["assets"] = [asset for asset in unsigned["assets"] if not asset["name"].endswith(".sig")]
        for published, error in (([unsigned], "release 0.2.0 is unsigned"),
                                 ([release("0.2.0")], "signature does not verify")):
            with self.subTest(error=error):
                self.published = published
                self.signing = self.forger if "verify" in error else self.key
                result = self.check()
                self.assertIsNone(result["available"])
                self.assertIn(error, result["error"])
                self.module.tick(types.SimpleNamespace(session=os.getpid()), self.root, self.current)
                self.assertFalse((self.root / "update/ready.json").exists())
                self.assertFalse((self.root / "update/staged").exists())
        self.signing = self.key
        self.assertEqual(self.check()["available"]["version"], "0.2.0")
        manifest = self.check()["available"]["manifest"]
        tampered = manifest | {"body": manifest["body"].replace('"a' , '"b', 1)}
        for bad in (tampered, {key: value for key, value in manifest.items() if key != "signature"}):
            with self.assertRaisesRegex(ValueError, "no longer verifies"):
                self.module.transaction(None, self.root, self.current, None, manifest["url"], manifest["sha256"],
                                        "platform", None, None, bad)

    def test_release_lists_come_only_from_github_or_a_loopback_server(self):
        for url in ("https://api.github.com/repos/dzkchen/oh-my-diff/releases?per_page=20", "https://127.0.0.1:8443/releases"):
            self.assertEqual(self.module.release_source(url), url)
        for url in ("https://evil.test/releases", "http://127.0.0.1/releases", "https://api.github.com/gists"):
            with self.subTest(url=url), self.assertRaisesRegex(ValueError, "--releases-url must be"):
                self.module.release_source(url)

    def test_launch_rechecks_staged_release_policy_and_compatibility(self):
        applied = []
        self.module.stage = lambda *arguments: None
        self.module.mod_request = lambda *arguments: None
        self.module.apply = lambda args, root, current, available: applied.append(available["version"])
        args = types.SimpleNamespace(session=os.getpid())
        for changes in ({"auto": "off"}, {"pin": "0.1.0"}, {"auto": "off", "pin": "0.1.0"}, {"channel": "stable"},
                        {"incompatible": True}, {"user_mods": True}, {"held": True}, {"failed": True}, {}):
            with self.subTest(changes=changes):
                self.settings = {"auto": "on", "channel": "prerelease"}
                self.write_settings()
                prerelease = "channel" in changes
                version = "0.2.0-rc.1" if prerelease else "0.2.0"
                self.published = [release(version, prerelease=prerelease)]
                self.module.save(self.root, held=None, failed=None)
                self.module.tick(args, self.root, self.current)
                self.assertTrue((self.root / "update/ready.json").is_file())
                self.settings.update({key: value for key, value in changes.items() if key in self.settings or key == "pin"})
                self.write_settings()
                self.module.upstream_binary = (lambda *arguments: self.upstream(args, self.current, "0.163")) if changes.get("incompatible") else self.upstream
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

    def test_recovery_removes_only_a_store_the_interrupted_install_created(self):
        for existing in (False, True):
            with self.subTest(existing=existing), tempfile.TemporaryDirectory(dir=self.root) as temporary:
                root = Path(temporary)
                store = root / "stores/platform"
                if existing:
                    store.mkdir(parents=True)
                args = types.SimpleNamespace(bin_dir=root / "bin", session=None, releases_url=None)

                def killed(*arguments, **keywords):
                    command = arguments[0]
                    self.assertEqual((command[command.index("--payload") + 1], keywords["cwd"]), (root, root))
                    self.assertNotIn("--archive", command)
                    Path(command[command.index("--prefix") + 1]).mkdir()
                    store.mkdir(parents=True, exist_ok=True)
                    raise KeyboardInterrupt

                with patch.object(self.module, "extract", return_value=root), patch.object(self.module, "run", side_effect=killed), \
                        patch.object(self.module, "discard"), patch.object(self.module, "abandon"):
                    with self.assertRaises(KeyboardInterrupt):
                        self.module.transaction(args, root, None, root / "archive", "https://example.test/archive", "a" * 64,
                                                "platform", {"path": "/usr/bin/true"}, "/usr/bin/true")
                self.assertEqual(self.module.read_json(root / "update/journal.json", {})["created"], None if existing else "platform")
                self.module.recover(args, root, None)
                self.assertEqual(store.exists(), existing)
                self.assertFalse((root / "update/journal.json").exists())

    def test_uninstall_removes_older_generations_before_current_and_cleans_leftovers(self):
        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        older = self.root / "releases" / ("1" * 32)
        for generation in (self.current, older):
            (generation / "bin").mkdir(parents=True, exist_ok=True)
            (generation / "prefix").mkdir(exist_ok=True)
            (generation / "prefix/install.json").touch()
            (generation / "receipt.json").write_text("{}")
            (generation / self.module.RELEASE_MANIFEST).write_text("{}")
            (generation / self.module.RELEASE_SIGNATURE).write_text("sig")
        (older / "prefix/personal.txt").write_text("keep")
        (self.root / "previous").symlink_to(older)
        (self.root / "releases/failed-stranded/prefix").mkdir(parents=True)
        (self.root / "releases" / ("2" * 32)).mkdir()
        (self.root / "releases" / ("2" * 32) / ".DS_Store").touch()
        (self.root / "update/staged").mkdir(parents=True)
        (self.root / "update/staged/package.tar.xz").touch()
        (self.root / "sessions").mkdir()
        (self.root / "catalog").mkdir()

        def package(generation, upstream, directory, *arguments):
            if (generation / "prefix/personal.txt").exists():
                raise ValueError("installation prefix contains unmanaged files")
            shutil.rmtree(generation / "prefix")

        args = types.SimpleNamespace(session=None)
        holder = self.module.flocked(self.root / ".install.lock")
        waiter = open(self.root / ".install.lock", "a+")
        waited = threading.Thread(target=self.module.fcntl.flock, args=(waiter, self.module.fcntl.LOCK_EX))
        waited.start()
        try:
            with patch.object(self.module, "package", side_effect=package), patch.object(self.module, "status"), \
                    patch.object(self.module, "broker_deployed", return_value=False), patch("builtins.print"):
                with self.assertRaisesRegex(ValueError, "unmanaged files"):
                    self.module.uninstall(args, self.root, bin_dir, self.current)
                self.assertTrue((self.root / "current").is_symlink() and (self.current / "receipt.json").is_file())
                (older / "prefix/personal.txt").unlink()
                self.module.uninstall(args, self.root, bin_dir, self.current)
            self.assertIsNone(self.module.flocked(self.root / ".install.lock"), "a fresh entrant waits for the holder")
            holder.close()
            waited.join(5)
            self.assertFalse(waited.is_alive())
            self.assertIsNone(self.module.flocked(self.root / ".install.lock"), "a fresh entrant waits for the waiter")
            self.assertEqual(os.fstat(waiter.fileno()).st_ino, (self.root / ".install.lock").stat().st_ino)
        finally:
            holder.close()
            waiter.close()
            waited.join(5)
        self.assertEqual(sorted(path.name for path in self.root.iterdir()), [".install.lock", "bin", "catalog", "releases", "stores"])
        self.assertEqual(list((self.root / "releases").iterdir()), [])
        self.assertTrue((self.root / "stores/platform/mods.json").is_file())

    def test_interrupted_uninstall_finishes_on_the_next_start(self):
        real_unlink, real_rmdir = Path.unlink, Path.rmdir
        for point in ("launcher", "receipt", "pointer"):
            with self.subTest(point=point), tempfile.TemporaryDirectory(dir=self.root) as temporary:
                root = Path(temporary)
                bin_dir = root / "bin"
                bin_dir.mkdir()
                (bin_dir / "codex").write_text("upstream codex")
                (bin_dir / "omd-mod").symlink_to(root / "upstream-omd-mod")
                current = root / "releases" / ("1" * 32)
                (current / "bin").mkdir(parents=True)
                (current / "prefix/management").mkdir(parents=True)
                (current / "prefix/install.json").write_text("{}")
                for name in self.module.LINKS:
                    (current / "bin" / name).write_text(name)
                (current / "receipt.json").write_text(json.dumps({"schema": 1, "generation": current.name, "bin_dir": str(bin_dir)}))
                (root / "current").symlink_to(current)
                (root / "stores/platform").mkdir(parents=True)
                (root / "stores/platform/mods.json").write_text("{}")
                self.module.set_links(root, bin_dir)

                def package(generation, upstream, directory, *arguments):
                    prefix = generation / "prefix"
                    (prefix / ".uninstall.json").write_text("{}")
                    (generation / "bin/codex").unlink()
                    if point == "launcher":
                        raise OSError("interrupted")
                    shutil.rmtree(prefix)

                def unlink(path, *arguments, **keywords):
                    if point == "receipt" and path.name == "receipt.json" or point == "pointer" and path == root / "current":
                        raise OSError("interrupted")
                    real_unlink(path, *arguments, **keywords)

                def rmdir(path):
                    if point == "prefix" and path.name == "bin" or point == "generation" and path == current:
                        raise OSError("interrupted")
                    real_rmdir(path)

                args = types.SimpleNamespace(session=None, upstream=None, bin_dir=None, root=root, command="uninstall",
                                             action=None, value=None)
                with patch.object(self.module, "package", side_effect=package), patch.object(self.module, "status"), \
                        patch.object(self.module, "broker_deployed", return_value=False), \
                        patch.object(Path, "unlink", unlink), patch.object(Path, "rmdir", rmdir), \
                        self.assertRaisesRegex(OSError, "interrupted"):
                    self.module.uninstall(args, root, bin_dir, current)
                self.assertTrue((root / "update/journal.json").is_file())
                self.assertEqual((bin_dir / "codex").read_text(), "upstream codex")
                printed = []
                with patch.object(sys, "argv", ["install.sh", "uninstall", "--root", str(root)]), \
                        patch.object(self.module, "package", side_effect=AssertionError("package code is not needed")), \
                        patch("builtins.print", side_effect=printed.append):
                    self.module.main()
                self.assertTrue(json.loads(printed[0])["uninstalled"])
                self.assertEqual(sorted(path.name for path in root.iterdir()), [".install.lock", "bin", "releases", "stores"])
                self.assertEqual(list((root / "releases").iterdir()), [])
                self.assertEqual((root / "stores/platform/mods.json").read_text(), "{}")
                self.assertEqual(sorted(path.name for path in bin_dir.iterdir()), ["codex", "omd-mod"])
                self.assertEqual((bin_dir / "codex").read_text(), "upstream codex")
                self.assertEqual(os.readlink(bin_dir / "omd-mod"), str(root / "upstream-omd-mod"))

    def test_uninstall_journal_for_an_unjournaled_nonempty_prefix_relinks_instead_of_retrying(self):
        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        (bin_dir / "codex").write_text("upstream codex")
        (self.current / "bin").mkdir(parents=True, exist_ok=True)
        (self.current / "prefix/install.json").unlink()
        (self.current / "prefix/stray.txt").write_text("stray")
        for name in self.module.LINKS:
            (self.current / "bin" / name).write_text(name)
        self.module.write_json(self.module.update_dir(self.root) / "journal.json",
                               {"uninstall": self.current.name, "bin_dir": str(bin_dir)})
        args = types.SimpleNamespace(bin_dir=bin_dir)
        self.assertIsNone(self.module.resume_uninstall(args, self.root))
        self.assertFalse((self.root / "update/journal.json").exists())
        self.assertTrue(self.module.managed(self.root, bin_dir / "codex", "codex"))
        self.assertEqual((self.current / "prefix/stray.txt").read_text(), "stray")

    def test_install_requires_asset_url_and_sha256_together(self):
        self.module.download = lambda *arguments: self.fail("downloaded without a pinned pair")
        for url, sha256 in (("https://example.invalid/x", None), (None, "a" * 64)):
            with self.assertRaisesRegex(ValueError, "together"):
                self.module.install(types.SimpleNamespace(asset_url=url, asset_sha256=sha256), self.root, self.current)

    def test_installer_ignores_modules_in_the_working_directory(self):
        planted = self.root / "planted.txt"
        (self.root / "argparse.py").write_text(f"open({str(planted)!r}, 'w').close()\n")
        result = subprocess.run(["sh", ROOT / "install.sh", "--help"], cwd=self.root, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(planted.exists())


class ProfilePrompt(unittest.TestCase):
    def test_node_on_path_is_used_without_mise(self):
        module = installer()
        with tempfile.TemporaryDirectory(prefix="omd-node-", dir="/private/tmp") as temporary:
            node = Path(temporary).resolve() / "node"
            node.write_text("#!/bin/sh\necho v24.18.1\n")
            node.chmod(0o755)
            with patch.dict(os.environ, {"PATH": f"{temporary}:/usr/bin:/bin"}):
                self.assertEqual(module.node_binary(types.SimpleNamespace(node=None)), node)
                node.write_text("#!/bin/sh\necho v22.1.0\n")
                with self.assertRaisesRegex(ValueError, "Node 24.18 or a later 24.x is required"):
                    module.node_binary(types.SimpleNamespace(node=None))

    def test_piped_install_reads_the_profile_from_the_terminal(self):
        module = installer()
        pid, leader = pty.fork()
        if pid == 0:
            try:
                os.write(1, f"\nresult={module.profile_choice(types.SimpleNamespace(profile=None))}\n".encode())
            finally:
                os._exit(0)
        screen, deadline = b"", time.monotonic() + 20
        while b"result=" not in screen and time.monotonic() < deadline:
            if select.select([leader], [], [], 0.5)[0]:
                try:
                    screen += os.read(leader, 4096)
                except OSError:
                    break
            if screen.endswith(b"Profile [1/2]: "):
                os.write(leader, b"1\n")
        os.waitpid(pid, 0)
        self.assertIn(b"OMD Core", screen)
        self.assertIn(b"result=full", screen)


if __name__ == "__main__":
    unittest.main()
