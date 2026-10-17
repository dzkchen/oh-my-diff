import json
import unittest

from scripts import mod_extension_types



class ModExtensionTypeTests(unittest.TestCase):
    def test_every_package_has_a_checked_extension_classification(self):
        registry = json.loads(mod_extension_types.REGISTRY.read_text())
        self.assertEqual(mod_extension_types.check(registry), [])


if __name__ == "__main__":
    unittest.main()
