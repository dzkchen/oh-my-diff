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


if __name__ == "__main__":
    unittest.main()
