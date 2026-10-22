import argparse
import contextlib
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts import profiles


ROOT = Path(__file__).resolve().parents[1]


def installed_fixture(base):
    prefix, bin_dir = base / "prefix", base / "bin"
    prefix.mkdir()
    bin_dir.mkdir()
    digests = {}
    for name in profiles.LAUNCHERS:
        (bin_dir / name).write_text(f"launcher {name}")
        digests[name] = profiles.support.digest(bin_dir / name)
    record = {key: {"installed_path": str(prefix / key)} for key in ("binary", "code_mode_host", "broker", "runner", "manager")}
    record.update(author={"files": [], "launcher_sha256": digests["omd-mod-author"]},
                  management={"files": [], "launcher_sha256": digests["omd-package"]},
                  activation={"sha256": digests["codex"]},
                  tools={name: {"installed_path": str(prefix / "binary"), "launcher_sha256": digests[name]}
                         for name in (*profiles.HOST_TOOLS, "omd-mod")},
                  packages={"example": {"files": ["index.ts"]}},
                  sources={"example": ["index.ts"], "inactive": ["index.ts"]},
                  shared_state={"codex_home": str(base / "home")}, store=str(base / "store"))
    for name in ("install.json", "binary", "code_mode_host", "broker", "runner", "manager"):
        (prefix / name).touch()
    for identifier in record["sources"]:
        source = prefix / "sources" / identifier
        source.mkdir(parents=True)
        (source / "index.ts").touch()
    return prefix, bin_dir, record


def uninstalling(record):
    return (patch.object(profiles, "load", return_value=record), patch.object(profiles, "check"),
            patch.object(profiles.authority_broker, "deployed", return_value=False),
            patch.object(profiles.shutil, "which", return_value="/usr/bin/true"),
            patch.object(profiles.support, "binary_identity"))


