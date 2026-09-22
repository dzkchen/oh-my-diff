# Controlled Contributor experiment

This experimental patch links the completed Oh My Diff controls into pinned
Codex `rust-v0.155.1`. The custom binary has an explicit upstream-style direct
mode that returns before registering any Oh My Diff task hook:

```sh
OMD_MODE=upstream_direct codex
```

In that mode Codex keeps the pinned upstream task flow. Oh My Diff lead routing,
delegation, escalation, checkpoints, guidance, repository knowledge, graph,
health, semantic LSP policy, review, completion, and presentation hooks remain
off. `/omd` and the compact status line report the effective mode and identify
the executable as the Oh My Diff custom binary; this compatibility/identity UI
does not alter model context, tools, permissions, requests, or task lifecycle.

Explicit enabled mode requires both `OMD_MODE=enabled` and a trusted
`OMD_CONTROLLED_MANIFEST`. For compatibility with earlier experimental launchers,
a manifest without `OMD_MODE` still enables the controlled runtime, while neither
variable selects the behaviorally identical direct-mode compatibility default.
An invalid mode, enabled mode without a manifest, or direct mode with a manifest
fails closed. Disabling Oh My Diff changes behavior inside the custom binary;
restoring upstream means selecting or reinstalling the retained upstream
executable and is a separate operation.

Enabled manifests may select each foundation capability explicitly through the
required boolean fields in `capabilities`: `delegation`, `escalation`,
`checkpoints`, `guidelines`, `repository_knowledge`, `code_graph`, `code_health`,
`semantic_lsp`, `reactive_rules`, `unified_review`, `completion_gate`, `terminal`,
and the default-off `application_bridge`. Older manifests that omit the object retain the legacy all-enabled
behavior. Delegation requires unified review; the completion gate requires both
unified review and checkpoints. Disabling delegation selects direct single-agent
work without disabling unrelated OMD controls. Inactive guideline, knowledge,
LSP, or reactive-rule configuration is rejected instead of being silently
ignored. The exact Phase 8 foundation profiles and supported build matrix are
frozen in
[`lean-v1.lock.json`](lean-v1.lock.json).

Every enabled task runs under exactly one versioned workflow contract, which
owns the second-party calls the task may make and the final review and
completion it requires. The bundled default `reviewed_omd@1` preserves today's
delegation, milestone review, separate final reviewer, and separate adversarial
completion verifier. `solo_evidence@1` is the explicitly selectable alternative:
one authorized lead, no Contributor, child agents, opposite-lead advice, or
escalation, no milestone review, the lead's own final self-review, and
self-verified completion against the same immutable acceptance contract, exact
candidate, current host evidence, and required checks. Its receipts record
`self_reviewed` with `independent_review: false`; the host rejects any receipt
claiming more assurance than the active contract provided.

A manifest without a `workflow` object keeps working: the existing capability
booleans are migrated to a contract with identical behavior. The unreduced
defaults become `reviewed_omd@1`; any reduced combination becomes
`legacy_capabilities@1`, whose requirements and derived assurance label state
exactly what those booleans meant. A manifest may instead carry
`workflow.user_selection`, `workflow.project_selection`,
`workflow.task_selection`, and `workflow.confirmation`. An explicit task
selection outranks a user default, which outranks a project recommendation,
which outranks the bundled default; a project may also record a minimum
assurance floor that fails closed, naming both sides, against a weaker choice.
Any selection weaker than the bundled default needs its exact confirmation
token. `omd-contract list|plan|status|select|require|clear` is the native
selection surface and prints the before/after requirement changes. The active
contract, its provenance, owners, configuration digest, precedence, denials, and
restrictions are written to `workflow-contract.json` beside the other evidence,
bound to the task's acceptance contract and initial candidate. Resume restores
that record; a different requested contract needs an explicit confirmation and
migrates only at a safe boundary after revalidating the candidate, evidence,
checks, workers, allowance, and resume state. Failed activation or migration
retains the prior contract or fails closed.

`application_bridge` requires a canonical external `bridge` policy reference
with its exact SHA-256. The managed launcher registers the prompt-gated bridge
MCP only for that capability. The policy binds adapter, application version,
reproduction, browser origin, exposed state, redaction, event bytes/count,
pending state, and timeout limits. See
[`../bridge/README.md`](../bridge/README.md).

