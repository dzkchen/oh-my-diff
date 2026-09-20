import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

from scripts import browser_bundle
from scripts import preview_lock
from scripts import private_lean_v1 as installer


class ManagedFixture:
    def executable(self, path, version="codex-cli 0.154.0"):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"#!/bin/sh\nprintf '%s\\n' '{version}'\n")
        path.chmod(0o755)

    def managed(self, root):
        prefix = root / "install"
        bin_dir = root / "bin"
        upstream_original = root / "upstream/codex"
        self.executable(upstream_original)
        for name in ("upstream", "omd"):
            self.executable(prefix / f"artifacts/{name}/codex")
        manifest = {
            "schema": installer.SCHEMA,
            "product": installer.PRODUCT,
            "prefix": str(prefix),
            "bin_dir": str(bin_dir),
            "shared_state": {"codex_home": str(root / "state"),
                             "codex_sqlite_home": str(root / "state"),
                             "policy": "inherited unchanged; never removed by uninstall"},
            "artifacts": {
                "upstream": {"path": str(upstream_original),
                             "sha256": installer.digest(prefix / "artifacts/upstream/codex"),
                             "version": "codex-cli 0.154.0"},
                "omd": {"sha256": installer.digest(prefix / "artifacts/omd/codex"),
                        "version": "codex-cli 0.154.0"},
            },
            "activation": None,
        }
        installer.write_manifest(prefix, manifest)
        return prefix, bin_dir, upstream_original


