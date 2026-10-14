import argparse
import contextlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts import lean_profiles


ROOT = Path(__file__).resolve().parents[1]


def installed_fixture(base):
    prefix, bin_dir = base / "prefix", base / "bin"
    prefix.mkdir()
    bin_dir.mkdir()
    digests = {}
    for name in lean_profiles.LAUNCHERS:
        (bin_dir / name).write_text(f"launcher {name}")
        digests[name] = lean_profiles.support.digest(bin_dir / name)
    record = {key: {"installed_path": str(prefix / key)} for key in ("binary", "code_mode_host", "broker", "manager")}
    record.update(author={"files": [], "launcher_sha256": digests["omd-mod-author"]},
                  management={"files": [], "launcher_sha256": digests["omd-package"]},
                  activation={"sha256": digests["codex"]},
                  tools={name: {"installed_path": str(prefix / "binary"), "launcher_sha256": digests[name]}
                         for name in (*lean_profiles.HOST_TOOLS, "omd-mod")},
                  packages={"example": {"files": ["index.ts"]}},
                  sources={"example": ["index.ts"], "inactive": ["index.ts"]},
                  shared_state={"codex_home": str(base / "home")}, store=str(base / "store"))
    for name in ("install.json", "binary", "code_mode_host", "broker", "manager"):
        (prefix / name).touch()
    for identifier in record["sources"]:
        source = prefix / "sources" / identifier
        source.mkdir(parents=True)
        (source / "index.ts").touch()
    return prefix, bin_dir, record


def uninstalling(record):
    return (patch.object(lean_profiles, "load", return_value=record), patch.object(lean_profiles, "check"),
            patch.object(lean_profiles.authority_broker, "deployed", return_value=False),
            patch.object(lean_profiles.shutil, "which", return_value="/usr/bin/true"),
            patch.object(lean_profiles.support, "binary_identity"))


