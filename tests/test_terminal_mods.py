import json
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class TerminalModSourceTests(unittest.TestCase):
    def test_terminal_mods_declare_only_their_required_features_and_capabilities(self):
        expected = {
            "omd_logo": ({"terminal"}, {"terminal_render_sites_v1", "terminal_welcome_v1"}),
            "omd_model_picker": ({"terminal", "events", "store"}, {"terminal_lists_v1", "events_v1"}),
        }
        for mod, (capabilities, features) in expected.items():
            manifest = json.loads((ROOT / "mods/first-party" / mod / "mod.json").read_text())
            with self.subTest(mod=mod):
                self.assertEqual(set(manifest["capabilities"]), capabilities)
                self.assertLessEqual(features, set(manifest["compatibility"]["required_features"]))


if __name__ == "__main__":
    unittest.main()