class PrivateLeanV1Tests(ManagedFixture, unittest.TestCase):
    def browser(self, destination, *_args):
        self.executable(destination / "runtime/bin/node", "v24.21.0")
        self.executable(destination / "bin/omd-browser-mcp", "Version 0.0.81")
        self.executable(destination / "bin/omd-bridge-mcp", "Version 1")
        (destination / "bridge").mkdir()
        (destination / "bridge/host.mjs").write_text("host\n")
        (destination / "artifacts").mkdir()
        manifest = {
            "schema": browser_bundle.SCHEMA,
            "product": browser_bundle.PRODUCT,
            "destination": str(destination.resolve()),
            "provisioning": "source",
            "node": {"version": "24.21.0"},
            "mcp": {"version": "0.0.81"},
            "browser": {"revision": "1244"},
            "launcher": "bin/omd-browser-mcp",
            "bridge": {"launcher": "bin/omd-bridge-mcp", "protocol": 1,
                       "transport": "loopback HTTP with MCP stdio control",
                       "adapters": ["browser", "node", "rust", "python", "java"]},
            "approval": "Codex default_tools_approval_mode=prompt",
            "sandbox": "fixture",
            "cleanup": "fixture",
        }
        manifest["tree"] = browser_bundle.tree_identity(destination)
        browser_bundle.write_json(destination / "bundle.json", manifest)
        return browser_bundle.verify(destination)

    def test_activation_is_explicit_and_inherits_shared_state(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            prefix, bin_dir, _ = self.managed(root)
            state = root / "state"
            state.mkdir()
            marker = state / "auth.json"
            marker.write_bytes(b"shared-secret-fixture")
            before = hashlib.sha256(marker.read_bytes()).hexdigest()
            installer.activate(prefix, bin_dir, "omd", "upstream_direct")
            wrapper = (bin_dir / "codex").read_text()
            self.assertIn("export OMD_MODE=upstream_direct", wrapper)
            self.assertNotIn("CODEX_HOME=", wrapper)
            installer.activate(prefix, bin_dir, "upstream")
            wrapper = (bin_dir / "codex").read_text()
            self.assertIn("unset OMD_MODE", wrapper)
            self.assertEqual(hashlib.sha256(marker.read_bytes()).hexdigest(), before)

    def test_enabled_mode_requires_existing_manifest(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            prefix, bin_dir, _ = self.managed(root)
            with self.assertRaisesRegex(ValueError, "requires --manifest"):
                installer.activate(prefix, bin_dir, "omd", "enabled")
            controlled = root / "controlled.json"
            controlled.write_text("{}\n")
            manifest = installer.activate(prefix, bin_dir, "omd", "enabled", controlled)
            self.assertEqual(manifest["activation"]["controlled_manifest"], str(controlled.resolve()))

    def test_omd_activation_registers_prompt_gated_browser_but_upstream_does_not(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            prefix, bin_dir, _ = self.managed(root)
            browser = self.browser(prefix / "browser")
            manifest = installer.load_manifest(prefix)
            manifest["browser"] = {
                "launcher": str(prefix / "browser/bin/omd-browser-mcp"),
                "bridge": {"launcher": str(prefix / "browser/bin/omd-bridge-mcp")},
                "tree": browser["tree"],
            }
            installer.write_manifest(prefix, manifest)
            installer.activate(prefix, bin_dir, "omd", "upstream_direct")
            wrapper = (bin_dir / "codex").read_text()
            self.assertIn("mcp_servers.omd_browser.command", wrapper)
            self.assertIn('default_tools_approval_mode="prompt"', wrapper)
            installer.activate(prefix, bin_dir, "upstream")
            self.assertNotIn("omd_browser", (bin_dir / "codex").read_text())

    def test_bridge_is_registered_only_for_a_hash_bound_enabled_policy(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            prefix, bin_dir, _ = self.managed(root)
            browser = self.browser(prefix / "browser")
            manifest = installer.load_manifest(prefix)
            manifest["browser"] = {
                "launcher": str(prefix / "browser/bin/omd-browser-mcp"),
                "bridge": {"launcher": str(prefix / "browser/bin/omd-bridge-mcp")},
                "tree": browser["tree"],
            }
            installer.write_manifest(prefix, manifest)
            policy = root / "bridge-policy.json"
            policy.write_text("{}\n")
            controlled = root / "controlled.json"
            controlled.write_text(json.dumps({
                "capabilities": {"application_bridge": True},
                "bridge": {"path": str(policy.resolve()), "sha256": installer.digest(policy)},
            }))
            installer.activate(prefix, bin_dir, "omd", "enabled", controlled)
            wrapper = (bin_dir / "codex").read_text()
            self.assertIn("mcp_servers.omd_bridge.command", wrapper)
            self.assertIn("OMD_BRIDGE_POLICY_SHA256", wrapper)
            policy.write_text("changed\n")
            with self.assertRaisesRegex(ValueError, "absent or changed"):
                installer.activate(prefix, bin_dir, "omd", "enabled", controlled)
            controlled.write_text(json.dumps({"capabilities": {"application_bridge": False}}))
            installer.activate(prefix, bin_dir, "omd", "enabled", controlled)
            self.assertNotIn("omd_bridge", (bin_dir / "codex").read_text())

    def test_modified_launcher_is_not_replaced_or_removed(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            prefix, bin_dir, _ = self.managed(root)
            installer.activate(prefix, bin_dir, "omd", "upstream_direct")
            (bin_dir / "codex").write_text("unmanaged\n")
            with self.assertRaisesRegex(ValueError, "unmanaged or modified"):
                installer.activate(prefix, bin_dir, "upstream")
            with self.assertRaisesRegex(ValueError, "absent or modified"):
                installer.uninstall(prefix, bin_dir)
            self.assertTrue(prefix.exists())

    def test_uninstall_restores_upstream_and_preserves_shared_data(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            prefix, bin_dir, upstream = self.managed(root)
            shared = root / "state"
            shared.mkdir()
            (shared / "config.toml").write_text("fixture = true\n")
            manifest = json.loads((prefix / "install.json").read_text())
            manifest["shared_state"]["codex_home"] = str(shared)
            manifest["shared_state"]["codex_sqlite_home"] = str(shared)
            installer.write_manifest(prefix, manifest)
            installer.activate(prefix, bin_dir, "omd", "upstream_direct")
            with mock.patch.dict(os.environ, {"PATH": str(upstream.parent)}):
                result = installer.uninstall(prefix, bin_dir)
            self.assertTrue(result["uninstalled"])
            self.assertFalse(prefix.exists())
            self.assertFalse((bin_dir / "codex").exists())
            self.assertEqual((shared / "config.toml").read_text(), "fixture = true\n")

    def test_uninstall_refuses_when_upstream_would_not_resolve(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            prefix, bin_dir, _ = self.managed(root)
            installer.activate(prefix, bin_dir, "omd", "upstream_direct")
            with mock.patch.dict(os.environ, {"PATH": "/usr/bin:/bin"}):
                with self.assertRaisesRegex(ValueError, "would not be restored"):
                    installer.uninstall(prefix, bin_dir)
            self.assertTrue(prefix.exists())
            self.assertTrue((bin_dir / "codex").exists())

    def test_install_paths_cannot_overlap_shared_state(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            state = root / "state"
            with mock.patch.dict(os.environ, {"CODEX_HOME": str(state),
                                               "CODEX_SQLITE_HOME": str(state)}):
                with self.assertRaisesRegex(ValueError, "shared Codex state"):
                    installer.validate_locations(state / "install", root / "bin")

    def test_default_install_target_is_removed_but_source_and_artifacts_remain(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            prefix = root / "install"
            bin_dir = root / "bin"
            upstream = root / "upstream/codex"
            self.executable(upstream)
            args = SimpleNamespace(prefix=prefix, bin_dir=bin_dir, upstream=upstream,
                                   repository="fixture-repository", target_dir=None)
            upstream_lock = {"commit": "fixture-commit", "tag": "fixture-tag",
                             "rust_toolchain": "1.95.0",
                             "normalized_cargo_lock_sha256": "lock-hash"}
            lean_lock = {"runtime_patch": {"sha256": "patch-hash"}}

            def clone(_repository, checkout, _commit):
                (checkout / "codex-rs").mkdir(parents=True)

            def command_output(arguments, cwd=None, env=None):
                if arguments[0] == "rustc":
                    return "rustc 1.95.0 fixture"
                if arguments[0] == "file":
                    return "Mach-O 64-bit executable arm64"
                if arguments[-1] == "--version":
                    return "codex-cli 0.154.0"
                return ""

            def command_run(arguments, cwd=None, env=None, capture=True):
                target = Path(env["CARGO_TARGET_DIR"])
                self.executable(target / "release/codex")
                self.executable(target / "release/omd-mod", "omd-mod fixture")
                return SimpleNamespace(returncode=0, stdout="", stderr="")

            environment = {"PATH": str(upstream.parent), "CODEX_HOME": str(root / "state"),
                           "CODEX_SQLITE_HOME": str(root / "state")}
            with mock.patch.dict(os.environ, environment, clear=True), \
                    mock.patch.object(installer, "verify_platform"), \
                    mock.patch.object(installer, "lock_inputs", return_value=(upstream_lock, lean_lock)), \
                    mock.patch.object(installer, "clone_pinned", side_effect=clone), \
                    mock.patch.object(installer, "output", side_effect=command_output), \
                    mock.patch.object(installer, "run", side_effect=command_run), \
                    mock.patch.object(installer.browser_bundle, "build_bundle", side_effect=self.browser):
                manifest = installer.install(args)
            self.assertEqual(manifest["activation"]["selection"], "omd")
            self.assertTrue((prefix / "source/codex-rs").is_dir())
            self.assertTrue((prefix / "artifacts/omd/codex").is_file())
            self.assertTrue((prefix / "browser/bin/omd-browser-mcp").is_file())
            self.assertEqual(manifest["browser"]["approval"],
                             "Codex default_tools_approval_mode=prompt")
            self.assertTrue((prefix / "artifacts/omd/omd-mod").is_file())
            self.assertEqual(manifest["mod_manager"]["installed_path"],
                             str(prefix / "artifacts/omd/omd-mod"))
            self.assertFalse((prefix / "target").exists())


class PreviewLockTests(unittest.TestCase):
    def test_pinned_preview_lock_matches_the_first_party_sources(self):
        self.assertEqual(preview_lock.build(), installer.preview_lock())

    def test_every_pinned_package_declares_the_shipped_api_version(self):
        lock = installer.preview_lock()
        api = json.loads((installer.ROOT / "mods/package.json").read_text())["version"]
        self.assertEqual(lock["mod_api"], api)
        self.assertTrue(lock["packages"])
        for identifier, package in lock["packages"].items():
            manifest = json.loads((installer.ROOT / package["source"] / "mod.json").read_text())
            self.assertEqual(manifest["api"], api, identifier)
            self.assertEqual(manifest["capabilities"], package["capabilities"], identifier)


@unittest.skipUnless(os.environ.get("OMD_TEST_MANAGER") and os.environ.get("OMD_TEST_NODE"),
                     "set OMD_TEST_MANAGER and OMD_TEST_NODE to exercise the installable preview")
class PreviewSliceTests(ManagedFixture, unittest.TestCase):
    def preview_install(self, root):
        prefix, bin_dir, _ = self.managed(root)
        shutil.copy2(os.environ["OMD_TEST_MANAGER"], prefix / "artifacts/omd/omd-mod")
        manifest = installer.load_manifest(prefix)
        manifest["mod_manager"] = {"sha256": installer.digest(prefix / "artifacts/omd/omd-mod"),
                                   "installed_path": str(prefix / "artifacts/omd/omd-mod"),
                                   "mod_api": installer.preview_lock()["mod_api"]}
        installer.write_manifest(prefix, manifest)
        installer.activate(prefix, bin_dir, "omd", "upstream_direct")
        store = root / "store"
        installed = installer.preview_install(prefix, bin_dir, store, Path(os.environ["OMD_TEST_NODE"]))
        return prefix, bin_dir, installer.resolved(store), installed

    def test_preview_installs_pinned_sources_typed_exports_and_a_guide(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            prefix, bin_dir, store, installed = self.preview_install(root)
            lock = installer.preview_lock()
            self.assertEqual(sorted(installed["packages"]), ["omd_coordination", "omd_workspace"])
            self.assertEqual(installed["mod_api"], lock["mod_api"])
            for identifier, package in installed["packages"].items():
                self.assertEqual(package["sha256"], lock["packages"][identifier]["package_sha256"])
                self.assertTrue((Path(package["path"]) / "index.ts").is_file())
            self.assertTrue((store / "api.d.ts").is_file())
            self.assertTrue((store / "PREVIEW.md").is_file())
            self.assertIn(f'"mods": "{store}"', "\n".join(installed["next"]))
            state = installer.preview_status(prefix, bin_dir, store)
            self.assertTrue(state["mod_api"]["compatible"])
            self.assertTrue(all(package["enabled"] for package in state["packages"]))
            self.assertFalse(any(package["locally_edited"] for package in state["packages"]))
            self.assertFalse(any(package["error"] for package in state["packages"]))

    def test_preview_reports_local_edits_and_protects_them_from_removal(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            prefix, bin_dir, store, installed = self.preview_install(root)
            source = Path(installed["packages"]["omd_workspace"]["path"]) / "index.ts"
            source.write_text(source.read_text().replace("Oh My Diff workspace", "My workspace"))
            edited = installer.preview_status(prefix, bin_dir, store)["packages"]
            self.assertTrue(next(item for item in edited if item["id"] == "omd_workspace")["locally_edited"])
            with self.assertRaisesRegex(ValueError, "locally edited"):
                installer.preview_uninstall(prefix, bin_dir, store, False)
            removed = installer.preview_uninstall(prefix, bin_dir, store, True)
            self.assertEqual(removed["removed_local_edits"], ["omd_workspace"])
            self.assertFalse(store.exists())

    def test_preview_disable_is_explicit_and_reversible(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            prefix, bin_dir, store, _ = self.preview_install(root)
            disabled = installer.preview_select(prefix, bin_dir, store, "omd_workspace", False)
            selected = {package["id"]: package["enabled"] for package in disabled["packages"]}
            self.assertEqual(selected, {"omd_coordination": True, "omd_workspace": False})
            enabled = installer.preview_select(prefix, bin_dir, store, None, True)
            self.assertTrue(all(package["enabled"] for package in enabled["packages"]))

    def test_preview_refuses_an_incompatible_host_api_and_an_internal_store(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            prefix, bin_dir, store, _ = self.preview_install(root)
            lock = {**installer.preview_lock(), "mod_api": "0.1.0-experimental.99"}
            with mock.patch.object(installer, "preview_lock", return_value=lock), \
                    self.assertRaisesRegex(ValueError, r"0\.1\.0-experimental\.99"):
                installer.preview_install(prefix, bin_dir, root / "other-store",
                                          Path(os.environ["OMD_TEST_NODE"]))
            with self.assertRaisesRegex(ValueError, "outside this repository"):
                installer.preview_install(prefix, bin_dir, installer.ROOT / "store",
                                          Path(os.environ["OMD_TEST_NODE"]))

    def test_preview_refuses_a_package_the_installed_host_cannot_run(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            prefix, bin_dir, _, _ = self.preview_install(root)
            pinned = root / "pinned"
            relative = installer.preview_lock()["packages"]["omd_workspace"]["source"]
            source = pinned / relative
            source.mkdir(parents=True)
            manifest = json.loads((installer.ROOT / relative / "mod.json").read_text())
            manifest["api"] = "0.1.0-experimental.99"
            (source / "mod.json").write_text(json.dumps(manifest))
            shutil.copy2(installer.ROOT / relative / "index.ts", source / "index.ts")
            for name in ("api.d.ts", "PREVIEW.md"):
                shutil.copy2(installer.ROOT / "mods" / name, pinned / "mods" / name)
            lock = {
                "schema": installer.PREVIEW_SCHEMA, "product": installer.PREVIEW_PRODUCT,
                "mod_api": manifest["api"], "node": installer.preview_lock()["node"],
                "types": {"path": "mods/api.d.ts", "sha256": installer.digest(pinned / "mods/api.d.ts")},
                "guide": {"path": "mods/PREVIEW.md"},
                "packages": {"omd_workspace": {
                    "version": manifest["version"], "capabilities": manifest["capabilities"],
                    "source": relative,
                    "files": {name: installer.digest(source / name) for name in installer.PACKAGE_FILES},
                    "package_sha256": installer.digest_of_package(source)}},
            }
            with mock.patch.object(installer, "ROOT", pinned), \
                    mock.patch.object(installer, "preview_lock", return_value=lock), \
                    self.assertRaisesRegex(ValueError, "installed host runs mod API"):
                installer.preview_install(prefix, bin_dir, root / "mismatch",
                                          Path(os.environ["OMD_TEST_NODE"]))


if __name__ == "__main__":
    unittest.main()
