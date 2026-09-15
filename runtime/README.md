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

`limits.max_depth` and `limits.max_reassessments` apply across the native tree.
Each supported Sol/Astra descendant is enrolled with its parent and depth before
its first request, and every controlled child uses the same task ledger plus the
tighter `worker_limits`. `recovery` bounds Contributor attempts, the equivalent
failure threshold, and whether the opposite OpenAI lead may take over after a
recorded reassessment. A fallback uses a fresh isolated snapshot and is reviewed
by the original lead route.

`lifecycle.explicit_resume` is absent for a new task. After interruption or
abrupt client loss, a new launcher invocation must supply a nonempty explicit
resume reference against the original evidence directory. The runtime replays
the numbered journal without resetting time, request, or exposure allowances;
retains uncertain requests; rejects changed limits or incomplete evidence;
cleans stale owned scratch; and records live workspace and effective-permission
reconciliation before controlled work continues.

Every controlled manifest also supplies a bounded `checkpoint` contract and a
small `legitimate_wait_tools` allowlist. The host keeps the compact checkpoint in
the external evidence directory and injects it into each lead turn independently
of conversation summaries. `omd_checkpoint` is deferred with the other controlled
tools and accepts only bounded, monotonic progress whose candidate, check, and
acceptance markers resolve to exact host-owned evidence files. Worker ownership,
stopped/completed/consumed results, live workspace/process state, request and
exposure allowance, and unchanged-call decisions are host-derived. Compaction
and explicit restart reconcile live state without advancing the progress version.
Repeated non-wait calls with the same signature and result force one reassessment
and then pause; configured waits remain bounded by the original task deadline.
A foreground completion is recorded only after every acceptance criterion has
evidence, remaining work is empty, and no worker or uncertain request is active.

The optional `guideline_store` manifest field selects a canonical external
operator-owned store. It does not select a checklist variant or activate a
proposal. The separate `omd-guidelines` binary records immutable development
proposals and disjoint validation, and allows a named maintainer to promote an
exact passed version or roll back to the prior selection. A controlled session
freezes the promoted version and proposal hash at startup, injects only that
version below current user/project instructions, and denies worker access to the
store. With the field absent or no promoted version, guidance behavior is
unchanged. See [`runtime/omd/README.md`](omd/README.md) for the operator commands.

The optional `knowledge` manifest object binds a canonical external store to the
exact `repository_identity`, a context byte limit, and an explicit `cold` or
`reuse` state. Cold sessions receive the store generation/revision but no retained
content. Reuse sessions refresh exact source excerpts before startup and inject
only fresh facts plus operator-approved inferred lessons, below current user and
project instructions. The store and retained task evidence are denied to workers
as filesystem paths; only the bounded frozen session snapshot is contributed.
The separate `omd-knowledge` operator handles retention, candidate approval,
inspection, removal, and generation-advancing reset. Omitting the object disables
repository knowledge injection.

The offline `omd-graph` operator builds one schema-versioned JSON code/impact
graph for the patched TUI and a self-contained interactive HTML snapshot. Its
bounded lexical index covers Rust, Python, TypeScript/JavaScript, and Java source
files while skipping hidden, generated, dependency, and build directories. It
records module/symbol/test nodes, local imports, call/test relationships, exact
line-hash evidence, per-file coverage, and explicit `extracted`, `inferred`, or
`unknown` confidence. Syntax-level results do not claim complete runtime impact.

Use `snapshot` to regenerate both outputs after source changes. `validate`,
`html`, `select`, and the TUI reject stale source bytes or newly added/missing
source files. In a controlled session, `/graph` opens the searchable terminal
navigator and adds the selected node plus its bounded neighborhood to the
composer. Set `OMD_GRAPH_SNAPSHOT` to the JSON path, or place it at
`.omd/code-graph.json` under the repository root. The HTML is a local static
file with search, node/confidence filters, source links, a neighborhood view,
and bounded copyable selections; it starts no server and edits no architecture.

The offline `omd-health` operator reuses that graph to bind approved repository
constraints to a versioned source baseline. It checks introduced dependency
boundaries, exact normalized domain-logic duplicates, removed or weakened tests,
and approved test minimums. Its report separates introduced findings, baseline
debt, and unresolved possible boundary matches; each finding states whether all
implicated paths are in the declared repair scope. It writes evidence only,
never repairs source, never runs as a watcher, and emits no health score.

```sh
cargo run --locked -p codex-omd --bin omd-graph -- snapshot /absolute/repository /absolute/repository/.omd/code-graph.json /absolute/repository/.omd/code-graph.html owner/repository REVISION
cargo run --locked -p codex-omd --bin omd-graph -- validate /absolute/repository /absolute/repository/.omd/code-graph.json
cargo run --locked -p codex-omd --bin omd-health -- baseline /absolute/repository constraints.json baseline.json REVISION
cargo run --locked -p codex-omd --bin omd-health -- check /absolute/repository constraints.json baseline.json report.json REVISION
```

```json
{
  "knowledge": {
    "store": "/absolute/host-owned/knowledge",
    "mode": "cold",
    "max_context_bytes": 65536
  }
}
```

The optional `communication` manifest object selects user updates and worker
reports independently. Both switches default to `false`, preserving ordinary
Codex behavior when omitted:

```json
{
  "communication": {
    "concise_user_updates": true,
    "structured_worker_reports": false
  }
}
```

