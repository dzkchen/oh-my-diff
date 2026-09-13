import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import urllib.request

from .compare import digest, identity, read, require, write


REVISION = "56ff018c04a38e27ada1e9d0a6d5839a51f88f0d"
BASE_URL = "https://huggingface.co/datasets/ByteDance-Seed/Multi-SWE-bench/resolve/" + REVISION + "/"
SPLITS = ("development", "validation", "held-out")
REPOSITORIES = {
    "python": ["astropy/astropy", "django/django", "scikit-learn/scikit-learn",
               "pytest-dev/pytest", "matplotlib/matplotlib", "sphinx-doc/sphinx",
               "psf/requests", "sympy/sympy", "pydata/xarray"],
    "c": ["facebook/zstd", "jqlang/jq", "ponylang/ponyc"],
    "cpp": ["catchorg/Catch2", "fmtlib/fmt", "nlohmann/json"],
    "go": ["cli/cli", "grpc/grpc-go", "zeromicro/go-zero"],
    "java": ["google/gson", "mockito/mockito", "alibaba/fastjson2"],
    "js": ["axios/axios", "expressjs/express", "iamkun/dayjs"],
    "ts": ["vuejs/core", "mui/material-ui", "darkreader/darkreader"],
    "rust": ["serde-rs/serde", "clap-rs/clap", "BurntSushi/ripgrep"],
}


def safe_task(row, language, source):
    repo = row["org"] + "/" + row["repo"]
    base = row.get("base_commit") or row["base"]["sha"]
    require(len(base) == 40 and all(c in "0123456789abcdef" for c in base), "task base revision missing")
    f2p = row.get("f2p_tests") or row.get("FAIL_TO_PASS")
    p2p = row.get("p2p_tests") or row.get("PASS_TO_PASS")
    if isinstance(f2p, str):
        f2p = json.loads(f2p)
    if isinstance(p2p, str):
        p2p = json.loads(p2p)
    patch = row.get("fix_patch") or row.get("patch")
    tests = row.get("test_patch")
    n2p, s2p = row.get("n2p_tests") or {}, row.get("s2p_tests") or {}
    require(patch and tests and (f2p or n2p or s2p), "task lacks repair expectations or patches")
    return {"id": repo + "#" + str(row["number"]), "repository": repo, "language": language,
            "family": repo.lower(), "source_revision": base, "source": source,
            "record_sha256": identity(row), "problem_sha256": digest((row.get("problem_statement") or row.get("body") or "").encode()),
            "gold_sha256": digest(patch.encode()), "test_patch_sha256": digest(tests.encode()),
            "fail_to_pass_count": len(f2p or {}), "new_to_pass_count": len(n2p), "skip_to_pass_count": len(s2p),
            "pass_to_pass_count": len(p2p or {}),
            "regression_coverage": "explicit pass-to-pass" if p2p else "no explicit pass-to-pass; require base/gold/wrong-patch environment validation",
            "kind": "public-repository-bug-fix", "evaluator": "pinned Multi-SWE-bench task-specific parser and exact test expectations",
            "environment_validation": "required before pilot execution", "provider_data_eligibility": "unverified; per-repository authorization required"}


def catalog(cache, output):
    cache.mkdir(parents=True, exist_ok=True)
    cache.chmod(0o700)
    tasks, sources, rejected = [], {}, []
    for language, repos in REPOSITORIES.items():
        for index, repo in enumerate(repos):
            file = "python/multi_swe_bench_python.jsonl" if language == "python" else language + "/" + repo.replace("/", "__") + "_dataset.jsonl"
            local = cache / file.replace("/", "--")
            if not local.exists():
                local.write_bytes(urllib.request.urlopen(BASE_URL + file, timeout=60).read())
            local.chmod(0o600)
            raw = local.read_bytes()
            source = {"url": BASE_URL + file, "sha256": digest(raw), "revision": REVISION}
            sources[file] = source
            candidates = []
            for line in raw.splitlines():
                row = json.loads(line)
                if row["org"] + "/" + row["repo"] != repo:
                    continue
                try:
                    candidates.append(safe_task(row, language, source))
                except ValueError as error:
                    rejected.append({"id": repo + "#" + str(row["number"]), "reason": str(error)})
            ordered = sorted(candidates, key=lambda t: digest(("cai-curation-v1:" + t["id"]).encode()))
            if repo == "serde-rs/serde":
                ordered.sort(key=lambda t: t["id"] != "serde-rs/serde#2798")
            require(ordered, f"no eligible tasks: {repo}")
            for task in ordered[:3]:
                task.update(split=SPLITS[index % 3], suite="repository" if language == "python" else "external-multi-swe",
                            selection="up to three by fixed SHA-256 ordering after validity filters; Serde 2798 forced to development")
                tasks.append(task)
    result = {"schema": 1, "version": "curation-v1", "status": "curated; confirmatory execution locked until pilot freeze",
              "dataset_revision": REVISION, "evaluator_commit": "24f493f8a103e72312ded4f6b9c89f081d69cb09",
              "tasks": tasks, "sources": sources, "rejected": rejected,
              "exposure_quarantine": {"astropy/astropy": "development only: upstream dataset viewer exposed example gold patches during curation",
                                      "serde-rs/serde": "development only: Phase 1 evaluator inspected base/gold/incorrect patches"},
              "suite_boundary": "repository gate is a curated Python public-repository subset from the pinned dataset; external gate uses seven non-Python languages, with no shared repositories/tasks. Both subsets share their dataset source; independent origin is not claimed.",
              "selection_uses_model_results": False}
    validate(result)
    write(output, result)
    print(json.dumps({"tasks": len(tasks), "suite_split_counts": dict(Counter(t["suite"] + ":" + t["split"] for t in tasks)),
                      "rejected_candidates": len(rejected)}))


