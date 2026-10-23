# Commands, files and data

How a mod runs one-shot commands, reads and changes workspace files, and keeps durable data. Use it for `exec.run`,
the `workspace.*` operations, `store.*`, evidence and reactive state, and for the worker and write-observation
operations that build on them.

## One-shot commands: `exec.run`

`exec.run` runs one program in the session's effective sandbox. Its arguments:

```ts
{program, sha256?, argv?, cwd?, env?, stdin?, timeout_ms?, max_output_bytes?, output_artifact?,
write?, network?, unix_sockets?, guards?, required_access?, exclusive_workspace?}
```

### `exclusive_workspace`

`exclusive_workspace` names an absolute writable checkout to lock before guards and until the command exits.

- It requires sandboxed write mode and prior checkout enrollment by this runtime.
- Local sessions hold shared leases for their selected local roots, including inherited and subsequently selected
  roots.
- Removal fails closed when ownership is unavailable or another participating session holds a lease.
- Older runtimes and other applications do not participate; callers must obtain explicit user confirmation that
  those applications are not using a checkout before removing it.
- Exclusive ownership is unavailable on non-Unix hosts and filesystems that cannot report creation identity;
  creation identity prevents an inode reused by a new checkout from inheriting historical enrollment.

### `exec.run` program, working directory and environment

- A bare program name resolves on `PATH` outside the repository. An absolute path must be canonical and outside the
  repository. `sha256` pins the resolved file.
- `cwd` is repository-relative.
- The environment starts empty except `PATH`, a private `HOME`/`TMPDIR`, `TERM=dumb`, locale variables, the
  declared `exec_environment` names and `env` entries limited to those names.
- Commands, buttons and keybindings run `exec.run` without network; `network: "loopback"` there fails with
  `exec_network_unavailable_in_commands`.
- Without `write` the repository is read-only. With `network: "loopback"` only local binding is allowed.
- Cancellation kills the process group and returns `exec_cancelled`.

### `exec.run` limits

| Limit | Default | Maximum |
| --- | --- | --- |
| Timeout | 10 s | 120 s |
| Captured stdout | | 1 MiB |
| Captured stderr | | 1 MiB |
| Returned `stdout` preview | | 64 KiB |
| Returned `stderr` preview | | 16 KiB |
| Concurrent runs per mod | | 4 |

- The host captures at most 1 MiB of stdout and of stderr and reports `stdout_truncated`/`stderr_truncated`.
  `stdout_sha256` and `stdout_bytes` cover the captured stdout.
- The returned `stdout` and `stderr` are previews of at most 64 KiB and 16 KiB so the result fits a callback's
  host-call transport; `stdout_preview_truncated`/`stderr_preview_truncated` report a shortened preview. Use
  `output_artifact` for complete output.
- Output draining shares the command's deadline and cancellation, so a descendant that keeps a pipe open cannot
  hold the call past its timeout.

### `unix_sockets`

`unix_sockets` names up to 4 declared `exec_environment` variables whose host values are Unix sockets the command
may connect to. It needs the `unix_sockets` capability.

- Each value must be an absolute, canonical path outside the repository to an existing socket owned by the current
  user, or the call fails with `exec_socket_unavailable`.
- The mod never supplies the path and no IP network is added.

### `exec.run` with `sandbox: "none"`

With the `os` grant, `sandbox: "none"` runs a program listed in `os_access` without the session sandbox.

- `cwd` may be absolute.
- A program reached through a symlink outside the repository runs as the link, so a version-manager shim such as
  `node` from mise or Volta runs the version it manages.
- The environment is cleared and then holds `PATH`, the real `HOME`, `USER`, `LOGNAME`, `SHELL`, locale, a private
  `TMPDIR`, `TERM=dumb`, the declared `exec_environment` names and `env`. No host credential or Codex variable is
  passed and no secrets API exists.
- Limits, timeouts, cancellation and process-group teardown are unchanged.
- `network`, `unix_sockets`, `guards`, `required_access` and `snapshot` need the sandbox.

