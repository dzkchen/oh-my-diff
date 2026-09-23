# Oh My Diff benchmarks

Compare default upstream, configured upstream and Oh My Diff with pinned inputs,
cold/reuse trials, request-level costs, latency, isolated checks and blinded
assessments. Reports keep retries and failures, separate evaluation overhead,
and distinguish actual charges, estimates and unknown costs.

Validation includes simulated provider fixtures and real upstream development
trials on two pinned tasks. Each upstream arm passed 3/3 Serde and 2/3 Requests
checks. An approved API supplement completed two independent reviews for all
twelve candidates; incomplete original native reviews and disagreements remain
retained. There are no Oh My Diff performance results. The custom fixture build is labeled
`unmodified-custom-build`.

## Quick start

Run from the repository root with Python 3.9+; no Python dependencies are required.
Use a fresh output directory for each run.

```sh
python3 -m unittest discover -s tests -v
python3 -m benchmarks.fixture --output /private/tmp/omd-comparison-demo
```

The fixture creates a manifest, schedule, run records, blinded packets, synthetic
assessments and report. It includes 18 checks, six intentional failures and 36
simulated assessments.

A fixed-model development manifest may set `comparison: "upstream-pilot"` and include
only `default-upstream` and `configured-upstream`. Scheduling balances paired order;
this mode cannot run validation or held-out tasks and makes no Oh My Diff comparison.
Live execution still requires provider/data authorization and validated spending bounds.

For real native processes with a local simulated provider:

```sh
python3 -m benchmarks.native_fixture --upstream /path/to/upstream/codex --custom /path/to/custom/codex --trials 3 --output /private/tmp/omd-native-demo
OMD_NATIVE_TESTS=1 python3 -m unittest discover -s tests -v
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
| `qualification` | Prepare, verify and execute the bounded native subscription development baseline. |
| `qualification_replay` | Recheck every saved development candidate with canonical test inputs, preserving original evidence. |
| `qualification_assess` | Prepare a fixed API assessment supplement; execution requires approval of that exact paid plan. |

## Evaluation rules

- Hash-bind binaries, configurations, tools, source, checks and frozen initial state. Keep default upstream unpatched and justify configured-upstream tuning.
- Run agents in source-only workspaces. Native execution uses an outer Seatbelt profile; checks run separately under Seatbelt or offline Docker. Linux support currently covers evaluation only.
- Count lead/worker requests, retries and cancelled exposure. Unknown costs or incomplete coverage suppress finite cost-per-success claims; local dollar reservations are not invoice guarantees.
- Give distinct assessors the same source/patch/rubric in isolated sessions. Preserve disagreements and failed assessment costs. Patch contents can still reveal authorship cues.
- Require approved provider/data access and budgets for paid runs, and a frozen protocol before held-out evaluation.

The [corpus guide](corpus/README.md) covers 88 pinned tasks and 18 focused scenarios.
The [protocol](corpus/protocol.json) defines splits, repeats, rubrics, leakage
controls and disagreement handling. The approved [freeze](corpus/freeze.json)
sets numerical budgets and quality/savings gates; held-out execution remains locked.

## Bounded upstream pilot

`python3 -m benchmarks.pilot prepare OUTPUT` prepares the pinned Serde development
calibration; `verify OUTPUT/manifest.json` validates its offline exported-source
controls. `run OUTPUT/manifest.json` incurs OpenAI API usage and requires an
approved allowance and data scope. It refuses a second start in the same bundle.
The September 13 pilot retained a failed pair and one symmetric infrastructure
retest; its byte-based context configuration was rejected. See the local pilot
audit for evidence and the approved `corpus/freeze.json` for criteria. Included OpenAI subscription usage is excluded from the USD 15 paid reserve. The subsequent native route is validated for the recorded account and development configuration; each new schedule still requires current quota and allowance checks. Criteria approval does not unlock held-out execution.
Do not use the rejected configuration to qualify held-out performance.

The local `.docs/audits/baseline-qualification.md` contains the later real-task
results, environment repair, evaluator replay, retained assessment failures and
exact reproduction commands. Subscription observations establish token/quota and
latency evidence, not metered API dollar savings. The explicitly approved assessment
supplement completed all 24 reviews for USD 1.5507183 estimated, within its
USD 7.8148875 reservation. It preserves all original assessments and changes no
task candidates. Review conflicts remain unresolved; this completes bounded
baseline evidence and protocol preparation, not a confirmatory quality gate.