def validate(data):
    tasks, ids, families, commits, answers = data["tasks"], set(), {}, {}, {}
    repositories = {}
    for task in tasks:
        require(task["id"] not in ids, "duplicate task")
        ids.add(task["id"])
        require(task["split"] in SPLITS, "invalid split")
        repo = task["repository"].lower()
        require(repo not in repositories or repositories[repo] == task["split"], "repository crosses splits")
        repositories[repo] = task["split"]
        require(task["source"]["revision"] == data["dataset_revision"], "dataset revision drift")
        for key, table in ((task["family"], families), ((task["repository"], task["source_revision"]), commits),
                           (task["gold_sha256"], answers)):
            require(key not in table or table[key] == task["split"], "related tasks or duplicate solutions cross splits")
            table[key] = task["split"]
        if task["repository"] in data["exposure_quarantine"]:
            require(task["split"] == "development", "exposed repository escaped quarantine")
        require(sum(task.get(k, 0) for k in ("fail_to_pass_count", "new_to_pass_count", "skip_to_pass_count")) > 0, "empty checks")
    for suite in ("repository", "external-multi-swe"):
        require({t["split"] for t in tasks if t["suite"] == suite} == set(SPLITS), "suite missing a split")
    repo_sets = [{t["repository"] for t in tasks if t["suite"] == suite} for suite in ("repository", "external-multi-swe")]
    require(not repo_sets[0] & repo_sets[1], "release gates overlap repositories")
    return {"tasks": len(tasks), "families": len(families), "held_out_execution_allowed": False}


def export_task(catalog_path, task_id, cache, output, evaluator=False, freeze=None):
    data = read(catalog_path)
    validate(data)
    task = next(t for t in data["tasks"] if t["id"] == task_id)
    if task["split"] == "held-out":
        require(freeze is not None, "held-out export requires approved freeze")
        approval = read(freeze)
        require(approval.get("held_out_execution_authorized") is not False,
                "held-out execution remains locked by the freeze")
        require(approval["catalog_sha256"] == identity(data) and approval["approved_by"] == "user"
                and type(approval["held_out_trials"]) is int and approval["held_out_trials"] > 0,
                "invalid or stale held-out freeze")
    file = next(file for file, source in data["sources"].items() if source == task["source"])
    raw = (cache / file.replace("/", "--")).read_bytes()
    require(digest(raw) == task["source"]["sha256"], "dataset changed")
    row = next(json.loads(line) for line in raw.splitlines() if identity(json.loads(line)) == task["record_sha256"])
    if evaluator:
        write(output, row)
        output.chmod(0o600)
    else:
        write(output, {"id": task["id"], "repository": task["repository"], "source_revision": task["source_revision"],
                       "problem_statement": row.get("problem_statement") or row.get("body"), "split": task["split"]})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("build", "validate", "export"))
    parser.add_argument("--catalog", type=Path, default=Path("benchmarks/corpus/catalog.json"))
    parser.add_argument("--cache", type=Path, default=Path("/private/tmp/cai-curation-private"))
    parser.add_argument("--output", type=Path)
    parser.add_argument("--task")
    parser.add_argument("--evaluator", action="store_true")
    parser.add_argument("--freeze", type=Path)
    args = parser.parse_args()
    if args.command == "build":
        catalog(args.cache, args.output or args.catalog)
    elif args.command == "validate":
        print(json.dumps(validate(read(args.catalog))))
    else:
        require(args.task and args.output, "export needs --task and --output")
        export_task(args.catalog, args.task, args.cache, args.output, args.evaluator, args.freeze)


if __name__ == "__main__":
    main()
