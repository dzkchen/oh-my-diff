# Controlled delegation primitives

Rust primitives linked by the experimental pinned Codex patch in `runtime/native`.
This crate owns admission and snapshots; the extension owns native execution,
provider observation, review and integration. See [the runtime workflow](../README.md).

`Task` serializes shared and worker request/exposure admission, journals a
reservation before dispatch, retains unknown exposure, and records
raw usage supplied by the host. Worker completion does not refund requests or
unsettled exposure. A fresh task refuses an existing evidence directory. An
explicit resume replays the append-only journal without resetting the original
deadline, requests, exposure, uncertain operations, or completed evidence. The
host must supply conservative per-request reservations,
validate provider usage/rates, bind authorization to the repository and context,
enforce request and process deadlines, and own the evidence directory outside
model-write permissions. The authorization setter is a trusted host API.
Sending must use the one-shot `dispatch` transition, which rechecks live limits
and authorization before marking the request in flight. The callback runs after
releasing the task lock so stop/revocation can proceed. Cancellation of dispatched
requests remains host-owned; admission does not imply remote cancellation.

Checkpointed tasks bind an objective, acceptance criteria, and a bounded
no-progress threshold at creation. They atomically maintain a compact
`checkpoint.json` outside conversational history while retaining the complete
numbered journal. Progress updates preserve completed acceptance evidence,
steering, failed hypotheses, and candidate/check versions; the host derives
worker states and remaining allowance. Reconciliation records prior and current
workspace/process state without pretending it is new progress. Worker results
move through completed and consumed states, while interruption and failed work
remain stopped. Duplicate active objectives are rejected. Repeated equivalent
tool results trigger reassessment and then pause; configured waits remain valid
until the task deadline.

`GuidelineStore` keeps immutable versioned proposals and validation records in a
host-owned directory. A proposal is either a complete checklist of four to
sixteen bounded one-line rules or a tiny core of one to four rules plus one to
twelve selected one-line rules. Proposals accept development evidence only;
validation records accept validation evidence only and reject any task identity
used by the proposal. Neither action activates a candidate.

The `omd-guidelines` operator binary provides `init`, `propose`, `validate`,
`promote`, `rollback`, `active`, and `history` commands. Promotion requires an
exact passed validation hash, a named maintainer and reason, and the expected
currently active selection. Rollback has the same maintainer and stale-state
checks and restores the preceding explicit selection, including no active
guideline. The store begins with no active guideline. When a controlled manifest
explicitly supplies a canonical external `guideline_store`, the native extension
freezes its active selection at session start, protects the store from workers,
and injects the version, proposal hash, and rules below current user and project
instructions. Omitting the field or leaving the store unpromoted preserves the
existing default.

`KnowledgeStore` retains immutable copies of bounded task evidence with task,
workspace, kind, source-path, and hash provenance. Source facts are exact bounded
UTF-8 line excerpts rather than model-authored summaries. Reuse refreshes their
file and excerpt hashes from canonical repository files, records changes, and
excludes missing, unsafe, or unreadable sources. Evidence integrity changes also
invalidate dependent lessons. Inferred lessons begin as candidates and enter a
later session only after an operator records an approval with actor, reason, and
the current store revision.

Every mutation uses an expected-revision compare-and-set under the store's writer
lock, so concurrent writers cannot silently replace one another. `inspect`
returns active records and the revisioned provenance journal. `remove` deletes a
selected record, and `reset` clears all active evidence, facts, and lessons while
advancing the store generation. Each native session must explicitly select
`cold`, which exposes no retained content, or `reuse`, which exposes only fresh
source excerpts and approved lessons. The configured store is external to the
repository, repository-identity bound, context-size bounded, and denied to model
workers.

`CodeGraph` is the bounded, source-backed representation shared by the patched
TUI `/graph` navigator and generated HTML. It recursively indexes supported
source files without following symlinks, fails closed at global file/byte/node/
edge/unknown/selection limits, and produces deterministic JSON for an explicit
repository identity and revision. Every relationship has a source line and hash.
Local imports are extracted; uniquely resolved lexical calls and related tests
are inferred; unresolved imports, calls, and ambiguous targets remain unknown.
Per-file coverage preserves those limitations instead of implying whole-program
analysis.

`omd-graph snapshot` writes the JSON and static HTML together. Subsequent
validation, HTML generation, evidence selection, and TUI loading compare the
recorded source set and hashes with the repository, so added, changed, or missing
source requires regeneration. HTML search/filtering, graph neighborhoods, local
source links, and copyable evidence run entirely in the generated file. The CLI
does not launch a service or provide architecture editing.

`HealthBaseline` and the one-shot `omd-health` operator reuse `CodeGraph` source,
import, symbol, test, confidence, and freshness evidence. A baseline binds an
explicit revision and source digest to the exact SHA256 of a maintainer-approved
constraint version. Dependency rules compare extracted imports with denied path
prefixes and keep unresolved possible matches uncertain. Duplication rules find
exact normalized function-body matches only inside selected domain prefixes and
label the lexical result inferred. Verification rules retain test bodies,
assertion-marker counts, and skip state, then report removed tests, reduced
assertions, newly skipped tests, or approved minimum failures.

