import json
from pathlib import Path
import re
import unittest

from scripts import mod_compatibility, mod_conformance

ROOT = Path(__file__).resolve().parents[1]


class ContractTests(unittest.TestCase):
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
        host = mod_conformance.HOST.read_text()
        legacy = set(re.findall(r'"([a-z_.]+)"', re.search(r"LEGACY_MOD_CAPABILITIES: &\[&str\] = &\[(.*?)\];", host, re.S).group(1)))
        surfaces = {
            "api.d.ts": mod_conformance.host_sets()[1]["capabilities"],
            "api-0.1.d.ts": legacy,
        }
        published = {}
        for name in surfaces:
            interface = re.search(r"export interface ModAPI \{(.*?)\n\}", (ROOT / "mods" / name).read_text(), re.S)
            published[name] = set(re.findall(r"^  (?:readonly )?(\w+)[(<:]", interface.group(1), re.M))
        rust = "\n".join(
            path.read_text()
            for path in list((ROOT / "runtime").rglob("*.rs")) + [ROOT / "runtime/omd/src/mods/runner.mjs"]
        )
        packages = sorted(path for path in (ROOT / "mods/first-party").iterdir() if path.is_dir())
        self.assertTrue(packages)
        for package in packages:
            manifest = json.loads((package / "mod.json").read_text())
            source = (package / "index.ts").read_text()
            surface = "api-0.1.d.ts" if manifest["api"].startswith("0.1.") else "api.d.ts"
            with self.subTest(mod=manifest["id"]):
                self.assertLessEqual(set(manifest["capabilities"]), surfaces[surface])
                self.assertIn(manifest["api"], {row["version"] for row in mod_compatibility.host_contract()["apis"]})
                self.assertEqual(
                    re.findall(r"from '([^']+)'", source), [f"../../{surface}"] * source.count("from '")
                )
                self.assertNotRegex(source, r"\b__omd\w*")
                self.assertNotIn("globalThis", source)
                body = "\n".join(line for line in source.splitlines() if not line.startswith("import "))
                for symbol in set(re.findall(r"\bapi\.(\w+)", body)):
                    self.assertIn(symbol, published[surface])
                self.assertNotIn(manifest["id"], rust, "a first-party mod is named in host source")

if __name__ == "__main__":
    unittest.main()
