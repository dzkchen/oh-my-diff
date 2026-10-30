# Capabilities and authority grants

What each manifest capability grants, how the authority grants (`os`, `http`, `fs.external`, `mcp`, `policy` and
others) are scoped and revoked, and how admission policy and `host_operation` interception work. Read it when you
choose a mod's `capabilities` or review what a trusted mod can do.

## Capabilities

Capabilities name authority classes. A call or registration outside the package's trusted capabilities fails with
`capability_denied: NAME` before any native work.

### Capabilities: core operations

| Capability | Grants |
| --- | --- |
| `exec` | `exec.run`, `exec.output_page`, `environment.read`, `environment.set`, `process.*`, `sidecars.*`, the `process_event` event; `app.request mcpServer/tool/call` |
| `pty` | `terminal.pty` (a writable pane also needs `fs.write`) |
| `history` | the `history` replacement |
| `outputs` | `tool_output` observers |
| `fs.read` | `workspace.read`, `workspace.list`, `workspace.stat`, read-only `workspace.check_access`, `workspace.snapshot`, `workspace.fingerprint`, `workspace.watch`, the `workspace_change` event; `app.request fuzzyFileSearch*` |
| `fs.write` | write-mode `workspace.check_access`, `workspace.transaction`, `workspace.backup`, `workspace.restore`, `workspace.request_rename`, the `workspace_pre_rename` event, `exec.run` with `write: true` |
| `network` | `exec.run` and `process.start` with `network: "loopback"` |
| `unix_sockets` | `exec.run` `unix_sockets` |
| `model` | `routes.list`, `routes.select`, `providers.*`, `ledger.settle`, the `routing` and `model_response` events |
| `agents` | `agents.*` (including `agents.inventory`), `api.agent`, `agent_offers` and `agent_spawn` interceptors, `model.complete`, `model.fork` (with `sessions` and `sessions_tools`), `task.status`, `workspace.integrate` |
| `store` | `store.*`, `evidence.write`, `evidence.read`, `api.state` |
| `sessions` | `sessions.list`, `sessions.read`, `sessions.ports`, `turns.activity`, turn evidence on `turn_end` |
| `sessions_tools` | tool arguments and outputs in `sessions.read` records, `sessions.snapshot`, `model.fork` and `agents.spawn {parent_history}` (with `sessions`) |
| `contracts` | `api.contract`, `receipts.submit`, `task.complete`, `contract.status`, `contract.restrict`, `contract.select`, the `contract` event |
| `builtins` | `api.builtins`, `builtins.invoke`, `commands.invoke` |

### Capabilities: terminal, threads and registrations

| Capability | Grants |
| --- | --- |
| `terminal` | the `terminal` event and `render` interceptors; `component_event`, `view`, `focus`; `terminal.notify`, `terminal.show_thread`, `commands.list`, `commands.describe`, `terminal.import_file`, `terminal.open`, `terminal.prompt`, `terminal.pane`, `terminal.panes`, `terminal.panel`, `terminal.notice`, `terminal.selection`, `terminal.copy`, `terminal.blit`, `terminal.image_sample`; the `component_change` interceptor |
| `threads`, `config`, `config.write`, `inventory`, `account` | `app.request` for the routed app-server methods of that class; `app_notification`; `threads` also `turns.abort`; `config` also `config.describe`, `config_list` interceptors and `config_change`; `config.write` also `config.set` and `config_set` interceptors; `inventory` also `app.routes`, `session.info` and `tools.list` |
| `approvals` | the `approval` middleware (which also needs `middleware`) and `approval_result`; `app_server_request` and `app.respond`; the `elicitation` interceptor and `elicitation_result` |
| `events` | `events.publish`, `events.schedule`, `events.cancel`, `time.sleep`, the `channel` and `timer` events |
| `credentials` | `credentials.list`, `credentials.request` |
| `composer` | `composer.read`, `composer.write`, `composer.suggest`, `prompts.*`, the `composer` event, the `composer_edit` and `composer_key` interceptors, `api.completion` and the `completion` replacement |
| `packages` | `packages.list`, `packages.index`, `packages.preview`, `packages.apply`, `packages.reload`, `routes.add`, `routes.write`, `settings.write` for another mod |
| `tools` | `api.tool`, `api.dynamicTools`, `tools.define`, `tools.undefine`, `tool_specs` interceptors |
| `interception` | `tool` interceptors, `tools.invoke`, `tools.check`, `tools.original` (`tool_original_v1`) and the `tool_batch` replacement |
| `input` | `input` and `mention` interceptors |
| `middleware` | `host_operation`, `model_request` and `response_stream` interceptors and the middleware events |
| `commands` | `api.command`, `command_list` and `command` interceptors, `settings.write` for the mod itself |
| `context`, `lifecycle`, `compaction`, `services`, `virtual_reads` | Their registrations and events; `compaction` also owns the `compaction` interceptor |

