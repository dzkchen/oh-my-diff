#!/usr/bin/env python3
"""Record fresh JUnit execution reports and verify release evidence at a clean revision."""
import argparse
import ast
from functools import cache
import hashlib
import json
import os
import re
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]


def revision(root):
    def git(*args):
        return subprocess.check_output(["git", "-C", str(root), *args], text=True).strip()

    if git("status", "--porcelain", "--untracked-files=normal"):
        raise ValueError("executed release evidence requires a clean checkout")
    return git("rev-parse", "HEAD")


def cases(report):
    tree = ET.fromstring(report)
    result = {}
    for case in tree.iter("testcase"):
        identity = (case.get("classname", ""), case.get("name", ""))
        if not identity[1] or identity in result:
            raise ValueError(f"missing or duplicate JUnit test identity: {identity}")
        status = "passed"
        for tag, value in (("skipped", "skipped"), ("failure", "failed"), ("error", "failed")):
            if case.find(tag) is not None:
                status = value
        if case.get("status") in {"notrun", "disabled", "skipped"}:
            status = "skipped"
        result[identity] = {"status": status, "file": case.get("file", "")}
    if not result:
        raise ValueError("JUnit report collected no tests")
    if any(suite.get("errors", "0") != "0" for suite in tree.iter("testsuite")):
        raise ValueError("JUnit report contains suite errors")
    return result


def source_files(root, reference):
    kind, _, name = reference.partition(":")
    if kind == "python":
        found = {}
        for path in (root / "tests").glob("test_*.py"):
            for node in ast.walk(ast.parse(path.read_text())):
                if isinstance(node, ast.ClassDef) and any(isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef))
                                                         and child.name == name for child in node.body):
                    found.setdefault(path, set()).add(f"tests.{path.stem}.{node.name}")
        return found
    if kind == "patch":
        return dict.fromkeys(patch_functions(root).get(name, ()))
    if kind == "script":
        paths, marker = [root / name], ""
    elif kind == "node":
        file, test = name.split(":", 1) if ":" in name else ("mods/runner.test.mjs", name)
        paths, marker = [root / file] if file.endswith(".mjs") else [], f"test('{test}'"
    elif kind == "rust":
        file, _, function = name.rpartition("::")
        paths = [root / "runtime" / file] if file else (root / "runtime/omd/tests").glob("*.rs")
        marker = f"fn {function}("
    else:
        return {}
    return {path: None for path in paths
            if path.resolve().is_relative_to(root.resolve()) and path.is_file() and marker in path.read_text()}


@cache
def patch_functions(root):
    manifest = json.loads((root / "runtime/patches/manifest.json").read_text())
    functions = {}
    current = None
    for line in (root / manifest["patch"]["path"]).read_text().splitlines():
        if line.startswith("+++ b/"):
            current = root / line[6:]
        elif current and line.startswith("+"):
            for name in re.findall(r"\bfn (\w+)\(", line):
                functions.setdefault(name, []).append(current)
    return functions


@cache
def resolve(reference):
    """Resolve a source inventory reference, without claiming collection or execution."""
    return bool(source_files(ROOT, reference))


def validate_bindings(bindings, collected, root=ROOT):
    root = root.resolve()
    if not isinstance(bindings, dict) or not bindings:
        raise ValueError("evidence bindings must be a nonempty object")
    for reference, identity in bindings.items():
        if not isinstance(identity, list) or len(identity) != 2 or not all(isinstance(part, str) for part in identity):
            raise ValueError(f"{reference}: binding must be [classname, test name]")
        kind, _, name = reference.partition(":")
        expected = name.rsplit("::", 1)[-1] if kind in {"rust", "patch"} else name
        if kind == "node" and ":" in name:
            expected = name.split(":", 1)[1]
        if kind not in {"rust", "patch", "node", "python", "script"} or not expected:
            raise ValueError(f"{reference}: unsupported evidence reference")
        if identity[1] != expected and not (kind in {"rust", "patch"} and identity[1].endswith("::" + expected)):
            raise ValueError(f"{reference}: report test name does not match the evidence ID")
        case = collected.get(tuple(identity), {})
        status = case.get("status", "not collected")
        if status != "passed":
            raise ValueError(f"{reference}: {status}; execution evidence requires a passing, unskipped test")
        sources = source_files(root, reference)
        path = Path(case.get("file", ""))
        if not path.is_absolute():
            path = root / path
        expected_class = sources.get(path)
        if path not in sources or (expected_class and identity[0] not in expected_class):
            raise ValueError(f"{reference}: JUnit source file/class does not match the evidence source")