class LeanProfileModeTests(unittest.TestCase):
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
                            lean_profiles.uninstall(prefix, bin_dir)
                        self.assertEqual((prefix / "personal.txt").read_text(), "preserve")
                        self.assertTrue((bin_dir / "codex").exists())
                    else:
                        self.assertTrue(lean_profiles.uninstall(prefix, bin_dir)["uninstalled"])
                        self.assertFalse(prefix.exists())
                        self.assertEqual(list(bin_dir.iterdir()), [])

    def test_interrupted_uninstall_resumes_and_keeps_replaced_launchers(self):
        real_rmtree, real_unlink = shutil.rmtree, Path.unlink
        for point in ("launchers", "prefix", "journal"):
            with self.subTest(point=point), tempfile.TemporaryDirectory() as temporary:
                prefix, bin_dir, record = installed_fixture(Path(temporary))
                journal = prefix / lean_profiles.UNINSTALL_JOURNAL

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
                    with patch.object(lean_profiles.shutil, "rmtree", side_effect=rmtree), \
                            patch.object(Path, "unlink", unlink), self.assertRaisesRegex(OSError, "interrupted"):
                        lean_profiles.uninstall(prefix, bin_dir)
                self.assertTrue(journal.is_file())
                self.assertFalse((bin_dir / "omd-mod").exists())
                (bin_dir / "codex").write_text("restored upstream")
                with patch.object(lean_profiles, "load", side_effect=ValueError("receipt gone")), \
                        patch.object(lean_profiles, "check", side_effect=ValueError("launcher gone")), \
                        patch.object(lean_profiles.authority_broker, "deployed", return_value=False):
                    resumed = lean_profiles.uninstall(prefix, bin_dir)
                self.assertTrue(resumed["uninstalled"])
                self.assertEqual(resumed["upstream"], str(lean_profiles.support.resolved("/usr/bin/true")))
                self.assertFalse(prefix.exists())
                self.assertEqual([path.name for path in bin_dir.iterdir()], ["codex"])
                self.assertEqual((bin_dir / "codex").read_text(), "restored upstream")

    def test_install_refuses_every_existing_launcher_before_changing_anything(self):
        for name in lean_profiles.LAUNCHERS:
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
                    with patch.object(lean_profiles.platform, "system", return_value="Darwin"), \
                            patch.object(lean_profiles.platform, "machine", return_value="arm64"), \
                            self.assertRaisesRegex(ValueError, "launcher already exists"):
                        lean_profiles.install(args)
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
            package = {"files": {"index.ts": lean_profiles.support.digest(origin / "example/index.ts")},
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

            with patch.object(lean_profiles, "invoke", side_effect=invoke):
                with self.assertRaisesRegex(ValueError, "interrupted"):
                    lean_profiles.sync_sources("manager", store, origin, {"example": package})
                self.assertEqual((target / "index.ts").read_text(), "new")
                failing.append("enable")
                with self.assertRaisesRegex(ValueError, "interrupted"):
                    lean_profiles.sync_sources("manager", store, origin, {"example": package})
                self.assertEqual(selection, {"path": str(target), "sha256": "new-package", "selected": False})
                commands.clear()
                self.assertEqual(lean_profiles.sync_sources("manager", store, origin, {"example": package}), ["example"])
                self.assertEqual(commands, ["selection-status", "trust-all", "enable", "reload"])
                self.assertEqual(selection, {"path": str(target), "sha256": "new-package", "selected": True})
                commands.clear()
                self.assertEqual(lean_profiles.sync_sources("manager", store, origin, {"example": package}), [])
                self.assertEqual(commands, ["selection-status"])
            self.assertEqual(sorted(path.name for path in (store / "sources").iterdir()), ["example"])

    def test_shelved_catalog_copy_survives_its_generation(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = base / "releases/one/prefix/sources/example"
            source.mkdir(parents=True)
            (source / "index.ts").write_text("export {}")
            destination = base / "catalog/example" / ("a" * 64)
            stale = destination.with_name(f".{destination.name}.new")
            stale.mkdir(parents=True)
            (stale / "partial").touch()
            self.assertEqual(lean_profiles.shelve(source, destination), destination)
            shutil.rmtree(base / "releases")
            self.assertEqual(list(destination.rglob("*")), [destination / "index.ts"])
            self.assertFalse(stale.exists())
            self.assertEqual(lean_profiles.shelve(base / "missing", destination), destination)

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

        with patch.object(lean_profiles, "load", return_value=record), \
                patch.object(lean_profiles, "check", return_value=(None, "/manager")), \
                patch.object(lean_profiles, "pinned_binaries", return_value=set()), \
                patch.object(lean_profiles, "invoke", side_effect=invoke), \
                patch.object(lean_profiles.authority_broker, "main", return_value={"installed": True}):
            lean_profiles.broker(Path("/prefix"), Path("/bin"), "install")
        self.assertEqual([command for command, _ in calls],
                         ["broker-grants-import", "broker-grants-import", "reload"])

    def test_cli_advertises_only_current_activation_choices(self):
        result = subprocess.run(
            [sys.executable, "-m", "scripts.lean_profiles", "--prefix", "/tmp/omd-unused-prefix",
             "--bin-dir", "/tmp/omd-unused-bin", "activate", "--help"],
            cwd=ROOT, capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("{platform,full,direct}", result.stdout)

    def test_launcher_defines_set_up_providers_only_in_omd_mode(self):
        provider = {"id": "omd_claude_cli", "name": "OMD Claude CLI", "base_url": "http://127.0.0.1:5/v1",
                    "env_key": "OMD_CLAUDE_LOCAL_TOKEN", "token": "/opt/omd/claude/local token"}
        record = {"binary": {"installed_path": "/opt/omd/codex"}, "store": "/opt/omd/store", "profile": "full",
                  "activation": {"selection": "full"}, "providers": {"omd_claude_cli": provider}, "author": {"node": "/opt/omd/node"}}
        text = lean_profiles.selected_text(record)
        self.assertIn("export OMD_NODE=/opt/omd/node", text)
        self.assertIn("-c features.daemon_auto_start=false", text)
        self.assertIn("OMD_CLAUDE_LOCAL_TOKEN=\"$(cat '/opt/omd/claude/local token' 2>/dev/null)\"", text)
        self.assertIn("-c 'model_providers.omd_claude_cli.base_url=\"http://127.0.0.1:5/v1\"'", text)
        self.assertNotIn("update_plan", text)
        record["activation"]["selection"] = "direct"
        self.assertNotIn("omd_claude_cli", lean_profiles.selected_text(record))

    def test_missing_service_rolls_back_selection_and_settings(self):
        identifier = "omd_lsp_view"
        store = Path("/tmp/omd-unused-store")
        source = store / "sources" / identifier
        record = {"store": str(store), "packages": {identifier: {}}}
        selected = False
        provider_enabled = False
        commands = []

        def invoke(_manager, command, _store, *arguments):
            nonlocal selected
            commands.append(command)
            if command == "selection-status":
                return {"selections": [{"id": identifier, "path": str(source),
                                        "selected": selected, "settings_sha256": "original-settings"}]}
            if command == "enable":
                selected = True
            elif command == "disable":
                selected = False
            return {}

        def profile_status(_prefix, _bin_dir):
            return {"packages": [{"id": identifier, "enabled_in_store": selected,
                                  "error": "service_provider_missing: omd_lsp_view requires omd.lsp"
                                  if selected and not provider_enabled else None}]}

        with patch.object(lean_profiles, "load", return_value=record), \
                patch.object(lean_profiles, "check", return_value=(None, Path("/tmp/omd-unused-manager"))), \
                patch.object(lean_profiles, "invoke", side_effect=invoke), \
                patch.object(lean_profiles, "status", side_effect=profile_status):
            with self.assertRaisesRegex(ValueError, "was restored:.*service_provider_missing"):
                lean_profiles.select_mod(Path("/tmp/omd-unused-prefix"), Path("/tmp/omd-unused-bin"),
                                         identifier, True)
            self.assertFalse(selected)
            self.assertEqual(commands, ["selection-status", "enable", "reload", "disable", "reload", "selection-status"])
            provider_enabled = True
            result = lean_profiles.select_mod(Path("/tmp/omd-unused-prefix"), Path("/tmp/omd-unused-bin"),
                                              identifier, True)
            self.assertTrue(selected)
            self.assertIsNone(result["packages"][0]["error"])

    @unittest.skipUnless(os.environ.get("OMD_TEST_MOD_BIN"), "set OMD_TEST_MOD_BIN for native offline coverage")
    def test_service_import_enable_requires_its_provider_in_isolated_store(self):
        manager = Path(os.environ["OMD_TEST_MOD_BIN"]).resolve()
        node = subprocess.check_output(["mise", "which", "node"], cwd=ROOT, text=True).strip()
        with tempfile.TemporaryDirectory(prefix="omd-profile-selection-", dir="/private/tmp") as temporary:
            base = Path(temporary)
            store = base / "store"
            lean_profiles.invoke(manager, "init", store, node)
            sources = store / "sources"
            sources.mkdir()
            for identifier in ("omd_lsp_view", "omd_lsp_sync"):
                source = sources / identifier
                source.mkdir()
                package = ROOT / "mods/first-party" / identifier
                manifest = json.loads((package / "mod.json").read_text())
                for name in ("mod.json", "index.ts", *manifest.get("assets", [])):
                    shutil.copy2(package / name, source / name)
                inspected = lean_profiles.invoke(manager, "inspect", source)
                lean_profiles.invoke(manager, "trust", store, source, inspected["sha256"],
                                     ",".join(inspected["manifest"]["capabilities"]))
            record = {"store": str(store), "packages": {"omd_lsp_view": {}}}

            def profile_status(_prefix, _bin_dir):
                host = lean_profiles.invoke(manager, "status", store)
                selected = {item["id"]: item for item in host["mods"]}
                active = selected.get("omd_lsp_view")
                return {"packages": [{"id": "omd_lsp_view", "enabled_in_store": active is not None,
                                      "error": active["error"] if active else None}]}

            before = lean_profiles.invoke(manager, "selection-status", store)["selections"]
            view_before = next(item for item in before if item["id"] == "omd_lsp_view")
            with patch.object(lean_profiles, "load", return_value=record), \
                    patch.object(lean_profiles, "check", return_value=(None, manager)), \
                    patch.object(lean_profiles, "status", side_effect=profile_status):
                with self.assertRaisesRegex(ValueError, "service_provider_missing.*omd.lsp"):
                    lean_profiles.select_mod(base / "prefix", base / "bin", "omd_lsp_view", True)
                after = lean_profiles.invoke(manager, "selection-status", store)["selections"]
                view_after = next(item for item in after if item["id"] == "omd_lsp_view")
                self.assertFalse(view_after["selected"])
                self.assertEqual(view_after["settings_sha256"], view_before["settings_sha256"])
                lean_profiles.invoke(manager, "enable", store, sources / "omd_lsp_sync")
                lean_profiles.invoke(manager, "reload", store)
                result = lean_profiles.select_mod(base / "prefix", base / "bin", "omd_lsp_view", True)
                self.assertTrue(result["packages"][0]["enabled_in_store"])
                self.assertIsNone(result["packages"][0]["error"])


if __name__ == "__main__":
    unittest.main()
