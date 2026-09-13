# CAI benchmarks

Compare default upstream, configured upstream and CAI with pinned inputs,
cold/reuse trials, request-level costs, latency, isolated checks and blinded
assessments. Reports keep retries and failures, separate evaluation overhead,
and distinguish actual charges, estimates and unknown costs.

Validation so far uses simulated provider responses. Native binaries really run,
but the custom build has no CAI patches and is labeled `unmodified-custom-build`.
No real model quality or CAI performance results are available yet.

## Quick start

Run from the repository root with Python 3.9+; no Python dependencies are required.
Use a fresh output directory for each run.

```sh
python3 -m unittest discover -s tests -v
python3 -m benchmarks.fixture --output /private/tmp/cai-comparison-demo
```

The fixture creates a manifest, schedule, run records, blinded packets, synthetic
assessments and report. It includes 18 checks, six intentional failures and 36
simulated assessments.

For real native processes with a local simulated provider:

```sh
python3 -m benchmarks.native_fixture --upstream /path/to/upstream/codex --custom /path/to/custom/codex --trials 3 --output /private/tmp/cai-native-demo
CAI_NATIVE_TESTS=1 python3 -m unittest discover -s tests -v
```

Native execution requires macOS Seatbelt and the pinned binaries. Native tests
also require loopback access and the cached Docker evaluator image. Tools and
images are never installed automatically.

## Commands

Use `python3 -m benchmarks.<module> --help` for arguments.

| Module | Purpose |
| --- | --- |
| `runner` | Execute a manifest through the gateway, checks and assessors. |
| `compare` | Validate and schedule (`plan`), create assessment packets (`blind`), or replay a `report`. |
| `reconcile` | Apply vetted USD charge exports to a new bundle, preserving original evidence. |
| `native_usage` | Import native JSONL observations; usage alone remains accounting-incomplete. |
| `curate` | Rebuild/validate the corpus and export task inputs. |

## Evaluation rules

- Hash-bind binaries, configurations, tools, source, checks and frozen initial state. Keep default upstream unpatched and justify configured-upstream tuning.
- Run agents in source-only workspaces. Native execution uses an outer Seatbelt profile; checks run separately under Seatbelt or offline Docker. Linux support currently covers evaluation only.
- Count lead/worker requests, retries and cancelled exposure. Unknown costs or incomplete coverage suppress finite cost-per-success claims; local dollar reservations are not invoice guarantees.
- Give distinct assessors the same source/patch/rubric in isolated sessions. Preserve disagreements and failed assessment costs. Patch contents can still reveal authorship cues.
- Require approved provider/data access and budgets for paid runs, and a frozen protocol before held-out evaluation.

The [corpus guide](corpus/README.md) covers 88 pinned tasks and 18 focused scenarios.
The [protocol](corpus/protocol.json) defines splits, repeats, rubrics, leakage
controls and disagreement handling. Final budgets and quality/savings gates
remain part of the pilot freeze.