def record(root, bindings, command, output):
    root = root.resolve()
    before = revision(root)
    output.unlink(missing_ok=True)
    with tempfile.TemporaryDirectory(prefix="omd-test-evidence-") as directory:
        report = Path(directory) / "results.xml"
        environment = {**os.environ, "OMD_TEST_EVIDENCE_JUNIT": str(report)}
        subprocess.run(command, cwd=root, env=environment, check=True)
        raw = report.read_text()
    if revision(root) != before:
        raise ValueError("checkout revision changed during test execution")
    tree = ET.fromstring(raw)
    for case in tree.iter("testcase"):
        path = Path(case.get("file", ""))
        if path.is_absolute() and path.is_relative_to(root):
            case.set("file", str(path.relative_to(root)))
    raw = ET.tostring(tree, encoding="unicode")
    validate_bindings(bindings, cases(raw), root)
    receipt = {"schema": 1, "revision": before, "command": command, "bindings": bindings,
               "junit": raw, "junit_sha256": hashlib.sha256(raw.encode()).hexdigest()}
    output.write_text(json.dumps(receipt, indent=2) + "\n")


def verify(required, receipts, root=ROOT):
    try:
        current = revision(root)
        verified = set()
        for path in receipts:
            receipt = json.loads(Path(path).read_text())
            if receipt.get("schema") != 1 or receipt.get("revision") != current:
                raise ValueError(f"{path}: execution receipt is not for the validated revision {current}")
            raw = receipt["junit"]
            if hashlib.sha256(raw.encode()).hexdigest() != receipt.get("junit_sha256"):
                raise ValueError(f"{path}: execution report hash mismatch")
            validate_bindings(receipt["bindings"], cases(raw), root)
            verified.update(receipt["bindings"])
        return [f"release evidence was not collected and passed at {current}: {reference}"
                for reference in sorted(set(required) - verified)]
    except (ValueError, KeyError, OSError, ET.ParseError, subprocess.CalledProcessError) as error:
        return [str(error)]


def report(argv, description, problems, required, summary):
    parser = argparse.ArgumentParser(description=description)
    parser.add_argument("--executed-evidence", type=Path, action="append", default=[])
    receipts = parser.parse_args(argv).executed_evidence
    if receipts:
        problems = problems + verify(required, receipts)
    if problems:
        raise SystemExit("\n".join(problems))
    print(f"{summary}; " + ("release execution evidence verified" if receipts else "execution coverage not verified"))


