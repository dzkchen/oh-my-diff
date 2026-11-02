# Authority grants

Use it when a mod needs authority beyond its sandbox: unsandboxed programs, delegated approvals, HTTP origins,
folders outside the workspace, MCP servers or environment variables. It covers the manifest fields that scope each
grant, the operations they allow and how a grant ends. The capability names are listed in
[Capabilities](capabilities.md#authority-grant-capabilities), with
[who can issue or widen a grant](capabilities.md#who-can-issue-or-widen-a-grant).

Entries are frozen in Mod API `1.0.0` unless marked experimental (see the
[registry table](stability-and-migration.md#experimental-entries-in-the-registry)). Runs on Apple Silicon macOS.

## Which capabilities are authority grants

An authority grant is a capability whose scope the manifest declares and the trust digest binds, so changed content
or a wider scope needs a new trust. The authority grants are `os`, `approve`, `approve.override`, `http`,
`fs.external`, `mcp`, `policy`, `peers`, `power`, `autonomous`, `history_write` and `history_persist`. Of these,
`approve.override`, `fs.external`, `mcp`, `peers`, `power`, `autonomous` and `history_write` are experimental.

## Unrestricted processes and delegated approvals

`os` lets a mod run the programs its manifest lists outside the sandbox, and `approve` lets it answer approval
requests for the user.

### `os_access` manifest field

`os_access: {programs, network?}` lists up to 32 programs that may run without the sandbox. `network` sets whether
those runs have external network access.

Requires the `os` and `exec` capabilities. `os` without `os_access`, or the reverse, fails with `invalid_os_access`.

- A program is `*`, a bare name resolved on `PATH` outside the repository, or an absolute path.
- A program inside the repository runs only when its absolute path is listed.
- With `network: false`, unsandboxed runs use a profile that denies IP networking only.
- Every unsandboxed `exec.run`, `process.start` and `terminal.pty` start asks once per mod and binary ("Run NAME for
  mod ID?") and again when the binary's hash changes, as after an upgrade. A callback outside a command waits for the
  answer.
- `exec.run`, `process.start` and `terminal.pty` share the pins in `program-pins.json` in the mod store. For headless
  runs, pin a binary ahead of time with `omd-mod trust-program STORE MOD_ID PROGRAM`. Headless, an unpinned run fails
  with `program_unconfirmed`, and the error names the resolved path to pass as PROGRAM. MOD_ID must be an active mod
  whose `os_access` lists the program.
- A declined prompt fails `exec_program_declined` or `process_program_declined`, and a terminal start returns
  `{status: 'declined'}`.
- Unsandboxed runs get the user's `HOME`, `USER`, `LOGNAME`, `SHELL`, locale and `SSH_AUTH_SOCK`, so `ssh`-based tools
  reach the user's SSH agent; the full environment is listed under
  [`exec.run` with `sandbox: "none"`](running-commands.md#execrun-with-sandbox-none).

### `approves` manifest field

`approves: {kinds, tools?, roots?, hosts?}` lists the request kinds a mod may approve (`exec`, `stdin`, `patch`,
`mcp_tool`, `network`) and optional scopes. Empty scopes are broad.

Requires the `approve`, `approvals` and `middleware` capabilities; `approve.override` also needs `approve`. `approve`
without `approves`, or the reverse, fails with `invalid_approves`.

| Scope | Meaning |
| --- | --- |
| `tools` | The tools the mod may approve; see below |
| `roots` | Absolute directories that must contain the command's working directory or every patched file after symlinks resolve (a dangling symlink never qualifies). |
| `hosts` | Match network hosts (`*.example.com`). |

`tools` matches:

- the command's program as written (the first word inside an `sh`, `bash` or `zsh` `-c`/`-lc` wrapper);
- `apply_patch` and `write_stdin`;
- `server/tool` of an MCP call.

Patterns may be `*` or `prefix*`. A bare name or `prefix*` also matches an absolute path that `PATH` resolves that
name to outside the repository, but never a same-named file elsewhere.

### Ending and showing the grants

Three settings limit or end the authority grants:

- `omd-mod trust ... --expires SECONDS` ends the authority grants at that time.
- Project scope limits them to one repository.
- `omd-mod revoke STORE MOD_ID_OR_PACKAGE` disables the mod and drops its grant at once. Its capabilities and secret
  environment are cleared, and enabling it again needs a new trust or install.

Trust output, the TUI trust dialog and status state what the grant exposes. In status, `mods[].authority` lists
`os_access`, `approves`, `expires_at`, `current` and `exposure`.

An expired or revoked grant fails `os` calls with `grant_expired: os`, stops the mod's unsandboxed managed
processes and panes at the next reload or call, and turns its approvals into `ask`.

## Structured access (`structured_access_v1`)

`http`, `fs.external` and `mcp` give scoped access without an unrestricted child process. They are authority grants
like `os`:

- The trusted digest includes their manifest scope.
- `--expires`, project scope and `omd-mod revoke` end them.
- Status `mods[].authority` shows the scope.
- An expired or revoked grant fails calls with `grant_expired`.

### `http_access` manifest field

`http_access: {origins, credentials?}` lists up to 32 origins and credential profile ids. An origin is
`scheme://host[:port]` (`http` or `https`) or `scheme://*.suffix` for subdomains.

Requires the `http` capability. `http` without `http_access`, or the reverse, fails with `invalid_http_access`.

### `http.request`

```ts
http.request {url, method?, headers?, body? | body_base64?, credential?, timeout_ms?, max_bytes?, redirects?}
// → {status, url, headers, body | body_base64, truncated, bytes, redirects}
```

The body is text when it is UTF-8.

| Limit | Default | Maximum |
| --- | --- | --- |
| Timeout | 30 s | 120 s |
| Response | 64 KiB | 128 KiB |
| Request body | | 1 MiB |
| Request headers | | 32 in 8 KiB |

No hop-by-hop or proxy headers are allowed.

### `http.request` redirects and credentials

- Redirects are followed only up to `redirects` (at most 5).
- Every hop is re-checked against the caller's current grant (`http_origin_denied`).
- 303 and POST 301/302 become GET.
- `authorization`, `cookie` and `x-api-key` are dropped across origins.
- `set-cookie` and authorization response headers read `[redacted]`.

`credential` names a granted profile whose token the host attaches as `Authorization: Bearer` only for the
profile's enrolled origin. A first request to another origin fails with `credential_origin_mismatch` and the mod
never sees the token. Credential profiles need an `https` enrollment origin.

The entry `owned` in `credentials` grants every secret the mod enrolled itself (`credentials.request {kind:
'secret'}`), whose ids aren't known when the manifest is written. Another mod's secret fails with
`credential_secret_not_owned`.

### `http.open`, `http.read` and `http.close`

Experimental.

`http.open` returns the status and headers with a `handle`. `http.close` ends the stream.

`http.read {handle, max_bytes?, wait_ms?}` returns up to 64 KiB (`data` or `data_base64`, never splitting a UTF-8
character) and `done`, or `http_stream_busy` while another read of the handle runs.

- Dropping an in-flight read closes its stream and releases its slot; later reads return `http_stream_unavailable`.
- Busy reads do not renew idle time.
- A mod has at most four streams open, including concurrent successful opens; excess responses are discarded with
  `http_stream_limit`. Pending requests do not reserve slots.
- Streams close after 60 s idle and at reload, disable, revoke or expiry.
- Cancelling the callback aborts a request in flight (`host_operation_cancelled`); the deadline fails it with
  `http_timeout`.

### `fs_access` manifest field

`fs_access: {roots: [{path, write?}]}` lists up to 16 absolute roots. Writes need `write: true`.

Requires the `fs.external` and `fs.read` capabilities, and `fs.write` for a root with `write: true`. `fs.external`
without `fs_access`, or the reverse, fails with `invalid_fs_access`.

`root` on `workspace.read`, `workspace.list`, `workspace.stat` and `workspace.transaction` resolves the paths under
that root with the workspace rules:

- relative paths without `..`;
- no symlinked components, opened without following links;
- expected versions on every transaction path (`stale expected version for ...`).

The root must be canonical (`fs_root_not_canonical`) and cannot overlap the workspace, mod stores, Codex home,
credential directories or the `host.json` protected and secret paths (`fs_root_protected`). External changes are
not workspace changes.

### `mcp_servers` manifest field

The `mcp` capability, `mcp.connect` and `mcp.disconnect` are experimental.

`mcp_servers: {name: {command, args?} | {url, credential?}}` lists up to 8 servers.

Requires the `mcp` capability. `mcp` without `mcp_servers`, or the reverse, fails with `invalid_mcp_servers`.

- `mcp.connect {server}` adds `mod_<id>_<name>` to the mod's thread through the engine's own MCP refresh, subject
  to managed MCP requirements.
- Its tools appear as `mcp__mod_<id>_<name>__<tool>` and run through normal tool admission and approvals
  (`tools.invoke` from the mod).
- A `credential` is sent only to the server URL's origin.
- `mcp.disconnect` removes it; servers also end at reload, disable, revoke or expiry.
- Command servers run as the user outside the sandbox like any configured MCP server.

### Access receipts

Each HTTP request, MCP change, external file operation and `environment.read`/`environment.set` leaves a receipt
with the mod, the operation, the time and any error, plus:

| Operation | Also records |
| --- | --- |
| `http.request`, `http.open` | The origin, the path without query or fragment, the method, the credential profile id, the status and redirects |
| `workspace.read`, `workspace.list`, `workspace.stat`, `workspace.transaction` with `root` | The root |
| `mcp.connect`, `mcp.disconnect` | The server |
| `environment.read` | The names |
| `environment.set` | The name and whether the call set or reset the override |

Receipts never contain bodies, headers or values. Status `access` lists the last 32, and calls the session runs are
also appended to its `mod-access.jsonl`.

Servers and remote hosts can still log what they receive.

### `environment.read`

Experimental.

`environment.read {names}` (`exec`) returns `{values: {NAME: {set, value}}}` for up to 16 names the manifest lists
in `exec_environment`.

- Secret-like names (`*KEY*`, `*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `AWS_*`, ...) report only `{set}`.
- A value over 4,096 bytes reads as `{set: false, value: null}`; read larger values from `exec.run {program:
  'env'}` output.
- Per-child values go in `exec.run` `env` and `process.start` `environment`, also limited to declared names.
  Nothing changes the host process environment.

### `environment.set`

`environment.set {name, value}` (`exec`) sets an override for later `environment.read`, `exec.run` and
`process.start` calls. The override is local to the caller, its source and the thread. `value: null` removes the
override, restores the inherited value and frees its slot. The package must list host feature
`environment_overrides_v1` in `required_features`.

- Names must be declared and non-reserved. A secret-like name also needs explicit trust, bound to the package hash, and
  a read reports only whether it is set.
- Values are at most 4096 bytes without NUL, with 16 names and 16 KiB total per scope.
- Overrides and explicit per-call values (`exec.run` `env`, `process.start` `environment`) are validated separately.
  Managed processes allow 8 explicit names and 1024 bytes per explicit value. An explicit per-call value wins over an
  override.
- Overrides end on unload, source replacement or session end; they do not change providers, sidecars or existing
  processes.
- Receipts contain the name and override/reset action, never the value.

### `exec_environment` names

A manifest may list up to 16 `exec_environment` names that `exec.run` passes through from the host environment. The
host refuses these names:

- `PATH`, `HOME` and `TMPDIR`;
- shell, loader and interpreter variables;
- names with the prefix `DYLD_`, `LD_`, `OMD_`, `CODEX_`, `SSH_`, `GPG_` or `GIT_CONFIG`.
