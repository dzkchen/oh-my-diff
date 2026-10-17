import json
import unittest

from scripts import integration_matrix


class IntegrationMatrixTests(unittest.TestCase):
    def test_matrix_matches_the_shipped_sources_and_resolves_its_evidence(self):
        matrix = json.loads(integration_matrix.MATRIX.read_text())
        self.assertEqual(integration_matrix.check(matrix), [])


if __name__ == "__main__":
    unittest.main()
