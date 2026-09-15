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
