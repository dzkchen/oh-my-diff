import unittest
import signal
import time

from benchmarks.qualification import score
from benchmarks.qualification_assess import request_deadline


class QualificationTests(unittest.TestCase):
    def test_assessment_wall_deadline_interrupts_blocking_work_and_restores_handler(self):
        previous=signal.getsignal(signal.SIGALRM)
        start=time.monotonic()
        with self.assertRaisesRegex(TimeoutError,"wall limit"):
            with request_deadline(0.05):
                time.sleep(1)
        self.assertLess(time.monotonic()-start,0.5)
        self.assertEqual(signal.getsignal(signal.SIGALRM),previous)
        self.assertEqual(signal.getitimer(signal.ITIMER_REAL),(0,0))

    def test_official_requests_parser_preserves_dataset_name_normalization(self):
        row={"p2p_tests":["tests/test_utils.py::headers[application/json;", "tests/test_utils.py::path[/value]"],
             "f2p_tests":["tests/test_utils.py::fixed"], "n2p_tests":[], "s2p_tests":[]}
        log='PASSED tests/test_utils.py::headers[application/json; charset=utf8]\nPASSED tests/test_utils.py::path[/a/value]\nPASSED tests/test_utils.py::fixed\n'
        self.assertTrue(score(log,row,"repository")["all_expected_passed"])
        self.assertFalse(score(log.replace("PASSED tests/test_utils.py::fixed", "FAILED tests/test_utils.py::fixed"),row,"repository")["all_expected_passed"])

    def test_nonempty_exact_expectations_and_all_categories_are_required(self):
        row={"p2p_tests":["old"], "f2p_tests":["fixed"], "n2p_tests":["new"], "s2p_tests":["unskipped"]}
        log='\n'.join('test '+name+' ... ok' for name in ('old','fixed','new','unskipped'))
        self.assertTrue(score(log,row,"external-multi-swe")["all_expected_passed"])
        self.assertEqual(score(log.replace('test new ... ok','test new ... FAILED'),row,"external-multi-swe")["missing"],["new"])
        self.assertFalse(score(log,{k:[] for k in row},"external-multi-swe")["all_expected_passed"])