Concise user updates add lead-only guidance for short ordinary-language progress
and final messages while retaining scope, uncertainty, evidence references,
limitations, and any clarification needed for safe progress. Structured worker
reports instead bind implementation, fallback, review, and escalation turns to a
host-validated JSON schema with explicit `status`, `summary`, `scope`,
`uncertainty`, `evidence`, and `required_clarification` fields. A blocked report
must name the clarification, a completed report cannot carry one, and a partial
or blocked implementation is returned to the lead without integration. Each
switch can be enabled alone, together, or neither; neither changes permissions,
accounting, task scope, or the separately selected simplicity guideline.

The optional `reactive_rules` manifest reference selects a canonical external
JSON rule set by exact SHA256. Rules match one exact lead/worker scope,
canonical tool name, and host-observed finish outcome; `completed_host_success`
and `completed_host_failure` are the host tool-result markers, not an inference
about domain-specific output such as a command's exit code. Overlapping matches,
regexes, wildcards, multiline instructions, and unbounded activation counts are
rejected. A match contributes one bounded developer-context message through the
native post-tool hook path and may be reactivated a bounded number of times when
context is rebuilt after compaction. The message carries rule-set version,
source, and hash, remains subordinate to current user/project instructions, and
states that the completed tool's effects were not rolled back. A reaction does
not retry by itself; any follow-up request uses ordinary shared admission and
accounting. Controlled children receive an isolated registry containing only
reactive context/reaction contributors. Omitting the reference preserves
existing behavior. No stream
interruption is installed because this hook path closes the demonstrated
feedback gap without cancelling an in-flight response.

Live task state is bounded independently of manifest values: at most 10,000 task
requests, 128 live workers, 1,024 lifetime worker identities, 256 unchanged-call
entries per progress revision, 128 failures, and 128 failure fingerprints. New
entries fail closed at a ceiling. Progress clears the call cache. Stopped workers
and consumed results move from the compact checkpoint to full append-only
`worker_archived` journal records, including ownership, limits, objective,
request/exposure accounting, terminal status, and result marker. Replay verifies
each archive before removing it from live state, preserves worker-ID reuse
protection, and exposes only active/unconsumed workers plus an archive count in
the checkpoint.

Interactive TTY use is app-like fullscreen by default. The main transcript and
composer remain in the alternate screen, with terminal state restored around
external programs, suspension, caught panics, and exit. Keep inline behavior
with `codex --no-alt-screen` or:

```toml
[tui]
alternate_screen = "never"
```

Controlled sessions show Oh My Diff branding and a compact task/request/
Contributor status. `/omd` opens the on-demand inspector for worker/archive,
allowance/exposure, permission/approval, renderer, mouse, evidence, and current
authorization state; its confirmed revoke action durably blocks future
Contributor requests. Ctrl+T transcript view supports `/` or Ctrl+F search and
`n`/`N` navigation. In fullscreen, left click positions the caret and drag
selection copies on release through Codex's existing clipboard strategies.
Set `OMD_TUI_MOUSE=off` for terminal-native selection. The composer displays
`===`, `->`, and `<=` as width-preserving `≡`, `→`, and `≤` while keeping literal
ASCII for editing, copying, and submission. Set `OMD_TUI_ASCII=1`, or use a
non-Unicode locale, for literal rendering.

Run the no-provider macOS end-to-end fixture from this repository:

```sh
python3 -m benchmarks.controlled_fixture /path/to/codex/codex-rs/target/debug/codex /private/tmp/omd-fixture-new --scenario runner
```

Other scenarios are `direct`, `escalation`, `permissions`, `conflict`,
`index-conflict`, `review-reject`, `request-cap`, `revoked`, `deadline`,
`recursion`, `outage-fallback`, and `client-loss-resume`. Use
`checkpoint` to retain incomplete steering without false completion and
`no-progress` to exercise bounded identical-result detection. Use
`--failure-class environment|edit|diagnosis|model` with `escalation`. Each scenario
requires a fresh destination. These
fixtures need loopback listening and native sandbox execution, and use synthetic
responses only. They establish runtime behavior, not model quality or savings.
The client-loss scenario kills the first client while a request is in-flight,
changes an unrelated tracked file, then explicitly resumes.
Use `--context-policy focused_brief|shared_task_packet|parent_history`,
`--lead-policy fixed|task_entry`, and `--lead sol|astra` to exercise the policy
matrix. Add `--concise-user-updates` or `--structured-worker-reports` to exercise
either communication mode independently. Use `--scenario reactive` for the
exact-match post-tool reaction and shared retry-accounting fixture.

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
on the enclosing runtime deadline; ordinary process groups and background
terminals are cleaned, while intentionally detached out-of-band daemons are not
claimed by the fixture evidence. Integration detects races but is not an atomic
filesystem transaction. Baseline native reviewers
inherit parent write permissions and are instructed to read only; the treatment
adds enforced read-only review. The experiment also checks that its final scored
tree equals the integrated reviewed tree. Included subscription allocation,
missing usage and unexposed development orchestration cost remain unknown, and
cannot support verified total-cost savings. Full upstream regression and paid
experiment results are separate gates recorded in the local audit.
Failure class is a lead-supplied typed claim bound to host-preserved evidence; the
runtime does not infer its semantic correctness. Escalation is advisory recovery,
distinct from bounded outage fallback and explicit lifecycle resume.