### Capabilities: authority grants

Apart from `request_policy`, these capabilities are authority grants: the manifest declares their scope, and
[Unrestricted processes and delegated approvals](#unrestricted-processes-and-delegated-approvals) and [Structured
access](#structured-access-structured_access_v1) describe how they are bound and ended.

| Capability | Grants |
| --- | --- |
| `os` | `sandbox: "none"` on `exec.run`, `process.start` and `terminal.pty` start (`unrestricted_process_v1`) |
| `approve` | `{approve}` from the `approval` middleware inside the manifest's `approves` scope (`delegated_approval_v1`) |
| `approve.override` | delegated approval of commands the user's own execpolicy rules forbid |
| `http` | `http.request`, `http.open`, `http.read`, `http.close` to the manifest's `http_access` origins (`structured_access_v1`) |
| `fs.external` | `root` on `workspace.read`, `workspace.list`, `workspace.stat` and `workspace.transaction` for the manifest's `fs_access` roots |
| `mcp` | `mcp.connect`, `mcp.disconnect` for the manifest's `mcp_servers` |
| `policy` | `admission` interceptors and namespace withholding inside the manifest's `policy.namespaces` (`admission_api_policy_v1`) |
| `request_policy` | a declared final-request policy that refuses every model request except web search unless the mod's required `model_send` interceptor serves (needs `middleware`; `final_request_policy_v1`); shown in the grant exposure text, not an expiring authority grant |
| `peers` | `peers.list`, `peers.send`, `peer_send` and `peer_receive` interceptors, the `peer_message` and `peer_receipt` events, within the manifest's `peer_access` (`peer_sessions_v1`) |
| `power` | `power.hold` and `power.release`; lid-closed holds need the deployed broker (`power_hold_v1`) |
| `autonomous` | `turns.queue`, `turns.queued`, `turns.dequeue`, `turn_stop` interceptors and the `turn_queue` event, within the manifest's `autonomy` limits (`autonomous_turns_v1`) |
| `history_write` | `app.request thread/rewrite` on the current thread and threads the mod started (`history_rewrite_v1`) |
| `history_persist` | `history_persist` interceptors, which see and may replace every stored history text (`history_persist_v1`) |

### `tool_result_fingerprints_v1`

`tool_result_fingerprints_v1` supplies observe-only `thread_id`, `call_sha256`, `result_sha256` and
`result_complete` fields on `tool_result`. The result digest covers the accepted model-visible output with a fixed
call ID; blocked, failed, aborted and unavailable lifecycle results have no result digest. `answered_by` names the
mod that answered the call without running it.

## Unrestricted processes and delegated approvals

`os`, `approve`, `approve.override`, `http`, `fs.external`, `mcp`, `policy`, `peers`, `power`, `autonomous`, `history_write`
and `history_persist` are authority grants. The manifest declares their scope, which the trust digest binds, so
changed content or a wider scope needs a new trust.

### `os_access` manifest field

`os_access: {programs, network?}` lists up to 32 programs and whether unsandboxed runs keep external network. It
needs `exec`.

- A program is `*`, a bare name resolved on `PATH` outside the repository, or an absolute path.
- A program inside the repository runs only when its absolute path is listed.
- With `network: false`, unsandboxed runs use a profile that denies IP networking only.
- Unsandboxed runs get the user's `HOME`, `USER`, `LOGNAME`, `SHELL`, locale and `SSH_AUTH_SOCK`, so `ssh`-based tools
  reach the user's SSH agent; other variables come only from declared `exec_environment` names.

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

## Admission and API policy (`admission_api_policy_v1`)

`policy` is an authority grant with manifest `policy: {namespaces}` (up to 16 patterns, `*` wildcards). At every
reload, after native trust, digest and dependency checks, each other active package passes the `admission`
interceptors with this input (`source_use` is what the source calls):

```ts
{package: {id, version, sha256, source, scope, capabilities, dependencies, requires, services, registrations, source_use},
 reason: 'load'}
```

An `admission` interceptor answers in one of three ways:

- `next(e)` admits the package.
- `{deny: reason}` refuses it (`admission_denied`, listed in status `rejected`). Packages that depend on or require a
  refused package, or import a service only it provides, are refused with `dependency_not_admitted`.
- `{withhold: [namespace]}` admits the package without those host namespaces; its calls there fail with
  `capability_withheld: <namespace>`. Namespaces are an operation's prefix (`exec`, `workspace`, `http`, `agents`,
  ...) or `service:<name>/<method>` for service calls, and each must match the policy mods' `policy.namespaces`
  (`admission_policy_invalid` otherwise).

