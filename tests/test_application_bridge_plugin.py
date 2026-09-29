import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "plugins/bundled/oh-my-diff/plugins/omd-application-bridges"
LAUNCHER = PLUGIN / "scripts/omd_application_bridge.py"
HOOK = PLUGIN / "hooks/omd_bridge_lifecycle.py"


def load_launcher():
    spec = importlib.util.spec_from_file_location("omd_application_bridge", LAUNCHER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ApplicationBridgePluginTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.repository = self.root / "repository"
        self.repository.mkdir()
        self.policy = self.root / "policy.json"
        self.policy.write_text("{}\n")
        self.manifest = self.root / "manifest.json"
        self.manifest_value = {
            "repository": str(self.repository),
            "capabilities": {"application_bridge": True},
            "bridge": {
                "path": str(self.policy),
                "sha256": hashlib.sha256(self.policy.read_bytes()).hexdigest(),
            },
        }
        self.write_manifest()

    def tearDown(self):
        self.temporary.cleanup()

    def write_manifest(self):
        self.manifest.write_text(json.dumps(self.manifest_value) + "\n")

    def environment(self):
        return {
            **os.environ,
            "OMD_MODE": "omd",
            "OMD_BRIDGE_CONFIG": str(self.manifest),
            "PLUGIN_ROOT": str(PLUGIN),
            "PLUGIN_DATA": str(self.root / "plugin-data"),
        }

    def run_hook(self, name, enabled=True):
        environment = self.environment()
        if not enabled:
            environment.pop("OMD_MODE", None)
            environment.pop("OMD_BRIDGE_CONFIG", None)
        return subprocess.run(
            [sys.executable, str(HOOK)],
            input=json.dumps({"hook_event_name": name, "session_id": "session-1"}),
            text=True,
            capture_output=True,
            env=environment,
            check=False,
        )

    def test_manifest_registers_prompt_gated_managed_mcp(self):
        manifest = json.loads((PLUGIN / ".mcp.json").read_text())
        server = manifest["mcpServers"]["omd_application_bridges"]
        self.assertEqual(server["command"], "./scripts/omd_application_bridge.py")
        self.assertEqual(server["default_tools_approval_mode"], "prompt")
        self.assertEqual(
            set(server["env_vars"]),
            {"OMD_MODE", "OMD_BRIDGE_CONFIG", "OMD_MOD_STORE"},
        )

    def test_launcher_requires_exact_enabled_external_policy(self):
        module = load_launcher()
        policy, digest = module.selection(self.environment())
        self.assertEqual(policy, self.policy)
        self.assertEqual(digest, self.manifest_value["bridge"]["sha256"])
        self.policy.write_text("changed\n")
        with self.assertRaisesRegex(module.Invalid, "changed"):
            module.selection(self.environment())
        self.policy.write_text("{}\n")
        self.manifest_value["capabilities"]["application_bridge"] = False
        self.write_manifest()
        with self.assertRaisesRegex(module.Invalid, "not enabled"):
            module.selection(self.environment())

    def test_launcher_resolves_only_the_recorded_private_bundle(self):
        module = load_launcher()
        prefix = self.root / "prefix"
        plugin_root = prefix / "plugins/oh-my-diff/plugins/omd-application-bridges"
        plugin_root.mkdir(parents=True)
        bridge = prefix / "browser/bin/omd-bridge-mcp"
        bridge.parent.mkdir(parents=True)
        bridge.write_text("#!/bin/sh\n")
        bridge.chmod(0o755)
        (prefix / "install.json").write_text(
            json.dumps({"browser": {"bridge": {"launcher": str(bridge)}}}) + "\n"
        )
        self.assertEqual(module.locate_launcher(plugin_root), bridge)
        bridge.chmod(0o644)
        with self.assertRaisesRegex(module.Invalid, "not executable"):
            module.locate_launcher(plugin_root)

    def test_lifecycle_context_is_selected_and_secret_free(self):
        started = self.run_hook("SessionStart")
        self.assertEqual(started.returncode, 0, started.stderr)
        output = json.loads(started.stdout)
        context = output["hookSpecificOutput"]["additionalContext"]
        for adapter in ("browser", "node", "rust", "python", "java"):
            self.assertIn(f"{adapter}_bridge", context)
        self.assertNotIn(str(self.policy), context)
        ended = self.run_hook("SessionEnd")
        self.assertEqual(ended.returncode, 0, ended.stderr)
        self.assertEqual(ended.stdout, "")
        inactive = self.run_hook("SessionStart", enabled=False)
        self.assertEqual(inactive.returncode, 0, inactive.stderr)
        self.assertEqual(inactive.stdout, "")


if __name__ == "__main__":
    unittest.main()