Every enabled task writes `effective-settings.json` and `task-cost.json` to its
external evidence directory. The first records the manifest hash, effective mode,
capability and communication switches, the active workflow contract and its
provenance, active optional sources, routing, limits, and cost-record path. The second retains every raw usage attempt, settled task
charge, retained exposure upper bound, and uncertain request IDs. Deferred
`omd_status` returns both records plus the compact checkpoint during a task.

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

The manifest configures native fallback lead routing and worker context independently.
The first-party TypeScript coordination mod selects fixed `sol`/`astra` or exact
`task_entry` routing and one configured `focused_brief`, `shared_task_packet`, or
`parent_history` worker policy. Rust still admits only a complete configured route,
including its provider and reasoning effort, and assembles the selected bounded
context: a lead-authored brief plus named files from the admitted snapshot, an
immutable host-owned packet bound by SHA256, or the exact parent history plus a
bounded assignment. Missing, disabled, invalid or broken mod decisions retain the
manifest's native `lead_policy` and `context_policy`. `context.json` records both
effective decisions with owner, package digest, configuration digest and generation,
plus content hashes, effective-permission hash, instruction sources, authorization
binding and all selected routes.

The first-party TypeScript recovery mod classifies preserved failures, decides
whether advisory recovery is eligible, selects the bounded opposite-lead advisory
route, and chooses whether a host-detected Contributor outage pauses or requests
the configured opposite lead. The host extracts these decisions before parsing
the native requests and records their host-owned package and source provenance.
Rust continues to capture exact calls and outputs, validate failure classes and
configured routes, enforce permissions and shared limits, own attempts, snapshots,
worker lifecycle and return control, run original-route review, integrate only an
unchanged candidate, clean up interrupted work and require explicit resume. A
disabled, missing, invalid or broken recovery mod retains the native manifest policy.

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

All controlled tasks use one host-owned review ledger. The deferred `omd_review`
tool sends an exact read-only candidate to the configured opposite lead for a
stable milestone, an explicitly named risk, optional every-turn advice, or the
final gate. Reviews consume the existing shared task request, exposure, worker,
and time allowance. Stable keys collapse duplicate findings; findings omitted on
a changed candidate become stale rather than disappearing, and explicit
resolution is bound to the changed candidate. Candidate changes while findings
remain count as repairs, whose total and repository-relative paths are bounded
by the manifest.

The ledger and candidate evidence are persisted outside the conversation and
revalidated on explicit resume. Every-turn advice has its own switch and defaults
off. Final review is never disabled: the host first runs the configured executable
checks in an isolated candidate snapshot, then requires a separate read-only
review with no open or stale findings. Checks and review are bound to the same
candidate hash; later writes invalidate approval. Contributor integration uses
this same ledger and still checks the parent immediately before applying the
reviewed delta. A foreground task cannot complete unless its live workspace is
the final approved candidate.

The deferred `omd_complete` tool adds a distinct adversarial completion gate
after that final review. At task creation the host freezes the short acceptance
contract and its hash. A separate read-only opposite-lead verifier must assess
every criterion and independently challenge missing wiring, test weakening, and
relevant negative cases against the exact final candidate and host-owned
evidence. Missing, stale, duplicated, reworded, or unavailable evidence cannot
complete the task. The compact receipt reports `completed`, `continue`,
`blocked`, or `unverified`; only `completed` permits foreground completion, and
any later failed attempt invalidates the earlier approval.

```json
{
  "review": {
    "every_turn_advice": false,
    "max_cycles": 16,
    "max_findings_per_cycle": 64,
    "max_open_findings": 128,
    "max_repairs": 4,
    "repair_scope": ["src", "tests"]
  },
  "completion": {
    "max_attempts": 8,
    "max_paths_per_challenge": 128,
    "max_requirements": 12,
    "max_requirement_bytes": 512
  }
}
```

Semantic feedback is also disabled unless the manifest names a canonical
external `lsp.preference_store` whose exact `repository_identity` entry is
enabled. The `omd-lsp` operator changes that remembered repository preference
and reports installed server discovery; it never installs a server. Once opted
in, the deferred `omd_lsp` tool starts at most one bounded server session for
each of Rust, TypeScript, JavaScript, Python, and Java. It detects
`rust-analyzer`; `typescript-language-server` or `vtsls`; `pyright-langserver`,
`pylsp`, or `jedi-language-server`; and `jdtls` from the launch `PATH`.

