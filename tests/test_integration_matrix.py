import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from scripts import integration_matrix

REQUIRED_BOUNDARIES = {
    "duplicate_tools",
    "duplicate_keybindings",
    "disabled_dependencies",
    "upstream_plugin_coexistence",
    "streaming_reload",
    "host_upgrade",
}


class IntegrationMatrixTests(unittest.TestCase):
    def setUp(self):
        self.matrix = json.loads(integration_matrix.MATRIX.read_text())

    def test_matrix_matches_the_shipped_sources_and_resolves_its_evidence(self):
        self.assertEqual(integration_matrix.check(self.matrix), [])

    def test_missing_launch_cut_is_reported(self):
        self.matrix.pop("launch_cut")
        with patch.object(integration_matrix, "MATRIX") as source:
            source.read_text.return_value = json.dumps(self.matrix)
            with self.assertRaisesRegex(SystemExit, "launch_cut is missing"):
                integration_matrix.main()

    def test_sources_reject_an_unrecognized_plugin_lock(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "runtime").mkdir()
            lock = integration_matrix.install_support.plugin_lock()
            for field in ("schema", "product"):
                invalid = {**lock, field: "unknown"}
                (root / "runtime/plugin-v1.lock.json").write_text(json.dumps(invalid))
                with self.subTest(field=field), patch.object(integration_matrix.install_support, "ROOT", root):
                    with self.assertRaisesRegex(ValueError, "unrecognized bundled plugin lock"):
                        integration_matrix.sources()

    def test_every_required_boundary_is_exercised(self):
        exercised = {
            boundary
            for entry in self.matrix["combinations"]
            for boundary in entry["boundaries"]
        }
        self.assertLessEqual(REQUIRED_BOUNDARIES, exercised)

    def test_every_maintained_component_appears_in_a_combination(self):
        used = {
            component
            for entry in self.matrix["combinations"]
            for component in entry["components"]
        }
        for component in self.matrix["components"]:
            if component["status"] != "removed":
                with self.subTest(component=component["id"]):
                    self.assertIn(component["id"], used)

    def test_untested_combinations_are_recorded_without_promising_exhaustive_coverage(self):
        self.assertTrue(self.matrix["untested"])
        reasons = " ".join(entry["reason"] for entry in self.matrix["untested"])
        self.assertIn("combinatorially unbounded", reasons)

    def test_declared_versions_and_evidence_are_checked_not_asserted(self):
        for mutate in (
            lambda matrix: matrix["release"].__setitem__("codex", "0.0.0"),
            lambda matrix: matrix["combinations"][0]["evidence"].append("rust:omd/tests/integration.rs::absent"),
            lambda matrix: matrix["combinations"].clear(),
            lambda matrix: matrix["profiles"]["full"]["first_party_installed"].remove("omd_usage"),
            lambda matrix: matrix["first_party_packages"]["omd_usage"].__setitem__("source", "mods/examples/omd_usage"),
            lambda matrix: matrix["launch_cut"]["entries"][0].__setitem__("disposition", "wave_1"),
            lambda matrix: matrix["launch_cut"]["entries"][0].__setitem__("path", "mods/first-party/omd_absent"),
            lambda matrix: matrix["launch_cut"]["entries"].append(
                {"id": "omd_theme", "kind": "mod", "path": "mods/first-party/omd_logo", "disposition": "wave_2"}
            ),
        ):
            drifted = copy.deepcopy(self.matrix)
            mutate(drifted)
            with self.subTest(mutation=mutate):
                self.assertNotEqual(integration_matrix.check(drifted), [])


if __name__ == "__main__":
    unittest.main()
