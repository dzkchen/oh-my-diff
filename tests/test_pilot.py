import unittest

from benchmarks.pilot import parse_assessment


class PilotTests(unittest.TestCase):
    def response(self, final):
        return {'output':[{'type':'message','content':[{'type':'output_text','text':'A preliminary statement.'}]},{'type':'message','content':[{'type':'output_text','text':final}]}]}

    def test_final_flat_or_nested_review_preserves_scores(self):
        flat='{"correctness":0,"scope":0.25,"maintainability":0,"rationale":"Missing patch"}'
        nested='{"scores":{"correctness":0,"scope":0.25,"maintainability":0},"rationale":"Missing patch"}'
        self.assertEqual(parse_assessment(self.response(flat)),parse_assessment(self.response(nested)))
        self.assertEqual(parse_assessment(self.response(flat))['scores']['scope'],0.25)

    def test_missing_or_unanchored_scores_are_not_salvaged(self):
        for value in ['{}','{"correctness":0,"scope":0.3,"maintainability":0,"rationale":"Bad"}','{"correctness":true,"scope":0,"maintainability":0,"rationale":"Bad"}']:
            with self.assertRaises(ValueError):
                parse_assessment(self.response(value))
