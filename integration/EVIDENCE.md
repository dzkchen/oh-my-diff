# Inventory and release execution evidence

`mod_conformance.py` and `integration_matrix.py` check source inventories by default.
A source reference can resolve even when its test is disabled, undiscovered, or has
weak assertions. Inventory success is never verified coverage. The recorded results
in the integration matrix are earlier claims, not freshly executed results.

Release qualification adds one or more `--executed-evidence RECEIPT` arguments to the
same commands; `mise run release:evidence RECEIPT...` runs both. Conformance requires every evidence ID
associated with a frozen launch surface. Integration requires every evidence ID in
its combinations and retained regressions. Missing, skipped, failed, uncollected,
or stale evidence fails this gate. It runs only against a clean Git revision.

Create receipts with `scripts/execution_evidence.py`. A bindings JSON object maps existing
evidence IDs to exact JUnit `[classname, name]` pairs, for example:

```json
{"python:test_example": ["tests.test_example.ExampleTests", "test_example"]}
```

Run the actual test runner through the recorder:

```sh
python3 -m scripts.execution_evidence --bindings /path/to/bindings.json \
  --output /path/outside/checkout/execution.json -- /path/to/junit-test-command
mise run release:evidence /path/outside/checkout/execution.json
```

The mise task runs both release checks and accepts multiple receipts. The test command must write JUnit XML to the fresh path supplied in its
`OMD_TEST_EVIDENCE_JUNIT` environment variable. Configure the runner's JUnit reporter
to use that path. No preexisting report is accepted. The command must exit zero,
the checkout must remain clean at the same revision, and each bound test must occur
exactly once in the report and pass without a skip. Missing reports and duplicate
JUnit identities fail. Receipts include the command, commit, complete report, report
hash, and evidence bindings. Store outputs outside the checkout or in an ignored
evidence directory. Preserve receipts with release validation artifacts.

Python's standard unittest runner is supported directly, including skipped tests,
expected failures, and failing subtests:

```sh
python3 -m scripts.execution_evidence --bindings /path/to/python-bindings.json \
  --output /path/to/python-receipt.json -- \
  python3 -m scripts.execution_evidence --unittest tests.test_mod_conformance
```

Node's built-in JUnit reporter includes the source file metadata required by the
validator. Run it through a shell to expand the recorder's fresh report path:

```sh
python3 -m scripts.execution_evidence --bindings /path/to/node-bindings.json \
  --output /path/to/node-receipt.json -- sh -c \
  'node --test --test-reporter=junit --test-reporter-destination="$OMD_TEST_EVIDENCE_JUNIT" mods/runner.test.mjs'
```

For Rust, build the test target in the patched tree for the candidate revision
([`runtime/README.md`](../runtime/README.md)) with
`cargo test -p <crate> --test <target> --no-run` from its `codex-rs` directory.
Use the exact executable emitted by that build. The libtest adapter first lists
that binary's tests, then executes each selected name with `--exact`; absent or
ignored tests cannot produce passing evidence. Its classname is the source path:

```sh
python3 -m scripts.execution_evidence --bindings /path/to/rust-bindings.json \
  --output /path/to/rust-receipt.json -- \
  python3 -m scripts.execution_evidence --libtest /path/to/built-test-binary \
  runtime/omd/tests/examples.rs host_feature_examples_load_and_register_together
```

The build step and recorder belong in the same release harness invocation. For
unit tests added by the patch, supply their `codex-rs/...` source path and full
module-qualified test name. The adapter reports the supplied source association;
the validator checks it against the evidence inventory. Build provenance still
depends on the harness selecting the binary it just built.

For `script:` evidence, use the checker adapter. Bind the reference to
`["script", "scripts/mod_compatibility.py"]`, for example:

```sh
python3 -m scripts.execution_evidence --bindings /path/to/script-bindings.json \
  --output /path/to/script-receipt.json -- \
  python3 -m scripts.execution_evidence --script scripts/mod_compatibility.py
```

This records the actual checker process exit status. Node `.mjs` script suites run
with `node --test` and a fresh JUnit report; empty, skipped, and failed suites cannot
qualify. It proves a checker ran successfully, not that a source lookup
inside that checker establishes behavioral coverage.

Names must match evidence IDs: Python and Node use the test name, Rust allows its
module-qualified suffix, and script checks use the script's repository path as the
JUnit case name. A script's existence alone never qualifies: its runner must execute
the check and report its outcome. Use JUnit reporters that include all collected
tests with explicit skipped, failure, and error elements and a `file` attribute
identifying the repository source. Python bindings must also match the defining
class. Native reporters must map scratch source paths to their repository mirror
(`runtime/omd/tests/...`) or patch source path (`codex-rs/...`); reports without
source metadata fail instead of accepting an unrelated same-name test. For native tests, the
recorded command must build and test the patched tree belonging to this revision;
an unrelated prebuilt binary does not establish source provenance. Configure that
command in the release harness, not in an unaudited hand-written report.

These are local validation receipts, not signed attestations. They establish fresh
reported execution, not the adequacy of assertions or the honesty of a custom
reporter. Behavioral protection still requires review of the assertions and a
regression that fails when the protected behavior is broken. A passing inventory,
or a receipt for an unrelated test, must not be described as that protection.
