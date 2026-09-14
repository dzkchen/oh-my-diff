# Controlled Contributor experiment

This experimental patch links isolated Contributor delegation into pinned Codex
`rust-v0.154.0`. It is inactive unless the trusted launcher supplies
`OMD_CONTROLLED_MANIFEST`. The ordinary runtime remains the default.

Apply to a clean checkout of the commit in `upstream.lock.json`:

```sh
python3 scripts/normalize_upstream_lock.py /path/to/codex
python3 scripts/apply_runtime_patch.py /path/to/codex
cd /path/to/codex/codex-rs
cargo build --locked -p codex-cli --bin codex
just test -p codex-omd -p codex-omd-extension -p codex-api
```

The patch manifest binds every before/after file hash. Application is idempotent,
rejects modified destinations, and leaves unrelated files and the index alone.
`omd/` contains the admission and snapshot crate. `native/` contains the extension
source; its `request_observer.rs` is installed into `codex-api/src`. The patch also
contains the small API transport, core spawning/execution, login and app-server
hooks needed by the extension. External dependency versions are unchanged.

The host binds the repository grant, models, routes, rates, parent permissions,
request/exposure/time limits and evidence directory before model execution. Each
transport attempt reserves shared capacity before dispatch, records raw usage,
and retains unknown exposure on failure. Contributor receives a fresh isolated
worktree, host-loaded project/user instructions, the inherited execution policy,
and narrower native filesystem permissions; it receives no provider credentials,
MCP servers, recursive extensions, or tool network access. Checks and a fresh
opposite-lead reviewer inspect the candidate in separate worktrees. Review
approval binds its hash.
Integration checks concurrent content and tracked-path changes, applies only the
reviewed delta, and verifies the resulting tree without committing it.

The extension registers `omd_contribute` and `omd_escalate` as deferred tools.
They are absent from the initial model-visible tool set and become available only
through Codex's native task-scoped `tool_search`. The lead can work directly with
ordinary tools, delegate once when the live repository-bound Contributor grant is
valid, or request bounded opposite-lead advice. Escalation requires a typed
`environment`, `edit`, `diagnosis`, or `model` failure and one to eight prior tool
call IDs. The host copies the exact calls and outputs into bounded evidence before
dispatch. Escalation reuses the task's remaining request, exposure, time, and
permission limits; it does not widen access or reset an allowance. The returned
advice does not edit or integrate files, so the original lead retains task ownership.

The manifest configures lead routing and worker context independently. `lead_policy`
is either fixed to `sol` or `astra`, or `task_entry`, which admits the exact configured
model, provider, and reasoning effort selected at task entry. Both lead routes remain
explicit in `leads`; the non-lead route performs final review. `context_policy` selects
one bounded mode: a lead-authored focused brief plus named files from the admitted
snapshot, an immutable host-owned shared task packet bound by SHA256, or the exact
parent history plus a bounded assignment. `context.json` records the selected policy,
content hashes, effective-permission hash, instruction sources, authorization binding,
and all selected routes.

Run the no-provider macOS end-to-end fixture from this repository:

```sh
python3 -m benchmarks.controlled_fixture /path/to/codex/codex-rs/target/debug/codex /private/tmp/omd-fixture-new --scenario runner
```

Other scenarios are `direct`, `escalation`, `permissions`, `conflict`,
`index-conflict`, `review-reject`, `request-cap`, `revoked`, and `deadline`. Use
`--failure-class environment|edit|diagnosis|model` with `escalation`. Each scenario
requires a fresh destination. These
fixtures need loopback listening and native sandbox execution, and use synthetic
responses only. They establish runtime behavior, not model quality or savings.
Use `--context-policy focused_brief|shared_task_packet|parent_history`,
`--lead-policy fixed|task_entry`, and `--lead sol|astra` to exercise the policy
matrix.

Prepare the development experiment using the retained frozen baseline inputs:

```sh
python3 -m benchmarks.controlled_experiment prepare /path/to/frozen-baseline /path/to/patched/codex /path/to/new-experiment
```

Inspect `manifest.json` and `plan.json` before approving paid execution. The plan
binds controllers, inputs, binaries, roles, schedule and pricing assumptions.
The runner requires the approved canonical plan SHA256 and refuses reuse of a
started experiment. Source authorization remains revocable through its original
host-owned grant. Credentials are loaded only by the approved host runner.
Generated evidence, binaries, target directories and runtime scratch are ignored.

This is a bounded macOS development implementation. Host Git setup commands rely
on the enclosing runtime deadline; the core command capture cancels ordinary
process groups, not every possible detached descendant. Integration detects
races but is not an atomic filesystem transaction. Baseline native reviewers
inherit parent write permissions and are instructed to read only; the treatment
adds enforced read-only review. The experiment also checks that its final scored
tree equals the integrated reviewed tree. Included subscription allocation,
missing usage and unexposed development orchestration cost remain unknown, and
cannot support verified total-cost savings. Full upstream regression and paid
experiment results are separate gates recorded in the local audit.
Failure class is a lead-supplied typed claim bound to host-preserved evidence; the
runtime does not infer its semantic correctness. Escalation is advisory recovery,
not the interruption/resume and recursive lifecycle work scheduled for Phase 4.
