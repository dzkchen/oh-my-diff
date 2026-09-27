import argparse
import importlib.util
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "plugins/bundled/oh-my-diff/plugins/omd-artifact-reading/scripts/github_read.py"
spec = importlib.util.spec_from_file_location("github_reader", SOURCE)
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)


def run(output):
    base = "github://octocat/Hello-World/pulls/1"
    records = []
    first = reader.read({"uri": base})
    body = json.loads(first["text"])
    assert first["canonical_url"] == "https://github.com/octocat/Hello-World/pull/1"
    assert body["head_sha"]
    records.append(first)
    for uri in (base + "/files", base + "/comments", base + "/review-comments", "github://octocat/Hello-World/commits/" + body["head_sha"]):
        result = reader.read({"uri": uri})
        assert result["canonical_uri"].startswith(uri)
        assert result["revision"] and result["anchors"]
        records.append(result)
    failures = []
    for request, expected in [({"uri": "github://octocat/Hello-World/issues/1"}, "ambiguous"), ({"uri": base, "expected_revision": "0" * 64}, "revision_changed"), ({"uri": "github://octocat/Hello-World/issues/9999999999"}, "inaccessible_deleted_or_not_authorized")]:
        try:
            reader.read(request)
            raise AssertionError("invalid resource accepted")
        except reader.Unavailable as error:
            assert expected in str(error), str(error)
            failures.append({"request": request, "error": str(error)})
    result = {"status": "pass", "scope": "real public GitHub resources, no credentials; drift is a stale expected revision, deletion/inaccessibility share GitHub 404 semantics, actual concurrent edit and 410 cases use deterministic fixtures", "reads": records, "failures": failures}
    output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"status": "pass", "reads": len(records), "expected_failures": len(failures)}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    run(parser.parse_args().output.resolve())
