from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from scripts.check_native_ownership import first_party, identifiers, inspect, literals, production


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

    def test_inherited_renamed_dependency_edges(self):
        from scripts.check_native_ownership import dependencies

        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest = root / "runtime/omd/Cargo.toml"
            manifest.parent.mkdir(parents=True)
            manifest.write_text('[dependencies]\nbridge = { workspace = true }\n')
            workspace = root / "Cargo.toml"
            workspace.write_text('[workspace.dependencies]\nbridge = { package = "codex-core", version = "1" }\n')
            self.assertEqual(dependencies(root)[0]["name"], "codex-core")
            workspace.unlink()
            patch = root / "runtime/patches/dependencies.patch"
            patch.parent.mkdir()
            patch.write_text('+++ b/codex-rs/Cargo.toml\n@@ -1,1 +1,2 @@\n [workspace.dependencies]\n+bridge = { package = "codex-tui", path = "tui" }\n')
            self.assertEqual(dependencies(root)[0]["name"], "codex-tui")
            patch.write_text('+++ b/codex-rs/Cargo.toml\n@@ -1,1 +1,3 @@\n+[workspace.dependencies.bridge]\n+package = "codex-core"\n+path = "core"\n')
            self.assertEqual(dependencies(root)[0]["name"], "codex-core")

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

    def test_scans_include_production_after_test_module(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = root / "runtime/omd/src/mods.rs"
            package = root / "mods/first-party/omd_sample/mod.json"
            path.parent.mkdir(parents=True)
            package.parent.mkdir(parents=True)
            package.write_text('{"id": "omd_sample"}')
            path.write_text('fn before() { let _ = "sample_mode"; }\n'
                            '#[cfg(test)]\nmod tests { fn fixture() { let _ = "omd_sample"; } }\n'
                            'fn after() { let _ = ("claude_billing", "omd_sample"); }\n')
            self.assertEqual([(f['name'], f['line']) for f in literals(root, identifiers(root))],
                             [('sample_mode', 1), ('claude_billing', 4), ('omd_sample', 4)])
            self.assertEqual([(f['name'], f['line']) for f in first_party(root)],
                             [('omd_sample', 4)])

    def test_unknown_test_boundary_cannot_hide_later_production(self):
        with TemporaryDirectory() as temporary:
            path = Path(temporary) / "sample.rs"
            path.write_text('struct S { #[cfg(test)] field: bool }\n'
                            'fn after() { let _ = "workflow"; }\n')
            with self.assertRaisesRegex(ValueError, "unbalanced test item"):
                production(path)

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
                'struct HostConfig {\n}\nfn f() { let _ = ("sample_rules", "git", "omd_sample"); }\n'
                '#[cfg(test)]\nfn t() { let _ = "sample_fixture"; }\n')
            runner.write_text("const sampleText = 1; const ok = 'fine';\n")
            package.write_text('{"id": "omd_sample"}')
            findings = {(item["surface"], item["name"]) for item in inspect(root)}
            self.assertEqual(findings, {("literal", "sample_rules"), ("literal", "omd_sample"),
                                        ("runner", "sampleText"), ("first_party_id", "omd_sample")})

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