def arguments(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bindings", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    if args.command[:1] == ["--"]:
        args.command.pop(0)
    if not args.command:
        parser.error("a JUnit-producing test command is required after --")
    return args


def main():
    if sys.argv[1:2] == ["--script"]:
        raise SystemExit(script_report(sys.argv[2:]))
    if sys.argv[1:2] == ["--libtest"]:
        raise SystemExit(libtest_report(sys.argv[2:]))
    if sys.argv[1:2] == ["--unittest"]:
        raise SystemExit(unittest_report(sys.argv[2:]))
    if sys.argv[1:2] == ["--release"]:
        from scripts import integration_matrix, mod_conformance
        parser = argparse.ArgumentParser(description="Verify all release-critical execution evidence")
        parser.add_argument("receipts", nargs="+", type=Path)
        args = parser.parse_args(sys.argv[2:])
        flags = []
        for receipt in args.receipts:
            flags += ["--executed-evidence", str(receipt)]
        mod_conformance.main(flags)
        integration_matrix.main(flags)
        return
    args = arguments()
    try:
        record(ROOT, json.loads(args.bindings.read_text()), args.command, args.output)
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        raise SystemExit(str(error)) from error
    print(f"recorded passing execution evidence in {args.output}")


def unittest_report(names):
    import inspect

    sys.path.insert(0, str(ROOT))
    tree = ET.Element("testsuite")

    class Result(unittest.TextTestResult):
        current = None

        def case_for(self, test):
            if self.current is test:
                return self.case
            module, _, name = test.id().rpartition(".")
            path = Path(inspect.getfile(type(test))).resolve()
            self.case = ET.SubElement(tree, "testcase", classname=module, name=name, file=str(path))
            self.current = test
            return self.case

        def startTest(self, test):
            super().startTest(test)
            self.case_for(test)

        def addSkip(self, test, reason):
            super().addSkip(test, reason)
            ET.SubElement(self.case_for(test), "skipped", message=reason)

        def addFailure(self, test, err):
            super().addFailure(test, err)
            ET.SubElement(self.case_for(test), "failure", message=str(err[1]))

        def addError(self, test, err):
            super().addError(test, err)
            ET.SubElement(self.case_for(test), "error", message=str(err[1]))

        def addExpectedFailure(self, test, err):
            super().addExpectedFailure(test, err)
            ET.SubElement(self.case_for(test), "skipped", message="expected failure")

        def addUnexpectedSuccess(self, test):
            super().addUnexpectedSuccess(test)
            ET.SubElement(self.case_for(test), "failure", message="unexpected success")

        def addSubTest(self, test, subtest, err):
            super().addSubTest(test, subtest, err)
            if err is not None:
                ET.SubElement(self.case_for(test), "failure", message=str(err[1]))

    result = unittest.TextTestRunner(resultclass=Result).run(unittest.defaultTestLoader.loadTestsFromNames(names))
    ET.ElementTree(tree).write(os.environ["OMD_TEST_EVIDENCE_JUNIT"], encoding="unicode")
    return 0 if result.wasSuccessful() else 1


def libtest_report(argv):
    parser = argparse.ArgumentParser(description="Report selected collected libtest cases as JUnit")
    parser.add_argument("binary", type=Path)
    parser.add_argument("source", help="Repository-relative test source path")
    parser.add_argument("tests", nargs="+")
    args = parser.parse_args(argv)
    binary = str(args.binary.resolve())
    listed = subprocess.check_output([binary, "--list", "--format", "terse"], text=True)
    collected = {line.removesuffix(": test") for line in listed.splitlines() if line.endswith(": test")}
    tree = ET.Element("testsuite")
    success = True
    for name in args.tests:
        case = ET.SubElement(tree, "testcase", classname=args.source, name=name, file=args.source)
        if name not in collected:
            ET.SubElement(case, "error", message="not collected by libtest")
            success = False
            continue
        result = subprocess.run([binary, "--exact", name, "--format", "pretty"], text=True, capture_output=True)
        status = re.search(rf"^test {re.escape(name)} \.\.\. (ok|FAILED|ignored)(?:$|,)", result.stdout, re.M)
        if status and status[1] == "ignored":
            ET.SubElement(case, "skipped", message="ignored by libtest")
        elif result.returncode or not status or status[1] != "ok":
            ET.SubElement(case, "failure", message=result.stdout + result.stderr)
            success = False
    ET.ElementTree(tree).write(os.environ["OMD_TEST_EVIDENCE_JUNIT"], encoding="unicode")
    return 0 if success else 1


def script_report(argv):
    parser = argparse.ArgumentParser(description="Execute a repository checker and report its exit status")
    parser.add_argument("script", type=Path)
    parser.add_argument("args", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    root = ROOT.resolve()
    path = (root / args.script).resolve()
    if not path.is_relative_to(root) or path.suffix not in {".py", ".mjs"} or not path.is_file():
        parser.error("expected a repository Python or Node script")
    tree = ET.Element("testsuite")
    failure = None
    if path.suffix == ".mjs":
        with tempfile.TemporaryDirectory(prefix="omd-node-evidence-") as directory:
            report = Path(directory) / "results.xml"
            result = subprocess.run(["node", "--test", "--test-reporter=junit",
                                     f"--test-reporter-destination={report}", str(path), *args.args], cwd=root)
            try:
                raw = report.read_text()
                collected = cases(raw)
                if not any(name not in {str(path), str(args.script), path.name} for _, name in collected):
                    failure = "Node suite collected no named tests"
                elif any(case["status"] != "passed" for case in collected.values()):
                    failure = "Node suite includes skipped or failed tests"
                tree.extend(ET.fromstring(raw).iter("testcase"))
            except (ValueError, OSError, ET.ParseError) as error:
                failure = str(error)
    else:
        module = ".".join(path.relative_to(root).with_suffix("").parts)
        result = subprocess.run([sys.executable, "-m", module, *args.args], cwd=root)
    source = str(path.relative_to(root))
    case = ET.SubElement(tree, "testcase", classname="script", name=source, file=source)
    if result.returncode or failure:
        ET.SubElement(case, "failure", message=failure or f"checker exited {result.returncode}")
    ET.ElementTree(tree).write(os.environ["OMD_TEST_EVIDENCE_JUNIT"], encoding="unicode")
    return result.returncode or int(failure is not None)


if __name__ == "__main__":
    main()
