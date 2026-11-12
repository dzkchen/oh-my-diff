import argparse
import contextlib
import json
import os
import shutil
import subprocess
import tempfile
import time
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
            patch.object(profiles.authority_broker, "POLICY", Path(record["store"]).parent / "system-policy.json"),
            patch.object(profiles, "CURSOR_DATA", Path(record["store"]).parent / "cursor-data"),
            patch.object(profiles.shutil, "which", return_value="/usr/bin/true"),
            patch.object(profiles.support, "binary_identity"))


class ProfileModeTests(unittest.TestCase):
    def test_account_purge_logs_out_only_isolated_named_claude_accounts_and_cleans_cursor_data(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary).resolve()
            stores = base / "stores"
            home = base / "shared-claude"
            home.mkdir()
            (home / "credentials").write_text("shared login")
            for selection in ("platform", "full"):
                accounts = stores / selection / "routes/claude/accounts"
                (accounts / "work").mkdir(parents=True)
                (accounts / "default").mkdir()
                (accounts / "external").symlink_to(home, target_is_directory=True)
            (stores / "external").symlink_to(home, target_is_directory=True)
            cursor = base / "cursor-data"
            cursor.mkdir(mode=0o700)
            (cursor / "agents.json").write_text("private state")
            prefix = base / "releases/generation/prefix"
            record = {"store": str(stores / "full"), "prefix": str(prefix), "update": {"root": str(base)}}
            calls = []

            def logout(arguments, **options):
                calls.append((arguments, options))
                return subprocess.CompletedProcess(arguments, 0)

            env = {"CLAUDE_CONFIG_DIR": str(home), "CLAUDE_SECURESTORAGE_CONFIG_DIR": str(home),
                   "ANTHROPIC_API_KEY": "inherited", "CLAUDE_CODE_OAUTH_TOKEN": "inherited"}
            with patch.dict(os.environ, env), patch.object(profiles.shutil, "which", return_value="/fixture/claude"), \
                    patch.object(profiles, "CURSOR_DATA", cursor), patch.object(profiles.subprocess, "run", side_effect=logout):
                result = profiles.purge_accounts(record)
            self.assertEqual(result["signed_out_claude_accounts"], 2)
            self.assertEqual({call[1]["env"]["CLAUDE_CONFIG_DIR"] for call in calls},
                             {str(stores / selection / "routes/claude/accounts/work") for selection in ("platform", "full")})
            self.assertTrue(all(call[0] == ["/fixture/claude", "auth", "logout"] for call in calls))
            self.assertTrue(all(not any(name.startswith("ANTHROPIC_") or name.startswith("CLAUDE_") and name != "CLAUDE_CONFIG_DIR"
                                       for name in options["env"]) for _, options in calls))
            self.assertFalse(cursor.exists())
            self.assertEqual((home / "credentials").read_text(), "shared login")

    def test_uninstall_purge_keeps_the_install_and_accounts_when_isolated_logout_fails(self):
        for failure in ("missing", "failed", "timeout"):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as temporary:
                base = Path(temporary).resolve()
                prefix, bin_dir, record = installed_fixture(base)
                account = Path(record["store"]) / "routes/claude/accounts/work"
                account.mkdir(parents=True)
                (account / "credentials").write_text("keep for retry")
                with contextlib.ExitStack() as stack:
                    for item in uninstalling(record):
                        stack.enter_context(item)
                    stack.enter_context(patch.object(profiles.shutil, "which", side_effect=lambda command, **kwargs:
                        None if command == "claude" and failure == "missing" else "/fixture/claude" if command == "claude" else "/usr/bin/true"))
                    stack.enter_context(patch.object(profiles.subprocess, "run", side_effect=subprocess.TimeoutExpired("claude", 10)
                        if failure == "timeout" else lambda *args, **kwargs: subprocess.CompletedProcess(args[0], 1)))
                    with self.assertRaisesRegex(ValueError, "Claude.*sign.out|sign.out.*Claude"):
                        profiles.uninstall(prefix, bin_dir, purge=True)
                self.assertTrue((bin_dir / "codex").exists())
                self.assertFalse((prefix / profiles.UNINSTALL_JOURNAL).exists())
                self.assertEqual((account / "credentials").read_text(), "keep for retry")

    def test_the_direct_selection_keeps_the_background_server_off(self):
        record = {"bin_dir": "/omd/bin", "binary": {"installed_path": "/omd/codex"}, "store": "/omd/store", "profile": "full",
                  "activation": {"selection": "direct"}}
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

    def test_route_setup_installs_its_experimental_mod_into_the_store(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            (base / "sources/omd_profiles").mkdir(parents=True)
            (base / "sources/omd_profiles/index.ts").write_text("new")
            (base / "store/sources/omd_profiles").mkdir(parents=True)
            (base / "store/sources/omd_profiles/index.ts").write_text("stale")
            record = {"profile": "full", "store": str(base / "store"), "manager": {"installed_path": "m"}, "packages": {},
                      "activation": {"selection": "full"}}
            locked = {"packages": {"omd_profiles": {"version": "1.0.0", "package_sha256": "abc", "files": ["index.ts"],
                                                    "capabilities": ["os"]}}}
            calls = []
            arguments = argparse.Namespace(setup=True, add=None, remove=None, allowance=None)
            with patch.object(profiles, "load", return_value=record), patch.object(profiles, "check"), \
                    patch.object(profiles.support, "mods_lock", return_value=locked), patch.object(profiles, "verify"), \
                    patch.object(profiles, "invoke", side_effect=lambda *items: calls.append(items)), \
                    patch.object(profiles, "route_setup", return_value={"provider": {}}), \
                    patch.object(profiles, "selected_text", return_value=""), patch.object(profiles, "select_mod"):
                profiles.route(base, base, "profiles", arguments)
            self.assertEqual((base / "store/sources/omd_profiles/index.ts").read_text(), "new")
            self.assertEqual(calls[0][1], "trust-all")
            self.assertEqual(json.loads((base / "install.json").read_text())["packages"]["omd_profiles"]["sha256"], "abc")

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
                    (managed, ["uninstall", "--purge"], "installer uninstall --root /omd/root --purge"),
                    (managed, ["update"], "installer update --root /omd/root"),
                    (record, ["uninstall", "--keep-broker"], "control uninstall --keep-broker"),
                    (record, ["uninstall", "--purge"], "control uninstall --purge"),
                    (record, ["update"], "tool update /omd/store"),
                    (record, ["help", "--all"], "tool --help"),
                    (record, ["doctor", "--json"], "control doctor --json")):
                with self.subTest(managed="update" in current, argv=argv):
                    launcher = base / "omd"
                    launcher.write_text(profiles.omd_text(current, str(base / "tool"), base / "control"))
                    run = subprocess.run(["sh", launcher, *argv], capture_output=True, text=True, check=True,
                                         env={**os.environ, "OMD_MOD_STORE": ""})
                    self.assertEqual(run.stdout.strip(), expected)

    def test_omd_help_lists_doctor_and_lists_omd_mini_only_once_it_is_installed(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = Path(temporary)
            launcher = store / "omd"
            launcher.write_text(profiles.omd_text({"store": str(store), "profile": "full"}, "tool", store / "control"))
            text = lambda: subprocess.run(["sh", launcher], capture_output=True, text=True, check=True).stdout
            (store / "mods.json").write_text(json.dumps({"mods": [{"path": str(store / "sources/omd_logo")}]}))
            self.assertIn("omd doctor [--json]", text())
            self.assertNotIn("omd mini", text())
            (store / "mods.json").write_text(json.dumps({"mods": [{"path": str(store / "sources/omd_mini")}]}))
            self.assertIn("omd mini", text())
            self.assertTrue(text().rstrip().endswith("Docs: https://github.com/dzkchen/oh-my-diff"))

    def test_reconcile_restores_a_reset_store_from_the_saved_choices_or_the_profile_defaults(self):
        for saved in (True, False):
            with self.subTest(saved=saved), tempfile.TemporaryDirectory() as temporary:
                store = Path(temporary).resolve()
                sources = store / "sources"
                record = {"default_active": ["omd_mods", "omd_statusline", "omd_update"],
                          "packages": {name: {"sha256": name, "capabilities": ["commands"]}
                                       for name in ("omd_logo", "omd_mods", "omd_statusline", "omd_update", "omd_usage")}}
                (store / "mods.json.corrupt").write_text(json.dumps({"mods": [
                    {"path": str(sources / "omd_statusline"), "enabled": False, "settings": {"position": "above"}},
                    {"path": str(sources / "omd_usage"), "enabled": True},
                    {"path": "/elsewhere/my_mod", "enabled": True}]}) if saved else "{broken")
                calls = []

                def invoke(_manager, command, _store, *arguments):
                    calls.append((command, *(Path(item).name if command != "trust-all" else len(json.loads(item)) for item in arguments)))
                    return {"selections": []} if command == "selection-status" else {}

                with patch.object(profiles, "invoke", side_effect=invoke):
                    result = profiles.restore_selection("manager", store, record)
                enabled = sorted(call[1] for call in calls if call[0] == "enable")
                if saved:
                    self.assertEqual(enabled, ["omd_logo", "omd_mods", "omd_update", "omd_usage"])
                    self.assertNotIn("omd_statusline", enabled)
                    self.assertIn(("settings", "omd_statusline", '{"position": "above"}'), calls)
                    self.assertEqual(result["not_restored"], ["/elsewhere/my_mod"])
                else:
                    self.assertEqual(enabled, ["omd_logo", "omd_mods", "omd_statusline", "omd_update"])
                    self.assertEqual(result["selections_from"], "profile defaults")
                self.assertEqual(calls[1], ("trust-all", 5))
                self.assertEqual(sorted(call[1] for call in calls if call[0] == "require"), list(profiles.PLATFORM_PACKAGES))
                self.assertEqual(calls[-1][0], "reload")
                self.assertFalse((store / "mods.json.corrupt").exists())
                self.assertTrue((store / "mods.json.restored").exists())

    def test_the_launcher_restores_mods_after_a_reset_before_starting_codex(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            (base / "bin").mkdir()
            (base / "bin/omd-package").write_text(f"#!/bin/sh\necho \"$@\" > {base / 'ran'}\n")
            (base / "bin/omd-package").chmod(0o755)
            record = {"bin_dir": str(base / "bin"), "binary": {"installed_path": "/usr/bin/true"}, "store": str(base / "store"),
                      "profile": "full", "activation": {"selection": "full"}}
            launcher = base / "codex"
            launcher.write_text(profiles.selected_text(record))
            subprocess.run(["sh", launcher], check=True, capture_output=True)
            self.assertFalse((base / "ran").exists())
            (base / "store").mkdir()
            (base / "store/mods.json.corrupt").write_text("{")
            result = subprocess.run(["sh", launcher], check=True, capture_output=True, text=True)
            self.assertEqual((base / "ran").read_text(), "reconcile --summary\n")
            self.assertEqual(result.stderr, "")

    def test_an_update_names_retired_mods_new_defaults_left_off_and_added_capabilities(self):
        store = Path("/store")
        previous = {"retired": ["omd_old"], "default_active": ["omd_logo"],
                    "packages": {"omd_logo": {"capabilities": ["terminal"]}, "omd_git": {"capabilities": ["commands"]}}}
        record = {"retired": ["omd_gone", "omd_old"], "default_active": ["omd_logo", "omd_new", "omd_on"],
                  "packages": {"omd_logo": {"capabilities": ["terminal"]}, "omd_git": {"capabilities": ["commands", "exec"]},
                               "omd_new": {"capabilities": ["exec"]}, "omd_on": {"capabilities": []}}}
        selections = {"selections": [{"path": "/store/sources/omd_on", "selected": True}]}
        with patch.object(profiles, "invoke", return_value=selections):
            self.assertEqual(profiles.update_changes("manager", store, previous, record),
                             {"retired": ["omd_gone"], "left_off": ["omd_new"], "capabilities": {"omd_git": ["exec"]}})

    def test_activate_names_the_install_command_for_a_profile_that_is_not_installed(self):
        with patch.object(profiles, "load", return_value={"profile": "platform"}), patch.object(profiles, "check"), \
                self.assertRaisesRegex(ValueError, "^OMD\\+ isn't installed here; .*install.sh \\| sh -s -- --profile full$"):
            profiles.activate(Path("/prefix"), Path("/bin"), "full")

    def test_doctor_names_one_fix_per_failure_and_adds_codex_doctor(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary).resolve()
            store, root = base / "store", base / "root"
            (store / "sources/omd_update").mkdir(parents=True)
            shutil.copy2(ROOT / "mods/first-party/omd_update/mod.json", store / "sources/omd_update/mod.json")
            (store / "mods.json").write_text(json.dumps({"mods": [{"path": str(store / "sources/omd_update"), "enabled": True,
                                                                   "settings": {"checks": "off"}}]}))
            (root / "update").mkdir(parents=True)
            (root / "update/state.json").write_text(json.dumps({"blocked": {"version": "2.0.0", "reasons": ["Codex 0.170.x is required"]}}))
            (root / "current").mkdir()
            (root / "current/receipt.json").write_text(json.dumps({"bin_dir": str(base / "links")}))
            record = {"store": str(store), "profile": "full", "version": "1.5.0", "activation": {"selection": "full"},
                      "manager": {"installed_path": "m"}, "runner": {"installed_path": "/usr/bin/true"}, "update": {"root": str(root)}}
            host = {"mods": [{"id": "omd_logo", "error": None}, {"id": "omd_bad", "error": "activation_failed"}], "rejected": []}
            with patch.object(profiles, "load", return_value=record), patch.object(profiles, "check"), \
                    patch.object(profiles, "invoke", return_value=host), patch.object(profiles.shutil, "which", return_value="/usr/local/bin/codex"), \
                    patch.object(profiles.authority_broker, "status", return_value={"deployed": False, "loaded": False, "authority": "unprotected (same-user)"}):
                checks = {item["check"]: item for item in profiles.doctor_checks(base, base / "bin")}
                self.assertEqual({name: item["status"] for name, item in checks.items()},
                                 {"path": "fail", "launcher": "ok", "store": "fail", "runner": "ok", "broker": "ok", "updates": "warn"})
                self.assertIn(f'export PATH="{base / "links"}:$PATH"', checks["path"]["fix"])
                self.assertEqual(checks["store"]["detail"], "omd_bad: activation_failed")
                self.assertTrue(checks["updates"]["detail"].startswith("stable channel, update checks off; 2.0.0 can't be installed"))
                upstream = subprocess.CompletedProcess([], 0, stdout='{"checks": []}', stderr="")
                printed = []
                with patch.object(profiles.subprocess, "run", return_value=upstream) as ran, patch("builtins.print", side_effect=printed.append):
                    self.assertEqual(profiles.doctor(base, base / "bin", ["--summary"], True), 1)
                self.assertEqual(ran.call_args_list[-1].args[0], [base / "bin/codex", "doctor", "--summary", "--json"])
                report = json.loads(printed[0])
                self.assertEqual((report["omd"]["ok"], report["codex"]), (False, {"checks": []}))

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

    def test_uninstall_purge_removes_the_store_and_resumes_after_a_store_failure(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary).resolve()
            prefix, bin_dir, record = installed_fixture(base)
            store = Path(record["store"])
            store.mkdir()
            (store / "credentials.json").write_text("owned")
            home = Path(record["shared_state"]["codex_home"])
            home.mkdir()
            (home / "config.toml").write_text('model = "user-model"\n')
            original = shutil.rmtree

            def remove(path, *args, **kwargs):
                if Path(path) == store:
                    raise PermissionError("store is locked")
                return original(path, *args, **kwargs)

            with contextlib.ExitStack() as stack:
                for item in uninstalling(record):
                    stack.enter_context(item)
                with patch.object(profiles.shutil, "rmtree", side_effect=remove), self.assertRaisesRegex(PermissionError, "store is locked"):
                    profiles.uninstall(prefix, bin_dir, purge=True)
                self.assertTrue((prefix / profiles.UNINSTALL_JOURNAL).is_file())
                result = profiles.uninstall(prefix, bin_dir)
            self.assertEqual(result["purged_mod_store"], str(store))
            self.assertFalse(prefix.exists())
            self.assertFalse(store.exists())
            self.assertEqual((home / "config.toml").read_text(), 'model = "user-model"\n')

    def test_uninstall_purge_refuses_shared_codex_state_before_removal(self):
        with tempfile.TemporaryDirectory() as temporary:
            prefix, bin_dir, record = installed_fixture(Path(temporary).resolve())
            record["store"] = record["shared_state"]["codex_home"]
            with contextlib.ExitStack() as stack:
                for item in uninstalling(record):
                    stack.enter_context(item)
                with self.assertRaisesRegex(ValueError, "Codex state"):
                    profiles.uninstall(prefix, bin_dir, purge=True)
            self.assertTrue(prefix.exists())
            self.assertTrue((bin_dir / "codex").exists())

    def test_uninstall_purge_unlinks_a_replaced_store_without_following_it(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary).resolve()
            prefix, bin_dir, record = installed_fixture(base)
            external = base / "external"
            external.mkdir()
            (external / "source.ts").write_text("user source")
            store = Path(record["store"])
            store.symlink_to(external, target_is_directory=True)
            with contextlib.ExitStack() as stack:
                for item in uninstalling(record):
                    stack.enter_context(item)
                profiles.uninstall(prefix, bin_dir, purge=True)
            self.assertFalse(store.is_symlink())
            self.assertEqual((external / "source.ts").read_text(), "user source")

    def test_uninstall_purge_requires_the_managed_coordinator_and_broker_removal(self):
        for managed, keep in ((True, False), (False, True)):
            with self.subTest(managed=managed, keep=keep), tempfile.TemporaryDirectory() as temporary:
                prefix, bin_dir, record = installed_fixture(Path(temporary).resolve())
                if managed:
                    record["update"] = {"root": str(prefix.parent)}
                with contextlib.ExitStack() as stack:
                    for item in uninstalling(record):
                        stack.enter_context(item)
                    with self.assertRaisesRegex(ValueError, "omd uninstall --purge" if managed else "remove the broker first"):
                        profiles.uninstall(prefix, bin_dir, keep_broker=keep, purge=True)
                self.assertTrue((bin_dir / "codex").exists())
                self.assertTrue(prefix.exists())

    def test_uninstall_purge_requires_privileged_cleanup_and_default_reports_remaining_policy(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary).resolve()
            prefix, bin_dir, record = installed_fixture(base)
            policy = base / "system/policy.json"
            policy.parent.mkdir()
            policy.write_text("{}")
            with contextlib.ExitStack() as stack:
                for item in uninstalling(record):
                    stack.enter_context(item)
                stack.enter_context(patch.object(profiles.authority_broker, "POLICY", policy))
                with self.assertRaisesRegex(ValueError, "omd-package broker uninstall --purge"):
                    profiles.uninstall(prefix, bin_dir, purge=True)
                result = profiles.uninstall(prefix, bin_dir)
            self.assertEqual(result["preserved_administrator_policy"], [str(policy)])
            self.assertTrue(policy.is_file())

    def test_broker_uninstall_forwards_purge_and_other_actions_reject_it(self):
        with patch.object(profiles, "load", return_value={}), patch.object(profiles, "check", return_value=(None, None)), \
                patch.object(profiles.authority_broker, "main", return_value={"deployed": False}) as invoked:
            profiles.broker(Path("/prefix"), Path("/bin"), "uninstall", purge=True)
            invoked.assert_called_once_with(["uninstall", "--purge"])
            with self.assertRaisesRegex(ValueError, "only valid with broker uninstall"):
                profiles.broker(Path("/prefix"), Path("/bin"), "install", purge=True)

    def test_identical_files_across_generations_and_catalog_are_one_inode(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source.ts"
            source.write_text("export default 1\n")
            prefixes = [root / "releases" / name / "prefix" for name in ("a", "b")]
            for prefix in prefixes:
                profiles.place(source, prefix / "management/install.sh", root / "objects")
                profiles.place(source, prefix / "sources/mod/index.ts", root / "objects")
            shelf = profiles.shelve(prefixes[1] / "sources/mod", root / "catalog/mod/sha")
            files = [prefix / name for prefix in prefixes for name in ("management/install.sh", "sources/mod/index.ts")]
            files += [shelf / "index.ts", root / "objects" / profiles.support.digest(source)]
            self.assertEqual({path.stat().st_ino for path in files}, {files[-1].stat().st_ino})
            self.assertEqual(files[0].stat().st_nlink, len(files))
            self.assertEqual([path.name for path in (root / "objects").iterdir()], [profiles.support.digest(source)])

    def test_an_object_edited_in_place_is_replaced_not_reused(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source.ts"
            source.write_text("export default 1\n")
            edited = profiles.place(source, root / "releases/a/prefix/sources/mod/index.ts", root / "objects")
            (root / "objects" / edited).write_text("tampered\n")
            fresh = root / "releases/b/prefix/sources/mod/index.ts"
            self.assertEqual(profiles.place(source, fresh, root / "objects"), edited)
            self.assertEqual(fresh.read_text(), "export default 1\n")
            self.assertTrue(os.path.samestat(fresh.stat(), (root / "objects" / edited).stat()))

    def test_identical_independent_copies_are_merged_and_every_generation_stays_valid(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "releases/new").mkdir(parents=True)
            prefix, bin_dir, record = installed_fixture(root / "releases/new")
            copies = []
            for name in ("old", "new"):
                for relative in (f"releases/{name}/prefix/management/install.sh", f"releases/{name}/prefix/sources/example/index.ts",
                                 f"catalog/mod/{name}/index.ts"):
                    path = root / relative
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text("same")
                    copies.append(path)
            store = root / "stores/full/sources/mod/index.ts"
            store.parent.mkdir(parents=True)
            store.write_text("same")
            different = root / "catalog/mod/other.ts"
            different.write_text("different")
            unreadable = root / "catalog/mod/unreadable.ts"
            unreadable.write_text("same")
            unreadable.chmod(0)
            profiles.deduplicate(root)
            unreadable.chmod(0o644)
            self.assertEqual({path.stat().st_ino for path in copies}, {copies[0].stat().st_ino})
            self.assertEqual(copies[0].stat().st_nlink, len(copies) + 1)
            self.assertEqual(store.stat().st_nlink, 1)
            self.assertNotEqual(different.stat().st_ino, copies[0].stat().st_ino)
            self.assertEqual(different.read_text(), "different")
            digest = profiles.support.digest(copies[0])
            record["management"]["files"] = {"install.sh": digest}
            self.assertEqual(profiles.support.digest(prefix / "management/install.sh"), digest)
            with contextlib.ExitStack() as stack:
                for item in uninstalling(record):
                    stack.enter_context(item)
                self.assertTrue(profiles.uninstall(prefix, bin_dir)["uninstalled"])
            self.assertFalse(prefix.exists())
            self.assertEqual(copies[1].read_text(), "same")

    def test_launcher_reaps_dead_markers_and_execs_codex_as_the_marked_process(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            codex = base / "fake-codex"
            codex.write_text(f'#!/bin/sh\necho $$ > {base}/pid\nls {base}/root/sessions > {base}/seen\nexit 7\n')
            codex.chmod(0o755)
            record = {"bin_dir": "/omd/bin", "binary": {"installed_path": str(codex)}, "store": str(base / "store"), "profile": "platform",
                      "activation": {"selection": "platform"},
                      "update": {"root": str(base / "root"), "installer": str(base / "install.sh"), "python": "python3"}}
            launcher = base / "launcher"
            launcher.write_text(profiles.selected_text(record))
            sessions = base / "root/sessions"
            sessions.mkdir(parents=True)
            dead = subprocess.Popen(["true"])
            dead.wait()
            (sessions / str(dead.pid)).touch()
            result = subprocess.run(["sh", launcher])
            self.assertEqual(result.returncode, 7)
            self.assertEqual((base / "seen").read_text().split(), (base / "pid").read_text().split())

    def test_launcher_announces_a_staged_release_once_while_another_session_is_open(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            for path in (base / "root/update", base / "root/current/bin", base / "root/sessions"):
                path.mkdir(parents=True)
            for path, text in ((base / "root/current/bin/codex", "#!/bin/sh\n"), (base / "install.sh", f'echo "$@" >> {base}/calls\n')):
                path.write_text(text)
            (base / "root/current/bin/codex").chmod(0o755)
            record = {"bin_dir": "/omd/bin", "binary": {"installed_path": str(base / "root/current/bin/codex")}, "store": str(base / "store"),
                      "profile": "platform", "activation": {"selection": "platform"},
                      "update": {"root": str(base / "root"), "installer": str(base / "install.sh"), "python": "python3"}}
            launcher = base / "launcher"
            launcher.write_text(profiles.selected_text(record))
            (base / "root/update/ready.json").write_text("{}")
            other = subprocess.Popen(["sleep", "30"])
            self.addCleanup(other.kill)
            (base / "root/sessions" / str(other.pid)).touch()
            calls = lambda: (base / "calls").read_text().count("launch") if (base / "calls").exists() else 0
            subprocess.run(["sh", launcher], check=True)
            self.assertEqual(calls(), 1)
            (base / "root/update/announced").touch()
            subprocess.run(["sh", launcher], check=True)
            self.assertEqual(calls(), 1)
            other.kill()
            other.wait()
            for unattended in (["app-server"], ["--version"], ["exec", "hi"], ["-c", "model=x", "app-server"], ["--profile", "ci", "exec", "hi"], ["completion", "zsh"], ["login", "status"], ["-m", "x", "mcp", "list"]):
                subprocess.run(["sh", launcher, *unattended], check=True)
                self.assertEqual(calls(), 1, unattended)
            for interactive in (["-p", "exec"], ["--search", "fix", "exec"], ["resume", "exec"]):
                before = calls()
                subprocess.run(["sh", launcher, *interactive], check=True)
                self.assertEqual(calls(), before + 1, interactive)
                self.assertNotIn("--unattended", (base / "calls").read_text().splitlines()[-1])
            (base / "root/update/journal.json").write_text("{}")
            subprocess.run(["sh", launcher, "app-server"], check=True)
            self.assertIn("--unattended", (base / "calls").read_text().splitlines()[-1])
            (base / "root/update/journal.json").unlink()
            before = calls()
            subprocess.run(["sh", launcher], check=True)
            self.assertEqual(calls(), before + 1)
            self.assertNotIn("--unattended", (base / "calls").read_text().splitlines()[-1])

    def test_launcher_runs_the_installer_for_a_new_update_request_only(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            request = base / "store/data/user/omd_update/store.json"
            for path in (base / "root/update", base / "root/current/bin", request.parent):
                path.mkdir(parents=True)
            (base / "root/current/bin/codex").write_text("#!/bin/sh\n")
            (base / "root/current/bin/codex").chmod(0o755)
            (base / "install.sh").write_text(f'echo "$@" >> {base}/calls\n')
            record = {"bin_dir": "/omd/bin", "binary": {"installed_path": str(base / "root/current/bin/codex")}, "store": str(base / "store"),
                      "profile": "platform", "activation": {"selection": "platform"},
                      "update": {"root": str(base / "root"), "installer": str(base / "install.sh"), "python": "python3"}}
            launcher = base / "launcher"
            launcher.write_text(profiles.selected_text(record))
            calls = lambda: (base / "calls").read_text().count("launch") if (base / "calls").exists() else 0
            for entries, expected in (('{"request":{"value":{"id":"1.0.0#1"}}}', 1), ("{}", 1)):
                (base / "root/update/seen").touch()
                os.utime(base / "root/update/seen", (0, 0))
                request.write_text(f'{{"schema":1,"entries":{entries}}}')
                subprocess.run(["sh", launcher], check=True)
                self.assertEqual(calls(), expected)
            (base / "root/update/state.json").write_text("{}")
            subprocess.run(["sh", launcher], check=True)
            self.assertEqual(calls(), 2, "state without a notice, as an older installer leaves it")
            (base / "root/update/notice.json").write_text("{}")
            subprocess.run(["sh", launcher], check=True)
            self.assertEqual(calls(), 2)

    def test_launcher_rearms_a_stale_announcement_while_a_recycled_pid_holds_a_marker(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            for path in (base / "root/update", base / "root/current/bin", base / "root/sessions"):
                path.mkdir(parents=True)
            for path, text in ((base / "root/current/bin/codex", "#!/bin/sh\n"), (base / "install.sh", f'echo "$@" >> {base}/calls\n')):
                path.write_text(text)
            (base / "root/current/bin/codex").chmod(0o755)
            record = {"bin_dir": "/omd/bin", "binary": {"installed_path": str(base / "root/current/bin/codex")}, "store": str(base / "store"),
                      "profile": "platform", "activation": {"selection": "platform"},
                      "update": {"root": str(base / "root"), "installer": str(base / "install.sh"), "python": "python3"}}
            launcher = base / "launcher"
            launcher.write_text(profiles.selected_text(record))
            (base / "root/update/ready.json").write_text("{}")
            other = subprocess.Popen(["sleep", "30"])
            self.addCleanup(other.kill)
            (base / "root/sessions" / str(other.pid)).touch()
            announced = base / "root/update/announced"
            announced.touch()
            os.utime(announced, (time.time() + 1, time.time() + 1))
            subprocess.run(["sh", launcher], check=True)
            calls = lambda: (base / "calls").read_text().count("launch") if (base / "calls").exists() else 0
            self.assertEqual(calls(), 0)
            old = time.time() - 7200
            os.utime(announced, (old, old))
            os.utime(base / "root/update/ready.json", (old - 60, old - 60))
            subprocess.run(["sh", launcher], check=True)
            self.assertEqual(calls(), 1)

    def test_author_launcher_explains_a_missing_node(self):
        with tempfile.TemporaryDirectory() as temporary:
            launcher = Path(temporary) / "omd-mod-author"
            launcher.write_text(profiles.author_launcher_text(None, Path(temporary) / "cli.mjs"))
            result = subprocess.run(["/bin/sh", launcher], capture_output=True, text=True, env={"PATH": temporary})
            self.assertEqual(result.returncode, 127)
            self.assertEqual(result.stderr, "omd-mod-author needs Node.js 24.18 or a later 24.x on PATH\n")
        self.assertTrue(profiles.author_launcher_text("/opt/node", "/cli.mjs").endswith('exec /opt/node /cli.mjs "$@"\n'))

    def test_plugins_creates_codex_home_before_the_first_codex_run(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary).resolve()
            prefix, home = base / "root/releases/generation/prefix", base / "codex"
            marketplace = prefix / "bundles/oh-my-diff"
            (marketplace / ".agents/plugins").mkdir(parents=True)
            (marketplace / ".agents/plugins/marketplace.json").write_text('{"name": "oh-my-diff"}')
            record = {"plugin_bundle": {"marketplace": str(marketplace), "plugins": ["omd-anchored-edit"]},
                      "shared_state": {"codex_home": str(home)}}

            def run(arguments, **kwargs):
                self.assertTrue(home.is_dir())
                (home / "config.toml").write_text(f'[marketplaces.oh-my-diff]\nsource = "{arguments[-1]}"\n')

            with (patch.object(profiles, "load", return_value=record),
                  patch.object(profiles, "check", return_value=(base / "codex-bin", None)),
                  patch.object(profiles.support, "run", side_effect=run)):
                result = profiles.register_plugins(prefix, base / "bin")
            self.assertEqual(result["plugins"], ["omd-anchored-edit"])
            self.assertEqual(home.stat().st_mode & 0o777, 0o700)

    def test_plugin_mod_reviews_the_added_plugins_component_through_omd_and_grants_nothing_itself(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            marketplace, home = base / "bundle", base / "codex"
            (marketplace / ".agents/plugins").mkdir(parents=True)
            (marketplace / ".agents/plugins/marketplace.json").write_text('{"name": "oh-my-diff"}')
            component = home / "plugins/cache/oh-my-diff/omd-anchored-edit/1.2.0/mod"
            component.mkdir(parents=True)
            (component / "mod.json").write_text('{"id": "omd_anchored_edit"}')
            record = {"plugin_bundle": {"marketplace": str(marketplace)}, "shared_state": {"codex_home": str(home)},
                      "tools": {"omd": {"installed_path": "/omd"}}, "store": "/store"}
            listed = {"installed": [{"pluginId": "other@oh-my-diff", "version": "9"},
                                    {"pluginId": "omd-anchored-edit@oh-my-diff", "version": "1.2.0"}]}
            manager, ran = [], []

            def run(arguments, **kwargs):
                ran.append((arguments, kwargs))
                if arguments[1] == "install" and declined:
                    raise RuntimeError("command failed (2)")

            for declined in (False, True):
                manager.clear()
                ran.clear()
                with (patch.object(profiles, "load", return_value=record),
                      patch.object(profiles, "check", return_value=("/codex", "/omd-mod")),
                      patch.object(profiles.support, "output", return_value=json.dumps(listed)) as output,
                      patch.object(profiles, "invoke", side_effect=lambda *arguments: manager.append(arguments) or {"component": str(component)}),
                      patch.object(profiles.support, "run", side_effect=run)):
                    if declined:
                        with self.assertRaisesRegex(RuntimeError, "failed"):
                            profiles.plugin_mod(Path("/prefix"), Path("/bin"), "enable", "omd-anchored-edit")
                    else:
                        profiles.plugin_mod(Path("/prefix"), Path("/bin"), "enable", "omd-anchored-edit")
                self.assertEqual(output.call_args.args[0], ["/codex", "plugin", "list", "--json", "--marketplace", "oh-my-diff"])
                self.assertEqual(output.call_args.kwargs["env"]["CODEX_HOME"], str(home))
                self.assertEqual(manager, [("/omd-mod", "plugin-component", component.parent)])
                expected = [["/omd", "install", str(component), "--store", "/store"]]
                if not declined:
                    expected.append(["/omd", "mods", "enable", "omd_anchored_edit", "--store", "/store"])
                self.assertEqual([arguments for arguments, _ in ran], expected)
                self.assertTrue(all(kwargs == {"capture": False} for _, kwargs in ran))
            with (patch.object(profiles, "load", return_value=record), patch.object(profiles, "check", return_value=("/codex", "/omd-mod")),
                  patch.object(profiles.support, "output", return_value='{"installed": []}')):
                with self.assertRaisesRegex(ValueError, "codex plugin add omd-anchored-edit@oh-my-diff-experimental"):
                    profiles.plugin_mod(Path("/prefix"), Path("/bin"), "enable", "omd-anchored-edit@oh-my-diff-experimental")

    def test_status_summary_shows_off_and_quarantined_profile_mods(self):
        package = {"error": None, "active": False, "enabled_in_store": False, "installed": True, "quarantined": None}
        result = {"product": "p", "profile_label": "OMD+", "activation": "full", "mod_api": "1", "store": "/store",
                  "packages": [{**package, "id": "omd_logo"}, {**package, "id": "omd_theme", "quarantined": "testing"},
                               {**package, "id": "omd_mini", "installed": False}]}
        self.assertEqual(profiles.status_summary(result).splitlines()[2:5],
                         ["  omd_logo: off", "  omd_theme: quarantined: testing", "  omd_mini: missing"])

    def test_status_marks_only_the_installed_version_quarantined(self):
        lock = {"packages": {"omd_theme": {"version": "1.1.1", "integrity": "new"}, "omd_logo": {"version": "1.0.0", "integrity": "x"}},
                "blocked": [{"id": "omd_theme", "version": "1.1.0", "integrity": "old", "reason": "bad"},
                            {"id": "omd_logo", "version": "0.9.0", "integrity": "x", "reason": "same bytes"},
                            {"id": "omd_mini", "version": "1.0.0", "integrity": "y", "reason": "absent"}]}
        self.assertEqual(profiles.quarantined(lock), {"omd_logo": "same bytes"})

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

    def test_a_mod_bundle_updates_changed_first_party_mods_in_place_and_rolls_back(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary).resolve()
            prefix, store, bundle = base / "prefix", base / "store", base / "bundle"

            def package(root, identifier, text):
                (root / "sources" / identifier).mkdir(parents=True, exist_ok=True)
                (root / "sources" / identifier / "index.ts").write_text(text)
                return {"version": "1.0.0", "capabilities": [text], "package_sha256": f"sha-{text}",
                        "files": {"index.ts": profiles.support.digest(root / "sources" / identifier / "index.ts")}}

            lock = {"mod_api": "1.0.0", "packages": {"one": package(prefix, "one", "old"), "two": package(prefix, "two", "same"),
                                                     "catalogued": package(prefix, "catalogued", "old")}}
            offered = {"mod_api": "1.0.0", "packages": {"one": package(bundle, "one", "new"), "two": package(bundle, "two", "same"),
                                                        "catalogued": package(bundle, "catalogued", "new"),
                                                        "added": package(bundle, "added", "new")},
                       "catalog": {"added": {"description": "A new mod", "support": "experimental"}},
                       "index": {"third": [{"version": "2.0.0", "integrity": "sha-third", "source": {"kind": "repository"}}]}}
            (prefix / "management/runtime").mkdir(parents=True)
            (prefix / "management/runtime/mods.lock.json").write_text(json.dumps(lock))
            (bundle / "mods.lock.json").write_text(json.dumps(offered))
            (store / "sources").mkdir(parents=True)
            shutil.copytree(prefix / "sources/one", store / "sources/one")
            (store / "package-index.json").write_text(json.dumps({"schema": 1, "packages": {"catalogued": [
                {"version": "1.0.0", "integrity": "sha-old", "source": {"kind": "local", "path": "old"}}]}}))
            record = {"schema": profiles.SCHEMA, "product": profiles.PRODUCT, "prefix": str(prefix), "store": str(store),
                      "management": {"files": {}}, "packages": {"one": {"sha256": "sha-old", "capabilities": ["old"]},
                                                                  "two": {"sha256": "sha-same", "capabilities": ["same"]}},
                      "sources": {identifier: package["files"] for identifier, package in lock["packages"].items()}}
            profiles.write(prefix, record)
            selection = {"path": str(store / "sources/one"), "sha256": "sha-old", "selected": True}
            commands = []
            index_path = str(store / "package-index.json")
            packaged = {"version": "1.0.0", "integrity": "sha-old", "scope": "user", "trust": {"capabilities": ["old"]},
                        "source": {"kind": "package", "index": index_path, "id": "catalogued", "version": "1.0.0"}}

            def invoke(_manager, command, _store, *arguments):
                commands.append(command)
                if command == "inspect":
                    return {"sha256": "sha-" + (Path(_store) / "index.ts").read_text()}
                if command == "selection-status":
                    return {"selections": [dict(selection)]}
                if command == "package-lock":
                    return {"packages": {"catalogued": dict(packaged)}}
                if command == "package-plan":
                    return {"packages": [{"id": "catalogued", "scope": "user"}], "confirmation": "confirmed",
                            "changes": {"packages": [{"state_version": {"migration_required": False}}]}}
                if command == "trust-all":
                    selection.update(sha256=json.loads(arguments[0])[0]["sha256"], selected=False)
                elif command == "enable":
                    selection["selected"] = True
                elif command == "package-apply":
                    packaged["integrity"] = json.loads(Path(index_path).read_text())["packages"]["catalogued"][0]["integrity"]
                return {}

            def state():
                installed = json.loads((prefix / "install.json").read_text())
                locked = json.loads((prefix / "management/runtime/mods.lock.json").read_text())["packages"]
                return ({identifier: (prefix / "sources" / identifier / "index.ts").read_text() for identifier in ("one", "two", "catalogued")},
                        (store / "sources/one/index.ts").read_text(), {identifier: locked[identifier]["package_sha256"] for identifier in locked},
                        installed["packages"]["one"]["sha256"], installed.get("mods_bundle"), selection["selected"], packaged["integrity"])

            with patch.object(profiles, "check", return_value=(None, "manager")), patch.object(profiles, "invoke", side_effect=invoke):
                (bundle / "sources/one/index.ts").write_text("tampered")
                with self.assertRaisesRegex(ValueError, "files differ from its lock: one"):
                    profiles.apply_mods(prefix, base / "bin", bundle, {"serial": 1}, True)
                (bundle / "sources/one/index.ts").write_text("new")
                before = state()
                self.assertEqual(profiles.update_mods(prefix, base / "bin", bundle, 1),
                                 {"updated": ["catalogued", "one"], "added": ["added"], "kept": [], "refused": [], "needs_review": [],
                                  "capabilities": {"one": ["new"]}})
                self.assertEqual(state(), ({"one": "new", "two": "same", "catalogued": "new"}, "new",
                                           {"one": "sha-new", "two": "sha-same", "catalogued": "sha-new", "added": "sha-new"},
                                           "sha-new", {"serial": 1}, True, "sha-new"))
                listed = json.loads((store / "package-index.json").read_text())["packages"]
                index = listed["catalogued"][0]
                self.assertEqual((index["integrity"], index["source"]["path"]), ("sha-new", str(prefix / "sources/catalogued")))
                self.assertEqual(listed["added"], [{"description": "A new mod", "support": "experimental", "version": "1.0.0",
                                                    "integrity": "sha-new", "source": {"kind": "local", "path": str(prefix / "sources/added")}}])
                self.assertEqual(listed["third"][0]["integrity"], "sha-third")
                self.assertEqual((prefix / "sources/added/index.ts").read_text(), "new")
                self.assertIn("added", json.loads((prefix / "install.json").read_text())["sources"])
                self.assertEqual(json.loads((prefix / "install.json").read_text())["management"]["files"]["runtime/mods.lock.json"],
                                 profiles.support.digest(prefix / "management/runtime/mods.lock.json"))
                self.assertEqual(profiles.rollback_mods(prefix, base / "bin"),
                                 {"updated": ["catalogued", "one"], "added": [], "kept": [], "refused": [], "needs_review": [],
                                  "capabilities": {"one": ["old"]}})
                self.assertEqual(state(), before)
                self.assertFalse((prefix / "sources/added").exists())
                self.assertEqual(sorted(json.loads((store / "package-index.json").read_text())["packages"]), ["catalogued"])
                self.assertNotIn("added", json.loads((prefix / "install.json").read_text())["sources"])
                self.assertFalse((prefix / "mods-previous").exists())
                with self.assertRaisesRegex(ValueError, "no first-party mod update to roll back"):
                    profiles.rollback_mods(prefix, base / "bin")
                rename = Path.rename

                def swap(path, target):
                    if path.parent.name == "sources" and path.name.endswith(".new"):
                        raise OSError("killed")
                    return rename(path, target)
                for interrupted in (patch.object(profiles, "write", side_effect=OSError("killed")),
                                    patch.object(Path, "rename", swap)):
                    with self.subTest(interrupted=interrupted), interrupted:
                        with self.assertRaisesRegex(OSError, "killed"):
                            profiles.apply_mods(prefix, base / "bin", bundle, {"serial": 1}, True)
                        self.assertTrue((prefix / profiles.MODS_MARKER).is_file())
                    profiles.rollback_mods(prefix, base / "bin")
                    self.assertEqual(state(), before)
                    self.assertFalse((prefix / profiles.MODS_MARKER).exists())
                sync, failures = profiles.sync_sources, [OSError("trust failed")]

                def flaky(*arguments):
                    if failures:
                        sync(*arguments)
                        raise failures.pop()
                    return sync(*arguments)
                with patch.object(profiles, "sync_sources", side_effect=flaky):
                    with self.assertRaisesRegex(OSError, "trust failed"):
                        profiles.update_mods(prefix, base / "bin", bundle, 1)
                self.assertEqual(state(), before)
                self.assertFalse((prefix / "mods-previous").exists())

                def refusing(manager, command, target, *arguments):
                    if command == "inspect" and Path(target).name == "added":
                        raise RuntimeError("unknown manifest field")
                    return invoke(manager, command, target, *arguments)
                with patch.object(profiles, "invoke", side_effect=refusing):
                    result = profiles.update_mods(prefix, base / "bin", bundle, 1)
                self.assertEqual((result["updated"], result["added"], result["refused"]), (["catalogued", "one"], [], ["added"]))
                self.assertEqual(json.loads((prefix / "install.json").read_text())["mods_refused"], {"added": "sha-new"})
                self.assertNotIn("added", json.loads((prefix / "management/runtime/mods.lock.json").read_text())["packages"])
                profiles.rollback_mods(prefix, base / "bin")
                profiles.update_mods(prefix, base / "bin", bundle, 1)
                self.assertEqual(json.loads((prefix / "install.json").read_text())["mods_refused"], {})

                def installed_new(manager, command, target, *arguments):
                    if command == "package-lock":
                        return {"packages": {"catalogued": dict(packaged), "added": packaged | {"source": {"kind": "package", "id": "added"}}}}
                    return invoke(manager, command, target, *arguments)
                with patch.object(profiles, "invoke", side_effect=installed_new):
                    self.assertEqual(profiles.rollback_mods(prefix, base / "bin")["kept"], ["added"])
                self.assertEqual((prefix / "sources/added/index.ts").read_text(), "new")
                self.assertIn("added", json.loads((store / "package-index.json").read_text())["packages"])

    def test_catalog_shelves_no_release_backup_or_store_index_uses_are_pruned(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            for shelf in ("one/a", "one/b", "one/c", "two/d", "two/e"):
                (root / "catalog" / shelf).mkdir(parents=True)
            release = root / "releases" / ("1" * 32) / "prefix"
            (release / "management/runtime").mkdir(parents=True)
            (release / "management/runtime/mods.lock.json").write_text(json.dumps({"packages": {"one": {"package_sha256": "a"}}}))
            (release / "mods-previous").mkdir()
            (release / "mods-previous/mods.lock.json").write_text(json.dumps({"packages": {"one": {"package_sha256": "b"}}}))
            (root / "stores/full").mkdir(parents=True)
            (root / "stores/full/package-index.json").write_text(json.dumps({"packages": {
                "two": [{"source": {"kind": "local", "path": str(root / "catalog/two/d")}}], "third": [{"source": {"kind": "repository"}}]}}))
            profiles.prune_shelves(root)
            self.assertEqual(sorted(str(path.relative_to(root / "catalog")) for path in root.glob("catalog/*/*")), ["one/a", "one/b", "two/d"])

    def test_a_catalog_copy_that_needs_approval_or_fails_to_plan_is_left_for_review(self):
        index = "/store/package-index.json"
        locked = {identifier: {"version": "1.0.0", "integrity": "old", "scope": "user", "trust": {},
                               "source": {"kind": "package", "index": index, "id": identifier, "version": "1.0.0"}}
                  for identifier in ("approval", "broken", "current", "migrating", "moved", "odd", "rescoped")}
        locked["current"]["integrity"] = "new"
        locked["elsewhere"] = locked["moved"] | {"source": {"kind": "repository"}}
        applied = []

        def invoke(_manager, command, _store, *arguments):
            identifier = json.loads(arguments[0])["source"]["id"] if arguments else None
            if command == "package-lock":
                return {"packages": locked}
            if command == "package-apply":
                applied.append(identifier)
            if identifier == "broken":
                raise RuntimeError("policy refuses it")
            if identifier == "odd":
                return {}
            return {"packages": [{"id": identifier, "scope": "project" if identifier == "rescoped" else "user"}], "confirmation": "c",
                    "changes": {"packages": [{"renewed_approval": identifier == "approval",
                                              "state_version": {"migration_required": identifier == "migrating"}}]}}

        with patch.object(profiles, "invoke", side_effect=invoke):
            result = profiles.update_catalog_copies("manager", Path("/store"), {
                identifier: {"version": "2.0.0", "package_sha256": "new"} for identifier in locked})
        self.assertEqual(result, {"catalog_updated": ["moved"], "needs_review": ["approval", "broken", "migrating", "odd", "rescoped"]})
        self.assertEqual(applied, ["moved"])
        with patch.object(profiles, "invoke", side_effect=RuntimeError("no lock")):
            self.assertEqual(profiles.update_catalog_copies("manager", Path("/store"), {}), {"catalog_updated": [], "needs_review": []})

    def test_reconcile_points_the_catalog_at_this_installation_before_moving_its_copies(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary).resolve()
            prefix, store = base / "prefix", base / "store"
            (prefix / "management/runtime").mkdir(parents=True)
            store.mkdir()
            packages = {"omd_usage": {"version": "1.0.0", "package_sha256": "old"}, "omd_new": {"version": "1.0.0", "package_sha256": "n"}}
            (prefix / "management/runtime/mods.lock.json").write_text(json.dumps({"packages": packages}))
            entry = {"version": "2.0.0", "integrity": "new", "source": {"kind": "local", "path": "/later"}, "description": "d"}
            (store / "package-index.json").write_text(json.dumps({"schema": 1, "packages": {
                "omd_usage": [entry], "third": [entry | {"source": {"kind": "repository"}}]}}))
            with patch.object(profiles, "update_catalog_copies", return_value={"catalog_updated": ["omd_usage"], "needs_review": []}) as moved:
                self.assertEqual(profiles.align_catalog(prefix, "manager", store)["catalog_updated"], ["omd_usage"])
            moved.assert_called_once_with("manager", store, packages)
            index = json.loads((store / "package-index.json").read_text())["packages"]
            self.assertEqual(index["omd_usage"], [entry | {"version": "1.0.0", "integrity": "old",
                                                           "source": {"kind": "local", "path": str(prefix / "sources/omd_usage")}}])
            self.assertEqual(index["third"][0]["version"], "2.0.0")
            (store / "package-index.json").unlink()
            self.assertEqual(profiles.align_catalog(prefix, "manager", store), {"catalog_updated": [], "needs_review": []})

    def test_a_directory_package_on_beside_its_bundled_copy_is_turned_off(self):
        store = Path("/store")
        selections = [
            {"id": "omd_advisor", "path": "/store/package-cache/omd_advisor/old", "scope": "user", "selected": True, "packaged": True},
            {"id": "omd_advisor", "path": "/store/sources/omd_advisor", "scope": "user", "selected": True, "packaged": False},
            {"id": "omd_usage", "path": "/store/package-cache/omd_usage/old", "scope": "user", "selected": True, "packaged": True},
            {"id": "omd_usage", "path": "/store/sources/omd_usage", "scope": "user", "selected": False, "packaged": False}]
        commands = []

        def invoke(_manager, command, _store, *arguments):
            commands.append((command, *arguments))
            return {"selections": selections} if command == "selection-status" else {}

        with patch.object(profiles, "invoke", side_effect=invoke):
            profiles.keep_bundled_copies("manager", store)
        self.assertEqual(commands, [("selection-status",), ("package-disable", "omd_advisor")])

    def test_an_upgrade_turns_off_only_profile_copies_of_newly_experimental_mods(self):
        store = Path("/store")
        selections = [
            {"id": "omd_inspector", "path": "/store/sources/omd_inspector", "selected": True},
            {"id": "omd_advisor", "path": "/store/sources/omd_advisor", "selected": True},
            {"id": "omd_btw", "path": "/store/package-cache/omd_btw/old", "selected": True},
            {"id": "omd_continue", "path": "/store/sources/omd_continue", "selected": False},
            {"id": "omd_logo", "path": "/store/sources/omd_logo", "selected": True}]
        commands = []

        def invoke(_manager, command, _store, *arguments):
            commands.append((command, *arguments))
            return {"selections": selections} if command == "selection-status" else {}

        with patch.object(profiles, "invoke", side_effect=invoke):
            retired = profiles.retire_packages("manager", store, "full", {"retired": ["omd_advisor"]})
            self.assertEqual(commands, [("selection-status",), ("disable", "/store/sources/omd_inspector")])
            self.assertIn("omd_inspector", retired)
            self.assertNotIn("omd_logo", retired)
            commands.clear()
            self.assertEqual(profiles.retire_packages("manager", store, "core", {"retired": ["omd_advisor"]}), {"omd_advisor"})
            self.assertEqual(profiles.retire_packages("manager", store, "core", None), retired)
            profiles.retire_packages("manager", store, "full", {"retired": sorted(retired)})
            profiles.retire_packages("manager", store, "full", None)
        self.assertEqual(commands, [])

    def test_activation_and_mod_selection_report_in_one_line(self):
        packages = [{"id": "omd_logo", "active": True}, {"id": "omd_theme", "active": False}]
        self.assertEqual(profiles.activation_summary({"activation": "full", "profile": "full", "profile_label": "OMD+",
                                                      "packages": packages}), "OMD+ is active with 1 of 2 mods on.")
        self.assertIn("omd-package activate full", profiles.activation_summary(
            {"activation": "direct", "profile": "full", "profile_label": "OMD+", "packages": packages}))
        record = {"packages": {"omd_theme": {}}, "store": "/store"}
        moved = {"selections": [{"id": "omd_theme", "path": "/store/package-cache/omd_theme/abc", "selected": True}]}
        with patch.object(profiles, "load", return_value=record), \
                patch.object(profiles, "check", return_value=(None, "manager")), \
                patch.object(profiles, "invoke", return_value=moved):
            with self.assertRaisesRegex(ValueError, "use omd mods enable omd_theme$"):
                profiles.select_mod(Path("/prefix"), Path("/bin"), "omd_theme", True)

    def test_an_upgrade_retrusts_store_copies_of_mods_outside_the_profile(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary).resolve()
            store, origin = base / "store", base / "origin"
            for identifier, text in (("omd_inspector", "new"), ("omd_logo", "logo"), ("omd_btw", "btw")):
                (origin / identifier).mkdir(parents=True)
                (origin / identifier / "index.ts").write_text(text)
            (store / "sources/omd_inspector").mkdir(parents=True)
            (store / "sources/omd_inspector/index.ts").write_text("old")
            packages = {identifier: {"package_sha256": identifier * 2, "capabilities": ["terminal"],
                                     "files": {"index.ts": profiles.support.digest(origin / identifier / "index.ts")}}
                        for identifier in ("omd_inspector", "omd_logo", "omd_btw")}
            selections = [{"id": "omd_inspector", "path": str(store / "sources/omd_inspector"),
                           "selected": False, "sha256": "stale"}]
            commands = []

            def invoke(_manager, command, _store, *arguments):
                commands.append((command, *arguments))
                return {"selections": selections} if command == "selection-status" else {}

            with patch.object(profiles, "invoke", side_effect=invoke):
                changed = profiles.refresh_kept_copies("manager", store, origin, packages, {"omd_logo": {}})
            self.assertEqual(changed, ["omd_inspector"])
            self.assertEqual((store / "sources/omd_inspector/index.ts").read_text(), "new")
            self.assertFalse((store / "sources/omd_btw").exists())
            trusted = [json.loads(arguments[0]) for command, *arguments in commands if command == "trust-all"]
            self.assertEqual(trusted, [[{"path": str(store / "sources/omd_inspector"), "sha256": "omd_inspector" * 2,
                                         "capabilities": ["terminal"]}]])
            self.assertNotIn("enable", [command for command, *_ in commands])

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
                f"echo \"$*|$OH_MY_DIFF_PRESENTATION|$OH_MY_DIFF_LAUNCH|$OMD_TUI_MOD_UI|$OMD_TUI_HEADER|$OMD_TUI_COMPOSER\" >> {log}\n"
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
                with self.assertRaisesRegex(ValueError, "needs its mod enabled: omd mods enable omd_mini$"):
                    profiles.mini(Path("/prefix"), base, [])
                selections["selections"] = []
                with self.assertRaisesRegex(ValueError, "omd install omd_mini, then omd mods enable omd_mini$"):
                    profiles.mini(Path("/prefix"), base, [])
            runs = [line.split("|") for line in log.read_text().splitlines()]
            self.assertEqual(code, 3)
            self.assertEqual([(argv, mode, *tui) for argv, mode, _, *tui in runs], [
                ("--no-alt-screen -c tui.show_tooltips=false --model m -s=danger-full-access -C /repo -c a=1 -i x.png --yolo --no-alt-screen fix it", "mini", "omd_mini", "off", "plain"),
                ("--model m -s=danger-full-access -C /repo -c a=1 --yolo resume 019a0000-0000-7000-8000-000000000001", "full", "", "", "")])
            self.assertEqual([launch.split(".")[1] for _, _, launch, *_ in runs], ["0", "1"])
            self.assertEqual(profiles.session_options(["resume", "--last", "-mx", "--model=y", "-c", "a=1", "-c", "b=2", "--", "-s", "p", "-m"]),
                             ["-mx", "--model=y", "-c", "a=1", "-c", "b=2"])
            self.assertEqual(profiles.session_options(["prompt", "-m"]), [])
            self.assertEqual(len({launch.split(".")[0] for _, _, launch, *_ in runs}), 1)


if __name__ == "__main__":
    unittest.main()