Reports keep introduced findings, existing baseline debt, and uncertain findings
in separate arrays. Uncertain-only output does not fail the command. Introduced
non-uncertain findings write the complete report and exit with status 2. Each
finding carries baseline/current source anchors plus either `authorized_scope` or
`requires_authorization`; the operator never edits source. Constraints and source
changes fail closed, and there is no watcher, service, or aggregate repository
health score.

`LspPreferenceStore` records an explicit enabled/disabled decision by repository
identity in a canonical host-owned file. `omd-lsp detect` inspects only the
current `PATH`; `preference` updates one repository revision atomically; and
`status` combines the retained choice with current server availability. The
native extension exposes no semantic tool unless the retained choice is enabled.

`LspSession` implements bounded stdio JSON-RPC without adding an external LSP
dependency. It validates the repository size before startup, opens installed
servers in the canonical workspace, synchronizes whole-document versions after
coherent edits, and retains only diagnostics explicitly bound to the current
version. Startup, requests, diagnostic batching, responses, idle lifetime,
workspace size, edit count, and output are all capped. Servers are terminated
after timeout, idle, task stop, client loss, or extension shutdown.

Navigation and references return the server result. Code actions may apply only
an edit-only action, resolving it first when advertised. Symbol and file renames
apply only after the workspace edit's complete path set equals the caller's
declared scope and each existing or absent path matches the caller's expected
SHA256 state. UTF-16 positions, server document versions, repository containment,
symlinks, overlaps, and resource operations are checked before writing. A failed
cross-file application restores the pre-edit bytes. Unsupported and unverifiable
operations carry a non-success fallback to ordinary search, scoped edits, and
executable checks.

`select_intermediate_checks` derives commands rather than accepting arbitrary
programs. It selects Cargo with an existing manifest, pnpm with an existing
TypeScript config, an installed Python checker, or configured Gradle/Maven;
missing tooling remains explicitly unsupported. The input digest covers relevant
source and project configuration, so the host can skip an identical check and
reject a result if inputs changed
while it ran.

`UnifiedReview` is the bounded state machine shared by stable-milestone,
risk-triggered, optional every-turn, and final review. Each cycle binds its
candidate and executable-check evidence by SHA256. Stable finding fingerprints
collapse repeats within and across reviews; omitted findings on a later candidate
remain stale until explicitly resolved. A final cycle succeeds only for a stable
candidate with current checks, a distinct reviewer, and no open or stale finding.

Candidate changes after findings are repair records. They name the old and new
candidate, affected finding IDs, exact changed paths, and new-candidate evidence;
the configured repair count and path scope fail closed. Any later review or
repair invalidates an older final approval. The native host persists the complete
ledger atomically, reloads and validates its candidate evidence only on explicit
resume, and charges each model review to the original task ledger. Every-turn
advice defaults off independently of the mandatory final review.

```json
{
  "schema": 1,
  "version": "repository-health-v1",
  "repository_identity": "owner/repository",
  "approval": {"actor": "maintainer", "reason": "approved architecture and test boundaries"},
  "dependency_boundaries": [
    {"id": "domain-no-infra", "from_prefix": "src/domain", "denied_to_prefix": "src/infra"}
  ],
  "duplication_scopes": [
    {"id": "domain-logic", "path_prefixes": ["src/domain"], "minimum_logical_lines": 4}
  ],
  "verification": [
    {"id": "domain-tests", "test_path_prefix": "tests/domain", "minimum_tests": 1, "minimum_assertions_per_test": 1}
  ],
  "repair_scope": ["src/domain"],
  "max_findings": 256
}
```

`ReactiveRules` validates a separately versioned, SHA-bound rule source used by
the native post-tool hook. Each rule selects an exact `lead` or `worker` scope,
tool name, and one of `completed_host_success`, `completed_host_failure`,
`blocked`, `failed_before_execution`, `failed_after_execution`, or `aborted`.
Duplicate matches are ambiguous and rejected. `max_activations` is limited to
one through eight, and `max_context_reactivations` to zero through four.
Activation prompts retain source/version/hash provenance and instruction
priority, explicitly deny rollback and automatic-retry claims, and remain
available for bounded context rebuild injection after compaction.

```json
{
  "schema": 1,
  "version": "reactive-v1",
  "rules": [
    {
      "id": "inspect-command-result",
      "scope": "lead",
      "trigger": {
        "event": "tool_finished",
        "tool": "exec_command",
        "outcome": "completed_host_success"
      },
      "instruction": "Inspect the exact command result and exit code before choosing any follow-up.",
      "max_activations": 1,
      "max_context_reactivations": 1
    }
  ]
}
```

