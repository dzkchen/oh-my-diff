# Workspace files

Use it when a mod reads, lists or changes workspace files, guards a change with expected fingerprints, reacts to
file changes, watches for external edits or freezes the workspace in a snapshot. Running a command against the
workspace is in [Running commands](running-commands.md).

Entries are frozen in Mod API `1.0.0` unless marked experimental (see the
[registry table](stability-and-migration.md#experimental-entries-in-the-registry)).

## Workspace reads, transactions, and write observation

`fs.read` grants `workspace.read` and the `workspace_change` event; `fs.write` grants `workspace.transaction`,
`workspace.request_rename` and the `workspace_pre_rename` event (see [Capabilities](capabilities.md#capabilities)).
These operations work only in the session's current local repository, at its canonical path, and the host checks the
effective read and write permissions for every path.

### Workspace reads and transactions

```text
workspace.read {paths, root?} → {files: {PATH: {text, sha256} | null}}
workspace.transaction {expected, writes?, deletes?, renames?, backup?, root?} → {files: {PATH: sha256 | null}, backup}
```

| Argument | Meaning |
| --- | --- |
| `paths` | At most 128 repository-relative paths |
| `expected` | Maps every affected path to its fingerprint: a SHA-256, `{size, mtime_ms}` or `null` for absent |
| `writes`, `deletes`, `renames` | Paths to write with their text, paths to delete, and `{old, new}` moves |
| `backup` | `true` stores the prior bytes outside the repository and returns them as the `backup` `ResourceRef` |
| `root` | An absolute root from the manifest's [`fs_access`](authority-grants.md#fs_access-manifest-field) instead of the repository; needs `fs.external` |

`root` is also accepted by `workspace.list` and `workspace.stat`.

- Reads return UTF-8 text and SHA256 for at most 128 repository-relative paths and 4 MiB.
- A transaction rejects stale files, symlinks, `.git` paths, overlapping moves, and changes outside the declared
  scope.
- Files are replaced atomically one at a time. After cancellation or a failed multi-file operation, the host rolls
  back with checks.
- If an external writer changes a touched path during rollback, the host reports a visible conflict that needs
  inspection.
- `workspace.transaction` isn't atomic across the repository, and it doesn't replace user approval.

| Error | When |
| --- | --- |
| `workspace_path_scope_invalid` | No paths, more than 128, or a repeated path |
| `workspace_read_permission_denied`, `workspace_write_permission_denied` | The session can't read or write a path |
| `fs_root_invalid` | `root` isn't a string |
| `fs_root_not_granted: ROOT` | `root` isn't one of the mod's `fs_access` roots |
| `fs_root_not_canonical: ROOT` | `root` isn't a canonical directory |
| `fs_root_protected: ROOT` | `root` overlaps the workspace, a mod store, credentials or a protected path |

```ts
const read = api.host.tryCall('workspace.read', { paths: [path] });
```

That call is from [`omd_files`](../first-party/omd_files/index.ts).

### Other workspace operations

| Operation | What it does |
| --- | --- |
| `workspace.list {path?, recursive?, include_ignored?, max_entries?}` | Returns at most 20,000 readable entries, skipping `.git`, `.omd` and paths the session cannot read. |
| `workspace.stat {paths, hash?}` | Returns `{kind, size, mtime_ms, sha256?}` or `null`. |
| `workspace.check_access {paths, write?}` (experimental) | Verifies up to 128 distinct named paths against the caller's current read or write grant and effective workspace permissions, returning `{paths, write}` on success. |
| `workspace.backup {expected}` | Saves up to 256 files (64 MiB) under the same preconditions. |
| `workspace.restore {backup, expected}` | Restores up to 256 files (64 MiB) under the same preconditions. |

- A separate `workspace.check_access` does not reserve permission for a later command; guarded
  `exec.run.required_access` rechecks inside the write operation.
- Transactions and restores are exclusive per repository within the host.

### `workspace.request_rename`

`workspace.request_rename {old, new}` moves a file and lets a subscribed mod add companion edits, such as a language
server's import updates, in the same transaction. It returns `{status: 'renamed', files}` or
`{status: 'fallback', reason}`.

1. The host captures the source and checks that the destination is absent.
2. Before the move, it calls the selected `workspace_pre_rename` subscribers with
   `{repository, old, new, expected, thread_id}`, in the requesting thread's state scope.
3. It accepts one `{status:"ready",expected,writes}` proposal.

- No proposal, an unsupported operation, or an unavailable server yields `{status:"fallback",reason}`.
- Conflicting proposals fail visibly.
- The host checks all expected hashes and effective write permissions, then applies the companion writes and move
  in one checked transaction.
- A subscriber can read additional companion files and use `process.start`, `process.exchange`, `process.status`,
  `process.stop` and `process.which` (no network, under its declared environment and the workflow contract's
  restrictions) before returning its proposal.

The [independent workspace example](../examples/workspace) demonstrates this path without using a language server.
It also shows a direct transaction for a mod tool.

## Workspace changes and watches

A mod learns about file changes from the `workspace_change` event and from `workspace.watch`.

### `workspace_change` delivery

The host delivers `workspace_change {repository, source, call_id, changes, status, reason}` after:

- a tool call changes readable files (`source: "tool"`, with `call_id`);
- a slash command or lifecycle callback runs `workspace.transaction`, `workspace.restore` or `workspace.integrate`
  (`source: "transaction"`);
- a slash command or lifecycle callback runs a writing `exec.run` (`source: "exec"`).

Each change contains the path's before and after hashes.

- Host operations inside a tool call are covered by that tool's single notification, and writes made by a
  `workspace_change` callback are not re-announced.
- Command and callback changes are delivered when the originating callback finishes, or at the next turn or tool
  boundary for slash commands.
- If more than 64 unannounced changes accumulate, subscribers receive one `source: "rescan"`, `unavailable`
  notification instead.
- A batch of more than 128 changed paths or 16,000 bytes of path names, or one with a path outside the read scope,
  arrives as `unavailable` with `reason` `workspace_change_batch_limit` or `workspace_change_scope_unavailable`.
- A change outside the thread's effective read scope reports `unavailable` without exposing its path or hash.
- The host scans the workspace only while a selected mod subscribes. The scan follows the repository's `.gitignore`,
  `.ignore` and `.git/info/exclude` rules and always skips `.git` and `.omd`. It is bounded to 20,000 files and
  128 MiB, and reports `unavailable` instead of partial coverage.

### `workspace.watch`

`workspace.watch {paths, recursive?, debounce_ms?, include_ignored?, key?, git?}` reports external edits as
`workspace_change` with source `external`.

- At most 16 watches per mod by default (`watches_per_mod` in [Host limits](limits.md#host-limits)).
- Protected paths are always excluded.
- Git-ignored paths are excluded unless `include_ignored` is true.

Watches end and deliver as described in [Callback delivery](events-and-lifecycle.md#callback-delivery).

#### Watch keys

A `key` lets a mod find and replace one of its watches instead of adding another. Keys require
`workspace_watch_key_v1` and are an experimental field.

- A `key` (1-64 bytes) names one watch per mod in this OMD process.
- Calling again from the same thread with the same arguments keeps the watch.
- Other arguments or another thread replace it without counting against the limit. Changes it already queued are
  still delivered.
- `workspace.unwatch {key}` (experimental) stops it. `workspace.unwatch {watch_id}` stops one of the mod's watches.

#### Git metadata

`git: true` (`workspace_watch_git_v1`, an experimental field) also reports changes to the repository's Git metadata.

- Changes to `HEAD`, `index`, `packed-refs` and `refs/…` arrive as paths such as `.git/HEAD`, with `before` and
  `after` null. Lock files and objects are left out.
- The host finds the Git directory from the workspace root upward, including linked worktrees and submodules.
- A `.git` file is followed only to a Git directory that proves the link: a worktree's backlink, or a submodule
  directory under an enclosing repository's `.git/modules`.
- Outside a repository, for a `--separate-git-dir` repository, or for a submodule of a linked worktree, the call fails
  with `watch_git_unavailable`.

## Workspace snapshots

`workspace.snapshot` freezes the workspace files and `workspace.fingerprint` identifies them.

### Snapshots: `workspace.snapshot`

`workspace.snapshot {agent?, expected?}` requires `fs.read` and returns `{snapshot: ResourceRef, candidate_sha256}`. It
freezes the current tracked files plus the untracked paths listed in the host config's `approved_untracked`, or a
completed owned agent's workspace (`agents` is also required). `expected` rejects a changed candidate.

- References are bound to the caller, package source, generation and thread.
- A capture contains at most 128 MiB of file contents and paths (`snapshot_bytes` in the host config can lower it).
  A larger workspace fails with `snapshot size limit`, but turn evidence still identifies it. Turn evidence reports
  `workspace_sha256: null` only when a captured path is unreadable.
- Each mod generation and thread keeps at most 8 snapshots and 128 MiB, the host at most 32 and 256 MiB; a full host
  evicts the oldest snapshot of the largest holder.
- Identical captures are deduplicated, and the registry clears on owner cleanup or session stop.
- Snapshots do not authorize reading denied paths.
- Reconstructed worktrees retain captured files even when snapshot ignore rules match them.

### `workspace.fingerprint`

`workspace.fingerprint {agent?, expected?}` takes the same arguments and permissions and returns only
`{candidate_sha256}`, the digest `workspace.snapshot` would report. It stores nothing, so use it to check
freshness; it is also available in the `context` event, where `workspace.snapshot` is not.
