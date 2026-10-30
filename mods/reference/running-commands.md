# Running commands

Use it when a mod runs one program with `exec.run`: its arguments, sandbox and environment, limits, result,
complete-output artifacts, guards and access checks, and runs against a frozen snapshot. Long-lived helper
processes use [Managed processes](managed-processes.md) instead.

## One-shot commands: `exec.run`

`exec.run` runs one program in the session's effective sandbox. Its arguments:

```ts
{program, sha256?, argv?, cwd?, env?, stdin?, timeout_ms?, max_output_bytes?, output_artifact?,
write?, network?, unix_sockets?, snapshot?, guards?, required_access?, exclusive_workspace?, sandbox?}
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
  declared [`exec_environment` names](authority-grants.md#exec_environment-names) and `env` entries limited to
  those names.
- Commands, buttons and keybindings run `exec.run` without network; `network: "loopback"` there fails with
  `exec_network_unavailable_in_commands`.
- Without `write` the repository is read-only. With `network: "loopback"` only local binding is allowed.
- The command starts in its own session without a controlling terminal, so a program that would prompt on
  `/dev/tty` (git credentials, ssh passphrases) fails instead of drawing over the TUI.
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
may connect to. It needs the `unix_sockets` capability (experimental).

- Each value must be an absolute, canonical path outside the repository to an existing socket owned by the current
  user, or the call fails with `exec_socket_unavailable`.
- The mod never supplies the path and no IP network is added.

### `exec.run` with `sandbox: "none"`

With the `os` grant, `sandbox: "none"` runs a program listed in `os_access` without the session sandbox.

- `cwd` may be absolute.
- The first run of a binary asks the user, who can decline (`exec_program_declined`); see [Authority
  grants](authority-grants.md#os_access-manifest-field).
- A program reached through a symlink outside the repository runs as the link, so a version-manager shim such as
  `node` from mise or Volta runs the version it manages.
- The environment is cleared and then holds `PATH`, the real `HOME`, `USER`, `LOGNAME`, `SHELL`, locale,
  `SSH_AUTH_SOCK` (so `ssh` and `git` over SSH can use the user's SSH agent), a private `TMPDIR`, `TERM=dumb`, the
  declared `exec_environment` names and `env`. No other host credential or Codex variable is passed and no secrets
  API exists.
- Limits, timeouts, cancellation and process-group teardown are unchanged.
- `network`, `unix_sockets`, `guards`, `required_access` and `snapshot` need the sandbox.

The child runs as the user: it can read every user-readable file (including secret files such as `~/.ssh` or
`~/.codex/auth.json`), change mod stores and control files and start processes the host does not supervise. The host
cannot undo its effects; only the OS-separated broker (see
[Protected authority (macOS)](protected-authority.md#protected-authority-macos)) keeps grants, credentials and evidence
anchors out of its reach.

### `exec.run` result

```ts
{exit_code, signal, stdout, stdout_sha256, stdout_bytes, output_artifact, stderr,
stdout_truncated, stdout_preview_truncated, stderr_truncated, stderr_preview_truncated,
timed_out, duration_ms, program: {path, sha256}, guards_verified, candidate_sha256?, evidence?}
```

The digest covers the raw captured stdout bytes. `candidate_sha256` and `evidence` are present for a run against a
snapshot ([`exec.run` against a snapshot](#execrun-against-a-snapshot)).

### `output_artifact` and `exec.output_page`

With `output_artifact: true`, the host accepts complete UTF-8 stdout up to 16 MiB, returns a 4 KiB preview plus
`{reference, sha256}` in `output_artifact`, and reports `stdout_bytes` and `stdout_preview_truncated`. Oversize
output fails without creating an artifact.

`exec.output_page {artifact, cursor?, max_bytes?}` (experimental) reads at most 16 KiB per call with a byte cursor. The
artifact is bound to the repository, current mod source and thread, hash-checked on reads, and subject to a 64 MiB quota
per binding. This keeps large command output outside mod callback receipts; callers can page it in later callbacks.

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
| Each other package file | at most 512 KiB (`file_limit` names the file) |
| Entrypoint and declared text together | at most 1 MiB per callback (`package_text_input_limit`) |

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

### `exec.run` against a snapshot

`exec.run` accepts `snapshot` (from [`workspace.snapshot`](workspace-files.md#snapshots-workspacesnapshot)) to run
against a private copy of frozen input. Normal command, filesystem and
cancellation permissions still apply. It may create build artifacts, but changing captured source rejects the
result.

- The result includes `candidate_sha256` and host-recorded `evidence`.
- Submit that reference with [`receipts.submit`](contracts.md#receiptssubmit) `{execution: true, ...}` for a `host`
  producer; the host verifies ownership, candidate, reference and outcome.
- A successful receipt requires exit zero, no signal or timeout, and untruncated output.
- Each mod generation and thread holds at most 64 execution records, the host at most 256.
- The record includes the persistent and explicit environment values used by that execution, captured once before
  launch. Secret-like values are represented by hashes rather than plaintext; reproducing those runs requires the
  same secrets.
