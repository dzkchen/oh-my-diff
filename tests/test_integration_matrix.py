import copy
import json
import unittest

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

    def test_published_document_matches_the_matrix(self):
        self.assertEqual(
            integration_matrix.DOCUMENT.read_text(),
            integration_matrix.render(self.matrix),
            "INTEGRATION.md is stale; rerun scripts/integration_matrix.py --write",
        )

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
