from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from scripts.check_native_ownership import first_party, inspect, production


class NativeOwnershipTests(unittest.TestCase):
    def test_forbidden_dependency_edges_include_renamed_and_target_dependencies(self):
        from scripts.check_native_ownership import dependencies

        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            for directory, allowed, forbidden in (
                ("omd", "serde", "codex-core"),
                ("native", "codex-core", "codex-tui"),
            ):
                path = root / "runtime" / directory / "Cargo.toml"
                path.parent.mkdir(parents=True)
                path.write_text(f'[dependencies]\n{allowed} = "1"\n')
                self.assertEqual(dependencies(root), [])
                for section in ("dependencies", "build-dependencies", "dev-dependencies",
                                "target.'cfg(unix)'.dependencies"):
                    path.write_text(f'[{section}]\nbridge = {{ package = "{forbidden}", version = "1" }}\n')
                    findings = dependencies(root)
                    self.assertEqual(len(findings), 1)
                    self.assertEqual(findings[0]["name"], forbidden)
                path.write_text(f'[dependencies]\n{allowed} = "1"\n')

    def test_production_resumes_after_test_items(self):
        with TemporaryDirectory() as temporary:
            path = Path(temporary) / "sample.rs"
            before = 'fn before() { let _ = "workflow"; }\n'
            tests = ('#[cfg(test)]\nmod tests {\n'
                     ' /* nested /* } */ comment */\n'
                     ' fn fixture() { let _ = r###" } #[cfg(test)] "###; }\n}\n'
                     '#[cfg ( test )]\n#[test]\nfn test_only() { let _ = "{"; }\n')
            after = 'fn after() { let _ = "review"; }\n'
            path.write_text(before + tests + after)
            self.assertEqual(production(path), before + ''.join('\n' if c == '\n' else ' ' for c in tests.rstrip('\n')) + '\n' + after)

    def test_feature_named_surfaces_and_config_are_reported(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            mod = root / "runtime/omd/src/mods.rs"
            config = root / "runtime/native/src/config.rs"
            package = root / "mods/first-party/omd_privacy_view/mod.json"
            for path in (mod, config, package):
                path.parent.mkdir(parents=True)
            package.write_text('{"id": "omd_privacy_view"}')
            mod.write_text("\n".join(
                f'pub const {surface}: &[&str] = &["{value}"];'
                for surface, value in (
                    ("MOD_HOST_FEATURES", "privacy_cache_v1"),
                    ("MOD_HOST_OPERATIONS", "git.stage"),
                    ("MOD_CAPABILITIES", "lsp"),
                    ("MOD_EVENTS", "claude_turn"),
                    ("MOD_REPLACEMENT_POINTS", "anthropic"),
                    ("MOD_MIDDLEWARE_EVENTS", "view"),
                )
            ))
            config.write_text("struct HostConfig {\n    pub privacy_rules: Vec<String>,\n}\n")
            findings = inspect(root)
            self.assertEqual({item["name"] for item in findings},
                             {"privacy_cache_v1", "git.stage", "lsp", "claude_turn", "anthropic", "privacy_rules"})

    def test_a_generic_literal_is_exempt_only_as_itself(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            mod = root / "runtime/omd/src/mods.rs"
            config = root / "runtime/native/src/config.rs"
            runner = root / "runtime/omd/runner/src/step.js"
            package = root / "mods/first-party/omd_files/mod.json"
            for path in (mod, config, runner, package):
                path.parent.mkdir(parents=True, exist_ok=True)
            package.write_text('{"id": "omd_files"}')
            mod.write_text('pub const MOD_HOST_FEATURES: &[&str] = &["files", "files_preview_v1"];\n' + "\n".join(
                f'pub const {surface}: &[&str] = &[];' for surface in (
                    "MOD_HOST_OPERATIONS", "MOD_CAPABILITIES", "MOD_EVENTS", "MOD_REPLACEMENT_POINTS", "MOD_MIDDLEWARE_EVENTS")))
            config.write_text('struct HostConfig {\n}\nfn f() { let _ = "files"; }\n')
            runner.write_text("const files = details.files;\n")
            findings = inspect(root)
            self.assertEqual({item["name"] for item in findings}, {"files_preview_v1"})

    def test_added_patch_lines_are_scanned_outside_tests_and_mirrors(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            package = root / "mods/first-party/omd_sample/mod.json"
            patch = root / "runtime/patches/sample.patch"
            for path in (package, patch):
                path.parent.mkdir(parents=True)
            package.write_text('{"id": "omd_sample"}')
            patch.write_text(
                "diff --git a/codex-rs/tui/src/a.rs b/codex-rs/tui/src/a.rs\n--- a/codex-rs/tui/src/a.rs\n"
                "+++ b/codex-rs/tui/src/a.rs\n@@ -1,2 +1,3 @@\n omd_sample\n-omd_sample\n+let x = \"omd_sample\";\n"
                "diff --git a/codex-rs/tui/src/a_tests.rs b/codex-rs/tui/src/a_tests.rs\n"
                "+++ b/codex-rs/tui/src/a_tests.rs\n@@ -0,0 +1 @@\n+omd_sample\n"
                "diff --git a/codex-rs/ext/omd/src/b.rs b/codex-rs/ext/omd/src/b.rs\n"
                "+++ b/codex-rs/ext/omd/src/b.rs\n@@ -0,0 +1 @@\n+omd_sample\n")
            self.assertEqual([(item["path"], item["line"]) for item in first_party(root)],
                             [("codex-rs/tui/src/a.rs", 2)])


if __name__ == "__main__":
    unittest.main()