The tool synchronizes complete coherent path batches and resynchronizes open
documents after completed tools. Diagnostics are collected only after a batch
and accepted only when the server supplies the current document version.
Definition, references, edit-only code actions, symbol rename, and file rename
are capability-gated. Every applied workspace edit must match the caller's
complete repository-relative scope and current SHA256 (or an absent destination),
plus any server document version. All files are validated before writes;
individual replacements are atomic and a failed multi-file application rolls
back. Command-bearing code actions, out-of-scope edits, stale versions,
unsupported resource operations, missing servers, and missing capabilities
return an explicit ordinary-tool fallback rather than semantic success.

`intermediate_check` derives non-installing, allowlisted project checks from the
changed languages: Cargo with an existing `Cargo.toml` for Rust, pnpm plus an
existing `tsconfig.json` for TypeScript/JavaScript, installed Pyright/Mypy/Ruff
for Python, and configured Gradle/Maven for Java. Output, duration, workspace
inputs, and processes are bounded. Results are bound to a whole-language input
digest, rechecked after
execution, and cached only while that digest remains exact.

```json
{
  "lsp": {
    "preference_store": "/absolute/host-owned/lsp-preferences.json",
    "limits": {
      "startup_ms": 10000,
      "request_ms": 10000,
      "diagnostic_batch_ms": 150,
      "idle_ms": 60000,
      "max_workspace_files": 20000,
      "max_workspace_bytes": 134217728,
      "max_response_bytes": 4194304,
      "max_edit_files": 128,
      "max_text_edits": 4096,
      "max_check_output_bytes": 1048576,
      "check_timeout_ms": 120000
    }
  }
}
```

```sh
cargo run --locked -p codex-omd --bin omd-lsp -- detect
cargo run --locked -p codex-omd --bin omd-lsp -- preference /absolute/host-owned/lsp-preferences.json owner/repository enabled /absolute/repository
cargo run --locked -p codex-omd --bin omd-lsp -- status /absolute/host-owned/lsp-preferences.json owner/repository
printf '%s' '{"action":"diagnostics","paths":["src/lib.rs"]}' | cargo run --locked -p codex-omd --bin omd-lsp -- adapter /absolute/repository /absolute/host-owned/lsp-preferences.json owner/repository rust
```

The `adapter` command is the native safety boundary used by the bundled
`omd-lsp-adapters` plugin. It accepts one bounded JSON request on stdin, checks
the exact remembered repository opt-in and its canonical-workspace sidecar
binding, admits only a responsive installed server for the selected language,
synchronizes the declared coherent path batch, performs one semantic command,
and terminates the server before return. The sidecar keeps the original
preference schema byte-compatible for older retained runtimes.
It returns `unsupported` with an ordinary-tool fallback for absent servers or
capabilities. The plugin supplies the five language-specific MCP commands and
presentation; native Rust still owns every process, document, edit, permission,
and cleanup invariant described above.

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

Other scenarios are `direct`, `omd-off`, `escalation`, `permissions`, `conflict`,
`index-conflict`, `review-reject`, `request-cap`, `revoked`, `deadline`,
`recursion`, `outage-fallback`, and `client-loss-resume`. Use
`checkpoint` to retain incomplete steering without false completion and
`completion` to exercise the integrated final gate, and `no-progress` to
exercise bounded identical-result detection. `direct` uses an explicit
no-delegation capability profile and validates effective settings plus durable
cost capture; `omd-off` selects upstream direct mode and rejects any OMD tool,
admission ID, worker route, or evidence.

`solo` selects `solo_evidence@1` through `workflow.task_selection` with the
confirmation token taken from `omd-contract plan`, and validates the whole solo
path: one authorized lead editing directly, a final self-review on the lead's own
route, checkpoint acceptance evidence, a self-verified completion gate, and a
receipt labelled `self_reviewed` with `independent_review: false`. `solo-denied`
additionally attempts a child-agent spawn and requires the recorded denial.
`contract-downgrade` starts a reviewed task, loses the client mid-flight, and
attempts to resume onto the weaker contract without a confirmation; the resumed
process must fail and the persisted record must still hold `reviewed_omd@1`. Every
scenario without a `workflow` block exercises legacy-manifest migration and
asserts the contract its capabilities migrate to. Use
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
