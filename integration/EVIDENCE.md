# Inventory and release execution evidence

- `mod_conformance.py` and `integration_matrix.py` check source inventories only. A resolved reference is not
  verified coverage; recorded matrix results are earlier claims.
- Release qualification: `mise run release:evidence RECEIPT...` (runs both checkers with `--executed-evidence`).
  Conformance needs every evidence ID of a frozen launch surface; integration needs every ID in its combinations and
  retained regressions. Missing, skipped, failed, uncollected or stale evidence fails. Clean Git revision only.

## Receipts

`scripts/execution_evidence.py` records one. Bindings map evidence IDs to exact JUnit `[classname, name]` pairs:

```json
{"python:test_example": ["tests.test_example.ExampleTests", "test_example"]}
```

```sh
python3 -m scripts.execution_evidence --bindings BINDINGS.json --output OUT/execution.json -- JUNIT_TEST_COMMAND
mise run release:evidence OUT/execution.json
```

Rules:

- The command writes JUnit XML to the fresh path in `OMD_TEST_EVIDENCE_JUNIT`; no preexisting report is accepted.
- It must exit 0, the checkout must stay clean at the same revision, and each bound test must appear exactly once and
  pass without a skip. Missing reports and duplicate JUnit identities fail.
- A receipt holds the command, commit, full report, report hash and bindings. Store it outside the checkout (or in
  an ignored directory) and keep it with the release validation artifacts.

## Runners

Python unittest (skips, expected failures and failing subtests supported):

```sh
python3 -m scripts.execution_evidence --bindings PY.json --output py.json -- \
  python3 -m scripts.execution_evidence --unittest tests.test_mod_conformance
```

Node (built-in JUnit reporter carries the source file metadata):

```sh
python3 -m scripts.execution_evidence --bindings NODE.json --output node.json -- sh -c \
  'node --test --test-reporter=junit --test-reporter-destination="$OMD_TEST_EVIDENCE_JUNIT" mods/runner.test.mjs'
```

Rust: build the target in the patched tree for this revision ([`runtime/README.md`](../runtime/README.md)) with
`cargo test -p CRATE --test TARGET --no-run` from `codex-rs`, then pass the exact emitted binary. The adapter lists
its tests and runs each selected name with `--exact`; absent or ignored tests can't pass. Classname is the source
path; patch-added unit tests use their `codex-rs/...` path and module-qualified name. Build and record in the same
harness invocation.

```sh
python3 -m scripts.execution_evidence --bindings RUST.json --output rust.json -- \
  python3 -m scripts.execution_evidence --libtest BUILT_TEST_BINARY \
  runtime/omd/tests/examples.rs host_feature_examples_load_and_register_together
```

`script:` evidence: bind to `["script", "scripts/mod_compatibility.py"]` and run the checker adapter; it records the
checker's exit status. Node `.mjs` script suites run with `node --test` and a fresh JUnit report.

```sh
python3 -m scripts.execution_evidence --bindings SCRIPT.json --output script.json -- \
  python3 -m scripts.execution_evidence --script scripts/mod_compatibility.py
```

## Matching

- Names match evidence IDs: Python and Node use the test name (Python also the defining class), Rust allows its
  module-qualified suffix, scripts use their repository path as the case name.
- Reporters must list every collected test with explicit skipped/failure/error elements and a `file` attribute.
  Native reports map scratch paths to `runtime/omd/tests/...` or `codex-rs/...`; reports without source metadata fail.
- Native commands must build and test this revision's patched tree; an unrelated prebuilt binary proves nothing.

## Limits

Receipts are local, unsigned validation records: they prove fresh reported execution, not that assertions are
adequate or a custom reporter is honest. Behavioral protection still needs reviewed assertions and a regression
that fails when the behavior breaks.
