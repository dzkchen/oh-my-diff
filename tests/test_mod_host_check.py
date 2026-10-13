import json
import tempfile
import unittest
from pathlib import Path

from scripts import mod_host_check as check


class SourceRules(unittest.TestCase):
    def test_equivalent_registration_syntax(self):
        variants = [
            'api.command("model", () => null);',
            "api . command ( 'model', () => null);",
            'const alias = api; alias["command"]("model", () => null);',
            'const { command: register } = api; register("model", () => null);',
            'const method = "command"; const name = "model"; api[method](name, () => null);',
            'const command = api.command.bind(api); command("model", () => null);',
        ]
        for source in variants:
            with self.subTest(source=source), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "first-party" / "fixture"
                path.mkdir(parents=True)
                (path / "mod.json").write_text(json.dumps({"id": "fixture"}))
                (path / "index.ts").write_text(
                    f'import type {{ ModAPI }} from "{check.ROOT / "mods/api.d.ts"}";\n'
                    f'export default function activate(api: ModAPI) {{ {source} }}')
                self.assertIn("/model conflicts with a built-in command", check.static_problems(path))

    def test_live_registrations_do_not_depend_on_source(self):
        status = {"mods": [{"id": "fixture", "unused_grants": ["commands", "context", "exec"],
                            "registrations": {"commands": [{"name": "computed"}], "events": ["context"]}}]}
        self.assertEqual(check.problems_from_status(status, "test", {}),
                         ["fixture: unused capabilities exec"])

    def test_conditional_registrations_and_middleware_keep_their_capabilities(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            (path / "index.ts").write_text(
                f'import type {{ ModAPI }} from "{check.ROOT / "mods/api.d.ts"}";\n'
                '''export default function activate(api: ModAPI) {
                  const { on: listen, middleware: wrap } = api;
                  if (api.settings.enabled) {
                    for (const name of ['start', 'resume'] as const) listen(name, () => null);
                    api ["on"] ("context", () => null);
                    listen('tool_output', () => null);
                  }
                  wrap('approval', () => null);
                  // api.on('history', () => null);
                }''')
            status = {"mods": [{"id": "fixture", "capabilities": ["middleware", "approvals"],
                                "unused_grants": ["lifecycle", "context", "outputs", "middleware", "history"],
                                "registrations": {"events": ["approval"]}}]}
            self.assertEqual(check.problems_from_status(status, "test", {"fixture": path}),
                             ["fixture: unused capabilities history"])

    def test_interceptor_patterns_use_real_registration_fields(self):
        for pattern in ("model_request", "model_*", "!render"):
            with self.subTest(pattern=pattern):
                self.assertIn("middleware", check.registered({"capabilities": ["middleware"],
                    "registrations": {"interceptors": [{"pattern": pattern}]}}))
        self.assertNotIn("middleware", check.registered({"capabilities": ["middleware"],
            "registrations": {"interceptors": [{"pattern": "!*"}]}}))

    def test_unresolved_computed_api_call_is_not_silently_skipped(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            (path / "mod.json").write_text(json.dumps({"id": "fixture"}))
            (path / "index.ts").write_text(
                f'import type {{ ModAPI }} from "{check.ROOT / "mods/api.d.ts"}";\n'
                'export default function activate(api: ModAPI) { api["com" + "ponent"]("panel", {}); }')
            self.assertTrue(any("computed ModAPI method" in problem for problem in check.static_problems(path)))

    def test_comments_and_type_imports_are_not_runtime_code(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            (path / "mod.json").write_text(json.dumps({"id": "fixture"}))
            (path / "index.ts").write_text('''
                // api.command('model', () => null); 'alt+b'
                import type { Example } from './types';
            ''')
            self.assertEqual(check.static_problems(path), [])

    def test_default_binding_with_named_types_requires_package_imports(self):
        variants = [
            ("import helper, { type Options } from './helper'; helper();", True),
            ("import { type Options } from './helper';", False),
            ("import type Helper from './helper';", False),
            ("export { type Options } from './helper';", False),
        ]
        for source, runtime_import in variants:
            with self.subTest(source=source), tempfile.TemporaryDirectory() as directory:
                path = Path(directory)
                (path / "mod.json").write_text(json.dumps({"id": "fixture"}))
                (path / "helper.ts").write_text(
                    'export type Options = {}; export default function helper() {}')
                (path / "index.ts").write_text(source)
                problems = check.static_problems(path)
                self.assertEqual(any("package_imports_v1" in problem for problem in problems), runtime_import)
                (path / "mod.json").write_text(json.dumps({
                    "id": "fixture", "compatibility": {"required_features": ["package_imports_v1"]}}))
                self.assertEqual(check.static_problems(path), [])


if __name__ == "__main__":
    unittest.main()
