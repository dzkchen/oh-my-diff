# Workspace files

Use it when a mod reads, lists or changes workspace files, guards a change with expected fingerprints, reacts to
file changes, watches for external edits or freezes the workspace in a snapshot. Running a command against the
workspace is in [Running commands](running-commands.md).

## Workspace reads, transactions, and write observation

`fs.read` grants `workspace.read` and the `workspace_change` event; `fs.write` grants `workspace.transaction`,
`workspace.request_rename` and the `workspace_pre_rename` event (see [Capabilities](capabilities.md#capabilities)).
The host accepts only the current canonical local repository and checks the effective read and write permissions
for every path.

### Workspace reads and transactions

- Reads return UTF-8 text and SHA256 for at most 128 repository-relative paths and 4 MiB.
- A transaction requires an exact `expected` SHA256 or `null` for every affected path, plus bounded `writes` and
  optional `{old,new}` renames.
- A transaction rejects stale files, symlinks, `.git` paths, overlapping moves, and changes outside the declared
  scope.
- Files are replaced atomically one at a time, with a checked rollback after cancellation or a failed multi-file
  operation; an external writer that changes a touched path during rollback causes a visible conflict that needs
  inspection.
- This is not a repository-wide filesystem transaction or a replacement for user approval.

### Workspace list, stat, access, transaction and backup operations

| Operation | What it does |
| --- | --- |
| `workspace.list {path?, recursive?, include_ignored?, max_entries?}` | Returns at most 20,000 readable entries, skipping `.git`, `.omd` and paths the session cannot read. |
| `workspace.stat {paths, hash?}` | Returns `{kind, size, mtime_ms, sha256?}` or `null`. |
| `workspace.check_access {paths, write?}` (experimental) | Verifies up to 128 distinct named paths against the caller's current read or write grant and effective workspace permissions, returning `{paths, write}` on success. |
| `workspace.transaction` | Accepts `writes`, `deletes`, `renames` and `backup: true`, which stores the prior bytes outside the repository and returns a `ResourceRef`. Every path needs an `expected` fingerprint. |
| `workspace.backup {expected}` | Saves up to 256 files (64 MiB) under the same preconditions. |
| `workspace.restore {backup, expected}` | Restores up to 256 files (64 MiB) under the same preconditions. |

- A separate `workspace.check_access` does not reserve permission for a later command; guarded
  `exec.run.required_access` rechecks inside the write operation.
- An `expected` fingerprint is a SHA-256, `{size, mtime_ms}` or `null` for absent.
- Transactions and restores are exclusive per repository within the host.

### `workspace.request_rename`

`workspace.request_rename` captures the source and absent destination, invokes selected `workspace_pre_rename`
subscribers (`{repository, old, new, expected, thread_id}`, in the requesting thread's state scope) before the
move, and accepts one `{status:"ready",expected,writes}` proposal.

- No proposal, an unsupported operation, or an unavailable server yields `{status:"fallback",reason}`.
- Conflicting proposals fail visibly.
- The host checks all expected hashes and effective write permissions, then applies the companion writes and move
  in one checked transaction.
- A subscriber can read additional companion files and use `process.start`, `process.exchange`, `process.status`,
  `process.stop` and `process.which` (no network, under its declared environment and the workflow contract's
  restrictions) before returning its proposal.

The [independent workspace example](../examples/workspace) demonstrates this path without using a language server.

## Workspace changes and watches

This section covers `workspace_change` delivery, write observation and the index scan, and `workspace.watch`.

### `workspace_change` delivery

`workspace_change {repository, source, call_id, changes, status, reason}` is delivered after a tool call changes
readable files (`source: "tool"`, with `call_id`), and after a `workspace.transaction`, `workspace.restore` or
`workspace.integrate` (`"transaction"`) or a writing `exec.run` (`"exec"`) performed by a slash command or
lifecycle callback.

- Host operations inside a tool call are covered by that tool's single notification, and writes made by a
  `workspace_change` callback are not re-announced.
- Command and callback changes are delivered when the originating callback finishes, or at the next turn or tool
  boundary for slash commands.
- If more than 64 unannounced changes accumulate, subscribers receive one `source: "rescan"`, `unavailable`
  notification instead.
- A batch of more than 128 changed paths or 16,000 bytes of path names, or one with a path outside the read scope,
  arrives as `unavailable` with `reason` `workspace_change_batch_limit` or `workspace_change_scope_unavailable`.
- The host scans only while a mod subscribes, is bounded to 20,000 files and 128 MiB, and reports `unavailable`
  instead of partial coverage.

### Write observation and the index scan

Write observation is the `workspace_change` event described under
[`workspace_change` delivery](#workspace_change-delivery), with each changed path's before and after hashes. Only a
selected mod that subscribes to it triggers the index scan.

- The scan follows the repository's `.gitignore`, `.ignore` and `.git/info/exclude` rules and always skips `.git`
  and `.omd`.
- A change outside the thread's effective read scope reports `unavailable` without exposing its path or hash; the
  batch limits are under [`workspace_change` delivery](#workspace_change-delivery).

The independent example also shows a direct transaction for a mod tool.

### `workspace.watch`

`workspace.watch {paths, recursive?, debounce_ms?, include_ignored?, key?, git?}` reports external edits as
`workspace_change` with source `external`.

- At most 16 watches per mod by default (`watches_per_mod` in [Host limits](limits.md#host-limits)).
- A `key` (1-64 bytes) names one watch per mod in this OMD process. Calling again from the same thread with the same
  arguments keeps it; other arguments or another thread replace it without counting against the limit, and changes it
  already queued are still delivered. `workspace.unwatch {key}` (experimental) stops it; `{watch_id}` stops one of the
  mod's watches. Keys require `workspace_watch_key_v1` and are an experimental field.
- Protected paths are always excluded.
- Git-ignored paths are excluded unless `include_ignored` is true.
- `git: true` (`workspace_watch_git_v1`, an experimental field) also reports changes to the repository's Git metadata,
  found from the workspace root upward (linked worktrees, submodules and separate Git directories included): `HEAD`,
  `index`, `packed-refs` and `refs/…`, as paths `.git/HEAD` and so on with `before` and `after` null. Lock files and
  objects are left out. Outside a repository the call fails `watch_git_unavailable`.

Watches end and deliver as described in [Callback delivery](events-and-lifecycle.md#callback-delivery).

## Workspace snapshots

This section covers `workspace.snapshot` and `workspace.fingerprint`.

### Snapshots: `workspace.snapshot`

`workspace.snapshot {agent?, expected?}` requires `fs.read` and returns `{snapshot: ResourceRef,
candidate_sha256}`. It freezes the current tracked and approved-untracked files, or a completed owned agent's
workspace (`agents` is also required). `expected` rejects a changed candidate.

- References are bound to the caller, package source, generation and thread.
- A capture holds at most 128 MiB of file contents and paths (`snapshot_bytes` in the host config can lower it); a
  larger workspace fails with `snapshot size limit`. Turn evidence still identifies such a workspace; its
  `workspace_sha256` is `null` only when a captured path is unreadable.
- Each mod generation and thread holds at most 8 snapshots and 128 MiB, the host at most 32 and 256 MiB; a full host
  evicts the oldest snapshot of the largest holder.
- Identical captures are deduplicated, and the registry clears on owner cleanup or session stop.
- Snapshots do not authorize reading denied paths.
- Reconstructed worktrees retain captured files even when snapshot ignore rules match them.

### `workspace.fingerprint`

`workspace.fingerprint {agent?, expected?}` takes the same arguments and permissions and returns only
`{candidate_sha256}`, the digest `workspace.snapshot` would report. It stores nothing, so use it to check
freshness; it is also available in the `context` event, where `workspace.snapshot` is not.
