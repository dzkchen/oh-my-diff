# Authority grants

Use it when a mod needs authority beyond its sandbox: unsandboxed programs, delegated approvals, HTTP origins,
folders outside the workspace, MCP servers or environment variables. It covers the manifest fields that scope each
grant, the operations they allow and how a grant ends. The capability names are listed in
[Capabilities](capabilities.md#capabilities-authority-grants).

## Unrestricted processes and delegated approvals

`os`, `approve`, `approve.override`, `http`, `fs.external`, `mcp`, `policy`, `peers`, `power`, `autonomous`,
`history_write` and `history_persist` are authority grants. The manifest declares their scope, which the trust digest
binds, so changed content or a wider scope needs a new trust. Of these, `approve.override`, `fs.external`, `mcp`,
`peers`, `power`, `autonomous` and `history_write` are experimental.

### `os_access` manifest field

`os_access: {programs, network?}` lists up to 32 programs and whether unsandboxed runs keep external network. It
needs `exec`.

- A program is `*`, a bare name resolved on `PATH` outside the repository, or an absolute path.
- A program inside the repository runs only when its absolute path is listed.
- With `network: false`, unsandboxed runs use a profile that denies IP networking only.
- Every unsandboxed `exec.run`, `process.start` and `terminal.pty` start asks once per mod and binary ("Run NAME for
  mod ID?") and again when the binary's hash changes, as after an upgrade. A callback outside a command waits for the
  answer.
- The three share the pins in `program-pins.json` in the mod store. `omd-mod trust-program STORE MOD_ID PROGRAM` pins a
  binary ahead of time for headless runs, where an unpinned run fails `program_unconfirmed` and names the resolved path
  to pass as PROGRAM. MOD_ID must be an active mod whose `os_access` lists the program.
- A declined prompt fails `exec_program_declined` or `process_program_declined`, and a terminal start returns
  `{status: 'declined'}`.
- Unsandboxed runs get the user's `HOME`, `USER`, `LOGNAME`, `SHELL`, locale and `SSH_AUTH_SOCK`, so `ssh`-based tools
  reach the user's SSH agent; the full environment is listed under
  [`exec.run` with `sandbox: "none"`](running-commands.md#execrun-with-sandbox-none).

### `approves` manifest field

`approves: {kinds, tools?, roots?, hosts?}` lists the request kinds a mod may approve (`exec`, `stdin`, `patch`,
`mcp_tool`, `network`) and optional scopes. Empty scopes are broad. It needs `approvals` and `middleware`;
`approve.override` needs `approve`.

| Scope | Meaning |
| --- | --- |
| `tools` | Matches the command's program (the first word inside an `sh`, `bash` or `zsh` `-c`/`-lc` wrapper) as written, `apply_patch`, `write_stdin`, or `server/tool` of an MCP call (`*` and `prefix*` patterns). A bare name or `prefix*` also matches an absolute path that `PATH` resolves that name to outside the repository, but never a same-named file elsewhere. |
| `roots` | Absolute directories that must contain the command's working directory or every patched file after symlinks resolve (a dangling symlink never qualifies). |
| `hosts` | Match network hosts (`*.example.com`). |

### Ending and showing the grants

`omd-mod trust ... --expires SECONDS` ends the authority grants at a time, project scope keeps them to one repository,
and `omd-mod revoke STORE MOD_ID_OR_PACKAGE` disables the mod and drops its grant at once: capabilities and secret
environment are cleared, and enabling it again needs a new trust or install.

Trust output, the TUI trust dialog and status (`mods[].authority`: `os_access`, `approves`, `expires_at`,
`current`, `exposure`) state what the grant exposes.

An expired or revoked grant fails `os` calls with `grant_expired: os`, stops the mod's unsandboxed managed
processes and panes at the next reload or call, and turns its approvals into `ask`. Install, rendering, services,
dependencies and model text cannot issue or widen a grant.

## Structured access (`structured_access_v1`)

`http`, `fs.external` and `mcp` are authority grants like `os`: the manifest scope is part of the trusted digest,
`--expires`, project scope and `omd-mod revoke` end them, status `mods[].authority` shows the scope, and an expired
or revoked grant fails calls with `grant_expired`. They give granted access without an unrestricted child process.

### `http_access` manifest field

`http_access: {origins, credentials?}` lists up to 32 origins and credential profile IDs. An origin is
`scheme://host[:port]` (`http` or `https`) or `scheme://*.suffix` for subdomains.

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
never sees the token.

The entry `owned` in `credentials` grants every secret the mod enrolled itself (`credentials.request {kind:
'secret'}`), whose IDs aren't known when the manifest is written. Another mod's secret fails with
`credential_secret_not_owned`.

### `http.open`, `http.read` and `http.close`

Experimental.

`http.open` returns the status and headers with a `handle`. `http.close` ends the stream.

`http.read {handle, max_bytes?, wait_ms?}` returns up to 64 KiB (`data` or `data_base64`, never splitting a UTF-8
character) and `done`, or `http_stream_busy` while another read of the handle runs.

- Dropping an in-flight read closes its stream and releases its slot; later reads return `http_stream_unavailable`.
- Busy reads do not renew idle time.
- A mod holds at most four streams, including concurrent successful opens; excess responses are discarded with
  `http_stream_limit`. Pending requests do not reserve slots.
- Streams close after 60 s idle and at reload, disable, revoke or expiry.
- Cancelling the callback aborts a request in flight (`host_operation_cancelled`); the deadline fails it with
  `http_timeout`.

### `fs_access` manifest field

`fs_access: {roots: [{path, write?}]}` lists up to 16 absolute roots and needs `fs.read` (and `fs.write` for
`write`). Writes need `write: true`.

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

- `mcp.connect {server}` adds `mod_<id>_<name>` to the mod's thread through the engine's own MCP refresh, subject
  to managed MCP requirements.
- Its tools appear as `mcp__mod_<id>_<name>__<tool>` and run through normal tool admission and approvals
  (`tools.invoke` from the mod).
- A `credential` is sent only to the server URL's origin.
- `mcp.disconnect` removes it; servers also end at reload, disable, revoke or expiry.
- Command servers run as the user outside the sandbox like any configured MCP server.

### Access receipts

Each HTTP request, MCP change, external file operation and `environment.read`/`environment.set` leaves a receipt
with the mod, operation, origin and path without query, root, server or names (never bodies, headers or values) in
status `access` (the last 32). Calls the session runs are also appended to its `mod-access.jsonl`.

Servers and remote hosts can still log what they receive; credential profiles need an `https` enrollment origin.

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

`environment.set {name, value}` (`exec`) sets a caller/source/thread-local override for subsequent
`environment.read`, `exec.run` and `process.start`. `value: null` removes the override, restores the inherited
value and frees its slot. Require `environment_overrides_v1` at admission.

- Names must be declared and non-reserved; secret-like names still need hash-bound trust and reads disclose only
  whether they are set.
- Values are at most 4096 bytes without NUL, with 16 names and 16 KiB total per scope.
- Persistent values are validated separately from explicit per-call values (managed processes allow 8 explicit
  names and 1024 bytes per explicit value). Explicit per-call values win.
- Overrides end on unload, source replacement or session end; they do not change providers, sidecars or existing
  processes.
- Receipts contain the name and override/reset action, never the value.

### `exec_environment` names

A manifest may list up to 16 `exec_environment` names that `exec.run` passes through from the host environment;
`PATH`, `HOME`, `TMPDIR`, shell, loader and interpreter variables and the `DYLD_`, `LD_`, `OMD_`, `CODEX_`, `SSH_`,
`GPG_` and `GIT_CONFIG` prefixes are refused.
