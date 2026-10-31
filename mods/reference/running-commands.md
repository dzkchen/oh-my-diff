# Running commands

Use it when a mod runs one program with `exec.run`: its arguments, sandbox and environment, limits, result,
complete-output artifacts, guards and access checks, and runs against a frozen snapshot. Long-lived helper
processes use [Managed processes](managed-processes.md) instead.

Mod API `1.0.0`: `exec.run` is frozen; `exec.output_page`, `environment.read` and the `unix_sockets` capability are
experimental. Platform: Apple Silicon macOS; `exclusive_workspace` needs a Unix filesystem that reports creation
identity.

## `exec.run`

`exec.run` (capability `exec`) runs one program in the session's effective sandbox and returns when it exits.

```text
exec.run {program, sha256?, argv?, cwd?, env?, stdin?, timeout_ms?, max_output_bytes?, output_artifact?, write?,
          network?, unix_sockets?, snapshot?, guards?, required_access?, exclusive_workspace?, sandbox?}
```

### `exec.run` arguments

| Argument | Meaning |
| --- | --- |
| `program` | A bare name resolved on `PATH`, or a canonical absolute path; see [program and environment](#execrun-program-working-directory-and-environment) |
| `sha256` | Pins the resolved file |
| `argv` | At most 128 arguments and 8,192 bytes, no NUL |
| `cwd` | Repository-relative working directory (absolute with `sandbox: "none"`) |
| `env` | At most 16 entries and 16 KiB, each name a declared `exec_environment` name |
| `stdin` | At most 64 KiB |
| `timeout_ms` | Default 10 s, at most 120 s |
| `max_output_bytes` | Stdout capture, at most 1 MiB (16 MiB with `output_artifact`) |
| `output_artifact` | Keeps complete stdout as an artifact; see [`output_artifact`](#output_artifact-and-execoutput_page) |
| `write` | Makes the repository writable (`fs.write`) |
| `network` | `"none"` (default) or `"loopback"` (`network`) |
| `unix_sockets` | Up to 4 declared names whose values are sockets; see [`unix_sockets`](#unix_sockets) |
| `snapshot` | Runs against a frozen copy; see [against a snapshot](#execrun-against-a-snapshot) |
| `guards` | Up to 4 read-only preconditions for a write; see [`guards`](#guards-for-live-workspace-writes) |
| `required_access` | `{write: [paths]}`; see [`required_access`](#required_access) |
| `exclusive_workspace` | An absolute checkout to lock; see [`exclusive_workspace`](#exclusive_workspace) |
| `sandbox` | `"none"` with the `os` grant; see [`sandbox: "none"`](#execrun-with-sandbox-none) |

### `exec.run` result

```text
{exit_code, signal, stdout, stdout_sha256, stdout_bytes, output_artifact, stderr,
 stdout_truncated, stdout_preview_truncated, stderr_truncated, stderr_preview_truncated,
 timed_out, duration_ms, program: {path, sha256}, guards_verified, candidate_sha256?, evidence?}
```

`stdout_sha256` covers the raw captured stdout bytes. `candidate_sha256` and `evidence` are present for a run against a
snapshot ([`exec.run` against a snapshot](#execrun-against-a-snapshot)).

### `exec.run` errors

| Error | When |
| --- | --- |
| `exec_arguments_invalid` | `argv`, `stdin`, `env` or `unix_sockets` is over its limit, or names an undeclared variable |
| `exec_network_invalid` | `network` is not `"none"` or `"loopback"` |
| `exec_network_unavailable_in_commands` | `network: "loopback"` from a command, button or keybinding |
| `exec_sandbox_invalid` | `sandbox` is not `"none"` |
| `exec_unrestricted_arguments_invalid` | `sandbox: "none"` with `network`, `unix_sockets`, `guards` or `required_access` |
| `exec_access_requires_write` | `required_access` without `write: true` |
| `exec_guards_invalid` | More than 4 guards, guards without `write`, or a malformed guard digest |
| `exec_guard_timeout`, `exec_guard_failed`, `exec_guard_changed` | A guard timed out, failed or printed other output |
| `exec_program_unavailable` | `program` does not resolve |
| `exec_program_changed` | The resolved file does not match `sha256` |
| `exec_program_declined` | The user declined the first unsandboxed run of the program |
| `exec_cwd_invalid`, `exec_cwd_unavailable` | `cwd` is malformed or cannot be opened |
| `exec_socket_unavailable` | A `unix_sockets` value is not a usable socket |
| `exec_concurrency_limit` | The mod already runs 4 commands |
| `exec_output_artifact_limit` | Stdout exceeds the capture limit with `output_artifact: true` |
| `exec_cancelled` | The call was cancelled; the host killed the process group |
| `capability_denied: <capability>` | `write`, `network`, `unix_sockets` or `sandbox: "none"` without its capability |

### `exec.run` example

```ts
const run = api.host.call('exec.run', { program: 'git', argv: ['status', '--porcelain'], timeout_ms: 5000 });
if (run.exit_code !== 0) throw new Error(run.stderr);
```

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

| Limit | Default | With `output_artifact` |
| --- | --- | --- |
| Timeout | 10 s, at most 120 s | unchanged |
| Captured stdout | 1 MiB | 16 MiB |
| Captured stderr | 1 MiB | unchanged |
| Returned `stdout` preview | 64 KiB | 4 KiB |
| Returned `stderr` preview | 16 KiB | unchanged |
| Concurrent runs per mod | 4 | unchanged |

- The host captures at most `max_output_bytes` of stdout (at most 1 MiB, which is also the default, or at most
  16 MiB with `output_artifact`) and 1 MiB of stderr, and reports `stdout_truncated`/`stderr_truncated`.
  `stdout_sha256` and `stdout_bytes` cover the captured stdout.
- The returned `stdout` and `stderr` are previews so the result fits a callback's host-call transport;
  `stdout_preview_truncated`/`stderr_preview_truncated` report a shortened preview. Use `output_artifact` for
  complete output.
- Output draining shares the command's deadline and cancellation, so a descendant that keeps a pipe open cannot
  keep the call running past its timeout.

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
- The environment is cleared and then contains `PATH`, the real `HOME`, `USER`, `LOGNAME`, `SHELL`, locale,
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

### `output_artifact` and `exec.output_page`

With `output_artifact: true`, the host raises the stdout capture to 16 MiB of UTF-8, or to `max_output_bytes` if that
is smaller. The result contains a 4 KiB preview, `{reference, sha256}` in `output_artifact`, `stdout_bytes` and
`stdout_preview_truncated`. Oversize output fails with `exec_output_artifact_limit` without creating an artifact.

`exec.output_page {artifact, cursor?, max_bytes?}` (experimental) reads at most 16 KiB per call with a byte cursor and
returns `{text, cursor, bytes, sha256}`.

The artifact is bound to the repository, the current mod source and the thread. Reads check its hash, and each
repository, source and thread combination has a 64 MiB quota. Large command output stays outside mod callback
receipts, and later callbacks can page it in.

### `exclusive_workspace`

Use `exclusive_workspace` for a command that removes a checkout, so that it fails while another session is using
that checkout. It names an absolute writable checkout. The host locks it before the guards run and keeps the lock
until the command exits.

- It needs sandboxed write mode (`write: true`), and a session of this OMD version must already have enrolled the
  checkout.
- Each local session takes a shared lease on the local roots it selects, including inherited roots and roots it
  selects later.
- Removing a checkout fails closed when its ownership is unavailable or another participating session has a lease on
  it.
- Older OMD versions and other applications don't take part in leasing. Before removing a checkout, get the user's
  explicit confirmation that those applications aren't using it.
- Exclusive ownership is unavailable on non-Unix hosts and on filesystems that can't report creation identity. The
  host uses creation identity so that a new checkout on a reused inode doesn't inherit an older enrollment.

### `guards` for live-workspace writes

For a live-workspace write, `guards` may contain up to four read-only command preconditions: `{program, sha256?,
argv?, cwd?, env?, stdout_sha256}`.

- The host runs them without network, while it holds its per-repository workspace operation lock, and compares their
  full, non-truncated stdout to the expected digest immediately before the write.
- Each guard is limited to 10 s and 1 MiB of output, and its time counts against the write's timeout.
- A failed or changed guard prevents the write.
- Guarded writes cannot target a frozen snapshot.
- Other processes outside the host can still modify the workspace between a guard and the write; commands that
  support their own locking or expected-version options should use them.

### `required_access`

Use `required_access` for commands that change metadata on behalf of selected files, such as staging.

`required_access: {write: [paths]}` checks up to 128 named workspace paths for write permission after the `guards`
commands and before the write, while the host still holds the same workspace operation lock. It requires `write: true`
and cannot target a snapshot. The command itself still runs under the effective filesystem sandbox; the host cannot
infer which files an arbitrary command represents.

### `exec.run` against a snapshot

`exec.run` accepts `snapshot` (from [`workspace.snapshot`](workspace-files.md#snapshots-workspacesnapshot)) to run
against a private copy of frozen input. Normal command, filesystem and
cancellation permissions still apply. It may create build artifacts, but changing captured source rejects the
result.

- The result includes `candidate_sha256` and host-recorded `evidence`.
- Submit that reference with [`receipts.submit`](contracts.md#receiptssubmit) `{execution: true, ...}` for a `host`
  producer; the host verifies ownership, candidate, reference and outcome.
- A successful receipt requires exit zero, no signal or timeout, and untruncated output.
- Each mod generation and thread keeps at most 64 execution records, the host at most 256.
- The record includes the [`environment.set`](authority-grants.md#environmentset) overrides and explicit per-call
  values used by that execution, captured once before
  launch. Secret-like values are represented by hashes rather than plaintext; reproducing those runs requires the
  same secrets.

## See also

- [Use a host integration from a mod](../../docs/mod-authors/use-a-host-integration.md): read the variables an
  integration such as herdr or Neovim sets, then run its binary and socket.
- [Packaging](packaging.md) for package assets that a mod can pass to a sandboxed command.