class ProfileModeTests(unittest.TestCase):
    def test_every_selection_keeps_the_background_server_off(self):
        for selection in ("platform", "full", "direct"):
            with self.subTest(selection=selection):
                record = {"binary": {"installed_path": "/omd/codex"}, "store": "/omd/store", "profile": "full",
                          "activation": {"selection": selection}}
                self.assertIn("-c features.daemon_auto_start=false", profiles.selected_text(record).splitlines()[-1])

    def test_a_route_launch_refreshes_a_catalog_that_lacks_routes_added_in_a_session(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            (base / "host.json").write_text(json.dumps({"routes": [{"model": "work", "provider": "omd_profiles", "data": {}},
                                                                   {"model": "home", "provider": "omd_profiles", "data": {}},
                                                                   {"model": "legacy", "provider": "omd_profiles"}]}))
            route, catalog = base / "route.json", base / "models.json"
            route.write_text(json.dumps({"default": "work", "models": [{"slug": "work", "family": "work"}]}))
            catalog.write_text(json.dumps({"models": [{"slug": "work"}]}))
            record = {"profile": "full", "store": str(base), "activation": {"selection": "omd"}, "manager": {"installed_path": "m"},
                      "providers": {"omd_profiles": {"route": str(route), "catalog": str(catalog)}}}

            def setup(_prefix, _record, _name, _identifier, options):
                self.assertEqual(options, {})
                route.write_text(json.dumps({"default": "work", "models": [{"slug": "work"}, {"slug": "home"}]}))
                catalog.write_text(json.dumps({"models": [{"slug": "work"}, {"slug": "home"}]}))

            arguments = argparse.Namespace(setup=False, model="home", codex=[])
            with patch.object(profiles, "load", return_value=record), patch.object(profiles, "check"), \
                    patch.object(profiles, "invoke", return_value={"selections": [{"id": "omd_profiles", "effective": True}]}), \
                    patch.object(profiles, "route_setup", side_effect=setup) as refreshed, \
                    patch.object(profiles.os, "execv") as launched:
                profiles.route(base, base, "profiles", arguments)
                profiles.route(base, base, "profiles", arguments)
            self.assertEqual(refreshed.call_count, 1)
            self.assertIn('model="home"', launched.call_args.args[1])

    def test_omd_launcher_routes_uninstall_to_the_installer_that_owns_it(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            for name in ("tool", "control", "installer"):
                (base / name).write_text(f"echo {name} \"$@\" \"$OMD_MOD_STORE\"\n")
                (base / name).chmod(0o755)
            record = {"store": "/omd/store"}
            managed = {**record, "update": {"python": "python3", "installer": str(base / "installer"), "root": "/omd/root"}}
            for current, argv, expected in (
                    (managed, ["uninstall", "--keep-broker"], "installer uninstall --root /omd/root --keep-broker"),
                    (managed, ["update"], "installer update --root /omd/root"),
                    (managed, ["codex-app", "status"], "installer codex-app --root /omd/root status"),
                    (record, ["uninstall", "--keep-broker"], "control uninstall --keep-broker"),
                    (record, ["update"], "tool update /omd/store")):
                with self.subTest(managed="update" in current, argv=argv):
                    launcher = base / "omd"
                    launcher.write_text(profiles.omd_text(current, str(base / "tool"), base / "control"))
                    run = subprocess.run(["sh", launcher, *argv], capture_output=True, text=True, check=True)
                    self.assertEqual(run.stdout.strip(), expected)

    def test_uninstall_uses_recorded_sources_and_preserves_unmanaged_files(self):
        for unmanaged in (False, True):
            with self.subTest(unmanaged=unmanaged), tempfile.TemporaryDirectory() as temporary:
                prefix, bin_dir, record = installed_fixture(Path(temporary))
                if unmanaged:
                    (prefix / "personal.txt").write_text("preserve")
                with contextlib.ExitStack() as stack:
                    for item in uninstalling(record):
                        stack.enter_context(item)
                    if unmanaged:
                        with self.assertRaisesRegex(ValueError, "unmanaged files"):
                            profiles.uninstall(prefix, bin_dir)
                        self.assertEqual((prefix / "personal.txt").read_text(), "preserve")
                        self.assertTrue((bin_dir / "codex").exists())
                    else:
                        self.assertTrue(profiles.uninstall(prefix, bin_dir)["uninstalled"])
                        self.assertFalse(prefix.exists())
                        self.assertEqual(list(bin_dir.iterdir()), [])

    def test_uninstall_removes_plugins_added_from_this_installation(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary).resolve()
            prefix, home = base / "prefix", base / "codex"
            (prefix / "plugins").mkdir(parents=True)
            home.mkdir()
            config = home / "config.toml"
            config.write_text(f'''[marketplaces.oh-my-diff]
source = "{prefix / 'plugins'}"
[marketplaces.other]
source = "{base}"
[plugins."omd-anchored-edit@oh-my-diff"]
enabled = true
[plugins."tool@other"]
enabled = true
''')
            calls = []

            def run(arguments, **kwargs):
                calls.append(arguments[1:])
                text = config.read_text()
                drop = ('[plugins."omd-anchored-edit@oh-my-diff"]\nenabled = true\n' if arguments[2] == "remove"
                        else f'[marketplaces.oh-my-diff]\nsource = "{prefix / "plugins"}"\n')
                config.write_text(text.replace(drop, ""))

            record = {"shared_state": {"codex_home": str(home)}, "binary": {"installed_path": "/omd/codex"}}
            with patch.object(profiles.support, "run", side_effect=run):
                self.assertEqual(profiles.remove_plugins(record, prefix), ["omd-anchored-edit@oh-my-diff"])
            self.assertEqual(calls, [["plugin", "remove", "omd-anchored-edit@oh-my-diff"],
                                     ["plugin", "marketplace", "remove", "oh-my-diff"]])
            self.assertIn('[plugins."tool@other"]', config.read_text())

    def test_interrupted_uninstall_resumes_and_keeps_replaced_launchers(self):
        real_rmtree, real_unlink = shutil.rmtree, Path.unlink
        for point in ("launchers", "prefix", "journal"):
            with self.subTest(point=point), tempfile.TemporaryDirectory() as temporary:
                prefix, bin_dir, record = installed_fixture(Path(temporary))
                journal = prefix / profiles.UNINSTALL_JOURNAL

                def rmtree(path, *arguments, **keywords):
                    if point == "launchers":
                        raise OSError("interrupted")
                    real_rmtree(path, *arguments, **keywords)

                def unlink(path, *arguments, **keywords):
                    if point == "journal" and path == journal or point == "prefix" and path.name == "install.json":
                        raise OSError("interrupted")
                    real_unlink(path, *arguments, **keywords)

                with contextlib.ExitStack() as stack:
                    for item in uninstalling(record):
                        stack.enter_context(item)
                    with patch.object(profiles.shutil, "rmtree", side_effect=rmtree), \
                            patch.object(Path, "unlink", unlink), self.assertRaisesRegex(OSError, "interrupted"):
                        profiles.uninstall(prefix, bin_dir)
                self.assertTrue(journal.is_file())
                self.assertFalse((bin_dir / "omd-mod").exists())
                (bin_dir / "codex").write_text("restored upstream")
                with patch.object(profiles, "load", side_effect=ValueError("receipt gone")), \
                        patch.object(profiles, "check", side_effect=ValueError("launcher gone")), \
                        patch.object(profiles.authority_broker, "deployed", return_value=False):
                    resumed = profiles.uninstall(prefix, bin_dir)
                self.assertTrue(resumed["uninstalled"])
                self.assertEqual(resumed["upstream"], str(profiles.support.resolved("/usr/bin/true")))
                self.assertFalse(prefix.exists())
                self.assertEqual([path.name for path in bin_dir.iterdir()], ["codex"])
                self.assertEqual((bin_dir / "codex").read_text(), "restored upstream")

    def test_install_refuses_every_existing_launcher_before_changing_anything(self):
        for name in profiles.LAUNCHERS[:1]:
            for dangling in (False, True):
                with self.subTest(name=name, dangling=dangling), tempfile.TemporaryDirectory() as temporary:
                    base = Path(temporary)
                    bin_dir = base / "bin"
                    bin_dir.mkdir()
                    if dangling:
                        (bin_dir / name).symlink_to(base / "missing")
                    else:
                        (bin_dir / name).write_text("user launcher")
                    args = argparse.Namespace(prefix=base / "prefix", bin_dir=bin_dir, store=base / "store")
                    with patch.object(profiles.platform, "system", return_value="Darwin"), \
                            patch.object(profiles.platform, "machine", return_value="arm64"), \
                            self.assertRaisesRegex(ValueError, "launcher already exists"):
                        profiles.install(args)
                    self.assertEqual(sorted(path.name for path in base.iterdir()), ["bin"])
                    self.assertEqual([path.name for path in bin_dir.iterdir()], [name])

    def test_source_reconciliation_finishes_trust_and_selection_after_an_interruption(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            origin, store = base / "origin", base / "store"
            (origin / "example").mkdir(parents=True)
            (origin / "example/index.ts").write_text("new")
            (store / "sources/example").mkdir(parents=True)
            (store / "sources/example/index.ts").write_text("old")
            target = store / "sources/example"
            package = {"files": {"index.ts": profiles.support.digest(origin / "example/index.ts")},
                       "sha256": "new-package", "capabilities": []}
            selection = {"path": str(target), "sha256": "old-package", "selected": True}
            commands, failing = [], ["trust-all"]

            def invoke(_manager, command, _store, *arguments):
                commands.append(command)
                if command in failing:
                    failing.remove(command)
                    raise ValueError("interrupted")
                if command == "selection-status":
                    return {"selections": [dict(selection)]}
                if command == "trust-all":
                    selection.update(sha256=json.loads(arguments[0])[0]["sha256"], selected=False)
                elif command == "enable":
                    selection["selected"] = True
                return {}

            with patch.object(profiles, "invoke", side_effect=invoke):
                with self.assertRaisesRegex(ValueError, "interrupted"):
                    profiles.sync_sources("manager", store, origin, {"example": package})
                self.assertEqual((target / "index.ts").read_text(), "new")
                failing.append("enable")
                with self.assertRaisesRegex(ValueError, "interrupted"):
                    profiles.sync_sources("manager", store, origin, {"example": package})
                self.assertEqual(selection, {"path": str(target), "sha256": "new-package", "selected": False})
                commands.clear()
                self.assertEqual(profiles.sync_sources("manager", store, origin, {"example": package}), ["example"])
                self.assertEqual(commands, ["selection-status", "trust-all", "enable", "reload"])
                self.assertEqual(selection, {"path": str(target), "sha256": "new-package", "selected": True})
                commands.clear()
                self.assertEqual(profiles.sync_sources("manager", store, origin, {"example": package}), [])
                self.assertEqual(commands, ["selection-status"])
            self.assertEqual(sorted(path.name for path in (store / "sources").iterdir()), ["example"])

    def test_broker_install_imports_exact_grants_without_retrusting(self):
        snapshot = {"mods": [{"path": "/mod", "scope": "project", "enabled": True,
                              "sha256": "a" * 64, "capabilities": ["exec"],
                              "secret_environment": ["API_TOKEN"], "expires_at": 4000000000}]}
        record = {"store": "/store", "broker": {"installed_path": "/broker"}}
        calls = []

        def invoke(manager, command, store, *args):
            calls.append((command, args))
            if command == "selection-status":
                return {"selections": [{**snapshot["mods"][0], "selected": True}]}
            if command == "broker-grants-import" and not args:
                return snapshot
            if command == "broker-grants-import":
                self.assertEqual(json.loads(args[0]), snapshot)
            return {}

        with patch.object(profiles, "load", return_value=record), \
                patch.object(profiles, "check", return_value=(None, "/manager")), \
                patch.object(profiles, "pinned_binaries", return_value=set()), \
                patch.object(profiles, "signed_manifest", return_value=Path("/omd-release.json")), \
                patch.object(profiles, "invoke", side_effect=invoke), \
                patch.object(profiles.authority_broker, "main", return_value={"installed": True}):
            profiles.broker(Path("/prefix"), Path("/bin"), "install")
        self.assertEqual([command for command, _ in calls],
                         ["broker-grants-import", "broker-grants-import", "reload"])

    @unittest.skipUnless(os.environ.get("OMD_TEST_MOD_BIN"), "set OMD_TEST_MOD_BIN for native offline coverage")
    def test_service_import_enable_requires_its_provider_in_isolated_store(self):
        manager = Path(os.environ["OMD_TEST_MOD_BIN"]).resolve()
        with tempfile.TemporaryDirectory(prefix="omd-profile-selection-", dir="/private/tmp") as temporary:
            base = Path(temporary)
            store = base / "store"
            profiles.invoke(manager, "init", store)
            sources = store / "sources"
            sources.mkdir()
            for identifier in ("omd_lsp_view", "omd_lsp_sync"):
                source = sources / identifier
                source.mkdir()
                package = ROOT / "mods/first-party" / identifier
                manifest = json.loads((package / "mod.json").read_text())
                for name in ("mod.json", "index.ts", *manifest.get("assets", [])):
                    shutil.copy2(package / name, source / name)
                inspected = profiles.invoke(manager, "inspect", source)
                profiles.invoke(manager, "trust", store, source, inspected["sha256"],
                                     ",".join(inspected["manifest"]["capabilities"]))
            record = {"store": str(store), "packages": {"omd_lsp_view": {}}}

            def profile_status(_prefix, _bin_dir):
                host = profiles.invoke(manager, "status", store)
                selected = {item["id"]: item for item in host["mods"]}
                active = selected.get("omd_lsp_view")
                return {"packages": [{"id": "omd_lsp_view", "enabled_in_store": active is not None,
                                      "error": active["error"] if active else None}]}

            before = profiles.invoke(manager, "selection-status", store)["selections"]
            view_before = next(item for item in before if item["id"] == "omd_lsp_view")
            with patch.object(profiles, "load", return_value=record), \
                    patch.object(profiles, "check", return_value=(None, manager)), \
                    patch.object(profiles, "status", side_effect=profile_status):
                with self.assertRaisesRegex(RuntimeError, "service_provider_missing.*omd.lsp"):
                    profiles.select_mod(base / "prefix", base / "bin", "omd_lsp_view", True)
                after = profiles.invoke(manager, "selection-status", store)["selections"]
                view_after = next(item for item in after if item["id"] == "omd_lsp_view")
                self.assertFalse(view_after["selected"])
                self.assertEqual(view_after["settings_sha256"], view_before["settings_sha256"])
                profiles.invoke(manager, "enable", store, sources / "omd_lsp_sync")
                profiles.invoke(manager, "reload", store)
                result = profiles.select_mod(base / "prefix", base / "bin", "omd_lsp_view", True)
                self.assertTrue(result["packages"][0]["enabled_in_store"])
                self.assertIsNone(result["packages"][0]["error"])

    def test_omd_mini_reopens_the_thread_its_switch_request_names(self):
        with tempfile.TemporaryDirectory(prefix="omd-mini-", dir="/private/tmp") as temporary:
            base = Path(temporary)
            log, exported = base / "runs.log", base / "export.json"
            (base / "codex").write_text(
                "#!/bin/sh\n"
                f"echo \"$*|$OH_MY_DIFF_PRESENTATION|$OH_MY_DIFF_LAUNCH\" >> {log}\n"
                "launch=${OH_MY_DIFF_LAUNCH%.*} run=${OH_MY_DIFF_LAUNCH##*.}\n"
                "if [ \"$OH_MY_DIFF_PRESENTATION\" = mini ]; then\n"
                f"  echo \"{{\\\"entries\\\":{{\\\"switch_$launch\\\":{{\\\"value\\\":{{\\\"run\\\":$run,\\\"target\\\":\\\"full\\\",\\\"thread\\\":\\\"019a0000-0000-7000-8000-000000000001\\\"}}}}}}}}\" > {exported}\n"
                f"else echo '{{\"entries\":{{}}}}' > {exported}; exit 3; fi\n")
            (base / "omd").write_text(f"#!/bin/sh\ncat {exported}\n")
            for name in ("codex", "omd"):
                (base / name).chmod(0o755)
            record = {"activation": {"selection": "full"}, "manager": {"installed_path": "/manager"}, "store": "/store",
                      "tools": {"omd": {"installed_path": str(base / "omd")}}}
            selections = {"selections": [{"id": "omd_mini", "effective": True, "error": None}]}
            with patch.object(profiles, "load", return_value=record), patch.object(profiles, "check"), \
                    patch.object(profiles, "invoke", return_value=selections), \
                    patch.object(profiles.sys.stdin, "isatty", return_value=True), \
                    patch.object(profiles.sys.stdout, "isatty", return_value=True), \
                    patch.object(profiles.signal, "signal"):
                code = profiles.mini(Path("/prefix"), base, ["--model", "m", "-s=danger-full-access", "-C", "/repo", "-c", "a=1",
                                                             "-i", "x.png", "--yolo", "--no-alt-screen", "fix it"])
                selections["selections"][0]["effective"] = False
                with self.assertRaisesRegex(ValueError, "needs its mod enabled"):
                    profiles.mini(Path("/prefix"), base, [])
            runs = [line.split("|") for line in log.read_text().splitlines()]
            self.assertEqual(code, 3)
            self.assertEqual([(argv, mode) for argv, mode, _ in runs], [
                ("--no-alt-screen --model m -s=danger-full-access -C /repo -c a=1 -i x.png --yolo --no-alt-screen fix it", "mini"),
                ("--model m -s=danger-full-access -C /repo -c a=1 --yolo resume 019a0000-0000-7000-8000-000000000001", "full")])
            self.assertEqual([launch.split(".")[1] for _, _, launch in runs], ["0", "1"])
            self.assertEqual(profiles.session_options(["resume", "--last", "-mx", "--model=y", "-c", "a=1", "-c", "b=2", "--", "-s", "p", "-m"]),
                             ["-mx", "--model=y", "-c", "a=1", "-c", "b=2"])
            self.assertEqual(profiles.session_options(["prompt", "-m"]), [])
            self.assertEqual(len({launch.split(".")[0] for _, _, launch in runs}), 1)


if __name__ == "__main__":
    unittest.main()
