import json
from pathlib import Path
import re
import unittest

from scripts import mod_compatibility, mod_conformance

ROOT = Path(__file__).resolve().parents[1]


class ContractTests(unittest.TestCase):
    def test_launch_inventory_rejects_drift_and_missing_consumers(self):
        contract = json.loads(mod_conformance.CONTRACT.read_text())
        _, sets = mod_conformance.host_sets()
        name = next(name for name, entry in contract["launch"].items() if entry["status"] == "frozen")
        del contract["launch"][name]
        self.assertIn(f"unclassified launch surface: {name}", mod_conformance.check_launch(contract, sets))
        contract["launch"][name] = {"status": "frozen", "consumer": {"path": "mods/api.d.ts", "snippet": "export"}, "evidence": ["node:missing test"]}
        problems = mod_conformance.check_launch(contract, sets)
        self.assertIn(f"{name}: missing launch/example consumer", problems)
        self.assertIn(f"{name}: missing or unresolved launch evidence", problems)
        contract["launch"][name] = {"status": "experimental"}
        self.assertIn(f"{name}: experimental surface needs a reason", mod_conformance.check_launch(contract, sets))

    def test_public_inventory_includes_nested_views_and_new_component_commands(self):
        fields = mod_conformance.fields("export interface View { first?: string; nested?: { hidden: string }; last: string; }", "View")
        self.assertEqual(fields, {"first", "nested", "last"})
        _, sets = mod_conformance.host_sets()
        public = mod_conformance.public_sets(sets)
        self.assertIn("native", public["components"])
        self.assertIn("owner/name", public["view_sites"])
        self.assertIn("example", public["author_commands"])

    def test_published_compatibility_matrix_matches_the_host(self):
        matrix = json.loads(mod_compatibility.MATRIX.read_text())
        self.assertEqual(mod_compatibility.check(matrix), [])

    def test_contract_covers_the_host_api_and_resolves_its_evidence(self):
        contract = json.loads(mod_conformance.CONTRACT.read_text())
        version, sets = mod_conformance.host_sets()
        self.assertEqual(mod_conformance.check(contract, version, sets), [])

    def test_published_coverage_table_matches_the_contract(self):
        contract = json.loads(mod_conformance.CONTRACT.read_text())
        self.assertEqual(
            mod_conformance.COVERAGE.read_text(),
            mod_conformance.render(contract),
            "mods/COVERAGE.md is stale; rerun scripts/mod_conformance.py --write",
        )

    def test_first_party_mods_use_only_the_published_api(self):
        version, sets = mod_conformance.host_sets()
        interface = re.search(r"export interface ModAPI \{(.*?)\n\}", (ROOT / "mods/api.d.ts").read_text(), re.S)
        published = set(re.findall(r"^  (?:readonly )?(\w+)[(<:]", interface.group(1), re.M))
        rust = "\n".join(
            path.read_text()
            for path in list((ROOT / "runtime").rglob("*.rs")) + [ROOT / "runtime/omd/src/mods/runner.mjs"]
        )
        packages = sorted(path for path in (ROOT / "mods/first-party").iterdir() if path.is_dir())
        self.assertTrue(packages)
        for package in packages:
            manifest = json.loads((package / "mod.json").read_text())
            source = (package / "index.ts").read_text()
            with self.subTest(mod=manifest["id"]):
                self.assertEqual(manifest["api"], version)
                self.assertLessEqual(set(manifest["capabilities"]), sets["capabilities"])
                self.assertIn(manifest["api"], {row["version"] for row in mod_compatibility.host_contract()["apis"]})
                allowed = {"../../api.d.ts", *(f"./{name}" for name in manifest.get("assets", []))}
                self.assertLessEqual(set(re.findall(r"from '([^']+)'", source)), allowed)
                self.assertEqual(len(re.findall(r"from '([^']+)'", source)), source.count("from '"))
                self.assertNotRegex(source, r"\b__omd\w*")
                self.assertNotIn("globalThis", source)
                body = "\n".join(line for line in source.splitlines() if not line.startswith("import "))
                for symbol in set(re.findall(r"(?<![\w./])api\.(\w+)", body)):
                    self.assertIn(symbol, published)
                self.assertNotIn(manifest["id"], rust, "a first-party mod is named in host source")

if __name__ == "__main__":
    unittest.main()
