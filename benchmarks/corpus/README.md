# Curated task corpus

`catalog.json` pins **88 public-repository bug-fix tasks from 30 repositories**.
`scenarios.json` adds **18 focused scenario contracts**, with initial source,
ordered actions and machine-checkable evidence requirements.

| Gate | Development | Validation | Held-out |
| --- | ---: | ---: | ---: |
| Curated Python repositories | 9 | 9 | 9 |
| External Multi-SWE-bench subset | 20 | 21 | 20 |
| Supplementary focused scenarios | 6 | 6 | 6 |

The external split covers C, C++, Go, Java, JavaScript, TypeScript and Rust in
every split. Each focused split covers diagnostics, graph, memory, browser/bridge,
structural editing and recovery. Focused contracts are curated test designs for
the corresponding features, not claims that those future features have run.

The two release gates have disjoint tasks and repositories. Both draw from the
same pinned public dataset source; they are not claimed to have independent
dataset origins. The repository gate is a deliberately curated Python subset,
not a score for the entire Python benchmark. Report both gates separately and
disclose their selection; never label these subsets as full-suite results.

## Provenance and selection

Source: [Multi-SWE-bench dataset files](https://huggingface.co/datasets/ByteDance-Seed/Multi-SWE-bench/tree/56ff018c04a38e27ada1e9d0a6d5839a51f88f0d),
revision `56ff018c04a38e27ada1e9d0a6d5839a51f88f0d`. The Python inventory is
`python/multi_swe_bench_python.jsonl`; other languages use repository JSONL files.
The [official evaluator](https://github.com/multi-swe-bench/multi-swe-bench/tree/24f493f8a103e72312ded4f6b9c89f081d69cb09)
is pinned at `24f493f8a103e72312ded4f6b9c89f081d69cb09`. Every selected record
retains its base commit, record/problem/gold/test hashes, source-file hash and
expected test-category counts. Gold and test contents are excluded from the
tracked catalog and agent exports.

Repository allocations are explicit in `benchmarks/curate.py`. Tasks are chosen
by fixed SHA-256 ordering, up to three per repository, using metadata validity
filters rather than model results. Serde has only two source records; another
selected repository also contributes two, so external splits are not equal size.
Task validity preserves fail-to-pass, new-to-pass and skip-to-pass categories.
Compilation-repair tasks can legitimately lack separate pass-to-pass entries;
the catalog marks that limitation instead of fabricating regression coverage.

Astropy is development-only because an upstream dataset viewer exposed example
solutions during curation. Serde is development-only because the Phase 1 smoke
inspected its solutions; task `serde-rs/serde#2798` is deliberately included there.
All tasks from a repository/family stay in one split. Validation rejects duplicate
IDs, cross-split repositories/families/base revisions, duplicate solution hashes,
dataset revision drift, exposed holdouts and overlapping release gates.

These checks establish curation integrity, not full environment validity or
unseen model pretraining data. Each task still needs its base/gold/wrong-patch
evaluator validation before a paid pilot. Contributor repository eligibility is
recorded as unverified; curation does not authorize sending repository data.

## Reproduction and export

```sh
python3 -m benchmarks.curate build --output /private/tmp/cai-catalog-rebuilt.json
python3 -m benchmarks.curate validate
python3 -m benchmarks.curate export --task 'serde-rs/serde#2798' --output /private/tmp/cai-task-input.json
```

Build downloads only pinned public JSONL files when absent. Raw records, including
solutions, remain in the private `/private/tmp/cai-curation-private` cache; they
are not printed. Rebuilding from the retained cache reproduces the catalog exactly.
Agent export contains only task ID, repository, base commit, problem statement and
split. Obtain source with a clean export at that base commit, without history,
gold patches or evaluator scripts. `--evaluator` exports the full record for the
trusted evaluator only, with restrictive file permissions.

Held-out export requires `--freeze APPROVAL.json`, binding `catalog_sha256` to the
canonical JSON hash and recording `approved_by: "user"` plus a positive
`held_out_trials`. This is an operator-supplied approval record, not an authenticity
service. No such approval or held-out execution occurred in this task.

`protocol.json` defines three repeats for development and validation, balanced
comparator order, retry accounting, five anchored rubric levels for correctness,
scope and maintainability, independent blinded assessment, disagreement handling
and leakage controls. Held-out trial count, savings/quality thresholds, spending,
latency/resources, assessor identities, uncertainty and retesting remain reserved
for the user-approved pilot freeze. The curation task does not start that pilot.

`benchmarks.scenarios.score_scenario` validates trusted observation records against
each focused contract. Missing evidence fails. Unit tests exercise positive and
missing-observation cases for all contracts; they do not pretend to execute the
future graph, browser, LSP, memory or structural-tool implementations.