### Admission rules

Admission runs without host operations. An outer handler may only tighten the decision beneath it, so an ordinary
handler cannot undo a required one.

- Policy mods and their dependencies are never judged and cannot judge themselves.
- Decisions are cached by the package and policy digests, so changed content is judged again.
- A failing, timed-out or faulted required admission interceptor refuses every judged package with
  `admission_policy_unavailable`. Disabling or reloading the policy mod in `/omd` (or `omd-mod disable`) restores
  them, and an expired or revoked `policy` grant stops judging.
- Policy grants nothing: it cannot add capabilities, issue or widen grants, change broker or managed policy, or
  reach authority operations, which are not host operations.
- Delegated overrides of the user's own execpolicy rules stay the `approve.override` grant; managed rules are never
  overridable.

### `host_operation` interceptors

Host and service calls are intercepted with `api.intercept('host_operation')` (`middleware`). Inputs carry
`{operation, namespace, arguments}`, so `match: {namespace: 'http'}` or `{namespace: /^service:/}` selects by
namespace.

`next.origin` names the actual `caller`, the service `provider` when a provider makes the call on someone's behalf,
and the caller `chain`; the host sets them and a mod cannot.

Interception covers every host operation and service call, including nested provider calls, except calls made
inside an interceptor callback and `sessions.*` and `evidence.*` calls. Pure SDK functions and local rendering are
not host operations and are not intercepted.

### `host_operation` middleware event

The `host_operation` middleware event (`middleware`) reports every other mod's host call as `{phase, caller,
operation}` plus `arguments` before, and `result` or `error` after.

For `store.*`, `environment.read`, `credentials.*`, `http.*`, `exec.*`, `sessions.*` and `evidence.*` the
`arguments` and `result` are `null` and an error is `private_operation_failed`; the operation, caller and whether
it failed stay visible. Other operations are shown in full.

Masking applies to the event only: a `host_operation` interceptor still receives the `arguments` and answer of the
calls it matches, except `sessions.*` and `evidence.*`, which are never intercepted. Because of that, `middleware`
is listed in the grant exposure text at trust, install and status; it is not one of the authority grants that
expire.

### `exec_environment` names

A manifest may list up to 16 `exec_environment` names that `exec.run` passes through from the host environment;
`PATH`, `HOME`, `TMPDIR`, shell, loader and interpreter variables and the `DYLD_`, `LD_`, `OMD_`, `CODEX_`, `SSH_`,
`GPG_` and `GIT_CONFIG` prefixes are refused.
