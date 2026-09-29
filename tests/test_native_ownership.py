from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from scripts.check_native_ownership import inspect


class NativeOwnershipTests(unittest.TestCase):
    def test_feature_named_surfaces_and_config_are_reported(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            mod = root / "runtime/omd/src/mods.rs"
            config = root / "runtime/native/src/config.rs"
            mod.parent.mkdir(parents=True)
            config.parent.mkdir(parents=True)
            mod.write_text("\n".join(
                f'pub const {surface}: &[&str] = &["{value}"];'
                for surface, value in (
                    ("MOD_HOST_FEATURES", "graph_cache_v1"),
                    ("MOD_HOST_OPERATIONS", "git.stage"),
                    ("MOD_CAPABILITIES", "review"),
                    ("MOD_EVENTS", "workflow"),
                    ("MOD_REPLACEMENT_POINTS", "checkpoint"),
                    ("MOD_MIDDLEWARE_EVENTS", "agent"),
                )
            ))
            config.write_text("struct HostConfig {\n    pub pi_user: Option<String>,\n}\n")
            findings = inspect(root)
            self.assertEqual({item["name"] for item in findings},
                             {"graph_cache_v1", "git.stage", "review", "workflow", "checkpoint", "pi_user"})

    def test_literals_runner_names_and_first_party_ids_are_reported_outside_tests(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            mod = root / "runtime/omd/src/mods.rs"
            config = root / "runtime/native/src/config.rs"
            runner = root / "runtime/omd/src/mods/runner.mjs"
            package = root / "mods/first-party/omd_sample/mod.json"
            for path in (mod, runner, config, package):
                path.parent.mkdir(parents=True, exist_ok=True)
            mod.write_text("\n".join(f'pub const {surface}: &[&str] = &[];' for surface in (
                "MOD_HOST_FEATURES", "MOD_HOST_OPERATIONS", "MOD_CAPABILITIES", "MOD_EVENTS",
                "MOD_REPLACEMENT_POINTS", "MOD_MIDDLEWARE_EVENTS")))
            config.write_text(
                'struct HostConfig {\n}\nfn f() { let _ = ("authorized_presets", "git", "omd_sample"); }\n'
                '#[cfg(test)]\nfn t() { let _ = "workflow_fixture"; }\n')
            runner.write_text("const piText = 1; const ok = 'fine';\n")
            package.write_text('{"id": "omd_sample"}')
            findings = {(item["surface"], item["name"]) for item in inspect(root)}
            self.assertEqual(findings, {("literal", "authorized_presets"), ("runner", "piText"),
                                        ("first_party_id", "omd_sample")})


if __name__ == "__main__":
    unittest.main()
