import json
from pathlib import Path
import unittest

from scripts import mod_extension_types


ROOT = Path(__file__).resolve().parents[1]


class ModExtensionTypeTests(unittest.TestCase):
    def test_every_package_has_a_checked_extension_classification(self):
        registry = json.loads(mod_extension_types.REGISTRY.read_text())
        self.assertEqual(mod_extension_types.check(registry), [])

    def test_published_extension_type_document_matches_the_registry(self):
        registry = json.loads(mod_extension_types.REGISTRY.read_text())
        self.assertEqual(
            (ROOT / "mods/EXTENSION_TYPES.md").read_text(),
            mod_extension_types.render(registry),
        )


if __name__ == "__main__":
    unittest.main()