The child runs as the user: it can read every user-readable file (including secret files such as `~/.ssh` or
`~/.codex/auth.json`), change mod stores and control files and start processes the host does not supervise. The
host cannot undo its effects; only the OS-separated broker (see [Protected authority
(macOS)](safety.md#protected-authority-macos)) keeps grants, credentials and evidence anchors out of its reach.

### `exec.run` result

```ts
{exit_code, signal, stdout, stdout_sha256, stderr,
stdout_truncated, stderr_truncated, timed_out, duration_ms, program: {path,
sha256}, guards_verified}
```

The digest covers the raw captured stdout bytes.

### `output_artifact` and `exec.output_page`

With `output_artifact: true`, the host accepts complete UTF-8 stdout up to 16 MiB, returns a 4 KiB preview plus
`{reference, sha256}` in `output_artifact`, and reports `stdout_bytes` and `stdout_preview_truncated`. Oversize
output fails without creating an artifact.

`exec.output_page {artifact, cursor?, max_bytes?}` reads at most 16 KiB per call with a byte cursor. The artifact
is bound to the repository, current mod source and thread, hash-checked on reads, and subject to a 64 MiB quota per
binding. This keeps large command output outside mod callback receipts; callers can page it in later callbacks.

### Integration discovery

Integration discovery uses these grants, not a separate API. A mod declares the non-secret variables an integration
sets (for example `HERDR_ENV`, `HERDR_PANE_ID`, `HERDR_BIN_PATH`, `HERDR_SOCKET_PATH`, or `NVIM`) in
`exec_environment` and reads them with `environment.read`, which starts no process.

- Inherited values are untrusted: run a binary named by one only as an absolute `program`, which the host
  canonicalizes, hashes and sandboxes, pin its returned `sha256` for later calls, and pass its socket through
  `unix_sockets`.
- Missing or malformed values leave the integration inert.
- Discovery itself grants neither execution nor socket access.

### `api.assets.read`

`api.assets.read(name)` returns a selected package's UTF-8 entrypoint or declared text asset with its SHA-256. It
reads only the caller's hash-bound package. Installed package caches include declared assets. A mod can supply its
own source to a sandboxed `exec.run` process without relying on a workspace copy.

| Package limit | Value |
| --- | --- |
| Assets declared per package | at most 16 |
| `mod.json` | at most 8 KiB |
| Each other package file | at most 128 KiB (`file_limit` names the file) |
| Entrypoint and declared text together | at most 256 KiB per callback (`package_text_input_limit`) |

A package over the per-callback text limit is refused by inspection, install and `omd-mod-author check`.

### `guards` for live-workspace writes

For a live-workspace write, `guards` may contain up to four read-only command preconditions: `{program, sha256?,
argv?, cwd?, env?, stdout_sha256}`.

- The host runs them without network under its exclusive workspace operation guard and compares their full,
  non-truncated stdout to the expected digest immediately before the write.
- Each guard is limited to 10 s and 1 MiB of output, and its time counts against the write's timeout.
- A failed or changed guard prevents the write.
- Guarded writes cannot target a frozen snapshot.
- Other processes outside the host can still modify the workspace between a guard and the write; commands that
  support their own locking or expected-version options should use them.

### `required_access`

`required_access: {write: [paths]}` checks up to 128 named workspace paths for write permission after the command
guards and before the write, under that same host operation guard. It requires `write: true` and cannot target a
snapshot.

It is intended for commands that mutate metadata on behalf of selected files, such as staging. The command itself
still runs under the effective filesystem sandbox; the host cannot infer which files an arbitrary command
represents.

## Workspace: list, stat, preconditions, backups and changes

### Workspace list, stat, access, transaction and backup operations

| Operation | What it does |
| --- | --- |
| `workspace.list {path?, recursive?, include_ignored?, max_entries?}` | Returns at most 20,000 readable entries, skipping `.git`, `.omd` and paths the session cannot read. |
| `workspace.stat {paths, hash?}` | Returns `{kind, size, mtime_ms, sha256?}` or `null`. |
| `workspace.check_access {paths, write?}` | Verifies up to 128 distinct named paths against the caller's current read or write grant and effective workspace permissions, returning `{paths, write}` on success. |
| `workspace.transaction` | Accepts `writes`, `deletes`, `renames` and `backup: true`, which stores the prior bytes outside the repository and returns a `ResourceRef`. Every path needs an `expected` fingerprint. |
| `workspace.backup {expected}` | Saves up to 256 files (64 MiB) under the same preconditions. |
| `workspace.restore {backup, expected}` | Restores up to 256 files (64 MiB) under the same preconditions. |

- A separate `workspace.check_access` does not reserve permission for a later command; guarded
  `exec.run.required_access` rechecks inside the write operation.
- An `expected` fingerprint is a SHA-256, `{size, mtime_ms}` or `null` for absent.
- Transactions and restores are exclusive per repository within the host.

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
- The host scans only while a mod subscribes, is bounded to 20,000 files and 128 MiB, and reports `unavailable`
  instead of partial coverage.

### Snapshots: `workspace.snapshot`

`workspace.snapshot {agent?, expected?}` requires `fs.read` and returns `{snapshot: ResourceRef,
candidate_sha256}`. It freezes the current tracked and approved-untracked files, or a completed owned agent's
workspace (`agents` is also required). `expected` rejects a changed candidate.

- References are bound to the caller, package source, generation and thread.
- Each mod generation and thread holds at most 8 snapshots and 64 MiB, the host at most 32 and 256 MiB; a full host
  evicts the oldest snapshot of the largest holder.
- Identical captures are deduplicated, and the registry clears on owner cleanup or session stop.
- Snapshots do not authorize reading denied paths.
- Reconstructed worktrees retain captured files even when snapshot ignore rules match them.

### `workspace.fingerprint`

`workspace.fingerprint {agent?, expected?}` takes the same arguments and permissions and returns only
`{candidate_sha256}`, the digest `workspace.snapshot` would report. It stores nothing, so use it to check
freshness; it is also available in the `context` event, where `workspace.snapshot` is not.

### `exec.run` against a snapshot

`exec.run` accepts `snapshot` to run against a private copy of frozen input. Normal command, filesystem and
cancellation permissions still apply. It may create build artifacts, but changing captured source rejects the
result.

- The result includes `candidate_sha256` and host-recorded `evidence`.
- Submit that reference with `receipts.submit {execution: true, ...}` for a `host` producer; the host verifies
  ownership, candidate, reference and outcome.
- A successful receipt requires exit zero, no signal or timeout, and untruncated output.
- Each mod generation and thread holds at most 64 execution records, the host at most 256.
- The record includes the persistent and explicit environment values used by that execution, captured once before
  launch. Secret-like values are represented by hashes rather than plaintext; reproducing those runs requires the
  same secrets.

## Durable data: `store.*` and evidence

### `store.*` operations

`store.get/put/delete/list/export/reset` operate on a per-mod namespace with `repository` (default) or `user`
scope.

- `put` and `delete` require the current `expected_revision` (`null` to create); a stale revision fails.
- `reset` needs the current generation.
- `list` pages 256 keys.
- `export {scope?, cursor?}` pages entries in at most 64 KiB, returning `{schema, owner, scope, generation,
  entries, cursor}`.
- Every record carries host-attested provenance `{mod, source_sha256, thread_id, origin, at}` (`at` is milliseconds
  since the Unix epoch).

| Limit | Value |
| --- | --- |
| Key | at most 256 bytes |
| Value | at most 64 KiB |
| Scope | at most 16 MiB and 4,096 keys |

Outside a session, `omd store export|reset --mod ID [--repo PATH] [--store PATH] [--scope repository|user]` exports
the complete namespace or resets it without running any mod code.

### `evidence.write` and `evidence.read`

`evidence.write {media_type, content, label?}` stores content-addressed evidence and returns a `ResourceRef`;
`evidence.read` reads it back in bounded pages.

### `api.state` compare-and-swap

`api.state` is re-read before every callback and written back with a compare-and-swap. If another process wrote it
meanwhile, the host runs the callback again against the fresh state, within the callback's 5 s budget, answering
its host calls from the results already recorded, so no operation runs twice (the clock stays at the first
attempt's start, so `Date.now()` in arguments replays).

If a retry asks for a different host call, it runs again fresh when every recorded call was read-only; otherwise it
fails with the transient `state_conflict`, because an operation that already ran is never repeated.

### `state_scope` (`state_scopes_v1`)

The location of `api.state` follows the manifest's `state_scope` (`state_scopes_v1`).

- `"store"` (the default) keeps one state of at most 192 KiB in the mod store, shared by every OMD process that
  uses that store.
- `"thread"` keeps one state per session thread and selection scope, so a project copy cannot inherit a same-ID
  user copy's state. It forks with the thread and is removed when the thread is deleted. Routing and compaction
  decisions made while a thread is set up see that thread's state (a fork's copy is made first), and registration
  reads the state of the thread whose callback reloaded the mods (none at process start).
- `"checkout"` keeps one state per checkout, shared by every OMD process working there whatever its mod store: in
  `<git-dir>/omd/state/<mod>.json` for a Git checkout (a linked worktree has its own), read-only to agent commands
  as Codex keeps `.git`. Outside Git, a projectless session, checkout state is unavailable
  (`state_checkout_unavailable`) and nothing is written to the directory.

Mods never run with the home directory or filesystem root as the session directory: the host stays off with a
notice in `/omd`. `omd-mod command STORE MOD NAME JSON [THREAD]` and `omd-mod test STORE SCENARIO [THREAD]` use the
given thread and the checkout of their working directory. A `thread` mod run from `omd-mod command` without `THREAD`
fails with `state_thread_unavailable`; in the TUI, a slash command typed before the session's thread exists runs once
it does. A callback result, including its state, stays within 256 KiB.

### `state_version` migration of thread and checkout state

The `omd-mod migrate` and `rollback` commands act on `"store"` state only.

- Thread and checkout state stored at another `state_version` migrates before the mod's next callback in that
  thread or checkout: the host runs the mod's `migrate` handler (it needs `store`) on it and keeps the previous
  file beside it as `<file>-backup-<sha256>`; until then registration and render reads see `null`.
- A package update that changes the `state_version` of a thread- or checkout-scoped mod with `store` is refused
  (`migration_handler_required`) unless the new version registers `migrate`; an adapter-wrapped package is not
  checked.
- The preview runs no new code: it marks such a package `state_version.handler_required`, and the confirmed apply
  loads it to check.
- Migration handlers can import declared package assets by relative path.

## Reactive state (`reactive_state_v1`)

Reactive state gives a mod typed handles on `api.state` keys and a way to react to their changes.

| Helper | What it is |
| --- | --- |
| `api.atom(key, fallback)` | A typed handle on one top-level key of an object `api.state` (`get`, `set`, `update`). |
| `api.member(key, id, fallback)` | One member of a map-valued key. |
| `api.derive(() => value)` | A memoised selector that recomputes when a key it read changes. |
| `api.subscribe(target, (value, previous) => …)` | Registers during activation and runs once per changed target after the handler that changed it, still inside that callback. |

- Writes go through the same compare-and-swap as `api.state.set`, so a concurrent writer reruns the callback rather
  than losing an update.
- A subscription's host calls and writes commit or rerun with the callback. A cascade stops after 8 rounds, and at
  most 64 subscriptions exist per mod.
- Subscriptions belong to the activation generation, so a reload or disable drops them.
- Render hooks report the keys they read; the host redraws a hooked component only when one of those keys, the
  mod's settings or its source changes, so several wrappers can watch the same state without redrawing the whole
  view on every key.

## Typed worker and workspace operations

`agents.spawn` accepts a host-authorized route and a `workspace` of `read_only` or `isolated_worktree`. A writable
child receives a captured, isolated worktree under the native task scratch area; its parent repository is never its
working directory. A `read_only` child may list `tools` from `exec_command`, `write_stdin`
and `web_search`; any other name fails with `read_only_tool_surface_invalid`.

`agents.wait` and `agents.result` return a host-attested thread reference and SHA256 of the final text. A mod
should validate that text against its declared result schema and source-reference rules before calling
`agents.result` with `consume: true`. The host requires consumption before `workspace.integrate` accepts that mod's
private handle.

The typed-task mod reads the native checkpoint before spawning, passes its bounded objective and revision into each
worker prompt, and reports the revision with the validated batch. It never marks acceptance criteria complete on
behalf of the parent.

### `workspace.integrate`

`workspace.integrate` captures the worker's changed paths, merges against the current parent snapshot, runs the
task's configured executable check on an isolated candidate, and obtains a candidate review before applying the
exact checked delta. It refuses conflicting parent edits, a changed candidate, a failed check or review, or a
changed parent before apply.

- The native ledger owns allowance, permissions, lifecycle, and evidence.
- A failed apply retains diagnostic evidence and may need operator inspection; external concurrent writers are not
  locked.
- Cancellation, a failed tool callback, mod disable or failure, and session stop retire owned handles and clean
  their worktrees; turn end does not.
- Direct mode never loads this mod.

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

### Write observation and the index scan

Write observation is the `workspace_change` event described under [Workspace: list, stat, preconditions, backups
and changes](#workspace-list-stat-preconditions-backups-and-changes), with each changed path's before and after
hashes. Only a selected mod that subscribes to it triggers the index scan.

- The scan follows the repository's `.gitignore`, `.ignore` and `.git/info/exclude` rules and always skips `.git`
  and `.omd`.
- More than 128 changed paths or 16 KB of path names reports `unavailable`, and so does a change outside the
  thread's effective read scope, without exposing its path or hash.

The independent example also shows a direct transaction for a mod tool.

### The experimental `process` capability

The experimental `process` capability grants `process.which`, `process.start`, `process.exchange`,
`process.status`, and `process.stop`. The host resolves an installed executable and its hash, verifies that
identity at launch, and runs it in a read-only repository sandbox with restricted network access and a private
scratch directory.

- The framed JSON exchange has bounded message size, wait, output, and session count.
- Sessions belong to one mod and generation; disable, reload, cancellation, and thread stop clean them up.
- A process cannot write the repository through this API.
- `process.which {names, sandbox: 'none'}` resolves as an unsandboxed `process.start` does (the `os` grant), so a
  version-manager shim returns its link path, not the manager's binary.

The first-party `omd_lsp_sync` mod owns Python, TypeScript/JavaScript, Rust and Java server choices and language
protocol; it is off by default in OMD+ and can be installed in an OMD Core store. It never installs a language
server.

- Definition, references and code-action discovery return bounded read-only results for observed sources.
- Symbol rename and text-only code actions apply with a backup and roll back on failure; actions that run server
  commands are refused.
- Absent or unsupported servers report fallback.

`api.host.tryCall` returns `{ok:true,value}` or `{ok:false,error}` for an expected unavailable operation, so a mod
can report fallback without treating server absence as a callback failure. Both `call` and `tryCall` remain subject
to the same declared capability and host permission checks.

### `process.start` framing

`process.start` frames stdio as `content-length` (default) or `ndjson`, and stops a process whose stdout breaks the
framing (a line that is not JSON under `ndjson`; a blank line or 8 KiB without a valid header under
`content-length`).

- stderr is discarded except under `raw`, which streams both unframed.
- `network: "loopback"` (with the `network` capability) allows local binding while keeping external network access
  restricted.
- `process.start` owns process group termination and starts adapters with a cleared host environment and an
  owner-only scratch directory.
