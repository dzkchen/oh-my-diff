# Controlled delegation primitives

Rust primitives linked by the experimental pinned Codex patch in `runtime/native`.
This crate owns admission and snapshots; the extension owns native execution,
provider observation, review and integration. See [the runtime workflow](../README.md).

`Task` serializes shared and worker request/exposure admission, journals a
reservation before dispatch, retains unknown exposure, and records
raw usage supplied by the host. Worker completion does not refund requests or
unsettled exposure. A fresh task refuses an existing evidence directory; resume
is not implemented. The host must supply conservative per-request reservations,
validate provider usage/rates, bind authorization to the repository and context,
enforce request and process deadlines, and own the evidence directory outside
model-write permissions. The authorization setter is a trusted host API.
Sending must use the one-shot `dispatch` transition, which rechecks live limits
and authorization before marking the request in flight. The callback runs after
releasing the task lock so stop/revocation can proceed. Cancellation of dispatched
requests remains host-owned; admission does not imply remote cancellation.

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