```sh
cargo run --locked --manifest-path runtime/omd/Cargo.toml --bin omd-guidelines -- init /absolute/host-owned/guidelines
cargo run --locked --manifest-path runtime/omd/Cargo.toml --bin omd-guidelines -- propose /absolute/host-owned/guidelines proposal.json
cargo run --locked --manifest-path runtime/omd/Cargo.toml --bin omd-guidelines -- validate /absolute/host-owned/guidelines validation.json
cargo run --locked --manifest-path runtime/omd/Cargo.toml --bin omd-guidelines -- promote /absolute/host-owned/guidelines promotion.json
cargo run --locked --manifest-path runtime/omd/Cargo.toml --bin omd-guidelines -- rollback /absolute/host-owned/guidelines rollback.json
```

```sh
cargo run --locked --manifest-path runtime/omd/Cargo.toml --bin omd-knowledge -- init /absolute/host-owned/knowledge owner/repository
cargo run --locked --manifest-path runtime/omd/Cargo.toml --bin omd-knowledge -- retain-evidence /absolute/host-owned/knowledge evidence.json
cargo run --locked --manifest-path runtime/omd/Cargo.toml --bin omd-knowledge -- retain-fact /absolute/host-owned/knowledge /absolute/repository fact.json
cargo run --locked --manifest-path runtime/omd/Cargo.toml --bin omd-knowledge -- propose-lesson /absolute/host-owned/knowledge lesson.json
cargo run --locked --manifest-path runtime/omd/Cargo.toml --bin omd-knowledge -- approve-lesson /absolute/host-owned/knowledge approval.json
cargo run --locked --manifest-path runtime/omd/Cargo.toml --bin omd-knowledge -- inspect /absolute/host-owned/knowledge /absolute/repository
cargo run --locked --manifest-path runtime/omd/Cargo.toml --bin omd-knowledge -- session /absolute/host-owned/knowledge /absolute/repository cold
cargo run --locked --manifest-path runtime/omd/Cargo.toml --bin omd-knowledge -- remove /absolute/host-owned/knowledge removal.json
cargo run --locked --manifest-path runtime/omd/Cargo.toml --bin omd-knowledge -- reset /absolute/host-owned/knowledge reset.json
cargo run --locked --manifest-path runtime/omd/Cargo.toml --bin omd-graph -- snapshot /absolute/repository graph.json graph.html owner/repository REVISION
cargo run --locked --manifest-path runtime/omd/Cargo.toml --bin omd-graph -- select /absolute/repository graph.json NODE_ID
cargo run --locked --manifest-path runtime/omd/Cargo.toml --bin omd-health -- baseline /absolute/repository constraints.json baseline.json REVISION
cargo run --locked --manifest-path runtime/omd/Cargo.toml --bin omd-health -- check /absolute/repository constraints.json baseline.json report.json REVISION
cargo run --locked --manifest-path runtime/omd/Cargo.toml --bin omd-lsp -- detect
cargo run --locked --manifest-path runtime/omd/Cargo.toml --bin omd-lsp -- preference /absolute/host-owned/lsp-preferences.json owner/repository enabled
cargo run --locked --manifest-path runtime/omd/Cargo.toml --bin omd-lsp -- status /absolute/host-owned/lsp-preferences.json owner/repository
```

`record_failure` journals a bounded typed failure with host-owned evidence
references. `permit_escalation` permits each failure at most once, enforces the
task's configured escalation cap, and fails closed after stop, deadline, request
exhaustion, a missing failure, or reuse. It snapshots the remaining allowance
before the caller dispatches through the ordinary shared admission path; it does
not refund or create requests, exposure, or time.

`capture_tracked` enumerates tracked files plus an explicit approved-untracked
list and rejects a changed path set. `Snapshot` reads dirty contents through
directory/file descriptors, revalidates the selected tree, and rejects symlinks
and hardlinks. Materialization also uses descriptor-relative writes. These are
Unix primitives, currently validated on macOS. `create_worktree`
seeds a disposable repository and detached worker worktree; it does not change
the source repository's index or commits. Git commands operate on local data
with global configuration and hooks disabled. Host lifecycle code must bound
and clean up these commands. Worktrees do not provide an OS sandbox.

`merge_candidate` preserves unrelated current changes and rejects affected-file
conflicts. It produces an in-memory candidate only. The host must validate
candidate-bound executable checks and separate-model review, reconcile the final
workspace version, and apply the delta through native permission enforcement.
No integration or review gate is claimed by this primitive.

Local validation uses the pinned installed toolchain and cached dependencies:

```sh
CARGO_TARGET_DIR=/private/tmp/omd-controlled-target cargo +1.95.0 test --offline --locked --manifest-path runtime/omd/Cargo.toml
CARGO_TARGET_DIR=/private/tmp/omd-controlled-target cargo +1.95.0 clippy --offline --locked --manifest-path runtime/omd/Cargo.toml --all-targets -- -D warnings
```
