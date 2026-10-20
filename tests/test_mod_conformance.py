import json
from pathlib import Path
import re
import unittest

from scripts import mod_compatibility, mod_conformance, mod_extension_types

ROOT = Path(__file__).resolve().parents[1]


class ContractTests(unittest.TestCase):
    def test_published_compatibility_matrix_matches_the_host(self):
        matrix = json.loads(mod_compatibility.MATRIX.read_text())
        self.assertEqual(mod_compatibility.check(matrix), [])

    def test_contract_covers_the_host_api_and_resolves_its_evidence(self):
        contract = json.loads(mod_conformance.CONTRACT.read_text())
        version, sets = mod_conformance.host_sets()
        self.assertEqual(mod_conformance.check(contract, version, sets), [])

    def test_every_package_has_a_checked_extension_classification(self):
        registry = json.loads(mod_extension_types.REGISTRY.read_text())
        self.assertEqual(mod_extension_types.check(registry), [])

    def test_first_party_mods_use_only_the_published_api(self):
        version, sets = mod_conformance.host_sets()
        interface = re.search(r"export interface ModAPI \{(.*?)\n\}", (ROOT / "mods/api.d.ts").read_text(), re.S)
        published = set(re.findall(r"^  (?:readonly )?(\w+)[(<:]", interface.group(1), re.M))
        rust = "\n".join(
            path.read_text()
            for path in list((ROOT / "runtime").rglob("*.rs")) + list((ROOT / "runtime/omd/runner/src").glob("*.js"))
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
