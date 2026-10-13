import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from scripts import integration_matrix, mod_conformance, execution_evidence as test_evidence


class EvidenceTests(unittest.TestCase):
    def test_inventory_is_not_verified_coverage_and_release_requires_all_claims(self):
        contract = {"decisions": [{"id": "decision", "evidence": ["rust:required"]}],
                    "launch": {"operations:a": {"status": "frozen", "decision": "decision"},
                               "operations:b": {"status": "experimental", "evidence": ["rust:optional"]}}}
        self.assertEqual(mod_conformance.release_evidence(contract), {"rust:required"})
        matrix = {"combinations": [{"evidence": ["node:required"]}],
                  "regression": [{"evidence": ["python:test_required"]}]}
        self.assertEqual(integration_matrix.release_evidence(matrix), {"node:required", "python:test_required"})

    def test_skipped_failed_missing_and_mismatched_tests_cannot_verify_evidence(self):
        binding = {"python:test_required": ["suite", "test_required"]}
        for content in ('<skipped/>', '<failure/>', '<error/>'):
            with self.subTest(content=content), self.assertRaisesRegex(ValueError, "execution evidence requires"):
                test_evidence.validate_bindings(binding, test_evidence.cases(
                    f'<testsuite><testcase classname="suite" name="test_required">{content}</testcase></testsuite>'))
        with self.assertRaisesRegex(ValueError, "not collected"):
            test_evidence.validate_bindings(binding, {("suite", "another_test"): {"status": "passed"}})
        with self.assertRaisesRegex(ValueError, "does not match"):
            test_evidence.validate_bindings({"python:test_required": ["suite", "unrelated"]},
                                            {("suite", "unrelated"): {"status": "passed"}})
        with self.assertRaisesRegex(ValueError, "duplicate"):
            test_evidence.cases('<testsuite><testcase name="a"/><testcase name="a"/></testsuite>')
        with self.assertRaisesRegex(ValueError, "no tests"):
            test_evidence.cases('<testsuite/>')

    def test_runner_binds_fresh_reports_to_clean_revision_and_checks_results(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "repo"
            root.mkdir()
            def git(*args):
                return subprocess.run(["git", "-C", str(root), *args], check=True, capture_output=True)
            git("init")
            (root / "source").write_text("initial\n")
            (root / "tests").mkdir()
            (root / "tests/test_fixture.py").write_text("class Suite:\n    def test_required(self): pass\n")
            (root / "tests/fixture.mjs").write_text("import test from 'node:test'; test('required', () => {});\n")
            git("add", "source", "tests/test_fixture.py", "tests/fixture.mjs")
            git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture")
            output = Path(directory) / "receipt.json"
            node_binding = {"node:tests/fixture.mjs:required": ["test", "required"]}
            test_evidence.record(root, node_binding, ["sh", "-c",
                'node --test --test-reporter=junit --test-reporter-destination="$OMD_TEST_EVIDENCE_JUNIT" tests/fixture.mjs'], output)
            self.assertEqual(test_evidence.verify(node_binding, [output], root), [])
            binding = {"python:test_required": ["tests.test_fixture.Suite", "test_required"]}
            command = [sys.executable, "-c", 'import os; from pathlib import Path; '
                       'Path(os.environ["OMD_TEST_EVIDENCE_JUNIT"]).write_text('
                       '\'<testsuite><testcase classname="tests.test_fixture.Suite" name="test_required" '
                       'file="tests/test_fixture.py"/></testsuite>\')']
            test_evidence.record(root, binding, command, output)
            self.assertEqual(test_evidence.verify(binding, [output], root), [])
            with self.assertRaisesRegex(ValueError, "source file/class"):
                test_evidence.validate_bindings(binding,
                    {("tests.test_fixture.Suite", "test_required"): {"status": "passed", "file": "unrelated.py"}}, root)
            self.assertIn("not collected", test_evidence.verify({"python:missing"}, [output], root)[0])
            receipt = json.loads(output.read_text())
            receipt["junit"] += " "
            output.write_text(json.dumps(receipt))
            self.assertIn("hash mismatch", test_evidence.verify(binding, [output], root)[0])
            test_evidence.record(root, binding, command, output)
            (root / "source").write_text("changed\n")
            self.assertIn("clean checkout", test_evidence.verify(binding, [output], root)[0])
            git("add", "source")
            git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "change")
            self.assertIn("not for the validated revision", test_evidence.verify(binding, [output], root)[0])
            with self.assertRaises(FileNotFoundError):
                test_evidence.record(root, binding, [sys.executable, "-c", "pass"], output)
            self.assertFalse(output.exists())
            with self.assertRaises(subprocess.CalledProcessError):
                test_evidence.record(root, binding, command[:-1] + [command[-1] + '; raise SystemExit(1)'], output)

    def test_unittest_report_records_actual_collection_skips_and_subtest_failures(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            (path / "fixture.py").write_text(
                'import unittest\nclass Example(unittest.TestCase):\n'
                '    def test_pass(self): self.assertTrue(True)\n'
                '    @unittest.skip("optional")\n'
                '    def test_skip(self): pass\n'
                '    def test_fail(self):\n'
                '        with self.subTest(value=1): self.assertEqual(1, 2)\n'
                'class Optional(unittest.TestCase):\n'
                '    @classmethod\n'
                '    def setUpClass(cls): raise unittest.SkipTest("optional suite")\n'
                '    def test_never_runs(self): pass\n')
            report = path / "report.xml"
            result = subprocess.run([sys.executable, str(test_evidence.ROOT / "scripts/execution_evidence.py"),
                                     "--unittest", "fixture"], capture_output=True, text=True,
                                    env={**os.environ, "PYTHONPATH": str(path), "OMD_TEST_EVIDENCE_JUNIT": str(report)})
            self.assertEqual(result.returncode, 1, result.stderr)
            collected = test_evidence.cases(report.read_text())
            self.assertEqual({name: case["status"] for (owner, name), case in collected.items() if owner == "fixture.Example"},
                             {"test_pass": "passed", "test_skip": "skipped", "test_fail": "failed"})
            self.assertEqual(sum(case["status"] == "skipped" for case in collected.values()), 2)

    def test_libtest_adapter_collects_before_execution_and_preserves_ignored_status(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "fixture.rs"
            source.write_text('#[test] fn passed() { assert_eq!(1, 1); }\n'
                              '#[test] #[ignore] fn ignored() { panic!("not executed"); }\n')
            binary = root / "fixture"
            subprocess.run(["rustc", "--test", str(source), "-o", str(binary)], check=True, capture_output=True)
            report = root / "junit.xml"
            result = subprocess.run([sys.executable, str(test_evidence.ROOT / "scripts/execution_evidence.py"),
                                     "--libtest", str(binary), "runtime/omd/tests/fixture.rs", "passed", "ignored", "missing"],
                                    capture_output=True, text=True,
                                    env={**os.environ, "OMD_TEST_EVIDENCE_JUNIT": str(report)})
            self.assertEqual(result.returncode, 1, result.stderr)
            self.assertEqual({name: case["status"] for (_, name), case in test_evidence.cases(report.read_text()).items()},
                             {"passed": "passed", "ignored": "skipped", "missing": "failed"})

    def test_node_script_adapter_rejects_a_successful_exit_with_skipped_tests(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "fixture.mjs").write_text("import test from 'node:test'; test.skip('not run', () => {});\n")
            report = root / "results.xml"
            with patch.object(test_evidence, "ROOT", root), patch.dict(os.environ, {"OMD_TEST_EVIDENCE_JUNIT": str(report)}):
                self.assertEqual(test_evidence.script_report(["fixture.mjs"]), 1)
            collected = test_evidence.cases(report.read_text())
            self.assertEqual(collected[("script", "fixture.mjs")]["status"], "failed")
            (root / "fixture.mjs").write_text("// No tests registered.\n")
            with patch.object(test_evidence, "ROOT", root), patch.dict(os.environ, {"OMD_TEST_EVIDENCE_JUNIT": str(report)}):
                self.assertEqual(test_evidence.script_report(["fixture.mjs"]), 1)


if __name__ == "__main__":
    unittest.main()
