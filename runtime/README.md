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
worktree and narrower inherited native filesystem permissions; it receives no
provider credentials or tool network access. Checks and a fresh Astra reviewer
inspect the candidate in separate worktrees. Review approval binds its hash.
Integration checks concurrent content and tracked-path changes, applies only the
reviewed delta, and verifies the resulting tree without committing it.

Run the no-provider macOS end-to-end fixture from this repository:

```sh
python3 -m benchmarks.controlled_fixture /path/to/codex/codex-rs/target/debug/codex /private/tmp/omd-fixture-new --scenario runner
```

Other scenarios are `permissions`, `conflict`, `index-conflict`, `review-reject`,
`request-cap`, `revoked`, and `deadline`. Each requires a fresh destination. These
fixtures need loopback listening and native sandbox execution, and use synthetic
responses only. They establish runtime behavior, not model quality or savings.

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
