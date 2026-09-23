import json
from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[1]
PATTERN = re.compile(r"(?i)(?<![a-z0-9])(?:c" + r"ai|cheaper[ _-]?ai)(?![a-z0-9])")
SKIP_PARTS = {".git", "__pycache__", "node_modules", "target"}
SKIP_FILES = {".DS_Store", ".env"}
ALLOWED_LINES = {
    "README.md": ("previously called",),
    ".docs/ROADMAP.md": ("Rename the project throughout", "Rename audit:"),
    "benchmarks/compare.py": ("LEGACY_OMD_ARM",),
    "benchmarks/curate.py": ("FROZEN_SELECTION_SALT",),
    "benchmarks/corpus/freeze.json": ('"c' + 'ai"',),
    "tests/test_controlled.py": ('"C' + 'AI_SUBSCRIPTION_',),
    ".docs/audits/controlled-contributor.md": ("frozen manifest expected `C" + "AI_SUBSCRIPTION_*`",),
}


def main():
    exceptions = {"immutable_evidence": 0, "documented_mapping": 0, "frozen_identifier": 0}
    unexpected = []
    for path in sorted(ROOT.rglob("*")):
        relative = path.relative_to(ROOT)
        name = relative.as_posix()
        if not path.is_file() or SKIP_PARTS.intersection(relative.parts) or path.name in SKIP_FILES:
            continue
        try:
            contents = path.read_text()
        except UnicodeDecodeError:
            continue
        matches = list(PATTERN.finditer(contents))
        path_match = PATTERN.search(name)
        if name.startswith(".docs/audits/evidence/"):
            exceptions["immutable_evidence"] += len(matches) + bool(path_match)
            continue
        allowed = ALLOWED_LINES.get(name, ())
        for line_number, line in enumerate(contents.splitlines(), 1):
            for match in PATTERN.finditer(line):
                if any(marker in line for marker in allowed):
                    category = "frozen_identifier" if name.startswith("benchmarks/") or name == "tests/test_controlled.py" or name == ".docs/audits/controlled-contributor.md" else "documented_mapping"
                    exceptions[category] += 1
                else:
                    unexpected.append({"path": name, "line": line_number, "match": match.group(0)})
        if path_match:
            unexpected.append({"path": name, "line": None, "match": path_match.group(0)})
    result = {"status": "pass" if not unexpected else "fail", "exceptions": exceptions, "unexpected": unexpected}
    print(json.dumps(result, indent=2, sort_keys=True))
    raise SystemExit(bool(unexpected))


if __name__ == "__main__":
    main()
