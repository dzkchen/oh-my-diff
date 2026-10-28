# Mod API reference

This is every [mod API reference page](reference/README.md) in one file, for agents and search.

This reference matches `@oh-my-diff/mod-api` and host API `1.0.0` and Codex `0.164.0`.
`omd-mod status` reports the OMD release as `host.omd`, the version `compatibility.releases` matches. Only this API version loads. [`api.d.ts`](api.d.ts) is the complete typed surface.

## Generated declarations

A store also generates declarations for the running host:

- `active-host.d.ts` describes the running host.
- `installed-contracts.d.ts` describes the service contracts available to consumers.
- `tool-types.d.ts` appears once a session has listed its tools ([Typed tool declarations](#typed-tool-declarations)).

## Stability

API `1.0.0` is stable. [The conformance registry](https://github.com/dzkchen/oh-my-diff/blob/main/mods/conformance/contract.json) marks each public operation, event,
capability, interceptor, component, render site, view field, classic hook and author command as frozen or
experimental:

- Frozen entries keep their shape through `2027-10-19`; a breaking change needs a major version and a migration note.
- Experimental ones may change in any release.
- A frozen entry's `experimental_fields` (fields added after 1.0.0, such as the `workspace.watch` `key`) are
  experimental too.

Version and support rules are in [COMPATIBILITY.md](https://github.com/dzkchen/oh-my-diff/blob/main/mods/conformance/COMPATIBILITY.md).

Examples of experimental surfaces (the conformance registry, `mods/conformance/contract.json`, is authoritative):

- Raster frame streaming: `terminal.blit`, the `raster` component, `process_raster_v1` and `raster_pixels_v1`.
- The `composer_key`, `mention` and `component_change` interceptors and `completion_tokens_v1`.
- HTTP streams (`http.open`, `http.read`, `http.close`); `http.request` is frozen.
- `api.uiState` and command views.
- `routes.write` (`route_write_v1`), added after 1.0.0.
- `api.settingsFile` and the settings file (`settings_file_v1`).
- Focus regions, `key_contexts`, the `region` and `help` key actions, `keys: 'all'` and a layout leaf's `style.focus`
  (`terminal_focus_v1`).
- Layout leaf `title` (`terminal_layout_title_v1`).
- Power holds: the `power` grant, `power.hold` and `power.release` (`power_hold_v1`), added after 1.0.0.
- `tools.original` (`tool_original_v1`), added after 1.0.0.

Not provided: closure-based client modules, vendor kill switches, raw secret access, hosted mobile or desktop clients,
rich children inside buttons (a button uses its typed `text`), audio, telemetry and pane drag.

### Migration notes

- Host calls per callback rise from 128 to 512 (`budget.hostCalls` starts at 512). The raise is additive: a mod that
  counted calls or stayed under 128 keeps working. The other limits raised with it (the callback transport budget,
  `process.exchange` and tool interceptor output, `api.state`, package files, view JSON, evidence pages and
  registrations per mod) only admit more than before, with two visible changes: `evidence.read` without `max_bytes`
  returns pages of up to 64 KiB instead of 16 KiB, and a `tool` replacement the model cannot take (over 64 KiB and
  longer than the original, which for a retried call is the latest attempt's output) is dropped with a diagnostic
  after the chain instead of being refused inside it. Either way the original output stands.

## Contents

| Page | Covers |
| --- | --- |
| [Overview](#overview) | Mods versus skills, hooks and plugins; what mods can't replace; host lifetime; the transport budget |
| [Capabilities and authority grants](#capabilities-and-authority-grants) | Every capability, authority grants, structured access, admission policy |
| [Commands, files and data](#commands-files-and-data) | `exec.run`, workspace reads and writes, `store.*`, reactive state |
| [Models and routing](#models-and-routing) | Routes, the ledger, model requests and streams, request policy, one-shot model calls |
| [Agents, contracts and sessions](#agents-contracts-and-sessions) | Contracts, agents, peers, power holds, autonomous turns, submissions, lifecycle events |
| [App bridge, approvals and tools](#app-bridge-approvals-and-tools) | The app-server bridge, approvals, continuation middleware, tool output, dynamic tools |
| [Processes, kernels and events](#processes-kernels-and-events) | Framed processes, code-mode kernels, adapters, channels and watches |
| [Credentials and threads](#credentials-and-threads) | Credentials, secrets, the thread store and turn activity |
| [History and compaction](#history-and-compaction) | Model-bound history, history rewriting, compaction interception |
| [Commands, configuration and composer](#commands-configuration-and-composer) | Commands, configuration, completion, composer drafts, `@` mentions |
| [Terminal UI](#terminal-ui) | Render hooks, startup presentation, the terminal surface, terminal identity |
| [External clients](#external-clients) | The `omd-client/1` protocol |
| [Packages, limits and registration rules](#packages-limits-and-registration-rules) | Binary evidence, package controls, host limits, registration and callback rules |
| [Authoring](#authoring) | Author commands, typed tools, TypeScript tests, watch, JSX, diagnostics |
| [Packaging, publishing and offline scenarios](#packaging-publishing-and-offline-scenarios) | Package commands and sources, npm publishing, `mod.test.json` |
| [Composition and safety](#composition-and-safety) | How mods combine, protected authority, administrator policy |
| [Plugin components and shell commands](#plugin-components-and-shell-commands) | Plugin components |

## Overview

When to write a mod instead of a skill, hook or plugin, what a mod can never replace, and the rules every host call
follows.

### Mods, plugins and hooks

| Use | For |
| --- | --- |
| A skill | A procedure the model follows |
| A hook | A reaction to a lifecycle event |
| A plugin | Tools or services |
| A mod | Only to change how `codex` itself behaves or looks |

#### Codex plugins and hooks

Codex 0.164.0 plugins bundle skills, prompts, MCP servers and hook files. Its hooks are external commands or MCP tools
that return a decision: block a call, add context, or rewrite a tool's input. The hooks are `pre_tool_use`,
`permission_request`, `post_tool_use`, `pre_compact`, `post_compact`, `session_start`, `session_end`,
`user_prompt_submit`, `subagent_start`, `subagent_stop`, `stop` and `interrupt`.

A hook can't hold state, stream, draw on screen, route a model or run an agent. When two `pre_tool_use` hooks rewrite
the same call, the last one to finish wins.

A mod runs inside the host, asks for only the permissions it needs, and composes with other mods by the
[composition rules](#composition-and-safety).

#### What mods can't replace or bypass

- Workflow-contract enforcement, permissions, spending grants, cancellation, provider credentials, workspace
  integrity, evidence and final acceptance.
- History beyond the documented rewrite points, reasoning or call/output pairs, the compaction engine, or prompts for
  provider-side compaction.
- Raw terminal escapes, arbitrary widgets or DOM/canvas access, approval key bindings, the transcript, or clipboard
  authorization.
- Arbitrary providers, runtime imports other than adapter-declared aliases, or a second scheduler.
- Other mods: `requires` declares presence and order only; mods never call each other or share state.

### Host lifetime and callback authority

#### One host per process

One native host owns the process-wide session dispatcher and client bridge at a time. A second live installation is
rejected. Stopping the owner releases its registrations; teardown from an older registration cannot remove a newer
one.

#### Runtimes

Main, input and persistence runtimes may have different idle snapshots, local generation numbers, telemetry and
callback failure state.

- Numeric generations are local to a runtime, not a cross-runtime authority token.
- Each callback uses its executing runtime's selected source and grants.
- Persistence refreshes its own runtime and uses that runtime's required-interceptor decision, including failure
  fallback. Required persistence failure withholds text; dropping persistence work cancels the callback.

#### Callback admission and completion

Callback admission and completion validate current source and authority. Cancellation, disablement, revocation,
source replacement or a changed executing generation rejects completion before callback state or results are
accepted.

**Effects already performed by a host call are not rolled back.** Authors must not rely on a disabled or replaced
callback committing state after its host call finishes. Failed-reload transactional restoration is a separate
contract; retaining an older runtime does not authorize stale callbacks.

#### Failure categories

Raster producers distinguish retryable, revoked and fatal failures by explicit categories, independently of
diagnostic wording. Thread-store destination conflicts use the native `AlreadyExists` category.

### Host primitives

The host is feature-agnostic: every operation, event and capability in this reference is available to any trusted mod
on equal terms, and none of them names a product feature. The [`release_check` example](examples/release_check) is
an independent author package that uses only this surface.

Each primitive advertises a host feature a package can require (API `1.0.0`). With no mod registered
for a primitive the host allocates nothing for it and changes no decision.

#### `OMD_MODE`

| Value | Runs |
| --- | --- |
| `OMD_MODE=omd` | The mod host in the default session |
| `OMD_MODE=upstream_direct` (or no `OMD_MODE`) | Pinned upstream behavior without mods |

Any other `OMD_MODE` value is rejected.

#### Host call transport budget

Host call arguments and results share a 1 MiB transport budget per callback.

- A result that would exceed the remaining budget becomes a `host_result_limit` error the mod can catch; the
  operation has still run.
- Primitive limits in this reference keep single results inside that budget; page or use artifacts for larger data.

## Capabilities and authority grants

What each manifest capability grants, how the authority grants (`os`, `http`, `fs.external`, `mcp`, `policy` and
others) are scoped and revoked, and how admission policy and `host_operation` interception work. Read it when you
choose a mod's `capabilities` or review what a trusted mod can do.

### Capabilities

Capabilities name authority classes. A call or registration outside the package's trusted capabilities fails with
`capability_denied: NAME` before any native work.

#### Capabilities: core operations

| Capability | Grants |
| --- | --- |
| `exec` | `exec.run`, `environment.read`, `environment.set`, `process.*`, `sidecars.*`, the `process_event` event; `app.request mcpServer/tool/call` |
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
| `contracts` | `api.contract`, `receipts.submit`, `task.complete`, `contract.status`, `contract.restrict`, the `contract` event |
| `builtins` | `api.builtins`, `builtins.invoke`, `commands.invoke` |

#### Capabilities: terminal, threads and registrations

| Capability | Grants |
| --- | --- |
| `terminal` | the `terminal` event and `render` interceptors; `component_event`, `view`, `focus`; `terminal.notify`, `terminal.show_thread`, `commands.list`, `commands.describe`, `terminal.import_file`, `terminal.open`, `terminal.prompt`, `terminal.pane`, `terminal.panes`, `terminal.panel`, `terminal.notice`, `terminal.selection`, `terminal.copy`, `terminal.blit`; the `component_change` interceptor |
| `threads`, `config`, `config.write`, `inventory`, `account` | `app.request` for the routed app-server methods of that class; `app_notification`; `threads` also `turns.abort`; `config` also `config.describe`, `config_list` interceptors and `config_change`; `config.write` also `config.set` and `config_set` interceptors; `inventory` also `session.info` and `tools.list` |
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

#### Capabilities: authority grants

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
| `request_policy` | a declared final-request policy that refuses every model request unless the mod's required `model_send` interceptor serves (needs `middleware`; `final_request_policy_v1`); shown in the grant exposure text, not an expiring authority grant |
| `peers` | `peers.list`, `peers.send`, `peer_send` and `peer_receive` interceptors, the `peer_message` and `peer_receipt` events, within the manifest's `peer_access` (`peer_sessions_v1`) |
| `power` | `power.hold` and `power.release`; lid-closed holds need the deployed broker (`power_hold_v1`) |
| `autonomous` | `turns.queue`, `turns.queued`, `turns.dequeue`, `turn_stop` interceptors and the `turn_queue` event, within the manifest's `autonomy` limits (`autonomous_turns_v1`) |
| `history_write` | `app.request thread/rewrite` on the current thread and threads the mod started (`history_rewrite_v1`) |
| `history_persist` | `history_persist` interceptors, which see and may replace every stored history text (`history_persist_v1`) |

#### `tool_result_fingerprints_v1`

`tool_result_fingerprints_v1` supplies observe-only `thread_id`, `call_sha256`, `result_sha256` and
`result_complete` fields on `tool_result`. The result digest covers the accepted model-visible output with a fixed
call ID; blocked, failed, aborted and unavailable lifecycle results have no result digest. `answered_by` names the
mod that answered the call without running it.

### Unrestricted processes and delegated approvals

`os`, `approve`, `approve.override`, `http`, `fs.external`, `mcp`, `policy`, `peers`, `power`, `autonomous`, `history_write`
and `history_persist` are authority grants. The manifest declares their scope, which the trust digest binds, so
changed content or a wider scope needs a new trust.

#### `os_access` manifest field

`os_access: {programs, network?}` lists up to 32 programs and whether unsandboxed runs keep external network. It
needs `exec`.

- A program is `*`, a bare name resolved on `PATH` outside the repository, or an absolute path.
- A program inside the repository runs only when its absolute path is listed.
- With `network: false`, unsandboxed runs use a profile that denies IP networking only.

#### `approves` manifest field

`approves: {kinds, tools?, roots?, hosts?}` lists the request kinds a mod may approve (`exec`, `stdin`, `patch`,
`mcp_tool`, `network`) and optional scopes. Empty scopes are broad. It needs `approvals` and `middleware`;
`approve.override` needs `approve`.

| Scope | Meaning |
| --- | --- |
| `tools` | Matches the command's program (the first word inside an `sh`, `bash` or `zsh` `-c`/`-lc` wrapper) as written, `apply_patch`, `write_stdin`, or `server/tool` of an MCP call (`*` and `prefix*` patterns). A bare name or `prefix*` also matches an absolute path that `PATH` resolves that name to outside the repository, but never a same-named file elsewhere. |
| `roots` | Absolute directories that must contain the command's working directory or every patched file after symlinks resolve (a dangling symlink never qualifies). |
| `hosts` | Match network hosts (`*.example.com`). |

#### Ending and showing the grants

`omd-mod trust ... --expires SECONDS` ends the three grants at a time, project scope keeps them to one repository,
and `omd-mod revoke STORE MOD_ID_OR_PACKAGE` disables the mod and drops its grant at once: capabilities and secret
environment are cleared, and enabling it again needs a new trust or install.

Trust output, the TUI trust dialog and status (`mods[].authority`: `os_access`, `approves`, `expires_at`,
`current`, `exposure`) state what the grant exposes.

An expired or revoked grant fails `os` calls with `grant_expired: os`, stops the mod's unsandboxed managed
processes and panes at the next reload or call, and turns its approvals into `ask`. Install, rendering, services,
dependencies and model text cannot issue or widen a grant.

### Structured access (`structured_access_v1`)

`http`, `fs.external` and `mcp` are authority grants like `os`: the manifest scope is part of the trusted digest,
`--expires`, project scope and `omd-mod revoke` end them, status `mods[].authority` shows the scope, and an expired
or revoked grant fails calls with `grant_expired`. They give granted access without an unrestricted child process.

#### `http_access` manifest field

`http_access: {origins, credentials?}` lists up to 32 origins and credential profile IDs. An origin is
`scheme://host[:port]` (`http` or `https`) or `scheme://*.suffix` for subdomains.

#### `http.request`

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

#### `http.request` redirects and credentials

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

#### `http.open`, `http.read` and `http.close`

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

#### `fs_access` manifest field

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

#### `mcp_servers` manifest field

`mcp_servers: {name: {command, args?} | {url, credential?}}` lists up to 8 servers.

- `mcp.connect {server}` adds `mod_<id>_<name>` to the mod's thread through the engine's own MCP refresh, subject
  to managed MCP requirements.
- Its tools appear as `mcp__mod_<id>_<name>__<tool>` and run through normal tool admission and approvals
  (`tools.invoke` from the mod).
- A `credential` is sent only to the server URL's origin.
- `mcp.disconnect` removes it; servers also end at reload, disable, revoke or expiry.
- Command servers run as the user outside the sandbox like any configured MCP server.

#### Access receipts

Each HTTP request, MCP change, external file operation and `environment.read`/`environment.set` leaves a receipt
with the mod, operation, origin and path without query, root, server or names (never bodies, headers or values) in
status `access` (the last 32). Calls the session runs are also appended to its `mod-access.jsonl`.

Servers and remote hosts can still log what they receive; credential profiles need an `https` enrollment origin.

#### `environment.read`

`environment.read {names}` (`exec`) returns `{values: {NAME: {set, value}}}` for up to 16 names the manifest lists
in `exec_environment`.

- Secret-like names (`*KEY*`, `*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `AWS_*`, ...) report only `{set}`.
- A value over 4,096 bytes reads as `{set: false, value: null}`; read larger values from `exec.run {program:
  'env'}` output.
- Per-child values go in `exec.run` `env` and `process.start` `environment`, also limited to declared names.
  Nothing changes the host process environment.

#### `environment.set`

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

### Admission and API policy (`admission_api_policy_v1`)

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

#### Admission rules

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

#### `host_operation` interceptors

Host and service calls are intercepted with `api.intercept('host_operation')` (`middleware`). Inputs carry
`{operation, namespace, arguments}`, so `match: {namespace: 'http'}` or `{namespace: /^service:/}` selects by
namespace.

`next.origin` names the actual `caller`, the service `provider` when a provider makes the call on someone's behalf,
and the caller `chain`; the host sets them and a mod cannot.

Interception covers every host operation and service call, including nested provider calls, except calls made
inside an interceptor callback and `sessions.*` and `evidence.*` calls. Pure SDK functions and local rendering are
not host operations and are not intercepted.

#### `host_operation` middleware event

The `host_operation` middleware event (`middleware`) reports every other mod's host call as `{phase, caller,
operation}` plus `arguments` before, and `result` or `error` after.

For `store.*`, `environment.read`, `credentials.*`, `http.*`, `exec.*`, `sessions.*` and `evidence.*` the
`arguments` and `result` are `null` and an error is `private_operation_failed`; the operation, caller and whether
it failed stay visible. Other operations are shown in full.

Masking applies to the event only: a `host_operation` interceptor still receives the `arguments` and answer of the
calls it matches, except `sessions.*` and `evidence.*`, which are never intercepted. Because of that, `middleware`
is listed in the grant exposure text at trust, install and status; it is not one of the authority grants that
expire.

#### `exec_environment` names

A manifest may list up to 16 `exec_environment` names that `exec.run` passes through from the host environment;
`PATH`, `HOME`, `TMPDIR`, shell, loader and interpreter variables and the `DYLD_`, `LD_`, `OMD_`, `CODEX_`, `SSH_`,
`GPG_` and `GIT_CONFIG` prefixes are refused.

## Commands, files and data

How a mod runs one-shot commands, reads and changes workspace files, and keeps durable data. Use it for `exec.run`,
the `workspace.*` operations, `store.*`, evidence and reactive state, and for the worker and write-observation
operations that build on them.

### One-shot commands: `exec.run`

`exec.run` runs one program in the session's effective sandbox. Its arguments:

```ts
{program, sha256?, argv?, cwd?, env?, stdin?, timeout_ms?, max_output_bytes?, output_artifact?,
write?, network?, unix_sockets?, guards?, required_access?, exclusive_workspace?}
```

#### `exclusive_workspace`

`exclusive_workspace` names an absolute writable checkout to lock before guards and until the command exits.

- It requires sandboxed write mode and prior checkout enrollment by this runtime.
- Local sessions hold shared leases for their selected local roots, including inherited and subsequently selected
  roots.
- Removal fails closed when ownership is unavailable or another participating session holds a lease.
- Older runtimes and other applications do not participate; callers must obtain explicit user confirmation that
  those applications are not using a checkout before removing it.
- Exclusive ownership is unavailable on non-Unix hosts and filesystems that cannot report creation identity;
  creation identity prevents an inode reused by a new checkout from inheriting historical enrollment.

#### `exec.run` program, working directory and environment

- A bare program name resolves on `PATH` outside the repository. An absolute path must be canonical and outside the
  repository. `sha256` pins the resolved file.
- `cwd` is repository-relative.
- The environment starts empty except `PATH`, a private `HOME`/`TMPDIR`, `TERM=dumb`, locale variables, the
  declared `exec_environment` names and `env` entries limited to those names.
- Commands, buttons and keybindings run `exec.run` without network; `network: "loopback"` there fails with
  `exec_network_unavailable_in_commands`.
- Without `write` the repository is read-only. With `network: "loopback"` only local binding is allowed.
- Cancellation kills the process group and returns `exec_cancelled`.

#### `exec.run` limits

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

#### `unix_sockets`

`unix_sockets` names up to 4 declared `exec_environment` variables whose host values are Unix sockets the command
may connect to. It needs the `unix_sockets` capability.

- Each value must be an absolute, canonical path outside the repository to an existing socket owned by the current
  user, or the call fails with `exec_socket_unavailable`.
- The mod never supplies the path and no IP network is added.

#### `exec.run` with `sandbox: "none"`

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
(macOS)](#protected-authority-macos)) keeps grants, credentials and evidence anchors out of its reach.

#### `exec.run` result

```ts
{exit_code, signal, stdout, stdout_sha256, stderr,
stdout_truncated, stderr_truncated, timed_out, duration_ms, program: {path,
sha256}, guards_verified}
```

The digest covers the raw captured stdout bytes.

#### `output_artifact` and `exec.output_page`

With `output_artifact: true`, the host accepts complete UTF-8 stdout up to 16 MiB, returns a 4 KiB preview plus
`{reference, sha256}` in `output_artifact`, and reports `stdout_bytes` and `stdout_preview_truncated`. Oversize
output fails without creating an artifact.

`exec.output_page {artifact, cursor?, max_bytes?}` reads at most 16 KiB per call with a byte cursor. The artifact
is bound to the repository, current mod source and thread, hash-checked on reads, and subject to a 64 MiB quota per
binding. This keeps large command output outside mod callback receipts; callers can page it in later callbacks.

#### Integration discovery

Integration discovery uses these grants, not a separate API. A mod declares the non-secret variables an integration
sets (for example `HERDR_ENV`, `HERDR_PANE_ID`, `HERDR_BIN_PATH`, `HERDR_SOCKET_PATH`, or `NVIM`) in
`exec_environment` and reads them with `environment.read`, which starts no process.

- Inherited values are untrusted: run a binary named by one only as an absolute `program`, which the host
  canonicalizes, hashes and sandboxes, pin its returned `sha256` for later calls, and pass its socket through
  `unix_sockets`.
- Missing or malformed values leave the integration inert.
- Discovery itself grants neither execution nor socket access.

#### `api.assets.read`

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

#### `guards` for live-workspace writes

For a live-workspace write, `guards` may contain up to four read-only command preconditions: `{program, sha256?,
argv?, cwd?, env?, stdout_sha256}`.

- The host runs them without network under its exclusive workspace operation guard and compares their full,
  non-truncated stdout to the expected digest immediately before the write.
- Each guard is limited to 10 s and 1 MiB of output, and its time counts against the write's timeout.
- A failed or changed guard prevents the write.
- Guarded writes cannot target a frozen snapshot.
- Other processes outside the host can still modify the workspace between a guard and the write; commands that
  support their own locking or expected-version options should use them.

#### `required_access`

`required_access: {write: [paths]}` checks up to 128 named workspace paths for write permission after the command
guards and before the write, under that same host operation guard. It requires `write: true` and cannot target a
snapshot.

It is intended for commands that mutate metadata on behalf of selected files, such as staging. The command itself
still runs under the effective filesystem sandbox; the host cannot infer which files an arbitrary command
represents.

### Workspace: list, stat, preconditions, backups and changes

#### Workspace list, stat, access, transaction and backup operations

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

#### `workspace_change` delivery

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

#### Snapshots: `workspace.snapshot`

`workspace.snapshot {agent?, expected?}` requires `fs.read` and returns `{snapshot: ResourceRef,
candidate_sha256}`. It freezes the current tracked and approved-untracked files, or a completed owned agent's
workspace (`agents` is also required). `expected` rejects a changed candidate.

- References are bound to the caller, package source, generation and thread.
- A capture holds at most 128 MiB of file contents and paths (`snapshot_bytes` in the host config can lower it); a
  larger workspace fails with `snapshot size limit`. Turn evidence then carries `workspace_sha256: null`, as it does
  when a captured path is unreadable.
- Each mod generation and thread holds at most 8 snapshots and 128 MiB, the host at most 32 and 256 MiB; a full host
  evicts the oldest snapshot of the largest holder.
- Identical captures are deduplicated, and the registry clears on owner cleanup or session stop.
- Snapshots do not authorize reading denied paths.
- Reconstructed worktrees retain captured files even when snapshot ignore rules match them.

#### `workspace.fingerprint`

`workspace.fingerprint {agent?, expected?}` takes the same arguments and permissions and returns only
`{candidate_sha256}`, the digest `workspace.snapshot` would report. It stores nothing, so use it to check
freshness; it is also available in the `context` event, where `workspace.snapshot` is not.

#### `exec.run` against a snapshot

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

### Durable data: `store.*` and evidence

#### `store.*` operations

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

#### `evidence.write` and `evidence.read`

`evidence.write {media_type, content, label?}` stores content-addressed evidence and returns a `ResourceRef`;
`evidence.read {reference, cursor?, max_bytes?}` reads it back in pages of at most 64 KiB (`max_bytes` 1 to 65,536, by default the maximum).

#### `api.state` compare-and-swap

`api.state` is re-read before every callback and written back with a compare-and-swap. If another process wrote it
meanwhile, the host runs the callback again against the fresh state, within the callback's 5 s budget, answering
its host calls from the results already recorded, so no operation runs twice (the clock stays at the first
attempt's start, so `Date.now()` in arguments replays).

If a retry asks for a different host call, it runs again fresh when every recorded call was read-only; otherwise it
fails with the transient `state_conflict`, because an operation that already ran is never repeated.

#### `state_scope` (`state_scopes_v1`)

The location of `api.state` follows the manifest's `state_scope` (`state_scopes_v1`).

- `"store"` (the default) keeps one state of at most 512 KiB in the mod store, shared by every OMD process that
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
it does. A callback result, including its state, stays within 1 MiB.

#### `state_version` migration of thread and checkout state

The `omd-mod migrate` and `rollback` commands act on `"store"` state only.

`omd-mod migrate STORE MOD_ID_OR_PACKAGE` and `omd-mod rollback STORE MOD_ID_OR_PACKAGE BACKUP` take a mod id or a
package folder. A bare name (no `/`) is a mod id resolved among the store's selected mods (watched folder or
installed); `.`, `..` and anything with a `/` are package folders. An id that matches copies in more than one scope fails with
`mod_ambiguous` (pass the folder), and a mod without saved store state fails with `migration_requires_saved_state`.

- Thread and checkout state stored at another `state_version` migrates before the mod's next callback in that
  thread or checkout: the host runs the mod's `migrate` handler (it needs `store`) on it and keeps the previous
  file beside it as `<file>-backup-<sha256>`; until then registration and render reads see `null`.
- A package update that changes the `state_version` of a thread- or checkout-scoped mod with `store` is refused
  (`migration_handler_required`) unless the new version registers `migrate`; an adapter-wrapped package is not
  checked.
- The preview runs no new code: it marks such a package `state_version.handler_required`, and the confirmed apply
  loads it to check.
- Migration handlers can import declared package assets by relative path.

### Reactive state (`reactive_state_v1`)

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

### Typed worker and workspace operations

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

#### `workspace.integrate`

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

### Workspace reads, transactions, and write observation

`fs.read` grants `workspace.read` and the `workspace_change` event; `fs.write` grants `workspace.transaction`,
`workspace.request_rename` and the `workspace_pre_rename` event (see [Capabilities](#capabilities)).
The host accepts only the current canonical local repository and checks the effective read and write permissions
for every path.

#### Workspace reads and transactions

- Reads return UTF-8 text and SHA256 for at most 128 repository-relative paths and 4 MiB.
- A transaction requires an exact `expected` SHA256 or `null` for every affected path, plus bounded `writes` and
  optional `{old,new}` renames.
- A transaction rejects stale files, symlinks, `.git` paths, overlapping moves, and changes outside the declared
  scope.
- Files are replaced atomically one at a time, with a checked rollback after cancellation or a failed multi-file
  operation; an external writer that changes a touched path during rollback causes a visible conflict that needs
  inspection.
- This is not a repository-wide filesystem transaction or a replacement for user approval.

#### `workspace.request_rename`

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

The [independent workspace example](examples/workspace) demonstrates this path without using a language server.

#### Write observation and the index scan

Write observation is the `workspace_change` event described under [Workspace: list, stat, preconditions, backups
and changes](#workspace-list-stat-preconditions-backups-and-changes), with each changed path's before and after
hashes. Only a selected mod that subscribes to it triggers the index scan.

- The scan follows the repository's `.gitignore`, `.ignore` and `.git/info/exclude` rules and always skips `.git`
  and `.omd`.
- More than 128 changed paths or 16 KB of path names reports `unavailable`, and so does a change outside the
  thread's effective read scope, without exposing its path or hash.

The independent example also shows a direct transaction for a mod tool.

#### The experimental `process` capability

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

#### `process.start` framing

`process.start` frames stdio as `content-length` (default) or `ndjson`, and stops a process whose stdout breaks the
framing (a line that is not JSON under `ndjson`; a blank line or 8 KiB without a valid header under
`content-length`).

- stderr is discarded except under `raw`, which streams both unframed.
- `network: "loopback"` (with the `network` capability) allows local binding while keeping external network access
  restricted.
- `process.start` owns process group termination and starts adapters with a cleared host environment and an
  owner-only scratch directory.

## Models and routing

How routes are configured and chosen, how the ledger records model spend, how mods intercept and police model
requests and streams, and how they make their own model calls. Read it when you route requests, edit what a
provider receives, or call a model from a mod.

### Routes

Routes are configuration, not names in the API.

#### Route fields

`<OMD_MOD_STORE>/host.json` lists `routes` with `name, provider, model, reasoning_effort, responses_url, rates,
roles (lead|worker), tools, mods, grant, credential, data`.

A route entry, with every field the host accepts:

```json
{"name": "reviewer", "provider": "openai", "model": "gpt-6.1-sol", "reasoning_effort": "medium",
 "responses_url": "https://api.openai.com/v1/responses", "roles": ["worker"], "tools": ["exec_command"],
 "mods": ["omd_workflow"], "credential": null, "data": null,
 "grant": {"path": "/abs/grant.json", "sha256": "<sha256 of the file>"},
 "rates": {"input_microusd_per_million": 1250000, "cached_microusd_per_million": 125000,
           "output_microusd_per_million": 10000000, "reservation_microusd": 200000, "max_output_tokens": 32000,
           "input_token_ceiling": 400000, "included_subscription": false}}
```

#### Choosing a route

- `routes.list` returns the routes visible to the calling mod with `billing` and `available`, plus `data` on the
  caller's own routes ([route writes](#route-writes-route_write_v1)).
- The `routing` replacement returns `{route}` to choose a configured lead route at thread start.
- A `model_request` interceptor switches one request among the thread's lead routes (see [Model requests and
  streams](#model-requests-and-streams-model_turn_interception_v1)).
- `agents.spawn.route` names a worker route or a registered provider.
- Worker routes require a grant file whose hash, repository (or one of its `repositories`), provider, model and URL
  are rechecked on every request.
- `routes.add {mod}` (capability `packages`, user only) asks the user, then adds the worker route `plan-MODEL-MOD`
  for the conversation's model and effort on the user's ChatGPT plan, open only to `mod`, and adds this repository
  to its grant. It returns `{route}`, or `{status: 'declined'}`. It refuses `routes_add_needs_chatgpt` without a
  ChatGPT sign-in or when the conversation's provider doesn't use it.

#### Route reload (`route_reload_v1`)

Route lookups recheck `host.json` (`route_reload_v1`): an edited route list applies to new threads, `routes.list`
and `routes.select` without restarting.

- Each turn, worker start and `task.status` also apply edited `limits` and `worker_limits` (recorded in the
  thread's ledger, with spend so far still counted) and refresh the rates, credential and model of routes a running
  thread already uses.
- Services, secrets and protected paths stay as loaded at start.
- An invalid edit keeps the previous routes and `routes.select` reports why.
- `routes.select` also admits a lead route added after the thread started when it is on the thread's provider.

#### Route writes (`route_write_v1`)

`routes.write {routes, services?}` (capability `packages`, user only) replaces the caller's own routes in
`host.json` after the user confirms a dialog listing every change. It returns `{routes, services}` (the caller's
route names and service ids afterwards), `{status: 'declined'}`, or `{unchanged: true}` without asking when
nothing would change.

- `routes` replaces every route without a `grant` whose `provider` is the caller's mod id. Each must name that
  provider, have the single role `lead` and no `grant` or `credential`. A paid route (neither `included_subscription` nor
  `provider_billed`) needs `limits.exposure_microusd` above zero (`routes_write_allowance_required`).
- A route's `data` (any JSON, at most 2 KiB) is ignored by the host; `routes.list` returns it only to the route's
  provider mod, and the mod's provider service can read it from `host.json`.
- `services`, when given, updates service grants the caller already owns: each entry is `{id, credentials?,
  route?}` and replaces those fields of the caller's grant with that `id` (`routes_write_service_unknown` for any
  other id, `routes_write_service_field` for any other field). A grant's program, arguments, network, paths and
  secrets are never written here. Credentials must be existing profiles (a `secret` profile only when the caller
  owns it). The dialog lists every route and grant field that changes with its new value.
- The resulting `host.json` is validated as it is at load; a failure is `routes_write_invalid: REASON` and changes
  nothing, and a `host.json` that changed between the dialog and the write is `routes_write_changed`. Routes apply
  through `route_reload_v1`; a service picks up a changed grant at its next `providers.register` or `sidecars.start`.

#### Route grant files

The grant file binds `{"schema": 1, "repository": "<repository identity>", "provider", "model", "responses_url",
"revocable": true}` plus either:

- `"included_subscription": true`: an `openai` ChatGPT route at the Codex subscription URL, zero reservation; or
- `"paid_api_key": true`.

Any other provider, including a local one, is a paid API route. It needs `paid_api_key`, a nonzero
`reservation_microusd` and a nonzero `limits.exposure_microusd` (lead) or `worker_limits.exposure_microusd`
(workers) in `host.json`, both `0` by default.

Grant files are operator actions; a mod cannot create one to authorize itself.

#### Provider-billed routes (`provider_billing_v1`)

A route with `"provider_billed": true` (`provider_billing_v1`; zero reservation, not `included_subscription`) is
billed by its provider.

- The host admits and counts its requests without reserving exposure or bounding the body.
- It records the provider's own cost from `usage.cost_microusd` on the completed response as basis
  `provider_reported`, and leaves it `unsettled` when absent.
- A lead whose provider is a service grant's provider-billed route is accounted under that route.

`ledger.settle {request_id, microusd, source}` (`model`) lets the grant's own mod settle one such unsettled request
later, by the `x-omd-request-id` the host sent to the provider. It appends a `request_provider_settled` ledger
event, adds the amount to the task charge and refuses requests of other providers or mods, settled requests and
unknown ids.

#### Selecting a workflow contract

Users select a workflow contract with `omd-package contract select ID@VERSION` (or `omd-contract select STORE
REPOSITORY ID@VERSION`) in the repository, or from the terminal through a mod's `contract.select {contract}`
(`contracts`, user actions only).

The host shows a native confirmation that names any assurance the choice lowers, writes the same user selection and
returns `{selected, applies: 'next_session'}` or `{status: 'declined'}`. It applies from the next session.

### Ledger

Every lead and native sub-agent request is observed and recorded in the session ledger (`task.status`, the `ledger`
field of `context` and `terminal` events). The ledger a mod receives carries the cost totals, the newest 64
attempts and `observed_requests` (a count).

- Limits are enforced only on mod-initiated agents, and on the lead when its model matches a configured lead route
  with rates.
- OMD sessions use the observed HTTP Responses transport; WebSocket transport is disabled for their threads and
  refused if any request would use it.

### Model requests and streams (`model_turn_interception_v1`)

Every lead, native sub-agent and mod worker request passes the `model_request` and `response_stream` interceptors
(capability `middleware`) before and while it streams; see [Continuation
middleware](#continuation-middleware-continuation_middleware_v1-tool_continuation_v2) for
ordering, `required` and failure rules.

#### `model_request` input

- `request_id`: unique across processes, also sent as `x-omd-request-id`.
- `attempt`: 2 or 3 after a mod's stop-and-retry.
- `scope {thread_id, agent_id, kind}`.
- `routes`, `original`, `route`, `model`, `provider`, `effort` and `tools` (names).
- `sections`: see [`model_request` sections](#model_request-sections).

A handler may change `route`, `effort` and `sections`.

#### `model_request` `route` and `effort`

- `route`: one of `routes`. The lead sees its thread's lead routes: those on its provider, and those on another
  provider that name their own credential profile.
- Switching provider sends the request to that route's URL with its credential and rates, leaves the thread's
  opaque reasoning items out of that request (the transcript keeps them) and strips item metadata the provider does
  not accept.
- A route without its own credential cannot cross providers.
- `effort`: `none`, `minimal`, `low`, `medium`, `high` or `xhigh`, only when the request carries reasoning.

#### `model_request` sections

`sections` holds every classified prompt item `{id, kind, role, group, protected, text, bytes, truncated}` in
request order:

- `instructions`;
- each context fragment by its kind (`agents_md.instructions`, `environments.environment_context`,
  `git_attribution.*`, reminders and attachments such as `generic.turn_aborted` or `images.resize_notice`, repeated
  kinds as `kind#2`);
- expanded skills from `$`/slash mentions and spawn items as `skill:<name>`;
- `skills.read` outputs as `skill:<package>`.

Previews total 48 KiB (4 KiB each); a `truncated` section can be replaced whole.

- Ordinary sections may be rewritten, dropped, reordered within their `group` (message) or joined by up to 8
  inserted `{id: 'mod:…', text}` sections, which the host frames as mod-provided context.
- An inserted section joins the developer or user message of the section before it, else the nearest such message
  after (or before) it, else a new developer message at the start of the input.
- Protected sections (permissions, approved prefixes and network rules, managed developer instructions,
  collaboration mode, guardian policy, user answers) and tool outputs cannot be changed, dropped or moved, and no
  section crosses a protected one.
- Native policy is enforced independently of this text.

#### `model_request` `next` and synthetic responses

`next` resolves to `{route, effort, cache: {from}}`: `from` is the first section (or `tools`) whose content differs
from the thread's previous request, where a provider's prompt cache stops matching; `null` means an unchanged
prefix.

A handler may answer without `next`:

```ts
{response: {output: [{type: 'message', text} | {type: 'tool_call', tool, namespace?, arguments}]}}
```

- `arguments` is an object for a JSON tool or a string for a freeform tool (at most 16 items).
- The host streams it as a complete response without contacting a provider, admitting or billing anything.
- It carries no usage, and `synthetic` names the mod.
- Tool calls get `mod-<id>-<request>-<n>` call IDs and pass tool interception, native permissions and approvals
  like any call.

#### `response_stream` chunks

`response_stream` input is one chunk with `request_id`, `scope`, `synthetic` and `protected`, and one of these
chunk kinds:

| Chunk | Meaning |
| --- | --- |
| `text` | A visible text delta. |
| `message` | A completed message; `text` is what streamed. |
| `tool_call` | A call starts: `call_id`, `tool`, `format` `json` or `freeform`. |
| `tool_input` | An argument delta. |
| `tool_done` | The complete call with `arguments`. |
| `reasoning` | Observe-only. |
| `stop` | `status`, `usage`. Observe-only. |

`next` resolves to `{chunks}`; a handler returns chunks derived from it.

- Change `text`, `tool` or `arguments` (JSON-object arguments for `json` tools).
- Drop the chunk (`{chunks: []}`); dropping a `tool_call` drops the whole call, which never runs.
- At a `message`, `tool_done` or `stop` chunk, add `{kind: 'message', text}` and `{kind: 'tool_done', tool,
  arguments}` chunks, which get fresh `mod-…` IDs (added to a `stop` chunk they come before the response ends).
- A returned received chunk keeps every field it arrived with.
- Text changes are both shown and recorded: a `message` whose deltas changed is recorded as streamed.
- `reasoning` and `stop` chunks are observe-only.

#### Stopping a response and retrying

At a `message`, `tool_done` or `stop` chunk a handler may return `{stop: {reason}}` or `{stop: {reason}, retry:
{inject}}`.

- The host keeps the item, records a developer note that a mod stopped the response, ends it and optionally retries
  with `inject` as developer context, at most twice per turn.
- The retried request is a new attempt with its own admission and settlement.

#### `on('model_response')`

`on('model_response')` (capability `model`) fires once per provider attempt and synthetic answer. It is delivered
after the response from the delivery queue and may call host operations.

The payload carries:

- `request_id`, `attempt`, `ledger_request`, `scope`, `route`, `provider` and `credential` (profile ID).
- `requested_model` and `served_model`.
- `status`: `completed`, `incomplete`, `failed` or `cancelled`.
- `stop_reason` (derived): `end_turn`, `tool_use` or the incomplete reason.
- `output {text (first 4 KiB), tool_calls}`.
- Raw `usage`, and `cache {read_tokens, write_tokens}`.
- `cost {microusd, basis}`, where `basis` is `settled`, `unsettled`, `provider_reported`, `included_subscription`,
  `unpriced` or `synthetic`. A request without configured rates is `included_subscription` when it goes to the
  ChatGPT Codex backend with the signed-in account (the native session on a ChatGPT plan; credits spent past the
  plan's limit are not reported), otherwise `unpriced`.
- `context_window` when the session knows it.
- `timing {started_at_ms, first_event_ms, duration_ms}`.
- `synthetic` and `error`.

Live routes beyond the configured fixture providers are not exercised by OMD's tests.

### Final-request policy (`final_request_policy_v1`)

`model_send` (capability `middleware`) runs on the exact body each request sends, after history, `model_request`
and the host's route, effort, section and output-ceiling edits; only the removal of item metadata a provider
rejects and compression follow.

- It covers lead, sub-agent and mod worker requests (`model.complete`, `model.fork`) and the session's internal
  requests (titles, reviews, memory, guardian), whose `scope.kind` is `internal` and which have no `provider` or
  `route`.
- Every attempt runs it again: turn and stream retries, a mod's stop-and-retry, compaction and route switches
  rebuild the body, and a transport retry resends the bytes that passed.
- A synthetic answer sends nothing and skips it.

#### `model_send` input pages

The input is one page:

- `request_id`, `attempt`, `scope`, `provider`, `route` and `model`.
- `page` and `pages` (1-based).
- `cached`.
- `segments`: the non-empty string leaves of `instructions`, `input`, `tools` and `text` (and `prompt`, `images`
  and `traces` in image and memory summarization requests), except structural fields
  (`type`, `id`, `call_id`, `status`, `role`, `name`, `namespace`, `detail`, item metadata).
- `opaque` and `opaque_total`.

Each segment is `{id, kind, role, editable, text, bytes, sha256}`:

- `id` is the JSON pointer (`/input/3/content/0/text`).
- `kind` is the content kind: `agents_md.instructions`, `user.text`, or `message.<role>` without one,
  `instructions`, `tool_call.arguments`, `tool_call.input`, `tool_output`, `reasoning`, `tool_spec`,
  `output_schema`, `image.prompt`, `memory` or the item type.
- `bytes` is the UTF-8 size.

| Page limit | Value |
| --- | --- |
| Page | up to 96 KiB of JSON-encoded text |
| Piece of a longer segment | up to 80 KiB |
| Read-only `before` and `after` context per piece | up to 1 KiB |
| `opaque` entries | up to 256 in all |
| Pages per request | more than 128 refuses the request (`final_request_too_large`) |

A longer segment arrives in pieces, each with `offset` (where the piece starts in the whole text) and the `before`
and `after` context, so a match across a boundary is visible from both pieces.

`opaque` names values that are not scanned: images, audio and files first, then encrypted reasoning and compaction;
`opaque_total` counts every one.

#### `model_send` edits and denials

`next` resolves to `{edits}` from the policies beneath. A handler calls `next` and returns `{edits}` keeping all of
those plus its own, or returns `{deny}` (with or without `next`).

- An edit `{segment, start, end, text}` replaces `text.slice(start, end)` of that segment on this page; `start`,
  `end` and `offset` are JavaScript string indices, never inside a surrogate pair (up to 4 KiB of replacement text,
  256 edits, no overlap).
- Only `editable` segments take edits: message text of any role, including user prompts, tool-call arguments (which
  must still parse as JSON when they did) and freeform input, tool output text and instructions.
- Policy floors (`permissions.`, `network_proxy.`, `managed_config.`, `collaboration_mode.` and `guardian.` kinds),
  reasoning, tool specs and output schemas can only be denied.
- After the edits are applied every policy sees the changed segments again; a second round of edits refuses the
  request (`final_request_unsettled`), so every policy approved the exact bytes sent.

#### `model_send` verdict reuse

Verdicts are reused by segment digest, kind, role and `editable` for the same policy mods, their trusted sources,
settings and the host generation, and the same provider, route, model and `scope` (thread, agent and kind), so a
request pages only new text (`cached` counts the rest).

- An edit that leaves the text unchanged is ignored.
- A policy whose decision depends on anything else adds `cache: false` to its result, which every handler above it
  must keep, and those segments are paged again on the next request.
- At least one page runs for every request, with no segments when all are cached.

#### When a request is refused (`final_request_refused`)

A request is refused, visibly as a turn or call error starting `final_request_refused`, when:

- a required `model_send` interceptor fails, times out, returns an invalid result, belongs to a faulted mod or
  waits more than 5 s for a busy runtime;
- any policy denies; or
- edits are invalid.

#### Declared policies (`request_policy`)

A selection trusted with capability `request_policy` (which needs `middleware`) is a declared policy. While it is
enabled, every request is refused (`request_policy_unavailable`) unless that mod is loaded, healthy and has a
required interceptor selecting `model_send`, including after a rejected selection, failed activation, fault or
failed reload.

- Image generation and edits and memory summarization pass the stage too (input images arrive as `opaque`).
  Web search is not policed: it sends recent conversation text and its queries as they are.
- While a required `model_send` interceptor or a declared policy exists, realtime calls and their websockets are
  refused (`request_policy_unsupported_transport`, naming the endpoint and the mods whose policy blocks it);
  Responses websockets are always off under OMD.
- Disable the mod in `/mods` or `/omd` to send again (only the administrator can disable a managed policy).
- Status `request_policy_unavailable` names the reason every request is being refused, or is `null`.
- Without `model_send` interceptors or declared policies the stage does not run and the body is untouched.

#### Records and coverage of final-request policy

Records keep digests, never segment text: chain traces hash each page's input and result, and the request evidence
records `final_request` (pages, scanned and cached segments, each edit's segment, range and the digest of the
replaced bytes) or `final_request_refused` with its reason.

- Transcripts, rollouts and resume data keep the original text; a retried or later request applies the same cached
  edits again.
- Coverage is the text listed above; images, audio, files, encrypted reasoning, provider-side tools, mods' own HTTP
  and sidecars, and terminal, log and resume originals are outside it, and the stage proves only what its policies
  detect.

### Built-in controls

`api.builtins({commands: {hide}, modes: {disable}, surfaces: {disable}, features: {remove}})`, registered during
activation, removes slash commands, collaboration modes, native surfaces and Codex features from the next idle
boundary until the mod is disabled, unloaded or fails. Controls belong to the directory OMD was launched in and cover every thread of
that session, including threads in its worktrees.

- `surfaces: {disable: ['status_line']}` turns off the upstream `/statusline` row at its source: its configured
  items are neither computed nor polled and reserve no height, the user's `tui.status_line` setting is untouched,
  and the row still draws when other mods publish `status` segments.
- `features: {remove: ['prevent_idle_sleep']}` (`builtins_features_v1`) takes Codex features out of the session:
  they read as off everywhere, whatever `config.toml` or `-c` sets, and they leave `/experimental`, the app-server's
  experimental feature list, `codex features list` and tips. Removing `code_mode` also removes `code_mode_only`.
  Nothing is written to `config.toml`; disabling the mod brings back the rows and the saved values. A feature that
  managed requirements pin on stays on. Keys must be Codex feature keys (`invalid_builtins` otherwise).
- `/quit`, `/exit`, `/approvals`, `/permissions`, `/status`, `/logout` and the default mode cannot be removed.
- A disabled mode is absent from `collaborationMode/list`. A thread that requests or still holds one is reported in
  the default mode and runs its next turn there with that mode's instructions cleared and a warning (a `warning`
  notification for app-server clients), including the turn at whose boundary the mod loads.
- Tools limited to collaboration modes lose the disabled ones and are not offered when none remain.

### One-shot model calls and forks (`model_complete_v2`)

#### `model.complete`

`model.complete {route, prompt, system?, context?, output?, effort?, max_output_tokens?, timeout_ms?}` (capability
`agents`) runs one tool-less, read-only worker turn.

| Argument | Meaning |
| --- | --- |
| `route` | A configured worker route the mod may use, or `lead`: the thread's lead route, only when that route lists the mod in its `mods`. |
| `prompt` | The prompt (8 KiB). |
| `system` | Added beneath the host's own role instructions (8 KiB). |
| `context` | Up to 8 blocks, 32 KiB; precedes the prompt. |
| `output.schema` | Asks for structured JSON output. |
| `effort` | Picks the reasoning effort. |
| `max_output_tokens` | At most 128,000, never above a paid route's own ceiling; sent on every route, the included subscription too. |
| `timeout_ms` | The call's timeout (at most 300 s; see [Results](#results-of-modelcomplete-and-modelfork)). |

#### `model.fork`

`model.fork {prompt, route?, tools?, …}` (capabilities `agents`, `sessions` and `sessions_tools`) does the same on
a snapshot of the current conversation: the thread's committed model-visible history, with opaque reasoning kept
for a same-provider route and left out for another provider, on `lead` unless `route` names a worker route.

It is tool-less unless `tools` lists tools; their calls come back in `tool_calls` with `executed: false` and never
run.

#### Results of `model.complete` and `model.fork`

Both return `{status, text, content, tool_calls, stop_reason, error, route, model, request_ids, usage, cache, cost,
timing}` from the worker's `model_response` records:

- `usage` is the last request's raw value.
- `cache` sums `read_tokens` and `write_tokens` over the call's requests that reported them (`null` when none did).
- `cost` sums the settled charges (`null` when a request is unsettled or unpriced) with their basis.
- A response the provider cut at its token limit returns `status: 'incomplete'` with the text that streamed and
  `stop_reason` (`max_output_tokens`).
- A provider failure returns `status: 'failed'` with `error`.
- A timeout (at most 300 s) or cancellation ends the worker and throws.

Every request passes the `model_request` and `response_stream` interceptors and its own admission and settlement
under `worker_limits`; no task or turn is started for the caller.

They run in event, tool, timer and channel callbacks and in terminal slash commands, which reach the session in the
same process (`no session in this process` otherwise). Prompt cache reuse is reported by `cache.read_tokens`, not
promised: a fork is a separate internal session whose cache key and instructions differ from the lead's.

#### Prompt cache marks (`model_cache_v1`)

`cache: {through: 'system' | N}` (`model_cache_v1`) marks the request prefix through the worker's instructions or
through context block `N` as cacheable. The instructions are the last developer message before the turn's user
message, which holds the host's role text, a fork's frozen parent conversation and the mod's `system`; environment
context after it is not included.

On each of the call's requests the host:

- sets `prompt_cache_key` and the `session-id` header (the ChatGPT backend's cache routing) to `omd-cache-` plus a
  hash of the model, instructions, tools and that prefix's model-visible fields, so calls sharing a prefix share
  the provider's cache routing (OpenAI Responses caches prefixes automatically);
- sends `x-omd-cache-breakpoint: ITEM:PART`, the last cacheable `input[ITEM].content[PART]` of the final body, for
  provider transports with explicit breakpoints.

`omd_profiles` turns the breakpoint into Anthropic `cache_control` on that block (or on the system prompt when it
falls in the leading developer messages) and, for profiles set up with `--cache-control`, passes it on in Chat
Completions content for providers such as OpenRouter.

Cache reads and writes come back in `cache` and in each request's `model_response` record, priced with the route's
cached and cache-write rates; a provider that ignores the mark reports no reads.

### SDK helpers (`sdk_helpers_v1`)

The runner adds small helpers to `api`; each calls the host operations named here under the mod's own grants, and
none starts paid work implicitly.

- `api.package` is `{id, version, sha256}` of the running source.
- `api.session()` calls `session.info` (`inventory`): `{thread_id, root, cwd, codex_version, omd_version, model,
  provider, route, turns_started, process_id}` for the session thread, also from terminal commands in the same process.
  `cwd` and `model` are the thread's current working directory and model (a settings change shows at once), and
  `turns_started` counts turns this process started in the thread. `process_id` is an opaque ID of the OMD process, the same for every thread and mod in it; key per-process
  records in shared state, such as watch IDs, by it. `omd_version` (experimental) is the OMD release, as in the
  terminal `identity`.
- `api.fs.exists(path)`, `api.fs.canonical(path)` (`{path, kind, sha256}`) and `api.fs.ancestors(name, from?)`
  (nearest first, up to the workspace root from `from`, else from the session's cwd with `inventory` or the root)
  normalize workspace-relative paths and read through `workspace.stat` (`fs.read`); symlinked components and paths
  outside the workspace are refused there.
- `api.classify(text, labels, {route, instructions?, effort?, timeout_ms?, max_output_tokens?, cache?})` makes one
  `model.complete` on the named route with a JSON schema enumerating `labels` and returns `{label, result}`
  (`label` is `null` when the answer is not one of them).
- `api.usage.summarize(response)` turns a `model_response` into `{measured, tokens, context, cost, timing, …}`.
  Tokens are provider facts (`measured: false` without usage), `context.ratio` uses the session's context window
  when known, and `cost.source` says whether a charge is projected from configured rates (`configured_rates`),
  covered by a subscription, synthetic or unknown.
- `api.usage.rateLimits()` reads `account/rateLimits/read` when the mod holds `account`; window expiry stays as the
  provider reports it.

#### `api.time` helpers

- `api.time.sleep(ms)` calls `time.sleep {ms}` (`events`, at most 60 s): the callback waits in place, holding no
  runtime lock, and the wait does not count as own time; cancellation wakes it and ends the callback.
- `api.time.wait(check, {interval_ms, timeout_ms})` polls `check` between sleeps within the 512 host calls.
- `api.time.after(key, delay_ms, handler)` and `api.time.every(key, interval_ms, handler)` register during
  activation (16 ms to 24 h) and return `{start(), cancel()}` over `events.schedule`/`events.cancel` key
  `time:<key>`.
- `every` reschedules after each handler run until `cancel()`, the handler returns `false`, or a reload with
  changed source, disable or session end drops it (the host timer limits apply).
- A mod uses these or its own `on('timer')`, not both.

Where `time.sleep` is unavailable:

| Callbacks | Result |
| --- | --- |
| Callbacks that hold the runtime (offline steps aside) | `time_sleep_unavailable` |
| Render, `terminal`, `command_list`, `config_list`, `tool_specs`, `agent_offers`, `admission`, `composer_edit`, `composer_key`, `component_change` and `history_persist` callbacks, which run without host operations | `host_operation_unavailable` |
| `model_request`, `model_send` and `response_stream` interceptors, which run on the request path | `time_sleep_unavailable` |

Offline scenarios serve `events.schedule` and `events.cancel` themselves: `advance_time` fires due timers in order
at their virtual times (the step returns `timers`), and `time.sleep` returns at once.

### Streaming providers

Mod-owned model providers need no additional primitive: a `services` grant with a `route` runs a loopback server
that Codex uses as a Responses provider, which streams normally. `max_request_bytes` in `host.json` bounds request
size and has no host maximum, so a provider's context window is configuration.

## Agents, contracts and sessions

This page covers contracts and receipts, agents and their definitions, peer sessions, autonomous turns, user prompt
submissions, and lifecycle events with classic hooks. Use it when a mod spawns workers, gates completion on
receipts, talks to other sessions, queues its own turns or adapts classic hook names.

### Contracts and receipts

A contract is a versioned document that gates task completion and workspace integration on receipts. Mods register
documents; users select one.

#### Registering a contract

`api.contract(document)` registers a versioned schema-2 contract document:

```ts
{schema: 2, id, version, description, assurance, gates: {complete?, integrate?}, restrict?}
```

A requirement names a receipt kind, a producer (`any`, `lead`, `host`, `integration` or `separate_agent`), bindings
(`candidate`, `acceptance`) and whether blocking findings are allowed.

#### Selecting a contract

- Users select a contract with `omd-contract select STORE REPOSITORY ID@VERSION`.
- `omd-contract require` records a project floor in `.omd/contract-selection.json`.
- Selections pin the document digest. A mod that changes a registered document makes the selection unavailable
  instead of silently weakening it.
- A weaker selection needs the confirmation printed by `omd-contract plan`.
- With no selection nothing is gated.
- An unavailable selection fails closed.
- Old `workflow.json` selections are not imported.

#### `receipts.submit`

`receipts.submit` records a receipt with a host-attested producer.

- `agent` must be a completed, read-only agent handle owned by the caller in the same session, spawned on a
  snapshot of the receipt's candidate.
- `evidence` must be that agent's result reference.
- A claimed `acceptance_sha256` must equal the evidence the agent was given.
- An isolated-worktree agent cannot attest its own candidate.
- Only a successful `workspace.integrate` can record an `integration` producer; an execution receipt cannot
  impersonate one.

#### Completion, integration and restriction

`task.complete {candidate_sha256, acceptance_sha256?}` checks the current workspace against the `complete` gate and
returns `completed` or `refused` with the missing requirements.

`workspace.integrate` checks the `integrate` gate against the agent's candidate (`candidate_sha256` from
`agents.result`) and records an integration receipt tied to the resulting parent candidate and the supplied
acceptance digest.

- It refuses before touching the parent when the contract cannot hold another receipt.
- If the receipt cannot be recorded after the files are applied, the result is still `integrated` and carries
  `receipt_error`.

Pass `acceptance_sha256` to `task.complete` or `workspace.integrate` when the selected contract binds receipts to
acceptance criteria.

`contract.restrict` only narrows operations for the rest of the session.

#### Blocking findings and the finding ledger

For an active contract, blocking finding fingerprints remain open across later receipts and candidate changes.
`contract.status.finding_ledger` reports each finding and its resolution.

A passing `receipts.submit` from a completed, host-attested agent may include `resolves: [fingerprint, ...]` for at
most 32 distinct open findings. The resolution must use:

- a changed candidate;
- the original acceptance digest;
- a different agent from the reporting agent.

The resolving agent must be spawned read-only from a frozen snapshot with `resolution_context: {acceptance_sha256,
findings}` and the matching acceptance evidence. The host:

- delivers the open finding details;
- binds that context to the agent;
- checks a matching top-level `resolution_assertion` in the agent's actual JSON result before accepting `resolves`.

The assertion contains `outcome: "pass"`, `candidate_sha256`, `acceptance_sha256`, and the exact fingerprint set.
This attests the independent result and its declared review context; interpretation of the finding and fix remains
the agent's judgment.

- Submitting a clean later receipt does not erase an earlier blocker.
- The ledger survives explicit resume and is replay-checked on restore.
- `task.complete` refuses while any blocker remains, returning `reason: "unresolved_blocking_findings"` and
  `outstanding_findings`.
- A session without a selected contract remains ungated.

#### Scoped restrictions

`contract.restrict {operations?, scoped?, reason}` can also narrow matching arguments. Each scoped rule is
`{operation, when: {"/json/pointer": scalar}}`; all predicates must match.

For example, restricting `agents.spawn` when `"/workspace"` equals `"isolated_worktree"` leaves read-only agents
available.

- There are at most 64 rules with 1–8 scalar predicates each.
- Restrictions are monotone, and saved rules are validated again on restart.

#### Contract withdrawal and persistence

The host rechecks the selected document at each turn start and after a mod fails. If no active mod still registers
the same document digest, the contract becomes unavailable (`contract_withdrawn`). Completion, integration and
receipts fail closed until the same document is registered again.

Contract receipts and restrictions survive restart in protected session state. The selected document and owner must
still match; invalid state fails closed.

### Agents

#### `agents.spawn`

```ts
agents.spawn {role, route, prompt, workspace?, tools?, evidence?, snapshot?, parent_history?}
```

It starts a read-only or isolated-worktree agent on a worker route under the session's worker limits.

- `evidence` delivers a stored evidence reference to the agent.
- `snapshot` selects a frozen copy and requires `fs.read`. Its permission is always `read_only`, its result
  identifies the captured candidate, and it cannot be integrated as an edit.
- Permissions are rechecked when the agent starts.

#### Agent handles and limits

`agents.message`, `agents.wait` (at most 30 s), `agents.result`, `agents.cancel` and `agents.list` address only the
caller's handles.

- Calls on one handle run in order; a wait on one handle does not block calls on another.
- The host holds at most 16 agents, counting spawns in progress.
- Agents live until cancelled, the mod is disabled or fails, or the session stops.

#### Parent history and `sessions.snapshot`

`parent_history: true` additionally requires `sessions` and `sessions_tools` and delivers frozen parent
conversation records including visible tool calls and outputs. It refuses more than 8,192 records or 1 MiB instead
of silently truncating them.

- The spawn result includes the history digest, byte count, item count and revision.
- The records are labelled untrusted task data.

`sessions.snapshot {call_ids?}` preserves the same history in a caller-bound evidence reference and requires
`sessions`, `sessions_tools` and `store`.

- A selection contains 1–32 unique IDs and must include each complete call/output pair.
- Evidence storage's 256 KiB limit still applies.
- This does not expose hidden reasoning.

#### Agent failure details

Failed `agents.result`/`agents.wait` and `agent_end` retain an optional `failure: {category, code, message}` from
the host error. The same object is `error` on an `error` outcome of `turn_end`, `turns.activity` turns and
`agents.inventory` `last_turn`; `reason` names only an abort.

| Field | Meaning |
| --- | --- |
| `category` | `transport`, `rate_limit`, `authorization`, `sandbox`, `allowance`, `invalid_request` or `unknown` |
| `code` | Preserves the structured protocol error |
| `message` | Bounded to 1,024 characters |

Missing details are unknown, never evidence of an outage. Mods own retry policy; the host owns admission.

#### Explicit thread resume

Explicit thread resume reopens the same task ledger, preserving requests, exposure, observed lead usage and
uncertain in-flight requests.

- Repository, thread identity, original limits and saved journal must validate.
- Implicit reopening, changed limits and completed tasks are refused.
- Agent handles and snapshot handles do not survive process restart; mods must reconcile saved pending work without
  silently spawning replacements.

### Agent definitions, inventory and spawn interception (`agent_lifecycle_v1`)

#### Agent definitions

```ts
api.agent({name, description, instructions, route?, effort?, tools?, offer?})
```

It registers up to 8 definitions per mod during activation, named `<mod>/<name>`. Configured and built-in role
names always win.

With `offer: true` the definition appears in the native `spawn_agent` role list, after `agent_offers` interceptors,
which may drop or re-describe offers but never add, rename or reassign one.

A model that names a definition, or a mod that calls `agents.spawn {definition, prompt}`, gets:

- the definition's instructions as subordinate developer instructions;
- its route: a lead route on the thread's own provider for native spawns, a worker route for mod spawns;
- its effort;
- when `tools` is set, only those tools: other tools are hidden from the child and refused if called
  (`agent_tool_denied`).

A definition that disappears with its mod's reload or disable can no longer be spawned
(`agent_definition_unavailable`). Running agents keep going and their inventory records keep the source digest.

#### `agent_spawn` interceptors

`agent_spawn` interceptors see every model `spawn_agent` call and every mod `agents.spawn` as:

```ts
{origin, caller, thread_id, agent_id, definition, prompt, model, effort, cwd, tools}
```

They may change:

- `definition` (retarget);
- `prompt`;
- `model`;
- `effort`;
- `cwd` (native spawns only: the session root or one of its `git worktree list` entries);
- `tools` (narrow only);

or answer `{deny}`.

- `next` runs the spawn and resolves `{agent_id, output, success}`. Outer handlers may rewrite `output` but not the
  identity or outcome.
- A `cwd` or `tools` change on a configured role is refused (`agent_spawn_override_requires_definition`): express
  it as a definition.
- The host re-checks route admission, worker limits and the parent's permission profile after the transform. Nested
  tool and model calls of the child go through interception and admission as usual.
- With `agent_spawn` interceptors registered, native spawn calls reach them instead of `tool` interceptors.

#### `agents.inventory`

`agents.inventory` returns every agent of the session: model spawns, mod workers and engine-started sub-agents
(`origin`). Each record carries:

- the parent thread and agent;
- the owner mod, definition and source digest;
- role;
- status (`running`, `completed`, `failed`, `cancelled`);
- start and end time, and duration;
- turn count;
- the last turn's outcome and visible answer;
- the final visible answer (4,096 characters);
- usage, described below;
- the failure or cancel reason.

Usage is summed from `model_response` reports (`source: accounting`). `basis: unknown` means nothing was priced and
`partial` means some responses were unpriced. For engine sub-agents outside OMD accounting, such as review, usage
is the engine's token totals (`source: engine`, request count and cost unknown).

A mod worker's `agent_id` is its handle. At most 64 finished records are kept.

#### `agent` middleware event

The `agent` middleware event delivers `{phase: 'start' | 'turn' | 'end', agent}` with the same record, in order and
under the state of the session thread at the root of the agent's parents.

Observation grants nothing: `agents.message`, `agents.wait`, `agents.result` and `agents.cancel` still address only
the caller's own handles.

### Peer sessions (`peer_sessions_v1`)

A mod with the `peers` authority grant declares `peer_access: {projects: "same" | "any"}`. While at least one
loaded mod holds the grant, each lead thread registers a peer session in the mod store (`peers/`), live while its
process holds the session lock.

#### `peers.list` and `peers.send`

`peers.list {package?}` lists other live sessions where that package (the caller by default) accepts messages.
Sessions in other repositories appear only when both packages declare `"any"`.

`peers.send {to, package?, data, correlation?, ttl_ms?}` writes the message to the recipient's mailbox and returns
`{id, status: 'queued'}`.

| Limit | Value |
| --- | --- |
| Data | at most 64 KiB |
| TTL | 1 s to 1 h, default 60 s |
| Waiting messages per recipient | 64 |

| Error | When |
| --- | --- |
| `peer_closed` | The recipient is closed |
| `peer_scope_denied` | The scope does not match |
| `peers_unavailable` | No broker is deployed; every peer operation fails closed |

#### Peer message authentication and delivery

Every message and receipt is countersigned by the authority broker over the canonical digest of its sender identity
(session, repository, package and source digest), recipient, correlation, data and expiry, so only pinned OMD
binaries can mint one.

The recipient session:

- verifies the tag;
- drops replays of a message ID it already took;
- answers expired messages with `expired`;
- re-checks its own package's scope;
- runs `peer_receive` interceptors, which may transform `data` or refuse;
- calls the package's `peer_message` handler with `untrusted: true`.

Senders' `peer_send` interceptors may transform `data` or refuse before the message is written.

#### `peer_receipt` events

The sender's package gets `peer_receipt` events:

| Event | Meaning |
| --- | --- |
| `delivered` | The message was delivered |
| `refused` | The recipient refused it (with reason) |
| `failed` | The handler threw |
| `expired` | The message expired |
| `closed` | The recipient's time ran out without a receipt and its session is gone |

Receiving never starts a turn, changes roots or routes, or lends authority; a receiver that wants to act queues its
own work under its own grants. Revoking or expiring the grant, disabling the mod or stopping the session closes the
registration.

### Power holds (`power_hold_v1`)

A mod with the `power` authority grant keeps the Mac awake. `power.hold {reason, lid_closed?, max_duration_ms, lease?}`
returns `{lease, lid_closed}`; passing a `lease` that is still live with the same `lid_closed` returns it unchanged,
otherwise a new lease starts. `power.release {lease}` returns `{released}`, false when the lease already ended or
belongs to another mod. Only event callbacks (lifecycle events, timers, channels) may hold
(`host_operation_event_only` otherwise).

Every lease holds an idle-sleep assertion, so the Mac doesn't sleep from inactivity while the lid is open; the display
may still sleep. With `lid_closed: true` the lease also asks the authority broker to set `SleepDisabled`, which keeps a
closed Mac running on battery. Leases from every mod and OMD process share that setting: the first records the previous
value and the last one to end restores it, then sleeps the Mac if the lid is closed.

A lease ends at `power.release`, after `max_duration_ms`, when the session stops and when OMD exits or crashes. A
disabled, failed or changed mod loses its leases at the next host event in the session. If the broker or its helper
exits, the setting is restored and the lease ends, so holding again with that `lease` starts a new one.

| Limit | Value |
| --- | --- |
| `reason` | 1 to 128 bytes |
| `max_duration_ms` | 60 s to 24 h |
| Live leases per mod in a session | 4 |

| Error | When |
| --- | --- |
| `power_unavailable` | `lid_closed` without the deployed broker, or a broker installed before power holds (run `omd-package broker install` again); lid-open holds still work |
| `authority_power_unavailable` | The broker's power helper is not installed or could not change the setting |
| `power_lease_limit` | The mod already holds 4 leases |
| `host_operation_event_only` | `power.hold` from a tool, CLI or component callback |
| `power_request_invalid` | `reason` or `max_duration_ms` is out of range |

### Autonomous turns (`autonomous_turns_v1`)

A mod with the `autonomous` authority grant declares:

```ts
autonomy: {max_queued (1-16), max_turns (1-100), max_continuations? (0-4), spend_microusd?}
```

#### `turns.queue`

`turns.queue {prompt, key, priority?, deadline_ms?}` works from any callback, including timers, channels and peer
messages, and queues the prompt for the caller's lead thread.

| Argument | Limit |
| --- | --- |
| `prompt` | 8 KiB |
| `priority` | `high`, `normal` or `low` |
| `deadline_ms` | 1 s to 24 h |

A key already queued by the same mod returns `duplicate`.

#### How queued turns start

- The host starts the best entry (priority, then age) one second after the thread goes idle, through the engine's
  start-if-idle path. Typed input that arrives first wins, and the entry waits for the next idle.
- The turn's message begins with `[Queued by mod <id> on <event> (key <key>); not typed by the user]`, and its
  trigger is `mod:<id>`.
- The `prompt` event's `provenance` and the `input` interceptors' `origin` name the package, source digest,
  originating event and key.
- The turn keeps the thread's route, permissions and approvals.

#### `turns.queued`, `turns.dequeue` and `turn_queue` events

`turns.queued` lists the caller's entries, turns started and settled spend. `turns.dequeue {key}` removes one.

The owner gets `turn_queue` events:

- `started`;
- `expired`;
- `dropped`: `stale_generation` after a source change or unload, or `grant_expired`;
- `denied`: `turn_budget_exhausted` or `spend_budget_exhausted`;
- `failed`.

Interrupting a turn (Esc) pauses every mod queue of the thread until the user next sends input. Disabling the mod
or revoking its grant drops its entries.

#### `turn_stop` interceptors

`turn_stop` interceptors run when the model would end a lead turn, and after a lead turn fails without being
interrupted. They receive:

```ts
{turn_id, outcome, error, message, continued, limit, provenance}
```

`outcome` is `completed` or `error`.

Answering `{continue: prompt}` keeps the same turn sampling with a labelled continuation, at most
`max_continuations` per turn for that mod and 4 in total. Continuations cannot mark verifiers passed or submit
receipts.

### User prompt submissions (`user_submissions_v1`)

A mod with `composer` can hold prompts the user captured and send them later as the user's own messages.

#### `prompts.consent`

`prompts.consent {text, attachments?}` (61,440 bytes, at most 8 image resources) runs only in user contexts (a
command, key binding or user component action). It records a single-use consent bound to the mod, the thread and
the exact content.

- At most 64 consents are pending per mod and thread, and consents of mods that are no longer loaded are dropped.
- Consents live in the mod store outside mod state and are not copied into forks.

#### `prompts.submit`

`prompts.submit {consent, text, attachments?, mode, client_id?}` works from any context. It spends the consent on
exactly that content and submits it through the terminal's own path as a user message, under the thread's
permissions, route and spending.

- `mode: 'turn'` starts a turn when the thread is idle.
- `mode: 'steer'` steers the running turn.

It returns `{status: 'started' | 'steered', client_id}` or, without spending the consent, `{status:
'not_submitted', reason}`. A spent, changed or missing consent fails.

The `reason` values are:

- `busy`;
- `no_active_turn`;
- `session_starting`;
- `input_held`, while the terminal holds its own queued input after a disconnect, an unconfirmed submission,
  rate-limit recovery or an unavailable thread.

#### `prompts.status` and `prompts.revoke`

`prompts.status {consent}` is one of:

- `pending`;
- `missing`;
- `delivered`: the message with that `client_id` was committed to the thread, also when replayed on resume;
- `unconfirmed`: spent, but no commit seen.

A caller can use it to reconcile an uncertain submission instead of sending twice. `prompts.revoke {consent}` drops
one.

A consent never grants autonomous authority: anything not captured by the user still needs `autonomous`.

### Lifecycle events and classic hooks (`lifecycle_events_v1`)

#### Lifecycle events

Observe-only events (capability `lifecycle` unless noted), all for the lead thread:

- `tool_batch_end {turn_id, calls: [{call_id, tool, outcome}]}` after every call one model response dispatched has
  settled.
- `instructions_loaded {kind, source, sha256, bytes, reason}` when the host loads AGENTS.md instructions
  (`instructions`, at `session_start` or on `refresh` when they change), a skill (`skill`, `explicit` or
  `implicit`) or a user attachment (`attachment`).
- `thread_settings {cwd, roots: {added, removed}, model, effort, provider}` with `before`/`after` values after the
  thread's working directory, workspace roots or model settings change.
- `worktree {phase: 'created' | 'removed', path, owner: 'agent' | 'tui'}` for isolated agent worktrees and
  worktrees the terminal creates or removes.
- `elicitation_result {server, request_id, action, content, by}` (capability `approvals`) after an MCP elicitation
  is answered; password and write-only fields are `[redacted]`, and `content` is the string `[redacted]` when the
  host no longer holds the request's schema.

#### `elicitation` interceptor

`api.intercept('elicitation', …)` (capability `approvals`) sees MCP form elicitations before the user is asked:

```ts
{server, request_id, mode, message, schema}
```

A handler may answer:

- `{accept: content}` (only declared fields and every required one);
- `{decline}`;
- `{cancel}`.

Passing it on asks the user. URL and user-verification elicitations and forms with password or write-only fields
are never offered to mods.

#### `api.hook`

`api.hook(name, [options], handler)` adapts the 33 classic hook names onto these events and the existing events and
interceptors.

| Classic hook | Event or interceptor |
| --- | --- |
| `PreToolUse` | `tool` |
| `PostToolUse`, `PostToolUseFailure` | `tool_result` |
| `PostToolBatch` | `tool_batch_end` |
| `PermissionRequest` | `approval` |
| `PermissionDenied` | `approval_result` |
| `UserPromptSubmit` | `input` |
| `UserPromptExpansion` | `prompt_expanded` |
| `SessionStart`, `SessionEnd` | `session` |
| `Setup` | `start` |
| `Stop`, `StopFailure` | `turn_stop` |
| `SubagentStart`, `SubagentStop` | `agent` (model-spawned) |
| `TaskCreated`, `TaskCompleted` | `agent` (other workers) |
| `TeammateIdle` | `idle` |
| `PreCompact` | `compaction` |
| `PostCompact` | `compaction_end` |
| `PreModelSwitch` | `model_request` |
| `PostModelSwitch`, `CwdChanged`, `DirectoryAdded` | `thread_settings` |
| `ConfigChange` | `config_change` |
| `InstructionsLoaded` | `instructions_loaded` |
| `FileChanged` | `workspace_change` |
| `WorktreeCreate`, `WorktreeRemove` | `worktree` |
| `Elicitation` | `elicitation` |
| `ElicitationResult` | `elicitation_result` |
| `MessageDisplay` | `model_response` |
| `Notification` | `app_notification` |

#### Hook handler input and delivery

The handler receives:

```ts
{hook, event, subject, thread_id, turn_id, origin, generation, original, effective, delivery}
```

`options.match` filters the hook's subject (for example the tool name) with exact values, arrays, regular
expressions, `api.match.glob(pattern)` and `api.match.not(matcher)`, which also work in interceptor `match`
options.

- Interceptor-backed hooks may be `required` and may return an answer such as `{deny}` or `{continue}`; returning
  nothing passes the call on.
- Event-backed hooks are delivered best-effort (`delivery: 'optional'`).
- A mod that uses a hook cannot also register the same native event itself.
- Hooks may be registered only during activation, including when their native event is already registered.

## App bridge, approvals and tools

How a mod reaches the app-server, takes part in approvals, wraps operations with interceptors, and shapes tool
output, tool lists and dynamic tools.

### App-server bridge (`app_v1`)

#### `app.request` routes

`app.request {method, params}` sends a method listed by `app.routes`. Each route names:

- a capability class;
- allowed contexts: `user` commands or `event` callbacks;
- whether a native confirmation is needed;
- the thread scope.

#### `app.request` parameter rules

Each route lists the parameter fields it accepts; any other non-null field is refused. Authority fields (approval
policy, sandbox, permissions, config, roots, environments, dynamic tools, base instructions, service tier) and
fields added by a later upstream stay closed until reviewed.

- `model` and `modelProvider` are allowed only as a configured route: each must match a `host.json` lead route, and
  when both are given, the same one. `modelProvider` needs `model` with it (`app_route_model_required`).
  `thread/settings/update {model, modelProvider}` moves the current thread to that provider from its next turn, as
  picking another provider's model in `/model` does.
- `thread/start` and `fuzzyFileSearch` roots must be the session root or one of its `git worktree list` entries.
- Thread-scoped methods reach the current thread and threads the mod itself started or forked. Their other thread
  ids (`beforeThreadId`) must name one of those.
- Local image and audio inputs must be `{resource}` references; raw paths are refused.

#### `thread/attachmentOwner/list`

`thread/attachmentOwner/list` searches the whole configured thread store across projects. Omitting `archived`
includes both archived and non-archived threads.

It requires `account`, a user action and native confirmation naming the mod and exact lookup parameters; event
callbacks cannot invoke it.

#### Contexts and native confirmations

- Turn-starting methods run only from user contexts.
- `turn/steer` runs from events into a running turn.
- `mcpServer/tool/call` asks for a native confirmation on every call.
- A confirmation names the mod, the method and its exact parameters. A confirmed request whose parameters exceed
  2,000 bytes is refused (`app_confirmation_too_large`).

#### Config writes

Config writes accept only writable keys, never a table that contains an authority key (`features` as a whole), and
check every leaf of a table value as its own key.

- Under the protected `mcp_servers` table only `mcp_servers.<name>.enabled` is writable.
- Plugin keys are limited to `plugins.<id>.enabled` and a plugin server's `enabled`, `enabled_tools` and
  `disabled_tools`.
- Config writes, `config.set` included, refuse any Codex value containing `<redacted>`
  (`app_config_value_redacted`), so a read value cannot be written back masked; mod settings may hold the literal
  text.

#### `config/read` redaction

`config/read` results replace with `<redacted>`:

- every value of a `*headers`, `env` or `query_params` table;
- `shell_environment_policy.set`;
- the `args` of anything with a `command` (MCP servers, also under profiles and plugins);
- every string whose key ends in a secret word (`*_token`, `*secret`, `password`, API keys; not
  `*_credentials_store`);
- a provider's `env_key` unless it is an upper-case variable name with an underscore (`OPENAI_API_KEY`);
- every line that looks like a credential (bearer tokens, key prefixes, private keys, user information in URLs; the
  other lines of multi-line text stay).

They also reduce an MCP server `url` or provider `base_url` to scheme, host and port: user information becomes
`<redacted>@`, and anything after the host becomes `/<redacted>`. This applies in the effective config and in each
layer. `hooks/list` applies the same line rule to hook `command` strings.

#### Excluded methods and subscriptions

`command/exec`, `process/*`, `fs/*`, `thread/shellCommand`, `thread/inject_items` and credential flows are
excluded.

Declare `subscriptions.app` in the manifest to receive `app_notification` and `app_server_request` phases. For
`app_notification`, deltas are coalesced, with 256 events / 1 MiB per mod, and the oldest are dropped with a count.

Only the session's own app-server (TUI, `codex exec` or a headless `codex app-server`, see [External
clients](#external-clients-omd-client1)) is reachable; hosts without one return
`client_surface_unavailable`.

#### `app.respond` (`app_respond_v1`)

`app.respond {request_id, result}` (capability `approvals`) answers a server request that is still pending and
whose method the mod subscribes to, from user or event contexts, as the terminal's own answer. The first answer
wins and `serverRequest/resolved` closes the native prompt.

`result` can never grant authority (`app_response_refused` otherwise):

- Command and file-change approvals take only `{decision: 'decline' | 'cancel'}`.
- Permission requests take only `{permissions: {}}`.
- MCP elicitations take only `{action: 'decline' | 'cancel'}`.
- `item/tool/requestUserInput` takes `{answers: {id: {answers: string[]}}}` (at most 16 questions of 16 answers,
  16,384 bytes).

Approving stays with the `approval` middleware and the `approve` grant; a question answer still reaches the model
as the user's reply.

| Error | When |
| --- | --- |
| `app_request_not_pending` | The request was already answered |
| `client_context_changed` | The call is bound to a thread the terminal is not showing |
| `client_surface_context_changed` | The call's terminal binding changed before it ran (another client surface attached, or the shown thread changed); retryable |

`app.respond` needs the terminal; headless hosts and `codex exec` refuse it, and it is never delegated to external
clients.

### Approvals (`approval_v1`)

`approval` middleware sees exec, patch, MCP, network and permission requests before hooks, automatic review and
full-access shortcuts. It returns `null`, `{deny}`, `{ask}` or `{approve}`.

#### How answers combine

1. Any deny rejects.
2. Then any `ask` forces the native prompt, bypassing remembered session approvals.
3. Then an `{approve}` from a mod with a current `approve` grant whose `approves` scope covers the request (see
   [Unrestricted processes and delegated
   approvals](#unrestricted-processes-and-delegated-approvals)) runs it without a prompt. The host
   shows a native notice naming the mod and reports `approval_result` with source `mod`.

An approve outside the grant, an expired grant, an error, a timeout or an invalid result counts as `ask`.

#### Forbidden commands and non-delegable requests

- A command that the user's own execpolicy rules forbid reaches the middleware with `host_decision: 'forbidden'`.
  Only a mod holding `approve.override` can approve it; anything else keeps it forbidden.
- Managed requirements and other host denials never reach the middleware.
- Permission-escalation requests are not delegable.
- `assessment: true` marks a `tools.check` assessment, which never runs or prompts.
- `approval_result` reports the decision and its source.

### Continuation middleware (`continuation_middleware_v1`, `tool_continuation_v2`)

#### `api.intercept`

`api.intercept(pattern, [options,] (e, next) => result)` wraps an operation. `pattern` is a surface name, `*`, a
`*` glob or a `!` negation, and selects only surfaces the package's capabilities entitle:

| Surface | Capability |
| --- | --- |
| `tool` | `interception` |
| `input` | `input` |
| `model_request`, `response_stream`, `host_operation` | `middleware` |
| `tool_specs` | `tools` |
| `command_list`, `command` | `commands` |
| `config_list` | `config` |
| `config_set` | `config.write` |
| `admission` | `policy` |
| `render` | `terminal` |

Options are `match`, `required` and `before`/`after` (mod IDs).

#### `match` option

In `match`:

- a scalar matches by `===`;
- a RegExp tests a scalar as a string;
- an array is any-of and matches any element of an array value;
- an object matches part of an object.

`match` is checked against the input each interceptor actually receives, so a rewrite by an outer interceptor
reaches every guard that matches the new input.

A mod registers up to 16 interceptors during activation; `intercept` returns a registration whose `.catch(handler)`
sets a fallback handler.

#### Surfaces and what a handler may change

`e` is a frozen copy of the effective input, and `await next(e2)` runs the rest of the chain and then the native
executor. Only the listed fields may change:

| Surface | Replaceable | `next` resolves to | A handler may return |
| --- | --- | --- | --- |
| `tool` | `tool`, `arguments` | `{output, success, truncated, bytes}` | that result, a changed `{output, success}` of at most 256 KiB (the model sees at most 64 KiB, or the original's length if larger; a longer replacement is dropped with a diagnostic and the original stands), an answer without calling `next`, or `{deny}` |
| `host_operation` | `arguments` | `{value}` | `{value}` or `{error}`, with or without calling `next` |
| `input` | `text` | `{text}` | what `next` returned, or `{deny}` |
| `model_request` | `route` (one of `routes`), `effort`, `sections` | `{route, effort, cache}` | what `next` returned, `{deny}`, or a synthetic `{response}` without calling `next` |
| `response_stream` | `text`, `tool`, `arguments` | `{chunks}` | `{chunks}` built from the received chunk plus added ones, or a boundary `{stop}` |
| `tool_specs` | `tools` (drop, re-describe or set `deferred`) | `{tools}` | `{tools}` derived from what `next` returned: drop, defer or re-describe entries, never add or rename one |
| `command_list` | `commands` (hide, `description`, `args_hint` of ordinary rows) | `{commands}` | `{commands}` derived from what `next` returned |
| `command` | `args` | `{result}` | a changed `{result}`, an answer without calling `next`, or `{deny}` |
| `config_list` | `rows` (hide, `label` of ordinary rows) | `{rows}` | `{rows}` derived from what `next` returned |
| `config_set` | `value` | `{value}` | what `next` returned, or `{deny}` |
| `admission` | nothing | `{admit: true}`, `{withhold}` or `{deny}` | the same or a tighter decision |
| `render` | `props` keys the native drawing reads (see [Render hooks](#render-hooks-render_hooks_v1)) | `{tree}` | a `{tree}` of presentation components holding `{type: 'native'}` at most once, with or without calling `next` |
| `composer_key` | `key` (one printable character or a mod key name) | `{key}` | `{key}` with or without calling `next`, or `{deny}` to drop the key |
| `mention` | `path` | `{path}` | `{path}` with or without calling `next`, or `{deny}` to skip the read |

A `{deny}` refuses only before the native executor runs. Once `next` has run a `command`, `config_set`, `peer_send`
or `agent_spawn`, a deny is an invalid result, so an ordinary handler's inner result stands and a required handler
fails.

#### Tool inputs and answers

Tool inputs also carry `call_id`, `thread_id`, `agent_id`, `schema`, `raw_arguments` and `batch`. `arguments` is an
object for function tools and the raw string for freeform tools such as `apply_patch`, and a rewrite keeps that
shape.

- Native, MCP (retarget by the model-visible name, such as `mcp__server__tool`), mod, subagent, code-mode and
  batched calls all pass through the same chain with their own call IDs.
- Output beyond 256 KiB arrives truncated with `truncated: true`; `next` also resolves with the output's complete `bytes`, and
  [`tools.original`](#toolsoriginal-tool_original_v1) keeps the complete text as evidence.
- For a code-mode call, `next` also resolves with `value` when a mod intercepting `tool` requires `code_mode_values_v1`, the structured result the cell receives (omitted above
  32 KiB or when it and `output` together exceed 256 KiB), and an answer given without calling `next` may carry `value` (at most 64 KiB) for the cell instead of
  `output` (`code_mode_values_v1`). The model and every other caller see `output`. A `value` returned after `next`
  ran is ignored: the cell keeps the executed result.
- A tool or host-operation answer runs nothing: the host records the answering mod as `answered_by` on
  `tool_result` and in turn evidence, and the answer cannot attest that a file changed or a process ran.
- Input handlers cannot answer for the engine, so an outer handler cannot bypass an inner required one.
- A model-request answer skips the interceptors beneath it but sends nothing to a provider; its tool calls still
  pass every tool interceptor and native check.
- When a chain changes a tool's output, the host keeps the original as readable evidence of the mod that settled
  the result.

#### The `next` object and retries

`next` also carries:

- `event`;
- `origin`, set by the host: `caller` is `model`, `code_mode` (with `cell_id`), `user`, `engine` or the calling mod,
  plus thread, agent and call IDs;
- `signal.aborted`;
- `trace`: the entries beneath this handler on its latest call;
- `budget`: `ms`, `remainingMs`, `hostCalls`;
- `is(pattern)`.

Calling `next` waits in place while the host runs the downstream chain; code before `next` runs once and the wait
does not count as own time.

A handler may call `next` up to three times. Each call is a separate attempt through the same executor and
admission, so a retried write or request is a second effect.

- A tool's first attempt is the model's call.
- Each further `next` re-dispatches the effective call through the turn's tool executor under `<call_id>:retryN`,
  with native permissions, approvals, sandbox, accounting and its own `tool_result`, and resolves with that
  `call_id`.
- Interceptors beneath the retrying handler run again for it; interceptors above it see only the final result.

#### Interceptor order

Ordinary interceptors wrap required ones. Within each tier the order is:

1. explicit `before`/`after`;
2. consumers outside their dependencies;
3. mod ID;
4. registration order.

A cycle disables the mods that declared its edges with `interceptor_order_conflict` (a mod it only names stays
loaded). Naming one mod in both `before` and `after` is an invalid registration. Required interceptors therefore
see the final effective input.

A mod never intercepts its own host calls, and host calls made inside an interceptor are not intercepted. A tool
call a mod starts with `tools.invoke` passes through every other mod's interceptors with that mod as
`origin.caller`.

#### `tools.invoke`

`tools.invoke {tool, arguments}` runs a model-visible tool through the current turn's executor under a new
`mod-<id>-<n>` call ID, with interception, permissions, approvals, sandbox, accounting, cancellation and its own
`tool_result`, and returns `{call_id, output, success, truncated}`.

Calls from `timer`, `channel`, `process_event` and `approval_result` wait for the turn's running tools like a model
call, so they never overlap a tool that is not parallel-safe. Failures and denials come back as `success: false`.

#### `tools.check`

`tools.check {tool, arguments}` returns `{decision: 'allow' | 'ask' | 'deny', reason, authority}` without running
anything. The tool's own runtime computes the host requirement the call would meet:

| Tool | Requirement computed |
| --- | --- |
| `exec_command` | the command policy |
| `apply_patch` | patch safety (the patch is parsed and verified, nothing is written) |
| MCP tools | the server's approval mode, annotations and remembered approvals |
| Tools that always ask a person (`request_permissions`, `request_user_input`, plugin installs) | `ask` |
| Tools without an approval step | `allow` |
| Unknown tools | `deny` (`authority: 'host'`) |

Approval middleware then sees the request with `assessment: true` and no prompt follows. A mod's deny or ask, or a
granted `{approve}` of an `ask` (or an overridable user-rule denial), is reported with `authority: 'mod'`.

#### Availability of `tools.invoke` and `tools.check`

Both operations need `interception` and a turn in progress in the thread (`tools_unavailable` otherwise). Each
model request publishes its dispatch, so they work from the turn's first model request until it ends: in
interceptors, tool and output callbacks, timers and channel events that run meanwhile.

A tool interceptor can hold a call for a person with `terminal.prompt`. The wait does not count against its budget;
cancelling the call stops the wait, and a later answer is discarded.

#### `tools.original` (`tool_original_v1`)

`tools.original {call_id}` keeps the complete output of a call whose result is passing through a `tool` interceptor
chain as the mod's own evidence, up to 16 MiB (`blob_too_large` beyond), and returns `{reference, sha256, bytes}`. `reference` is a
`ResourceRef` to read with `evidence.read` in pages of at most 64 KiB, `sha256` hashes the complete text and `bytes` is its length.
Call it after `await next(e)` in the same callback with the input's `call_id`: the `output` a handler sees is cut at 256 KiB,
and `next` resolves with the complete length as `bytes` so the handler can tell. It needs `interception`.

It fails with `tool_original_unavailable` when the call's result is not in a chain, such as before `next` has
resolved, after the callback ended, for a call an interceptor answered without running it, or for an unknown call.
A retried call (`:retryN`) yields its latest attempt's original, and that `next` also resolves with `bytes`. Only a host call made from inside that call's own `tool` chain can read it; a timer, another event or another call's chain gets `tool_original_unavailable`.
The evidence is the mod's rotating evidence (the newest 1,024 records per mod and repository are kept, older ones are dropped down to 768, and the oldest go first while the blobs those records hold exceed 256 MiB; a process checks on its first write and then every 16 writes or 16 MiB).

#### Handler failures and skipped interceptors

A handler that throws, times out or returns an invalid result before calling `next` is skipped and the chain
continues with its input. After `next`, the downstream result is kept and nothing runs again.

A `.catch` handler runs instead with `next.error` (`kind`, `message`) and `next.called`; when `called` is true its
`next` resolves to the recorded result.

| Condition | Result |
| --- | --- |
| A failed required interceptor, a runtime still busy after 5 s, or a required interceptor of a faulted mod | The operation fails closed with `intercept_required_failed`; disable or reload the mod in `/mods` to recover |
| An optional interceptor and a busy runtime | It waits up to 2 s, then is skipped with `mod_runtime_busy` |
| An optional interceptor on a model request a mod makes itself, with the runtime busy | It is skipped at once with `mod_callback_in_flight` |

A skipped model-request interceptor appends `{kind: "intercept_skipped", surface, reason}` to
`mod-middleware.jsonl`. A reload during a chain lets running handlers finish; later operations use the new
generation.

#### Chain status and offline scenarios

Interceptors call host operations under their own grants with lifecycle-event access, including `terminal.prompt`.

The host keeps the last 16 chains in status `chains` with bounded inputs and results (values over 2 KiB become a
sha256 and byte count). Each trace entry names the mod, `location`, `outcome` (`returned`, `passed`, `skipped`,
`kept`, `caught` or `rejected`), attempts, own time and bounded inputs and results. Model-request chains are also
appended to the session's `mod-middleware.jsonl`.

The offline scenario step `{"type":"intercept","surface":"tool","payload":{...},"core":[{"value":...}]}` runs a
chain against queued engine results (`{"error":...}` rejects) and returns it without timings.

### Tool output, feedback, batches and specs

#### `tool_output` observers

`on('tool_output')` observers (`tool_feedback_v1`) return `{append}` of at most 4 KiB, 16 KiB per call in total,
added after any interceptor result at any output size.

- Handlers receive the first 256 KiB as `text`, the last 16 KiB as `tail` when the output is longer, and the total
  `bytes`.
- Image and audio items appear as `[image]` and `[audio]` markers.
- Tool-output callbacks may call every host operation their grants allow in lifecycle events, such as
  language-server exchanges or `model.complete`, before the model sees the result. The output waits for them.

#### `replace('tool_batch')`

`replace('tool_batch')` (`tool_batch_v1`) may merge parallel-safe calls of one response into one call of a tool the
mod registered. The merged call runs through ordinary admission and approvals, and results fan out by call id: the
merged tool returns an object keyed by call id whose values are the output text. A merge with
`success_per_call: true` (`tool_batch_success_v1`) instead reads each value that is exactly `{output, success}` as
that call's output and own success flag; any other value stays text. `tool` interceptors see the merged call with
call ID `<batch id>-merge-<index>` and that `batch` position.

#### `intercept('tool_specs')`

`intercept('tool_specs')` (`tool_continuation_v2`, `tools`) composes model-visible tool lists per route and request
without host operations: drop a tool, re-describe it, or set `deferred: true` to move it behind `tool_search`. A
model without tool search keeps deferred tools visible so they stay callable. Execution is unchanged.

#### `tools.list`

`tools.list` (`inventory`) returns the lead thread's tools from the latest router build:

```ts
{thread_id, tools: [{name, kind: 'builtin' | 'mcp' | 'extension' | 'dynamic', server, original: {description, parameters, freeform}, effective: {description, parameters, deferred} | null}]}
```

- `original` is what the tool registered.
- `effective` is what the model sees after `tool_specs` interceptors: `null` when one hid the tool, `deferred:
  true` for tools behind `tool_search` already.
- `kind: 'extension'` covers every tool an extension contributes, mod tools included.
- `server` names an MCP tool's server.

Lists are bounded like `tool_specs`: 512 tools, 4096-character descriptions, and a `parameters` schema over 16 KiB
is `null`. It fails with `tools_unavailable` before the thread's first turn builds its tools.

The host keeps the latest lead-thread snapshot in the store as `tool-inventory.json`, rewritten only when it
changes, and `omd-mod declarations STORE` renders it as `tool-types.d.ts`.

#### Argument validation after a rewrite

When a `tool` interceptor rewrote a call, or a `tool_specs` interceptor replaced the tool's `parameters`, the host
validates the call's final arguments against the tool's original schema before dispatch. It checks `type`,
`properties`, `required`, `items`, `enum`, `anyOf` and `additionalProperties`; other keywords are not checked.

A mismatch refuses the call with `tool_arguments_invalid: <tool>: <json-pointer>: <reason>`, with `/` for the root.
Freeform tools and tools without a schema are not validated.

### Dynamic tools (`dynamic_tools_v1`)

`api.dynamicTools(handler)` lets a mod define tools at run time.

| Operation | What it does |
| --- | --- |
| `tools.define {name, description, parameters}` | Adds or replaces a tool (at most 64 per mod, names distinct from its static tools) |
| `tools.undefine {name}` | Removes a tool |

Definitions take effect at the next model request, reach the handler as `{name, arguments}`, run from native event
and tool callbacks, and reset when the mod reloads.

## Processes, kernels and events

This page covers framed processes and their streaming, raster and pixel-buffer protocols, terminal list hooks,
code-mode kernels, library adapters, and the channel, process, watch and timer events. Use it when a mod runs a
managed process, feeds a terminal raster, or reacts to background events.

### Framed processes

#### `process.start` options

`process.start` takes:

- `framing: "content-length"` (default), `"ndjson"` or `"raw"`;
- `network: "none"` or `"loopback"`.

The protocol-named transports are removed.

#### `process.exchange`

`process.exchange` returns messages until the next one would push the encoded `messages` past 256 KiB (at most 64,
and always at least one), so a result fits a callback's receipt budget; the rest stays queued for the next call.

Once the process exits, its readers get one second to deliver what it wrote. Output queued by then is returned
before the exchange that fails with `process_stopped`. `process.status` reports `running: true` until it has been
exchanged, and an exchange's `send` is dropped.

#### `stdin: "null"`

`stdin: "null"` starts the process with standard input at end of file, for commands that would otherwise wait on an
open pipe. Its exchanges cannot `send` (`process_stdin_null`) and it cannot take `raster`.

#### Raw streams (`process_streams_v1`)

Experimental (`process_streams_v1`): under `raw` the host reads stdout and stderr as written and queues each read
(at most 8,000 bytes, so a chunk fits one exchange even when every byte is escaped) as `{stream: "stdout" |
"stderr", data}`.

- Bytes that are not UTF-8 arrive as their own `{stream, data_base64}` chunk between the text chunks around them,
  so one read can queue several chunks.
- A character split across writes arrives whole in the later chunk.
- The two streams are separate pipes, so chunks keep their order within a stream but not across streams.
- `send` takes strings, written verbatim.
- The queue keeps its bound of 128 messages: a process that writes faster than the mod exchanges blocks on its
  pipe, and nothing is dropped.
- `raw` cannot take `raster`, `keys` or `pixels`.

#### Process environment and sandbox

- The host replaces `{process.home}` in process arguments with that session's private scratch directory, for tools
  that do not honor the `HOME` environment.
- `environment` supplies at most eight explicit, bounded variables to that process. The host rejects its own
  reserved variables and loader overrides.
- Sandboxed processes also cannot read or write protected and credential paths.

With the `os` grant, `sandbox: "none"` starts a listed program (`path` and `sha256` still pinned) with the same
environment rules as unsandboxed `exec.run`; `network` comes from `os_access`. The host keeps ownership, limits,
cancellation and process-group teardown, and stops it when the grant expires or is revoked, the mod reloads or is
disabled, or its source changes.

#### Raster processes (`process_raster_v1`)

With `process_raster_v1` and the `terminal` capability, an `ndjson` process can take:

- `raster: KEY` (one of the caller's raster ids);
- optionally `keys: ID` (a `keys: true` component).

Its stdout messages `{"blit": {media_type, base64}}` are drawn into that raster by the host as `terminal.blit {key,
image}` from the mod, with the same validation, but without a callback per frame. The newest frame wins, and a
frame the terminal cannot take yet is retried for up to 5 s.

#### Pixel buffers (`raster_pixels_v1`)

With `raster_pixels_v1` and `pixels: true` the host also creates a private raw buffer and sends `{"pixels":
{"source": HANDLE, "path": PATH}}` on stdin before bound input. Without it the process gets no buffer and its raw
publications stop it with `terminal_blit_source_not_owned`.

The child opens that file, writes exactly `width * height * channels` packed bytes at offset zero, and publishes:

```json
{"blit": {"pixels": {"source": HANDLE, "format": "rgb" | "rgba", "width": W, "height": H, "sequence": N}}}
```

The equivalent mod call is `terminal.blit {key, pixels: {...}}`. Sequence numbers start at 1 and increase for each
publication.

#### Pixel publication acknowledgement

The child must not modify the buffer until stdin acknowledges `{"pixels": {"source": HANDLE, "sequence": N,
"ready": true, "error": null}}`.

- The host sends a successful acknowledgement when the next frame should start, not right after the copy: it aims
  the next publication just before the following 16 ms tick, using the time the producer took from its previous
  acknowledgement to publish.
- A producer that renders on each acknowledgement shows fresh frames with one copy per shown frame.
- An owned invalid descriptor or failed copy returns `ready: false` with an error at once.
- A failed copy does not consume the sequence, so direct callers may retry the same publication.
- Retrying an accepted publication reuses its copy without a second acknowledgement.

#### Pixel publication retries and backpressure

A managed producer's pending raw publication is retried while the process is active only for surface, layout and
callback admission errors (`terminal_blit_unknown`, `terminal_blit_not_owned`, `terminal_blit_limit`, `callback_*`,
`client_surface_*`). Any other error, and confirmed owner revocation, stops the process.

- While a raw frame waits for its 16 ms tick, a newer raw publication gets backpressure.
- A raster whose last frame stayed undrawn for four ticks (an inactive tab or unplaced layout) answers
  `retry_after_ms: 250` until it is drawn again.
- Backpressure neither copies nor acknowledges the buffer, so the same publication can be retried safely.

#### Pixel buffer safety and limits

- The host retains the original descriptor, copies a bounded immutable frame, and never reopens a child-supplied
  path. Replacing the pathname cannot redirect the read.
- Handles are bound to the thread, mod generation, raster and process lifetime; stopping/reloading the process
  revokes them.
- Frames are limited to 4096 pixels per side (64 MiB for RGBA), with one newest pending image per raster.
- General POSIX shared memory is not granted by the sandbox; the private file works under the existing process
  sandbox.

Raw frames reach Kitty without PNG encoding. Inline-image terminals and external PNG/JPEG clients receive encoded
snapshots scaled down to the raster's pixel size (a client's `cell_px`, else 8×16) and at most 8 MiB, and
cells-only clients receive half-blocks. Host paths and handles never reach external renderers.

#### Frame pacing and profiling

Frames are paced at 16 ms while experimental. Use `frame_ms` and `retry_after_ms` instead of hardcoded timing.
Encoded producers keep their stdin and stdout shapes.

For local profiling, `OMD_FRAME_TRACE=/absolute/new/file.jsonl` enables per-stage wall and thread-CPU timings; the
file must not already exist.

#### Raster pointer, key and box input

Other messages reach `process_event` and `process.exchange` as usual. Input on a bound raster is written to the
process's stdin instead of `component_event` callbacks:

| Input | Stdin message |
| --- | --- |
| Pointer events on the raster | `{"pointer": {action, button, x, y, inside}}`, with `x`/`y` in the drawn frame's pixels (null before a frame; sub-cell on terminals that report pixel positions) |
| Key and paste input on the keys component | `{"input": [events]}` |
| After the first render, and whenever the raster's drawable box or the client cell changes | `{"box": {columns, rows, cell_px: {width, height}}}` |

- A left press on the raster focuses the keys component.
- Bindings are scoped to the owning conversation thread.
- Input queues hold at most 128 messages and 256 KiB; consecutive motion and resize messages coalesce.
- Overflow or a write blocked for two seconds stops the process and discards queued input.
- The binding ends with the process.
- An invalid key or another framing is `process_raster_invalid`; without `terminal`, `capability_denied: terminal`.

### Terminal lists, insert, placeholder and glyphs

A `render` hook on component `list` draws built-in pickers as components; the host keeps keyboard handling,
selection and the chosen action. Components accept an `{insert}` action.

A terminal view may set `placeholder` and `theme.glyphs` (2–4 printable ASCII characters mapped to the same number
of characters; width-changing mappings are ignored).

### Code-mode kernels

Kernels are configuration: `[[features.code_mode.kernels]]` entries with `name`, `command`, absolute `driver` and
`driver_sha256` register kernels for the `kernel` code-mode tool. The driver hash is checked before each worker
starts; with no entries the tool reports that no kernel is configured.

### Adapters

A library package can declare `adapter_module: {entry, aliases}`. A dependent package with `adapter: "<package
id>"` is wrapped by that module before activation and may import its aliases. The adapted package keeps only its
own capabilities.

### Channels, processes and watches (`events_v1`)

#### `events.publish`

`events.publish {channel, data, correlation?}` publishes under the caller's namespace. Subscribers declare channel
patterns and receive `channel` events (256 events / 1 MiB per subscriber) in the publishing thread.

- Events whose originating thread is gone are dropped.
- Sequence numbers are independent per publisher/channel.

#### Channel counters

The host retains at most 256 channel counters per publisher and 4,096 process-wide. A new channel beyond either
limit fails with `channel_sequence_limit`, while existing channels remain publishable.

- On publication, counters for a publisher with no successful publication for at least 15 minutes and no queued
  events are reclaimed. Its next publication starts at sequence 1.
- Successful publication with no subscribers still counts as activity; rejected publication does not.
- Unsubscribing alone does not reset counters.

#### Process notifications

`process.start {notify: ['output','exit']}` delivers coalesced `process_event`s. `exit` fires once, when the leader
exits, even while a background child keeps the output streams open and more output may follow.

`process_event` exits carry only the session; read the exit status with `process.status`.

#### `workspace.watch`

`workspace.watch {paths, recursive?, debounce_ms?, include_ignored?, key?}` reports external edits as `workspace_change`
with source `external`.

- At most 16 watches per mod.
- A `key` (1-64 bytes) names one watch per mod in this OMD process. Calling again from the same thread with the
  same arguments keeps it; other arguments or another thread replace it without counting against the limit, and
  changes it already queued are still delivered. `workspace.unwatch {key}` stops it; `{watch_id}` stops one of the
  mod's watches. Keys require `workspace_watch_key_v1`.
- Protected paths are always excluded.
- Git-ignored paths are excluded unless `include_ignored` is true.

#### Callback delivery

- Watches and timers end when their mod is disabled or its source changes, and each delivery runs in the thread
  that registered it.
- A `channel`, `timer`, `process_event` or watched `workspace_change` callback that changes its mod's state
  republishes the terminal view, so background results appear without waiting for the next turn.

#### Timers (`timers_v1`)

`events.schedule {key, delay_ms}` (`timers_v1`) delivers one `timer` event `{key}` to the calling mod after 16 ms
to 24 h.

- Scheduling a key again replaces it within that thread.
- `events.cancel {key}` stops only that thread's timer.
- There are 16 timers per mod across all threads, including ticks pending delivery.
- Require `timers_16ms_v1` for delays below 1000 ms.
- Deliveries are spaced at least 16 ms apart per mod/thread, and each is a full callback: draw animation from a
  component module's frame clock instead.
- Pending ticks with the same key coalesce, and other owners continue while one owner waits for its budget.
- A timer never starts a turn by itself; only `turns.queue` under an `autonomous` grant can.

## Credentials and threads

How mods enroll and use credential profiles and secrets, how services get isolated launch snapshots, and how thread
store data, turn cancellation, turn activity and recorded sessions are read. Use it when a mod needs a token, a
secret or thread-scoped history.

### Credentials, secrets and routes (`credentials_v1`, `secrets_v1`)

#### Credential profiles and secrets

`credentials.list` returns profiles without secret material, with `status` `ready` once enrolled; secrets are
listed only to the mod that owns them.

`credentials.request` opens native flows from user contexts: ChatGPT sign-in, masked API-key entry, refresh and
removal, and `{kind: 'secret', label, origin}` for an origin-bound secret owned by the calling mod.

- Labels are unique in the store, so enrolling an existing label fails with `credential_profile_label_exists`.
- `{action: 'refresh', profile}` on the mod's own secret asks for a new value and replaces it.
- A mod can remove only its own secrets, and the confirmation names the profile's kind and label.

#### Routes and sidecars

Route entries may name a `credential`; its token replaces the request's authorization after upstream auth, and a
missing or expired credential blocks the request. `routes.select {route, scope}` applies a configured route at the
next request or for the thread.

`sidecars.start {id, credential?, secrets?}` injects a host-approved credential and the caller's own secrets
(`OMD_SECRETS`, JSON `[{id, label, origin, value}]`) into the sidecar only; values never reach the mod runtime or
the model.

`sidecars.status {id}` returns `{id, running, started_at_ms}` for a sidecar or provider service the caller started
in this process. Compare `started_at_ms` with a store entry's `provenance.at` to tell whether it predates a change.

#### Credential origins

Every credential profile sends its token to one origin, fixed at enrollment:

| Profile kind | Origin |
| --- | --- |
| `chatgpt` | `https://chatgpt.com` |
| `api_key` | `https://api.openai.com` |
| `provider` | The `https` origin passed as `origin` to `credentials.request {action: 'enroll', kind: 'provider', label, provider?, origin}`, which the enrollment prompt shows |

A route `credential` is injected only into requests whose URL has that origin; any other route fails with
`credential_origin_mismatch`.

#### Credential gateway (`credential_gateway_v1`)

Sidecars never receive credential tokens (`credential_gateway_v1`). When the host's service grant lists profile IDs
in `credentials` (network required), the sidecar gets `OMD_CREDENTIAL_GATEWAY`, a loopback URL with a per-sidecar
secret path that closes when the sidecar stops.

A request to `$OMD_CREDENTIAL_GATEWAY/PROFILE/PATH` is sent over HTTPS to `PATH` on that profile's origin with
`Authorization: Bearer` (or `x-api-key` when the request sets `x-omd-credential-header: x-api-key`) and the
response streams back. Redirects aren't followed. Stopping the sidecar cancels its in-flight gateway requests and
streams.

| Gateway limit | Value |
| --- | --- |
| Connections, globally | at most 16 |
| Forwards per registration | four |
| Connection and inactivity timeout | 30 seconds |
| Total deadline | 10 minutes |

#### `omd-mod credentials`

`omd-mod credentials STORE` lists profiles without secrets.

`omd-mod credentials STORE add-secret MOD_ID LABEL ORIGIN` reads a value from stdin and stores it as a secret owned
by `MOD_ID` for `ORIGIN`, the same profile `credentials.request {kind: 'secret'}` creates. It replaces the value of
that mod's existing secret with the same label and origin, prints the profile, and asks for broker authorization
when the authority broker is deployed. Package setup scripts use it to enroll a key without writing it to disk.

`providers.register {id, secrets?}` delivers owned secrets to a provider service as `sidecars.start` does. It reads
the store's `host.json` services at call time, so a grant written during the session needs no restart. A routed grant
with a loopback `responses_url` defines its `route.provider` for the process (at startup when its mod is active, and
at each registration) unless the configuration already defines it; a grant with exactly one secret uses it as the bearer token. A
thread resumed after its provider is gone continues on the configured provider.

`providers.models {provider, name?, models}` lists up to 16 models `{slug, display, context_window,
efforts, default_effort?}` in `/model`, grouped under `name` (1–64 bytes, default `provider`). It needs a running `providers.register` registration whose
grant `route.provider` equals `provider`. Each call replaces that provider's list; unregistering, a stopped service
or disabling the mod drops it. It returns `{provider, models}` (the count). The models get Codex's standard tools
(shell, freeform `apply_patch`, tool search). Picking one switches the thread to that provider from the next turn;
history carries over except reasoning another provider produced. A compaction checkpoint only another provider can
read is first rewritten as a plaintext summary by that provider (one request on its account); if that fails, the turn
shows a warning and runs without the summary.

#### Service launch snapshots

Service launches use private read-only sandbox snapshots of the package's admitted entrypoint and assets,
preserving their relative paths. Original package paths are denied to the child.

Grants may include `code_roots` mapping canonical dependency directories to SHA-256 digests of sorted JSON
`[relativePath, kind, value]` rows: `kind` is `file` with a content SHA-256 or `link` with an internal relative
target. Verified bytes are copied without reopening the source; `OMD_SERVICE_ROOT` names the snapshot root, under
which absolute dependency paths are mirrored.

Changed dependencies require a new grant. Reload and disable stop stale services before their IDs can be reused.

### Thread store, resume and turn activity (`store_thread_v1`, `turn_activity_v1`)

#### `turns.abort`

`turns.abort {turn_id}` (`threads`) requests cancellation of the named active turn in the current thread from a
user or event callback. Require `turn_abort_v1`.

- `{accepted: true}` means cancellation was accepted, not that cleanup has completed.
- A stale or absent turn, queued input or competing cancellation returns `accepted: false`.
- Tool callbacks cannot call it, and it cannot target another thread.
- Successful cancellation wakes idle listeners after cleanup.

#### Thread-scoped store and `resume`

`store.*` accepts `scope: 'thread'`: data forks with the thread, is removed when the thread is deleted and kept
when it is archived. `resume` carries `last_turn` and `restarted`.

#### `turns.activity`

`turns.activity {turn_id?, last?}` reads turn outcomes, tool calls, processes and file changes for the current
thread from event, tool and terminal slash-command callbacks, recorded only while an enabled mod's source calls
`turns.activity`.

- File changes come from the same workspace observer as `workspace_change`, which rereads only files whose size,
  ctime or inode changed.
- Commands record their exit code when they finish, including commands that outlive their tool call.
- The log is removed when the thread is deleted.

#### `sessions.list`

`sessions.list {since?, until?, cursor?, limit?}` pages this repository's recorded sessions that allow memory.

#### `sessions.read`

`sessions.read {session_id, revision, handle, cursor?, max_bytes?}` pages one session's
`local_visible_records`:

| Record | Fields |
| --- | --- |
| `message` | `role`, `text` |
| `tool_call` | `name`, `call_id`, `arguments` |
| `tool_result` | `call_id`, `output` (text parts only) |

- Each record has credential lines replaced by `[redacted]` (`redacted`; line endings kept) and is cut to 2,048
  characters with `truncated`.
- Without the `sessions_tools` capability, tool records carry `bytes` and `sha256` of their arguments or output
  instead of the text.
- Reasoning and other item types are left out.
- Pages hold at most 16 KiB, and a session at most 4,096 records (`projection_truncated`, the oldest are kept).
- A changed rollout fails the read against its `revision`.
- `sessions.list` and `sessions.read` serve mod CLI commands (`api.command(name, …, {cli})`) and `context`
  callbacks, not TUI slash commands.

Credential lines are those:

- naming a credential (`Authorization:`, `api_key`, `password=`, …);
- assigning a secret-like name (`TOKEN=…`, `"secret": …`, `AWS_SECRET_ACCESS_KEY=…`);
- holding a known token prefix (`sk-`, `ghp_`, `AKIA…`) or URL credentials (`scheme://user:password@`);
- private-key blocks.

## History and compaction

How a mod sees and changes conversation history: the bounded view of each model request, store-time redaction,
durable transcript rewriting and compaction interception. Use this page when a mod edits what the model sees, what
is stored, or how and when the thread compacts.

### Model-bound history (`history_v1`)

`replace('history')` receives a bounded view of each model request's items and may return `{drop?, replace?,
insert?}`.

Each item in the view carries:

- `index`
- `type`
- `role`
- `call_id`
- `editable`
- a 2 KiB text preview
- the byte size
- the `images` count

The view holds the newest items, at most 2048, that fit the callback's 4 MiB runner request, in order and keyed by
their original `index`.

#### History edit rules

- Messages, tool outputs and tool call arguments can be replaced; replacing a message with images keeps only the
  new text.
- A reasoning item can be dropped only together with the item it precedes, and an insert cannot separate them.
- Call and output items are dropped as pairs.
- The last item (the current input) is kept.
- Inserts are `user` or `developer` text.

The transcript and resume data are unchanged, each applied edit is recorded, and an invalid edit or failing mod
keeps the original request.

### Store-time history rewriting (`history_persist_v1`)

`api.intercept('history_persist', …)` (authority capability `history_persist`) rewrites history text before it is
stored, for redaction: every text written to the thread's rollout and the prompt-recall file
(`~/.codex/history.jsonl`). Each batch arrives as `{thread_id, entries}`; an entry is `{index, kind, role, call_id,
text}`.

#### `history_persist` entry kinds

`kind` is one of:

- a response item type:
  - `message`
  - `agent_message`
  - `reasoning` (summary and raw text)
  - `function_call`
  - `custom_tool_call`
  - `local_shell_call` (each command word and environment value)
  - `tool_search_call` (each string in its arguments)
  - `function_call_output`
  - `custom_tool_call_output`
  - `tool_search_output` (tool descriptions)
  - `web_search_call` (queries, URLs, patterns)
  - `image_generation_call` (the revised prompt)
- a text kept beside an item: `delivered_message`, `sender_user_messages`;
- an event copy:
  - `event:user_message`
  - `event:agent_message` (also a turn's last agent message)
  - `event:reasoning`
  - `event:plan`
  - `event:goal` (a thread goal's objective)
  - `event:command_execution` (command words, input and output)
  - `event:function_call_output`
  - `event:mcp_tool_call` (each argument string, result text, structured content string and error)
  - `event:dynamic_tool_call`
  - `event:file_change` (added and deleted file contents, diffs, stdout and stderr)
  - `event:web_search` (query, action and result strings)
  - `event:review` (custom instructions, hint, findings and explanation)
  - `event:image_generation`
  - `event:hook_prompt` or `event:collab_agent_tool_call` (the prompt);
- `inter_agent_communication`, `compacted` (a compaction summary and its replacement history) or `prompt_history`
  (a prompt-recall entry).

#### `history_persist` returns and batching

Return `{entries}` with only `text` changed, or pass a changed input to `next`. A reordered, added, dropped or
relabelled entry is rejected.

A batch is split across callbacks of at most 48 KiB of JSON-encoded entries (escaping counts). A longer text
arrives as consecutive entries with the same index, split after its last whitespace within the budget, so only a
long run without whitespace is cut inside a token.

#### `history_persist` effects and limits

- Item ids, call ids, roles, order and count never change.
- A rewritten response item carries `rewritten {revision, op: "redact", by}` and reads as not original. `by` names
  the mods whose link changed the text (`mod:<id>`) and `host` when entries were withheld.
- A rewritten user message drops its text elements.
- The interceptor gets no host operations.
- The live conversation keeps the original text until the thread is resumed, forked or rolled back from the
  rollout.

Not offered:

- identifiers, names, paths and status fields
- images and other binary payloads
- encrypted content
- extension-owned items (standalone web search, image generation and sleep)
- sub-agent activity
- realtime transcripts

#### `history_persist` failures

- A failing optional interceptor keeps the original text.
- A failing required interceptor, or a persist runtime that fails while one is installed, stores `[withheld: a
  required history_persist interceptor failed]` instead (a withheld prompt-recall entry is not written).

### Durable transcript rewriting (`history_rewrite_v1`)

A mod with the `history_write` authority grant changes the persisted transcript itself through `app.request
thread/rewrite {threadId, expectedRevision?, edits?, undo?}`, on the current thread or a thread it started.
Revoking the mod drops `history_write`.

#### Reading rows

Without `expectedRevision` the call only reads `{revision, rows}`; `edits` or `undo` without it fail with
`history_rewrite_invalid`.

Each row is `{id, turnId, kind, access}`:

- `kind` is `message.<role>`, the tool call type or a display item type.
- `access` is `edit`, `delete` (reasoning, web search, image generation and display-only items) or `frozen`
  (compaction, configuration and rows before the newest compaction checkpoint).

A row pairs a display item with its model items: a message, or a tool call with its output.

#### Edits

`edits` apply in order as one revision:

| Edit | Meaning |
| --- | --- |
| `{op: "delete", id}` | Delete the row |
| `{op: "replace", id, items}` | Replace the row's items |
| `{op: "insert", before? \| after?, items}` | Insert items; with neither `before` nor `after` it appends after the last row |
| `{op: "move", id, before? \| after?}` | Move the row |

- `items` is one Responses `message` (`user`, `assistant` or `developer`) or one tool call followed by its output
  with the same `call_id`.
- A replacement keeps the row's role or call id; an inserted call id must be new to the thread.
- A replaced or inserted message gets a matching display item.
- A replaced or inserted tool row keeps only its model items, so it leaves replay and export views.
- Images are referenced by `image_url` (a URL or data URL) or `file_id`.
- Host metadata in the items is dropped and ids are assigned by the host.

#### Rewrite errors

| Error | When |
| --- | --- |
| `history_rewrite_invalid` | `edits` or `undo` without `expectedRevision` |
| `history_rewrite_busy` | A turn is in progress or agent mail is pending on the thread. The check is repeated atomically when the thread unloads, so a turn that starts meanwhile is never cut off and the thread stays loaded; retry once it is idle |
| `history_revision_conflict` | A stale `expectedRevision` |

Any refused edit leaves the transcript unchanged.

#### What a rewrite does

A rewrite copies the whole edited transcript to a new rollout and switches the thread to it, so resume,
`thread/turns/list`, `thread/items/list`, search and export read the result. Every client receives
`thread/rewritten {threadId, revision}` and the terminal reloads the transcript. The replaced rollout is kept
unchanged.

- Each inserted, replaced or moved model item carries `rewritten {revision, op, source?, by: "mod:<id>"}` metadata.
  It loses the host's execution, delivery and tool-call inventory metadata and so never proves that a tool ran.
- The approval reviewer's transcript labels rewritten messages and tool rows as not original.
- Receipts, usage and evidence records are not rewritten.

#### Undo and the revision log

`undo: true` restores the transcript the latest rewrite replaced and keeps rows added since; undoing an undo redoes
it.

The host keeps a per-thread revision log, anchored by the authority broker when it is deployed. Resume fails with:

- `history_anchor_mismatch` or `history_original_mismatch` when the log or an original referenced by the latest
  committed rewrite changed;
- `history_anchor_unavailable` when the deployed broker cannot be asked.

An interrupted rewrite, including a record torn by a crash, is rolled forward or discarded on the next access.

### Compaction interception (`compaction_intercept_v1`)

`api.intercept('compaction', (input, next) => …)` (capability `compaction`) sees every compaction of the lead
thread once: manual `/compact` and automatic pre-turn, mid-turn and post-turn compaction, through local
summarization (`implementation: 'local'`), provider compaction (`'remote'`) or a token-budget reset (`'budget'`).

#### Compaction input

| Field | Meaning |
| --- | --- |
| `trigger` | The compaction trigger |
| `reason` | The upstream reason: `user_requested`, `context_limit`, `model_downshift` or `comp_hash_changed` |
| `phase` | `standalone_turn`, `pre_turn`, `mid_turn` or `post_turn` |
| `budget` | `{tokens, auto_limit, context_window, hard}` |
| item count | The number of history items |
| `history` | A bounded view: the newest 1,024 items, 512-byte previews within 128 KiB |
| `summary_prompt` | The summary prompt; `next` may change it only for local summarization |

`next` runs the host's compaction once (each provider attempt passes route admission, accounting and request
policy) and returns `{summary, history, usage, provider_call}`, where `history` views the new history.

#### Compaction handler answers

A handler that does not call `next` may answer:

| Answer | Effect |
| --- | --- |
| `{skip: reason}` | No compaction; automatic compaction is not offered again this turn |
| `{defer: reason}` | No compaction; offered again at the next trigger |
| `{summary}` | The host builds its standard history: recent user messages plus the summary, with no provider call |
| `{history: {keep, insert?}}` | A custom replacement history |

A handler that called `next` may replace its result with `{summary}` or `{history}`, whose indices then refer to
the new history.

- `keep` lists the items kept verbatim; tool calls and their outputs, and a reasoning item and the item it
  precedes, are kept or dropped together.
- `insert` adds `user` or `developer` text `before` an index.

#### Compaction refusals and failures

- The host refuses a replacement it estimates at the context window or more (`compaction_replacement_over_limit`).
- A skip or deferral when the context is already full (`budget.hard`) fails the turn with `compaction_required`
  naming the mod instead of compacting anyway.
- A failing required interceptor fails the compaction; a failure after `next` keeps the host's result with a
  diagnostic.

#### Compaction summarizers and results

A custom summarizer calls `model.fork` (the conversation on its own route) or `model.complete` and answers
`{summary}`.

Interrupting the turn cancels a waiting chain. The installed result persists as the normal compaction checkpoint,
so resume reads it.

`compaction_end` reports `outcome` (`compacted`, `replaced`, `skipped`, `deferred` or `failed`), `by` and
`provider_call`.

## Commands, configuration and composer

How mods list, describe and run commands, read and write Codex configuration, and take part in the composer: `@`
completion, drafts, suggestions, key interception and file mentions. Read it when a mod adds slash commands, wraps
settings writes or edits what the user is typing.

### Commands and configuration (`command_config_middleware_v1`)

#### Command listing and description

`commands.list` (`terminal`) returns `{commands: [row]}` for every built-in, service-tier and mod command the
composer can offer. `commands.describe {command}` returns one row.

A row is `{command, description, owner, hidden, args_hint, immediate, protected}`:

| Field | Meaning |
| --- | --- |
| `command` | The command name. |
| `description` | The description shown in the popup. |
| `owner` | Names the mod, or is `null`. |
| `hidden` | Whether the command is hidden. |
| `args_hint` | Comes from `api.command(name, handler, {args_hint})` and shows beside the description in the popup. |
| `immediate` | `immediate: false` (`api.command(..., {immediate: false})`) refuses the mod command while a turn runs (`command_unavailable_during_turn`). Built-ins report the engine's own rule. |
| `protected` | `protected` rows (`/omd`, `/quit`, `/exit`, `/approvals`, `/permissions`, `/status`, `/logout`) keep recovery and authority reachable. |

#### `commands.invoke`

`commands.invoke {command, args?}` (`builtins`, user contexts) runs a built-in or any mod command and resolves with
`{command, result}`. `result` is a mod command's returned value, or `{invoked: true}` for a built-in, which the
terminal dispatches with the effective arguments.

- Another mod's command runs only after a native confirmation, since its handler runs with that mod's grants.
- A mod command's display, insert and submit outcomes still apply.
- Runs nest at most four deep (`command_recursion_limit`).
- The permissions, sandbox elevation, logout, quit, exit, feedback and test-approval built-ins are refused.

#### `config.describe`

`config.describe` (`config`) returns `{rows: [row]}`: each enabled mod's settings as `mods.<id>.<name>` rows, then
the host-writable Codex keys present in the effective config.

A row is `{key, label, value, source, version, scope, editable, managed, secret, hidden}` plus `type` and `enum`
for mod settings:

| Field | Meaning |
| --- | --- |
| `source` | The config layer (`user`, `project`, `system`, `mdm`, ...). |
| `version` | The layer version. |
| `managed` | Marks managed layers. |

Secret keys and secret-bearing tables (headers, environment, tokens) show `<redacted>` and are never editable.

#### `config.set`

`config.set {key, value, expected?}` (`config.write`, user contexts) writes an `editable` row:

- Codex keys are written after a native confirmation through `config/value/write` with the described layer version.
- Mod settings are written through the same validation as `settings.write` (another mod's settings after a native
  confirmation).
- `expected` refuses the write (`config_stale`) when the value changed since it was read.
- A concurrent Codex write fails with the server's version conflict.

Every successful `config.set` and `settings.write` change raises `config_change {key, original, effective, source,
scope, caller}` for the other mods registered for it.

#### Command and configuration interceptor surfaces

Four
[continuation](#continuation-middleware-continuation_middleware_v1-tool_continuation_v2)
surfaces wrap these:

- `command_list` (`commands`) and `config_list` (`config`) compose rows without host operations: hide, relabel
  (`description`, `label`) or hint (`args_hint`) ordinary rows; a dropped ordinary row becomes hidden. Protected,
  managed and secret rows cannot change or be dropped, nothing can be added or renamed, and a failing list chain
  keeps the native rows. Hidden commands leave the popup and the typed-command lookup.
- `command` (`commands`) wraps typed, popup and `commands.invoke` runs of built-in and mod commands: rewrite
  `args`, transform `{result}`, answer with `{result}` or refuse with `{deny}` (`command_denied: reason`).
  Protected built-ins never pass through it, so a broken required interceptor cannot lock out `/omd`.
- `config_set` (`config.write`) wraps `config.set` and `settings.write` per key: change `value` or `{deny}`
  (`config_set_denied: reason`); the host re-checks editability, managed floors and the writable-key allowlist
  after the chain.

Interceptors of these surfaces skip their own mod's calls like every other surface, which bounds recursion through
`commands.invoke` and `settings.write`.

### Codex configuration (`codex_config_v1`)

A manifest's `codex_config` turns on Codex features the package depends on, for every lead thread the session
starts, resumes or forks while the package is active: `{"codex_config": {"tools.update_plan.enabled": true}}`.

- Keys come from a closed host allowlist (`tools.update_plan.enabled`, `tool_output_token_limit.raise`) and must be `true`.
- `tool_output_token_limit.raise` sets the thread's `tool_output_token_limit` to at least 65,536 tokens (about 256 KiB),
  keeping a larger configured value. `exec_command` and `write_stdin` still default to 10,000 tokens unless the call
  sets a larger `max_output_tokens`, which a `tool` interceptor can do. It makes no output smaller or safer: the
  package must budget model-visible outputs itself, or every long output reaches the model whole.
- The package must list `codex_config_v1` in `required_features`.
- Anything else fails inspection with `invalid_codex_config`.

The host recomputes the keys whenever it reloads the active packages (at the next turn boundary after a change), so
a package enabled mid-session applies to lead threads started after that reload; threads that already exist keep
their configuration. It overrides an explicit `false` in the user's config for those threads and writes nothing to
`config.toml`.

Install, update and trust previews and `omd-mod status` list a package's `codex_config` with its other authority.

### Composer completion (`completion_v1`)

#### `@` mention completion

`replace('completion')` receives each `@` mention query with up to 200 upstream candidates and returns
`{items: [{path}]}` in the order to show. Paths must be workspace-relative. Without an owner upstream ranking is
used; stale results are dropped.

#### Command argument completion

While the user types arguments to a mod command (`completion_arguments_v1`), the mod that registered the command
receives `{kind: 'argument', command, query, line}` when it handles `completion` (`api.on` or `replace`), otherwise
the exclusive owner does. It returns `{items: [{insert}]}` and the list opens only when it has items.

A mod can therefore complete its own commands without owning `@` mention ranking. Accepting an argument choice
advances past a separator and keeps completion closed until the draft or cursor changes, so the next Enter submits
the command.

#### Token completion

`api.completion({trigger}, handler)` (capability `composer`, `completion_tokens_v1`, experimental) completes
arbitrary tokens. `trigger` is one ASCII punctuation character other than `@`, `/` and `$`, and a mod registers at
most four during activation.

While the token before the cursor (from the last whitespace) starts with the trigger, the handler receives
`{kind: 'token', trigger, query, line}` (`query` without the trigger, `line` up to the cursor) and returns
`{items: [{insert}]}` with the same limits, debounce and stale-result dropping as argument completion.

The host shows the rows in the composer's completion list and, on Tab or Enter, replaces the whole token with the
selected `insert` and advances past a separator so the accepted token does not immediately reopen completion. When
two mods register the same trigger, the first loaded mod keeps it and the other gets a status notice.

### Composer drafts and suggestions (`composer_v2`)

#### `composer.read`

`composer.read` returns `{text, cursor, selection, revision, attachments, suggestion}`. `revision` advances
whenever the draft's text or attachments change, whoever changed them.

Each attachment has:

- a stable `id`;
- its placeholder `label`;
- its `owner` (`user` or the mod that attached it);
- an immutable image `resource` bound to the reading mod, its source hash and repository, with package lifetime
  across configuration revisions and thread forks (PNG and JPEG up to 8 MiB; otherwise `null`);
- the image's `width` and `height` in pixels when its header decodes.

#### `composer.write`

`composer.write {revision, edit?, cursor?, selection?, attach?, detach?}` applies only to that revision and fails
with `stale_revision` otherwise.

- `edit` is `{kind: 'fill' | 'insert' | 'append', text}` or `{kind: 'splice', start, end, text}` (byte offsets on
  character boundaries).
- `cursor` and `selection: {start, end}` place the cursor or select.
- `attach` adds image resources.
- `detach` removes attachments by placeholder.

The complete edit, positions and detach list are validated before the draft changes; rejected writes leave its
content and attachments intact. Queued client calls remain bound to their admitted thread, source generation and
active authority, including after confirmation. A write never submits. Images a mod attached leave the draft when
that mod is unloaded, reloaded or disabled.

#### `composer.suggest`

`composer.suggest {revision, id, text}` shows one dimmed suggestion after the cursor while the cursor is at the end
of that revision (4 KiB, first line shown); a newer suggestion replaces an older one.

- The user accepts it with the move-right key at the end of the draft (so a remapped `editor.move_right` applies)
  or by clicking it, and dismisses it with Esc.
- Any draft change, a turn start, an open dialog or the owner's reload clears it.
- `{clear: true}` withdraws the caller's own.

#### `composer` event

The `composer` event (capability `composer`) reports two kinds of payload:

- `{kind: 'change', revision, attachments_revision, origin}` to every subscriber (`attachments_revision` advances
  only when the attached images change), debounced to 250 ms.
- `{kind: 'suggestion', id, status: 'accepted' | 'dismissed' | 'cleared', reason?}` to the suggestion's owner.

#### `composer_edit` interceptor

`api.intercept('composer_edit', …)` sees every mod write and native fill before it reaches the draft: `{source:
'mod' | 'paste' | 'history' | 'completion', caller, revision, edit}`. Handlers may change only `edit.text` or
answer `{deny}`, which leaves the draft unchanged and tells the user. They run while the terminal applies the edit,
so they get no host operations. The whole chain, including any wait for a runtime busy with another callback, gets
50 ms; when that runs out a native fill applies unmodified with a status notice and a mod write is refused with
`mod_runtime_busy`. While a required interceptor selects `composer_edit`, a native fill is refused the same way.

#### `composer_key` interceptor

`api.intercept('composer_key', …)` (`composer_key_v1`, experimental) sees each key press or repeat that reaches the
prompt box, after mod key components, dialogs, chords and app key bindings and before popups and the editor keymap:
`{key, text, revision, cursor}`.

- A printable character without Ctrl or Alt is `key` and `text` as typed (`'a'`, `'#'`, `' '`).
- Any other key is its mod key name (`Ctrl+w`, `Enter`, `Shift+Tab`) with `text: null`.
- `text` is also `null` in vim normal mode, where characters are commands.

Handlers may set `key` to another character or to a key name valid in view `keybindings` or an unmodified named key
(`Left`, `Backspace`), which the composer then applies as if typed, or answer `{deny}` to drop the key silently.

- Paste bursts, bracketed paste and non-ASCII characters (IME) bypass the chain.
- The whole chain, including any wait for a runtime busy with another callback, gets 50 ms per keystroke and no
  host operations; when that runs out, or the result is invalid, the original key applies and a status notice
  shows.
- Use `match` on `key` so other keystrokes never start a callback.

#### `component_change` interceptor

`api.intercept('component_change', …)` (capability `terminal`, `ui_controls_v1`) runs before a user's focus or
scroll change is reported, and only for the mod that owns the component being left or entered: `{kind: 'focus', id,
from, to, origin: 'user'}` or `{kind: 'scroll', id, from, to, origin}`.

Handlers answer:

- `{deny}` to keep the previous focus or offset;
- `{focus: id}` to move focus to another of their own components (or `null` to release it);
- `{scroll: n}` to clamp the offset.

They run while the terminal handles the gesture, so they get no host operations. The whole chain, including any wait
for a runtime busy with another callback, gets 50 ms; when that runs out the change applies unchanged.

#### Submitted drafts and `prompt_expanded`

The `input` interceptors also receive the submitted draft's `revision`, `attachments` (`{kind, source}`) and
placeholder `elements` (`{kind: 'paste' | 'mention' | 'skill' | 'image', start?, end?, name?, source}`).

After skills and mentions are expanded, `prompt_expanded` (capability `middleware`) lists them by name, path and
SHA-256 only (`{kind: 'skill' | 'mention' | 'paste' | 'image', …}`), never their content, and the `prompt` event's
`effective` is the text the model receives.

### `@` file mentions (`mention_read_v1`)

#### What the host reads

When a turn starts, the host reads each `@path` or `@"path with spaces"` of the submitted text that names an
existing workspace file, and gives the model its contents after the prompt as
`<mentioned_file><path>…</path>…</mentioned_file>`.

- At most 16 mentions are read per turn.
- A leading `./` and unquoted trailing punctuation are ignored.
- Quoted paths use JSON string escaping and preserve punctuation, quotes and backslashes. An `@` inside a quoted
  path is part of that path.
- Picking a file from the `@` list inserts it in this form, except in a slash command or shell command, which get
  the bare path.

#### Read checks and limits

Reads use the `workspace.read` checks: repository-relative paths without `..`, `.git`, backslashes or symlink
components, and the intersection of the selected turn environment's filesystem permissions with the thread's
effective read permissions and deny rules.

- Expansion requires exactly one local environment at the thread's repository; other environments or working
  directories skip expansion.
- Each file is read once, in mention order, while the turn's mentioned files total at most 256 KiB of returned
  UTF-8 bytes, checked again after reading.
- A file that fails the checks, does not fit or is not UTF-8 is left to the model's own tools.

#### `mention` interceptor

Before each read, `api.intercept('mention', …)` (capability `input`, experimental) receives `{thread_id, path}`.
Handlers may set `path` to another workspace file, which is read under the same checks, or answer `{deny}` to skip
the read. They run beside the session like `input` interceptors and may call host operations; a failing chain skips
the read, and interrupting the turn cancels the chain.

## Terminal UI

How a mod draws in the terminal client: render hooks over native components, the startup presentation, the terminal
surface (layouts, documents, images, rasters, pointer events, overlays, the box model, prompts, notices and PTY
panes), and terminal identity. Read it when a mod restyles native output or adds panes, dialogs, sites or controls.

### Render hooks (`render_hooks_v1`)

#### Render interceptor and hook results

`api.intercept('render', {match: {component: 'tool_call'}}, async (e, next) => …)` draws one native terminal
component instance. `e` is `{component, id, surface, viewport: {columns, rows}, lifecycle, owner, props}`:

| Field | Meaning |
| --- | --- |
| `surface` | `inline` or `fullscreen`. |
| `lifecycle` | `live` while the component can still change and `final` once it cannot. |
| `owner` | `null` for host components. |

`next(e)` resolves to `{tree}`; the host's own drawing is `{type: 'native', style?}`. A hook can:

- observe: return what `next` returned;
- restyle: `style` takes `tone`, `bold`, `italic`, `underline`, `fg`, `bg`;
- wrap: place the native node in a tree;
- replace: return a tree without it;
- hide: return `{tree: []}`.

Trees hold `box`, `line`, `text`, `markdown`, `code`, `diff`, `list` and `native` components (64 components, depth
6, unique ids, 256 KiB); the native node appears at most once. Hooks compose as one continuation chain in
interceptor order, so unrelated wrappers nest, and each hook sees the props the hook before it passed on.

#### Render components

| `component` | `id` | Props (`RenderProps`) | Rewritable |
| --- | --- | --- | --- |
| `user_message` | content digest | `text`, `images`, `spoken` | — |
| `assistant_message` | content digest | `text`, `first`, `truncated` (the host cut `text` at 48 KiB; streamed chunks and the final message; the streaming tail is `live`) | — |
| `tool_call` | call ID (row ID for agent rows; `explore:<first call ID>` for an exploration group) | every agent tool row (`RenderToolCall`); see [`tool_call` props](#tool_call-props) | — |
| `tool_result` | call ID | `tool`, `success`, `text` (MCP results inside their call) | — |
| `spinner` | `main` | `header`, `elapsed_seconds`, `details`, `message`, `interrupt_hint` | `header` |
| `turn_duration` | `turn-<completed ms>` | `seconds`, `completed_at_ms` | — |
| `notice` | content digest | `kind` (`info`/`warning`/`error`), `text`, `hint` | `text` |
| `session_mode` | `collaboration` | `mode`, `label`, `cycle_hint` | `label` |
| `composer_hint` | `placeholder` / `footer` | `slot`, `placeholder`, `input_enabled` / `mode`, `text`, `task_running` | `placeholder` |
| `question` | item ID or content digest | `questions` (`id`, `header`, `question`, `secret`, option labels), then `current`, `queued` (live) or `answered`, `interrupted` (final) | — |
| `list` | view ID | `view_id`, `title`, `subtitle`, `items`, `selected` | — |

#### `tool_call` props

Every agent tool row (`RenderToolCall`) carries `call_id`, `kind`, `status` (`running`/`completed`/`failed`/
`interrupted`), `duration_ms` and `expanded`, and per kind:

| `kind` | Props |
| --- | --- |
| `exec` | `command`, `parsed`, `exit_code`, `output_lines`, `output_tail`, `user_shell` |
| `explore` | `calls` (grouped reads, searches and listings) |
| `patch` | `files` (`path`, `change`, `added`, `removed`), `error` |
| `web_search` | `action`, `query` |
| `agent` | `tool`, `agents`, `prompt` |
| `mcp` | `server`, `tool`, `arguments`, `output_lines` |
| `dynamic` | `tool`, `arguments`, `output_lines` |
| `image` | `tool`, `path`, `prompt` |

Group and file limits:

- Exploration groups contain at most 32 calls; larger sequences split into additional rows without dropping calls.
- Patch `files` contains at most 32 details; `file_count`, `added` and `removed` are complete totals across all
  changed files.

#### Grouped members

Grouped exploration and computer activity offer each member through `tool_call` as `exec` or `mcp`.

- When those member hooks replace the drawing, each member has its own focus, pointer region and `expanded` flag;
  `next` draws a collapsed member as its compact row, and Find searches every member expanded.
- Native grouping remains when no member is replaced.
- Aggregate exploration rendering remains available on the group when member rendering does not replace it.

#### Render hook behavior

Text props carry at most 48 KiB; a content digest is stable across resume and reflow, so equal content draws
identically. Tool rows are offered from live cells and committed history.

- In the fullscreen transcript a hooked tool row needs no control row: F4 focuses it and Enter, →/← or a click
  opens and closes it, and `expanded` is `true` while it is open and for every row of the full transcript (Ctrl+T),
  so a hook that shortens rows returns `next(e)` then.
- Selection copies what is drawn; raw mode never runs hooks.
- Approval overlays have no render hook: their identity, decision text, options, focus and grants stay native, and
  `surface_styles.approval` only paints the frame.
- A question hook changes the presentation only; answers, focus and keys stay with the native dialog.
- The existing panes, `above_composer` band and named sites stay declarative views.

#### Render callback runtime

Render callbacks get no host operations and cannot write state (`render_side_effect_refused`; a write during
activation stays local to that render); read `api.state` or atoms instead.

- Renders run in a runner that stays activated while the package revision, settings and persisted state stay
  unchanged. Changing state requires a new activation.
- Stateless renders can reuse the runner across rows, including renders that call `next`. Activation-local state is
  restored before each reused render. Module variables may survive between renders, so never draw from them.
- A tree lives until its input changes or a state key its hooks read changes. Live components redraw asynchronously
  and keep their last tree until the new one arrives, fullscreen transcript cells redraw the same way, and inline
  scrollback, which is written once, waits for each cell's hooks as it is inserted. A narrower or wider terminal is
  a new input.
- A hook that throws, times out or returns an invalid tree is skipped with the input it received, so the native
  drawing survives. A disabled or failed mod's hooks are gone at once, and every failed render joins the status
  `chains` log.
- With no `render` interceptor the host never calls a mod while drawing.

### Startup presentation (`terminal_welcome_v1`)

#### Presentation value

The terminal event's read-only `presentation` is `{thread_id, phase, surface?}`.

- `surface` is `fullscreen` when the terminal client draws on the alternate screen and `inline` otherwise (inline
  sessions never draw the `welcome` site); it is absent until the client has chosen its screen mode.
- A new thread is `fresh`, an accepted native turn start makes it `started`, and a resumed or forked thread is
  `resumed`, from existing host markers before the first ready publication.
- Before the first editable frame, a repeatable `event: 'startup'` callback has `ledger: null` and a null
  `thread_id`; its phase comes from the host's new/resume/fork selection.
- Native task, app and paid operations are unavailable through the host boundary.
- Before local presentation is available, the whole presentation value may be absent or null.

This is a presentation refresh, not a once-only session or turn event. Composer input, submission rejection,
ordinary view refreshes, and mod reload do not reset it. It describes the host session; mods do not need to persist
their own first-turn flag. A locally queued draft is not an accepted turn. Empty bootstrap snapshots preserve the
initial view; real disabled, broken or reloaded publications replace it.

#### `welcome` site

The reserved `welcome` site renders bounded generic components centered in the owned transcript's unused area.
`welcome: {show_while_composing: true}` keeps the site visible with a draft, including while the slash-command, file
or mention popup is open; the default shows it only with an empty composer.

- Accepted/running and resumed sessions, transcript selection/search, raw output and overlays suppress it.
- Any history beyond the startup header and notices (a command's output, a rejected submission) hides it until a new
  thread, like Codex's own welcome.
- Approvals and input retain their space; if no blank space fits the components, the site does not draw.
- Inline output retains the native transcript without the centered decoration.
- No welcome site preserves Codex's normal blossom policy.

#### Title suffix and greeting

- `session_title_suffix` appends up to 80 visible characters to the upstream version heading, including inline/raw
  output; the host keeps its source-backed version and attribution.
- `greeting` overrides the startup phrase with up to 256 visible characters, and an empty string hides it.

Both are last-writer scalars in dependency order, then mod ID order, so a later opt-in theme can override an
earlier presentation default. Escape/control injection is refused. Disable, a broken mod, or direct mode restores
the upstream fields.

### Terminal surface (`terminal_surface_v1`, `terminal_media_v1`, `terminal_prompt_v1`, `terminal_pty_v1`)

#### Selection and clipboard

`terminal.selection {}` (`terminal`) returns `{text, truncated}` for the current TUI selection, or `text: null`
when there is none. It prefers the visible transcript overlay and never reads obscured transcript text, another
client's selection or the OS clipboard.

- UTF-8 text is capped at 64 KiB and further bounded by its JSON-encoded size so a selection followed by a copy
  fits one callback's receipt budget. Any shortening sets `truncated: true`.
- `terminal.copy {text}` uses the native plain-text clipboard backend with the same 64 KiB limit. Its status is
  `confirmed`, `unconfirmed`, `pending` or `busy`; the native host waits for the matching clipboard worker's
  delivery result. `unconfirmed` means the backend cannot confirm delivery.

Both operations require a local user callback and reject event/tool calls and attached-client requests. Invoke
selection from a clicked component action, as the terminal example does; typing a slash command clears the
transcript selection before its callback. Require `terminal_selection_v1` and `terminal_copy_v1` for these
operations.

#### Appearance primitives

The appearance additions (`terminal_surface_paint_v1`, `terminal_image_sample_v1`, `terminal_import_lifetime_v1`)
remain generic presentation primitives.

##### Surface paint

`surface_styles.composer` and `.approval` accept a `TerminalSurfacePaint` with `top`, `bottom`, `foreground`,
`border` RGB/indexed colors and `opacity` from 0 to 1.

- Background colors interpolate vertically and blend with existing colors.
- The foreground is independent of background opacity; reset foregrounds get a readable color against the surviving
  background. Explicit native foregrounds and special backgrounds remain.
- Borders use blank edge cells and disappear at zero opacity.
- `NO_COLOR` omits styling.
- Inline rendering uses the current bounded viewport; it does not repaint earlier terminal scrollback.
- `approval` frames native approval prompts and mod confirmations; their text, options, default selection, focus
  and grants stay host-owned.

Surface paints compose by surface name with the later contributor replacing that surface's paint.

##### `terminal.image_sample`

`terminal.image_sample {resource, columns, rows}` returns `{width,height,rgba}` (row-major RGBA bytes) for a
caller-owned PNG/JPEG.

| Limit | Value |
| --- | --- |
| Columns | integers 1..120 |
| Rows | 1..60 |
| Source size | at most 8 MiB |
| Source dimensions | 4096 pixels per dimension |
| Decoder allocation | 64 MiB |

A mod can implement ASCII ramps or image inspection without a new file read.

##### Import lifetime

`terminal.import_file` adds `lifetime: thread|package` (default thread).

- Package imports retain repository, owner, exact source and immutable content identity across settings/reload/new
  threads.
- A source change requires a new confirmed import. The original path is never reread.
- Existing blob and resource quotas apply; removing the mod store removes retained assets.

Keeping settings, selected assets and image-to-ASCII conversion in a mod lets outside authors use the same APIs for
document viewers, image previews, warnings, watermarks and dashboards.

#### Layouts and component types

Views may declare a `layout` tree of splits and tabs with transcript, composer and mod-named sites (`mod/site`).
A `site:` or `transcript` leaf may set `title` (`terminal_layout_title_v1`), at most 64 bytes without control
characters: a site's frame shows it instead of the site name and `''` draws no title, and a titled transcript gives
its top row to a rule carrying the title, accented while the chat has focus in a view with `key_contexts`. A
`composer` leaf takes no title.
Components add `document` (up to 100,000 lines with anchors, selection and find), `diff`, `image`, `raster` and
`terminal` (a PTY session).

Updating only a document's anchors updates activation targets without resetting its cursor, selection or scroll,
including when source-backed text is unchanged.

#### `image` component

An `image` places a Kitty graphics image in its cells, aspect-fit to the measured cell size.

| Renderer | Where |
| --- | --- |
| Kitty graphics image (Unicode placeholders, so it scrolls, clips and hides under dialogs and overlays like text) | local Kitty and Ghostty |
| iTerm2 inline image (`iip`) | local Orca, iTerm2 and WezTerm |
| Truecolor half-block cells | elsewhere |
| Alt text | under `NO_COLOR` or below 4 columns |

Each image component has its own image id; replacing or removing the component deletes it, and exit and suspend
delete every image.

#### Image formats and pixel mapping

Images decode at most 8 MiB, PNG or JPEG, 4,096 pixels a side (`terminal_raster_v1`). An SVG `image`
(`svg_assets_v1`) draws `[image unavailable: alt]` in the terminal, which has no SVG rasterizer; external renderers
receive the same resource and draw it natively.

Either way the image is aspect-fit into the component's cells from its top-left cell (Kitty with `client.cell_px`,
or 8×16 when unknown; half-block cells count as 1×2 pixels), so a mod can map `pointer` cells, and `half` rows, on
an `image` back to image pixels.

#### Span styles

Spans accept `fg` and `bg` theme colors, `italic` and `underline` (`terminal_style_v1`); `document` keeps span
styles.

#### Component key and paste input (`terminal_input_v1`)

A `pane` or `document` with `keys: true` (`terminal_input_v1`) forwards keys and pastes while focused as
`component_event {kind: 'input', events}`, each event `{key, text}` or `{paste, truncated?}` (a paste is at most
64 KiB).

| Limit | Value |
| --- | --- |
| Events per batch | at most 64 events and 64 KiB; input waiting for one component arrives in order as one batch, so a slow callback adds at most one batch of lag |
| Queued events | beyond 256 queued events input is dropped and the next batch reports `dropped` |

Leaving the component:

- Ctrl+] leaves the component (terminals without the kitty keyboard protocol send it as Ctrl+5, which also leaves).
- Ctrl+C leaves it and keeps its native meaning (interrupt or quit).
- Esc goes to the mod and leaves the component or closes the dialog.
- `keys: 'all'` (`terminal_focus_v1`, also on `module`) also forwards Esc, Ctrl+C and the other Ctrl and Alt keys
  (Ctrl+Z still suspends), so only Ctrl+] (or Ctrl+5) leaves.
- Key contexts of the component's site owner that name its site get each key before the component does.

Input callbacks run in the terminal process with read-only workspace access, and the view redraws as soon as one
changes the mod's state. A key that must write (a save) publishes an `events.publish` hop whose `channel` callback
runs with the session's access.

Terminal-side callbacks (slash commands, input) run beside the session, so their hop can arrive before their own
`api.state` write lands: keep the request in state and, when the `channel` callback does not find it yet, serve it
from a short `events.schedule` timer.

The mod owns the buffer, cursor and selection and draws them as spans; a key `document` keeps its scroll across
content changes and scrolls to `selected`. A paste into a focused `terminal` component goes to the PTY, bracketed
when the program asked for it.

#### Layout region sizing, split resize and tab select

In a layout region, `terminal`, `document`, `diff`, `list` and `raster` components without a `height` share the
rows left after the region's other components and gaps. In a row layout each gets the region's full inner height.

- Releasing a mouse drag on a split border sends `component_event {kind: 'resize', component, ratio}`, where
  `component` is the split's path (`r` for the root, then `.N` per child index) and `ratio` its new percentages, so
  a mod can keep the ratio in its layout.
- Clicking a tab title switches the tab and sends `component_event {kind: 'select', component, index}` with the
  `tabs` node's path (`terminal_tabs_v1`), so the owner can keep `active` in its layout.

Both go only to the mod whose view supplied the layout.

#### View keybindings and command ownership

View `keybindings` accept `Ctrl+`, `Alt+` and `Shift+` combinations of letters, digits, F2–F12 and named keys
(`Up`, `PageDown`, `Enter`, ...), except terminal control keys and Shift+Tab; a binding that collides with a native
key is ignored with a warning.

On macOS, Kitty and Ghostty send Option+letter as a composed character (`π` for Option+p) unless Option-as-Alt is
enabled (`macos_option_as_alt` in Kitty, `macos-option-as-alt` in Ghostty), so an `Alt+` binding should not be a
control's only affordance: name its slash command next to it in the hint.

Key bindings and component actions run only the contributing mod's commands: a bare name is its own `id:name`, and
a binding or control naming another mod's command is dropped.

#### Focus regions, key contexts and help (`terminal_focus_v1`)

With a view `layout`, the host computes focus regions every frame. The chat (transcript and composer) is region 0
and each drawn `site:` leaf is a region named by its site, numbered from 1 in layout order; only a `tabs` node's
active tab counts. When a `tabs` node's active tab changes (a tab click or a new `active`), focus inside it moves to
the node's newly drawn region.

- A `{region}` key action moves focus without a mod callback: `left`, `right`, `up` and `down` pick the nearest
  region on that side, `next` and `previous` cycle in layout order, `chat` or `0` returns to the chat, a number
  from 1 to 12 is that site region and a site name focuses that region. A region gets back the control last focused there, else its
  first control that is not a keys component or terminal, else no control.
- The focused region's frame draws in the accent color, or with its leaf's `style.focus` accent.
- While a region has focus, keys it does not bind never reach the composer. Ctrl, Alt and F-keys still reach
  `keybindings` and native shortcuts, and native prompts such as approvals keep their keys.
- Esc in a region returns to the chat. Ctrl+] in a region returns to the chat, or from a focused keys component or
  terminal to its region; in the chat it focuses the last region (else the first) when the view has key contexts.
  Clicking a region or a control in it focuses the region, and pastes into a focused region never reach the
  composer.

View `key_contexts` bind keys that apply only while `when` holds, at most 8 contexts and 32 keys per mod (16 and 128
composed):

| `when` field | Holds when |
| --- | --- |
| `focus` | One name or a list of up to 8 different names: `chat`, `site` (any site region or a control in any site) or a site name. Omitted, anywhere. |
| `composer` | `empty` or `draft`, by the composer's text. |

- A context that cannot hold in the chat may also bind unmodified keys: named keys other than Esc, Shift+Tab and
  single printable characters (`h`, `1`, `[`, `?`, `G`; letters match case exactly). A context that can hold there takes `keybindings` key names, and there a key
  that collides with a native binding is ignored as in `keybindings`.
- A binding is a key action or `{action, label}`; `label` (at most 64 bytes) names it in the help overlay.
- Contexts of the focused site's owner (the `owner` of `owner/site`) match first, then the others in composition
  order. A focused control keeps Enter, Space, Up, Down and a select's Left and Right.
- `{region}` and `{help: true}` also work in `keybindings`; commands follow the ownership rule below.

`{help: true}` opens a host overlay listing the bindings that apply to the focused region with their labels and
owning mod, then `keybindings` and the host keys. `/` searches, Up and Down (or `j` and `k`) move, Enter runs the
selected binding and Esc clears the search or closes the overlay.

#### `component_event`

`component_event`, `view` and `focus` report interaction. `component_event` goes only to the component's owner and
also reports, with `origin` `user` or `mod`:

| Event | Reports |
| --- | --- |
| `focus` and `blur` | Focus changes. |
| `change` | An input's or select's new `value` or a multiselect's checked `values`, on every edit. |
| `scroll` | A pane's `offset`. |
| `pointer` | Cell-relative `{column, row, action, button}`. |
| `open` / `close` | Panes and dialogs (`ui_composition_v1`). |

Every `component_event` carries the `thread_id` of the session thread it came from (null before the session has
one), and a `state_scope: "thread"` owner's callback runs with that thread's state.

These events wait in order behind a slow callback; beyond 256 waiting events new ones are dropped and the next
delivered event reports the count as `dropped`.

#### Component modules (`component_modules_v1`)

Component modules need the feature `component_modules_v1`, which `mod_host_check.py --static`
requires of any package that calls `api.component`.

`api.component(module, {init?, view, key?, pointer?, every?})` is registered during activation under the `terminal`
capability (at most 16 per mod) and draws `{type: 'module', id, label, module, props?, height?, keys?, pointer?}`
nodes.

##### Component module lifecycle

Each mounted node runs in its own runner that stays alive while the node is in the view, so `init(props, ui)` runs
once and the state handlers return carries over between frames (returning `undefined` keeps it).

- At most four nodes are mounted at once for the terminal and four for each external client; a fifth node draws a
  `component_limit` error line and no mounted runner is evicted for it.
- Handlers are synchronous; a returned promise fails with `component_handlers_must_be_synchronous`.
- In the terminal, removing a node or changing its owner or module starts a new mount. Results, retries and
  undelivered posts from the previous mount are discarded.

##### Component module steps

A step runs at most once per 16 ms frame and only when something is pending: a mount, new props or size, queued
input, or a due `every: {ms, tick}` tick.

- `every` ticks run from 16 ms to 24 h, with at most 8 missed ticks caught up.
- `ms` may be a function of the state, and `null` pauses ticks, so a paused module costs nothing until input or new
  props arrive.

##### Component module handlers

- `key(state, {kind: 'key', key, text})` receives keys while the node, given `keys: true`, has focus from a click
  or Tab (Esc and Ctrl+] return focus; pasted text arrives as one event with `key: null`).
- `pointer(state, {kind: 'pointer', column, row, action, button})` receives pointer events over the region with
  `pointer: true`, consecutive moves coalesced.
- `view(state, ui)` returns a render tree (`box` without style, `line`, `text`, `markdown`, `code`, `diff`, `list`;
  at most 64 components, depth 6, 256 KiB).

`ui` is `{columns, rows, props, post(data)}`, where `rows` is the node's `height` and 0 when it has none (auto
height). `post` hands the mod's `component_post` hooks `{component, module, data}` at most once per frame (a later
post in the same frame replaces it; 64 KiB).

##### Component module authority and failure

- Handlers have no host authority (`host_operation_unavailable`, `time.sleep` included, and no `host_operation`
  hook or interceptor sees the attempt) and cannot write state, but `api.state.get()` and `api.uiState.get()` read
  the current values at every step.
- A throw, three consecutive steps over 8 ms after the mounting one (`component_overrun`) or an invalid tree
  unmounts the node, which then draws one dim error line (the error's first line) until the next view revision
  mounts it again. A failed step never counts toward the mod's [fault limit](#fault-limit).
- Without `height` the region is as tall as its latest tree.

##### Component modules for external clients

External clients read a node's tree with `omd/render {slot: 'module', props: {component, columns?, rows?}}` (their
own instance, sized as given or as last rendered, 80 columns and rows 0 by default; `effective.next_ms` says when
the next tick is due) and send it key and pointer events through `omd/client/event`.

Their posts reach `component_post` as `{component, module, client, data}` (hooks there make the same host
operations `component_event` hooks make, on either surface), and detaching unmounts their instances.

#### Raster, pointer and overlays (`terminal_raster_v1`)

##### `terminal` event `client`

The `terminal` event carries `client: {kind: 'terminal', graphics, pointer, reduced_motion, cell_px, columns,
rows}`:

| Field | Meaning |
| --- | --- |
| `graphics` | `kitty` (pixel images), `iip` (iTerm2 inline images: Orca, iTerm2, WezTerm), `cells` (half-block) or `text` (`NO_COLOR`). |
| `pointer` | `half_cell`, `cell` or `none` (no mouse capture: tmux, `OMD_TUI_MOUSE=off`, inline viewport). |
| `reduced_motion` | Follows `tui.animations` and the system setting, and mods that animate stop when it is true. |
| `cell_px` | The measured cell size or null. |
| `columns` and `rows` | The terminal grid. |

`client` is null without a terminal client. When any of these change (the window or font is resized, animations are
turned off) the view renders again with the new `client`; a burst of changes renders once per render in progress.

##### `raster` component

`{type: 'raster', id, label, alt, width?, height?, pointer?}` is a keyed canvas of 1–512 × 1–256 cells that shows
`alt` until its first frame and clips to the component's width.

- An omitted `width` fills the region's width.
- An omitted `height` shares the rows left in a layout region like `terminal`, `document`, `diff` and `list` (12
  elsewhere).
- A fill raster's size is the one it last rendered at, and a cells `terminal.blit` before its first render is
  `terminal_blit_unknown`.
- A mod holds at most 16 rasters: a blit to a 17th key is `terminal_blit_limit`; a raster's frames are dropped with
  its component.

##### `terminal.blit` cells

`terminal.blit {key, rect: {x, y, width, height}, cells}` updates part of the caller's own raster (`key` is its
id). `cells` lists the rect's cells row by row, each a one-cell glyph or `[glyph, fg, bg]` with theme colors or
null.

`terminal.blit {key, rect, packed}` (`terminal_raster_packed_v1`) passes the same cells as base64 of `rect.width ×
rect.height` little-endian u32 triplets `[codePoint, fg, bg]`, row by row:

- A code point is one printable column (no controls, combining marks or wide characters).
- A color is `0x00RRGGBB`, `0x01000000` for the theme default or `0x02000000 | index` for a 0–255 palette color;
  under `NO_COLOR` every cell draws in the default colors.
- A cell takes 16 bytes of base64, about half a colored JSON cell, and the host decodes it without a JSON tree. The
  runner has no `btoa`, so encode with a small helper such as the one in the `raster_wave` example.
- A callback's host calls, arguments included, share its 1 MiB receipt budget: a packed cell takes 16 bytes of it and
  a colored JSON cell about 29. Timer ticks are 16 ms apart, so a larger raster should redraw only the cells that
  change.
- External clients receive `packed` updates as `cells`.

| Error | When |
| --- | --- |
| `terminal_blit_not_owned` | The raster is another mod's. |
| `terminal_blit_unknown` | The terminal has not received the raster in a view yet, such as one returned by the same callback. |
| `terminal_blit_too_large` | One call is over 256 KiB. |
| `terminal_blit_limit` | A blit to a 17th key. |
| `terminal_blit_packed_invalid` | `packed` is not base64, is not 12 bytes a cell, or has a code point or color outside the rules above; the message names the cell. |

Cells and packed updates that reach a raster before its next 16 ms frame merge into that frame, later cells
overwriting earlier ones, so one timer tick can draw a frame in several calls. The call returns `{frame, queued,
frame_ms}`: the frame the update shows in and the frames pending (a picture, then the cells merged after it). Merged
cells never take more than the raster, so the call returns `{status: 'backpressure', retry_after_ms: 250}` only while
a pending frame stays undrawn for four ticks (an inactive tab or unplaced layout). Image and pixel frames keep the
pacing below.

##### `terminal.blit` images

`terminal.blit {key, image: {media_type: 'image/png' | 'image/jpeg', base64}}` (instead of `rect` and `cells`)
shows a raster you own as one transient picture, aspect-fit from the top-left cell into the raster's width × height
cells by the same rule and renderers as `image` (Kitty placeholders, iTerm2 inline images, truecolor half-blocks,
`alt` under `NO_COLOR`).

- The newest frame replaces the previous one, a cells blit replaces the frame and a frame replaces the cells.
- It is never stored as a resource, so prefer it to a new `image` resource per frame (which exhausts the record
  quota) or to cells (two effective pixels a cell).
- External clients whose renderer `formats` include the media type receive the frame as sent, other clients with
  `cells` receive half-block cells.

| Error | When |
| --- | --- |
| `terminal_blit_image_invalid` | A wrong media type, bad base64 or an image that does not decode within 4096 px per side. |
| `terminal_blit_invalid` | Not exactly one of `cells`, `packed`, `image` and `pixels` is passed. |

Both refuse before queueing.

##### Pointer events

`box`, `pane`, `image` and `raster` accept `pointer: true`. The owner then receives `component_event {kind:
'pointer'}` with:

- `action` `enter`, `leave`, `move`, `down`, `up` and `drag`;
- `column`/`row` relative to the component's first cell (a nested box counts its title and children);
- `half` (0 or 1, the half-cell row) on terminals that report pixel positions (Kitty, Ghostty and WezTerm), else
  null.

A press captures the pointer until release, so `drag` and `up` reach the component outside its cells with
out-of-range or negative coordinates. Motion is latest-wins per component: a slow callback sees the newest
position, never a backlog. Views with no pointer components add no pointer work.

##### Overlays

A mod-named site (`mod/site`) with `overlay: {anchor, offset?, width, height, z?, clip?, style?}` draws above the
layout instead of in the sidebar.

| Field | Meaning |
| --- | --- |
| `anchor` | A screen corner (`top_left`, `top_right`, `bottom_left`, `bottom_right`) or `center`, or `{component}` (the component's top-left cell; the overlay is skipped while that component is not drawn). |
| `offset` | Moves the overlay by cells. |
| `z` | 0–9; orders overlays. |
| `clip` | `clip: 'anchor'` clips it to the anchor component's cells, otherwise to the screen. |

- An overlay hides what lies beneath it from pointer events, and a dialog stays above every overlay.
- A view with an overlay outside these bounds is invalid: `width` 1–200, `height` 1–60, `offset.x` within ±500,
  `offset.y` within ±200, and a screen anchor cannot use `clip: 'anchor'`.
- Overlays are not exclusive: when several patches set one for the same site, the patch that composes last wins,
  and a `wrap` patch overrides another mod's overlay without a claim or a `terminal.conflicts` entry.

#### Box model (`terminal_box_model_v1`)

One `style: TerminalBoxStyle` object styles a `box`, `pane` or `dialog`, an overlay, a layout `site:` leaf and, as
`sidebar_style`, the sidebar.

- `border`: `none`, `plain`, `rounded`, `double` or `thick`; a title sits in the top edge. Under the theme's
  `icons: 'ascii'`, `OMD_TUI_ASCII=1`, or a non-Unicode locale, every border draws as `+`, `-` and `|`, and
  markers, cursors and separators draw in ASCII too.
- `padding` and `margin`: cells on every side, or `[vertical, horizontal]`, each 0–4.
- `gap` (0–4) separates children: rows in a column, cells in a row.
- `background` and `foreground`: a tone (`accent`, `muted`, ...) or a color (0–255 or `#rrggbb`). A filled or
  bordered box pads its rows to its width, so the fill reaches the edge; other boxes leave rows unpadded.
- `direction: 'row'` lays children side by side (see [Row layout](#row-layout)).
- `hover` and `focus` take `{border?, background?, foreground?}` on a `box` or `pane`, and `focus` on a layout
  `site:` leaf while its region has focus; other surfaces refuse them
  (see [Hover and focus accents](#hover-and-focus-accents)).

##### Row layout

With `direction: 'row'`:

- A `button`, `text` or `line` takes its natural width; every other child gets a share of the rest by its `flex`
  weight (1–12, default 1).
- When natural widths exceed the available space, shorter children keep their width and longer children share the
  remaining columns.
- `max_width` caps a child's width and a child with fewer columns than its `min_width` drops out.
- In a column, `min_width`/`max_width` hide the box outside its bounds.

##### Hover and focus accents

- `hover` applies while the pointer is over the box (no `pointer: true` needed; events still need it).
- `focus` applies while the box or a descendant has focus.
- Accents never add or remove a border, so geometry stays put.

##### Default styling

Unstyled panes, dialogs and layout sites are cards: the theme `border`, `padding: [0, 1]` and the title in the top
edge. A pane with `border: 'none'` is a flat panel whose title row leads its content. Unstyled boxes and overlays
draw no frame.

- The sidebar has no padding, one row between its components under the comfortable density, and no border unless
  `sidebar_style` sets one, which then carries the view `title`.
- A split's `gap` (0–4) leaves cells between its children.
- Render hook trees refuse `style` and `flex`.
- The host's progress and mod diagnostics draw as cards above the prompt (four entries each, wrapped to
  six lines, then `+N more`), so the sidebar opens only for a mod's `sidebar` components, `panels` or unplaced named sites.

#### Terminal operations

Operations the TUI serves, such as `terminal.panel`, need a running TUI. From `omd-mod command` they fail with
`host_operation_unavailable: requires a native task`. Call them with `api.host.tryCall` and fall back to returning
text.

##### Notifications and commands

- `terminal.notify {title, body?}` uses the configured notification method with a focus condition and a 2 s rate
  limit.
- `commands.list`, `commands.describe` and `commands.invoke` are described in
  [Commands and configuration](#commands-and-configuration-command_config_middleware_v1).
- `sessions.ports` (`session_ports_v1`, `sessions` capability) returns `{ports: [{port, pid, address}]}`: TCP
  listeners owned by the current thread's background terminals and their child processes, read by the host outside
  the mod sandbox (at most 32 ports, 3 s per probe).

##### Threads, imports and composer

`terminal.show_thread`, `terminal.import_file` (confirmed, at most 8 MiB), `composer.read`, `composer.write` and
`composer.suggest` (see [Composer drafts and
suggestions](#composer-drafts-and-suggestions-composer_v2)). The import confirmation shows
the resolved path.

##### `terminal.open`

`terminal.open {url} | {path}` opens an http(s) URL or an existing HTML, Markdown, text, PDF or image file after a
native confirmation.

`{path, line?, editor: true}` (`terminal_editor_v1`) opens a workspace file in the argv the user sets as `editor`
in `host.json`, with `{path}` and `{line}` substituted.

##### `terminal.prompt`

`terminal.prompt {kind: 'confirm' | 'text', title, message, masked?}` asks the user; mods never answer prompts.

`{kind: 'choice', title, message, options: [{value, label}], multiple?, other?}` (`ui_composition_v1`) shows a
native picker of up to 32 options: one value, several with `multiple`, or a typed answer through an `Other…` row
with `other`. It returns `{status: 'accepted', values, other?}` or `declined` when cancelled.

##### `terminal.blit`

`terminal.blit {key, rect, cells | packed}` (`terminal_raster_v1`, experimental) queues a raster update, described in
[Raster, pointer and overlays](#raster-pointer-and-overlays-terminal_raster_v1).

##### `terminal.pane` and `terminal.panes`

`terminal.pane {action, id, offset?}` (`ui_composition_v1`) opens, closes, focuses, scrolls or reveals one of the
caller's own panes, dialogs or controls; another mod's component is `terminal_pane_not_owned`. Scrolling uses
`offset`; a pane shows 8 rows and stops scrolling once its last row is in view.

`terminal.panes {}` (`ui_controls_v1`) returns the caller's own panes as `{panes: [{id, visible, collapsed,
focused, scroll}]}`; a pane is `visible` while its header row was on screen in the last frame.

##### `terminal.panel`

`terminal.panel {title, subtitle?, tabs?, items, search?, query?, selected?, close_args?, action}` (`terminal_panel_v1`) opens Codex's
own list panel in the bottom pane, where `/config` lives. `title` is at most 128 bytes and `subtitle` at most 2,000
bytes of plain text that keeps its line breaks. `tabs` lists up to 8 `{id, title}` (titles up to 32 bytes); with
tabs, every item names its `tab`. `items` holds 1–200 `{id, tab?, label, description?, group?, keywords?, detail?, kind, value?, options?}` with
unique ids without spaces (up to 128 bytes), labels up to 128 bytes and descriptions up to 256 bytes:

| `kind` | `value` | Space or Enter |
| --- | --- | --- |
| `toggle` | boolean | Flips it. |
| `choice` | one of `options`, 1–32 `{value, label}` with unique values without spaces | Moves to the next option. |
| `text` | string up to 2,000 bytes | Opens Codex's single-line prompt; an empty answer is ignored. |
| `action` | none | Runs the action. |

Each change runs the caller's command `action.command` with `args`, the item id and the new value joined by spaces
(`set bars true`), and the panel shows the new value at once. Up and Down move and repeat while held, Left and Right
switch tabs, `/` searches every tab when `search` is true: labels match fuzzily, best first, then items whose
description, keywords or tab title contain the query; Esc clears the search or closes the panel. Outside a search, a letter moves to
the next item whose label starts with it, `g` and `G` go to the first and last row, and Home, End, PgUp and PgDn work
as in every Codex list.

Experimental (`terminal_panel_navigation_v1`): an item's `group` (up to 32 bytes) gathers items under a header row
with their count, in order of first appearance after any ungrouped items; Space or Enter on the header collapses or
expands it. `keywords` (up to 256 bytes) is searched but not shown, and `detail` (up to 512 bytes) shows below the
list while the item is selected. `query` (up to 128 bytes) opens the panel with that search, and `selected` names the
item to select first. With `close_args`, closing the panel runs `action.command` with `close_args`, the selected item
id (`-` on a header) and the search the user last chose an item with (cleared when the user ends a search without
choosing one), joined by spaces, so a mod can reopen the panel where the user left it. A call with the title of the caller's open panel replaces it in place and keeps its
tab (also across a tab-less panel such as a confirmation), selected item and search; another title opens a new panel
over it, and Esc returns to the one below. Only the user's own commands and panel actions open panels
(`host_operation_user_only` elsewhere). Returns `{shown: true}`.

A package or settings change (`packages.apply`, `settings.write`) reloads mods, and the rest of that callback's
panel calls fail with `callback_cancelled`. When a command that changed packages or settings finishes, every open
panel's `action.command` runs again with its `args` alone, bottom panel first, so each mod redraws its panels from
current state; keep anything the redraw needs, such as a result notice, in `api.uiState` or in `args`.

##### `terminal.notice`

`terminal.notice {text, kind?, placement?, ...}` (`ui_controls_v1`) shows a notice of at most 512 bytes attributed
to the mod. `kind` is `info` (default), `warning` or `error`.

| `placement` | Where |
| --- | --- |
| `placement: 'toast'` (default) | Below the composer notes. |
| `placement: 'status'` | In the status row (first 40 characters). |
| `placement: 'transcript'` | Appends a log notice to the transcript that never reaches the model unless `audience: 'model'`. |

Toast and status notices:

- Each lasts `ttl_ms` (1,000 to 60,000, default 5,000).
- At most 4 per mod; a new notice with the same `id` replaces the old one.
- `{id, placement, clear: true}` removes it early and returns `{cleared}`.

Transcript notices:

- `audience: 'model'` also adds the text as mod-provided context to the thread's next model request and every retry
  of it until a response completes. At most 8 are queued per thread (`model_context_queue_full`); with
  `model_request` interceptors' inserted sections, at most 8 per request, the rest waiting for the next one.
- `tool_call_id` draws a transcript notice beneath that tool call's cell in the owned transcript, or as a notice
  naming the call in inline mode or when no drawn cell holds the call.

##### `terminal.pty`

`terminal.pty {action: 'start' | 'write' | 'read' | 'stop', session}` starts an interactive shell from a user
command after confirmation, in the session sandbox without network (macOS) with a scratch `HOME`.

`start` accepts:

| Field | Meaning |
| --- | --- |
| `program`, `argv`, `sha256` | May name a program (`pty_programs_v1`). |
| `write: true` | Lets the pane write the workspace; needs `fs.write`. |
| `network: 'loopback'` | Lets it reach services on this computer only; needs `network`. |

The confirmation names the program, write and network access and that the mod can type into the pane.

With the `os` grant, `sandbox: 'none'` starts a listed program unsandboxed with the real `HOME` (no `write` or
`network` fields), skips the per-start confirmation and stops when the grant ends.

Sessions:

- Belong to the calling mod, thread and admitted generation (four per mod, sixteen in all).
- Render only in terminal components owned by that mod.
- Stop when the thread, repository, permission context or admitted generation changes, or the mod unloads.
- Queued requests and terminal input retain their original binding and cannot address a replacement session.
- A focused `terminal` component receives keys; Ctrl+] (or Ctrl+5) leaves it.

##### `builtins.invoke` and `api.builtins`

`builtins.invoke {action}` runs a key action from user contexts. It is refused (`builtins_view_active`) while a
dialog, popup, overlay or focused mod component would take the key, and `list.*` and the permission-mode actions
are never invoked (`keymap_action_refused`).

`api.builtins({keys, commands: {replace}})` overlays key bindings (never `approval.*`) and routes a built-in
command to a mod command; the slash popup lists the built-in with that command's description and arguments.

### Terminal identity, rich lines and picker

#### Alternate screen, inline mode and composer sites

Terminal views are drawn on Codex's alternate screen, including its default fullscreen transcript. Inline
`--no-alt-screen` sessions draw the sidebar, header and dialogs inside the current viewport, and `render` hooks and
status segments apply to scrollback.

When any mod's view sets `inline_sites: 'hidden'` (`terminal_inline_sites_v1`), the inline viewport omits the
sidebar, header and named sites; dialogs, status segments, mod progress and diagnostics, the composer, approvals
and scrollback remain, and the owned fullscreen viewport is unchanged.

A launcher can narrow one session's TUI with three environment variables. `OMD_TUI_MOD_UI=ID[,ID…]` keeps sites,
panels, header, footer, layout and status segments only from the listed mods; other mods keep their `dialog` site,
`render` hooks, commands, keys and theme, and the status row holds only the listed mods' segments, without upstream
`/statusline` items or the host summary unless a mod failed. `OMD_TUI_HEADER=off` drops the Codex session header and
first-run help, and `OMD_TUI_COMPOSER=plain` draws the composer as a bare prompt line without its background,
blank rows, placeholder or idle hint row. `omd mini` sets all three. They are read once at start, and agent tool
processes don't inherit them or the launcher's `OH_MY_DIFF_*` variables (a mod's `exec_environment` still can).

The `above_composer` and `below_composer` sites draw in both modes, host-sized to their wrapped
components, directly above and below the bottom pane (composer, native hints and status row), with styles, links
and focusable controls. `above_composer` is clipped to 8 rows and `below_composer` to 6, each scrolling to the
focused control. Both are hidden while an approval or popup replaces the composer.

#### Terminal identity (`terminal_identity_v1`)

The `terminal` input carries a read-only `identity` (`terminal_identity_v1`):

- `codex_version` from the installed build;
- `omd_version`, the installed OMD release, such as `1.2.0` or `1.3.0-rc.2` (experimental);
- `install_profile` (`full`, `platform_only`, `private`, `unknown` or `unreported`);
- effective `mode` (`omd`);
- installed, enabled, active and failed mod counts.

Upstream-style direct mode loads no mods.

#### Rich lines (`terminal_rich_line_v1`)

`terminal_rich_line_v1` adds a one-row `line` component with up to 12 styled `spans` (`text`, `tone`, `bold`; 256
characters in total), whose `label` is the accessible text, and optional `min_width`/`max_width` (1–500 columns) on
`box` and `pane`.

Native draws a bounded box only when the site's inner width fits, and header height counts only drawn boxes. Header
rows are never spaced by the comfortable density.

#### List rows (`terminal_lists_v1`)

`terminal_lists_v1` lets a `render` hook on component `list` replace built-in list rows. The host keeps selection
actions, session state, keyboard handling and native fallback when the mod is absent or fails.

#### Copy-on-select and right-click paste

Copy-on-select and right-click paste are Codex settings (`tui.copy_on_select`, `tui.right_click_paste`); mods
change them through `config.write`.

## External clients

Other renderers (a desktop window, an editor webview, a text console) attach to a running session over the upstream
app-server JSON-RPC and draw the same composed mod view. Use this page to build or review such a client. Oh My Diff
ships no desktop or editor client of its own; a mod ships its adapter (see [Client adapters](#client-adapters)).

### External clients (`omd-client/1`)

#### Transports and auth

- `unix://PATH`, or `unix://` for the default socket under `$CODEX_HOME`: a WebSocket over a 0600, owner-checked
  Unix socket, no token. The default choice for local clients.
- `ws://IP:PORT` with `--ws-auth capability-token` (`--ws-token-file` or `--ws-token-sha256`) or `--ws-auth
  signed-bearer-token` (`--ws-shared-secret-file`, optional `--ws-issuer`/`--ws-audience`). A non-loopback listener
  refuses to start without auth.
- `stdio`: the spawning process speaks newline-delimited JSON-RPC to `codex app-server`.
- `codex app-server --listen URL` runs a headless host. `codex --listen URL` (same `--ws-*` flags, including
  `--ws-allowed-origin`) exposes the live TUI's in-process app-server, so a client co-attaches to the terminal
  session; it takes only `unix://PATH` or `ws://IP:PORT` with an explicit port (bare `unix://` and port 0 are
  refused).

#### WebSocket bearer tokens and origins

- Native clients send `Authorization: Bearer <token>`.
- Browsers offer the subprotocols `codex-app-server` and `codex.bearer.<token>` instead, and the server selects
  `codex-app-server`.
- The server compares the raw token, so a capability token used from a browser must be base64url or hex
  (subprotocol values cannot carry `+`, `/` or `=`, and browsers may log them).
- `--ws-allowed-origin ORIGIN` (repeatable, `scheme://host[:port]`, requires `--ws-auth`) admits a browser or
  webview origin. Origins are compared exactly after normalization, which drops a default port (`:80`, `:443`); any
  other `Origin` is refused.
- The exec-server listener honors the same allowed origins and subprotocol bearer.

#### Initialize and errors

A client sends `initialize {clientInfo, capabilities: {experimentalApi: true}}` and the `initialized` notification.
`omd/*` methods are experimental and need that opt-in.

Requests are not serialized by the host, so a client awaits the attach before any other `omd/*` call; before it
every method fails with `client_not_attached`.

Errors are JSON-RPC errors whose message starts with the code. Besides the codes listed with each request, these
exist:

- `mod_host_inactive`, `session_unavailable`, `host_operation_unavailable` and `view_unavailable` (no mods, thread,
  session runtime or published view in this host)
- `command_unavailable` and `command_unavailable_during_turn` for the action's command
- `render_slot_invalid` and `render_props_invalid`
- `resource_not_in_view` and `resource_unavailable`
- `recovery_action_invalid` and `mod_store_unavailable` from recovery

#### Requests

##### `omd/client/attach`

```ts
omd/client/attach {name, renderer: {kind: 'terminal'|'gui'|'text', formats: ('svg'|'png'|'jpeg'|'cells'|'text')[], pointer: 'pixel'|'cell'|'half_cell'|'none', reducedMotion, cellPx?}, operations}
// → {clientId, protocol: 'omd-client/1', epoch, roster, features, delegable}, then omd/view/updated
```

- The result's `roster` already lists the new client, and `omd/roster/updated` reports later changes.
- Attaching again on the connection replaces its entry.
- Attach also succeeds while mods are inactive or failed to start (empty `epoch`, null `snapshot`), so the recovery
  calls stay reachable.

##### `omd/client/update`

```ts
omd/client/update {renderer?, viewport?: {width, height, unit}, focus?}
// → {}
```

`focus` sets the entry's `focused`. Every client gets `omd/roster/updated` and mods render again.

##### `omd/client/detach`

```ts
omd/client/detach {}
// → {}
```

##### `omd/view/read`

```ts
omd/view/read {}
// → {epoch, revision, snapshot, actionToken}
```

##### `omd/client/event`

```ts
omd/client/event {epoch, component, event}
// → {delivered}
```

`event` is one of:

- `{kind: 'change', value}`
- `{kind: 'change', values}` (strings)
- `{kind: 'pointer', pointer: {column, row, half?: 0|1|null, action:
  'down'|'up'|'scroll_up'|'scroll_down'|'move'|'drag'|'enter'|'leave', button: 'left'|'right'|'middle'|null}}`
- `{kind: 'scroll', offset}`
- `{kind: 'key', key, text?}`
- `{kind: 'focus'}`

Behavior:

- `{delivered}` is answered in the order the connection sent its events and actions.
- The owner (from `component_owners`) gets `component_event` with `client: clientId` and only the kind's fields
  above. `origin`, `events`, `anchor`, `range`, `index` and any other field a client sends are dropped.

| Error | When |
| --- | --- |
| `view_stale` | Another epoch |
| `view_stale: <component>` | The component is gone |
| `component_event_invalid` | Another kind, a missing or malformed field the kind requires, or an event over 64 KiB |

##### `omd/action`

```ts
omd/action {actionToken, component, row?, value?}
// → {status: 'completed', outcome, actionToken}
```

`outcome` is the command's result (`insert`, `submit`, `display`, `preview`) or null, which the client applies in
its own UI (a `submit` through `turn/start`).

Errors:

- `action_stale` (also when the view changed before the action ran)
- `action_replayed`
- `action_unknown`
- `action_unavailable: <component>`
- `action_value_invalid: <component>` (including document anchors and lines and diff lines)

##### `omd/render`

```ts
omd/render {slot, props}
// → {original, effective, tree, answeredBy}
```

- The result gives the client's native props before and after `render` interceptors, drawn with the envelope `{id:
  'client:<slot>', surface: 'inline', lifecycle: 'final', viewport: {columns: 80, rows: 24}, owner: null}`.
- Slot `module` with `props: {component, columns?, rows?}` (1–65535 cells) steps the client's own instance of that
  view's component module and answers its `tree` with `effective: {next_ms}`.

##### `omd/resource/read`

```ts
omd/resource/read {reference}
// → {mediaType, data, sha256}
```

`data` is base64. Only references in the current view can be read.

##### `omd/recovery/read` and `omd/recovery/apply`

```ts
omd/recovery/read {}
omd/recovery/apply {action: 'enable'|'disable'|'reload'|'reset', target}
```

`omd/recovery/read` returns the host-owned `/omd` recovery state, and `omd/recovery/apply` returns the result:

```ts
{mods: [{id, path, scope, enabled, packaged, failing, error}], resettable, store_error, activation_error, reload_error}
```

- `reload` reloads the mods at once, refreshes the session's limits and contract and pushes the new view, or fails
  with `recovery_unavailable_during_turn` while the lead thread's turn runs. It needs no attached client: `/omd`'s
  Reload mods sends it from the terminal.
- `enable`, `disable` and `reset` change what runs or reset `host.json`/`mods.json`, so like `packages.apply` and
  `config.set` they need the terminal (`/omd`) or `omd-mod` and fail for a client with
  `client_surface_operation_unavailable`.
- `resettable` names the files `/omd` and `omd-mod` can reset; a client reads it but cannot reset them.
- A source changed after trust keeps its last trusted code running, reports `source_changed: ...` on the mod and
  `untrusted_source: ...` as `reload_error`, and loads after `omd-mod trust` and a reload.

#### Host notifications and server requests

The host sends these notifications:

- `omd/view/updated {epoch, revision, snapshot, actionToken}`: the full, coalesced `ModViewSnapshot` (`view`,
  `component_owners`, `layout_owner` (the mod whose view supplied `view.layout`), `progress`, `activity`,
  `diagnostics`).
- `omd/roster/updated {roster}`
- `omd/surface/mirrored {caller, operation, arguments}`

The host also sends the server request `omd/surface/call {caller, operation, arguments, confirm?}`. A client
answers it with the operation's result or an error whose message the mod receives. When the mod's call is cancelled
or outlives its callback budget first, the host drops the request and a late answer is ignored.

Other server requests (approvals, `requestUserInput`, permissions, elicitation) reach every subscribed client, and
the first answer wins, an error included. An SDK client answers only what its `onServerRequest` returns a value for
(`undefined` leaves the request unanswered), so a client that does not handle a request never resolves it before
the user at the terminal.

#### Actions and tokens

A client names a component and row, never a command. The host resolves the action from its own current view and
runs it like Space/Enter in the TUI: `command` interceptors, then the command as a user action.

- Tokens are random, per connection and bound to the view's epoch and revision.
- A pushed revision or a use replaces the token, while progress and activity pushes keep it.
- A use spends the token even when the action then fails, so re-read the view after an error.
- The last 8 retired tokens keep `action_stale` and `action_replayed` accurate.
- Send one action at a time per connection and keep the newest token from the last view or action result.
- Roster-driven re-renders coalesce, and a view that did not change keeps its revision, so one client's viewport or
  focus update does not rotate the others' tokens.

#### Ordering, epochs and reconnecting

State is per connection. A disconnect removes the roster entry and at once fails that client's pending surface
calls with `client_surface_closed` (an attach on a closing connection gets `client_surface_closed: the connection
is closing`).

- `epoch` is an opaque decimal string (empty, with revision 0 and a null snapshot, until the host publishes its
  first view).
- `revision` grows within an `epoch`.
- A new `epoch` means the host restarted and invalidates everything the client holds.

Reconnecting is `initialize`, attach (a full snapshot, never deltas), then `thread/resume` per thread, which
replays pending approvals. `thread/resume` also joins a loaded thread before its first turn.

- Approvals stay upstream server requests broadcast to subscribed connections (first answer wins,
  `serverRequest/resolved` tells the rest).
- `turn/interrupt` cancels a turn.
- `thread/rewritten` invalidates a thread's cached history.

#### Capabilities and fallback

The wire roster lists `{id, name, renderer, viewport, focused, attachedMs}` (camelCase renderer). Mods see it as
`clients: ClientEntry[]` beside `client` in the `terminal` input, in snake_case (`renderer.reduced_motion`,
`renderer.cell_px`, `focused`, `attached_ms`); neither lists declared operations. `client` stays the local
terminal's facts, or null headless.

A view serves every attached renderer, so draw for the least capable or branch on `clients`.

- An SVG `image` shows its alt text in terminals (SVG rules in [Binary evidence and package
  controls](#binary-evidence-and-package-controls)); a client listing `svg`, `png` or `jpeg`
  reads the resource with `omd/resource/read` and draws it.
- `terminal.notify`, `terminal.notice` and `terminal.blit` are mirrored to attached clients in both modes, blits
  only to clients listing `cells`; others draw a raster's `alt`.

Headless, the host answers those three itself with the terminal's validation:

- A blit is checked against `component_owners` (`terminal_blit_not_owned`, `terminal_blit_unknown`) and the
  raster's size and paced at one frame per 16 ms with the same 32-update backpressure.
- A notice fails with `terminal_notice_invalid` like in the terminal, and a `model`-audience notice is still queued
  for the model.

#### Delegation

With no terminal attached, `features` includes `surface_call` and `delegable` lists the declared operations the
host delegates. A mod's surface operation goes to the clients that declared it, and the first answer wins.

User-only operations are never delegated:

- `credentials.request`
- `terminal.import_file`
- `builtins.invoke`
- `commands.invoke`
- `config.set`
- `packages.apply`
- `routes.add`
- `routes.write`
- `contract.select`

`prompts.consent` is never delegated either. Whenever a client's action or event caused the call, these operations
and a `terminal.pty` start fail in both modes (`client_surface_operation_unavailable: <operation> needs the
terminal (/omd) or omd-mod`), so clients never reach grant-writing or user-only operations: use the terminal's
`/omd` or `omd-mod enable|disable|reload|reset`.

- Headless, a `terminal.pty` start from a non-user context is `host_operation_user_only`.
- An operation no attached client declared fails with `client_surface_operation_unavailable: no attached client
  serves <operation>`.
- `app.request` runs on the headless host itself. A confirmed method first goes as `omd/surface/call
  terminal.prompt {kind: 'confirm', title, message}` to the clients that declared `terminal.prompt` and runs only
  on `{status: 'accepted'}`, returning `{status: 'declined'}` otherwise or when none did.
- A call with `confirm` needs the user's consent in the client before it acts.

#### Security

Clients cannot mint grants or evidence. No `omd/*` method writes a grant, consent or evidence record; actions
resolve against the host's view, events reach only a component's owner, and resources only those in the view.

Mod engine callbacks keep running in the host runner without ambient Node, DOM or secrets; only the confined
renderer process uses its own UI runtime.

#### Client adapters

A mod owns its client adapter. It declares `os` with `os_access.programs` (for example `node`) and starts its UI
process from a native callback (a `channel` hop from a command) with `process.start {sandbox: 'none'}`, or starts
it sandboxed with `network: 'loopback'` (`network`) for a loopback `ws://` listener.

- It passes the listen URL and the token, or a token file path, through `environment` (names listed in
  `exec_environment`; a name containing `TOKEN`, `KEY` or `SECRET` needs `--allow-secret-env`) or ndjson stdin.
- The host stops the process with the mod.
- Its stdout is the framed message channel, so a UI process logs to stderr or a file: output that breaks the
  framing stops the process (an `exit` `process_event` follows).

#### Client SDK (`@oh-my-diff/mod-api/client`)

The UI process connects with the SDK in `@oh-my-diff/mod-api/client`:

```ts
connect({url, token?, command?, name, renderer, operations?, onView, onRoster, onMirrored, onSurfaceCall?, onServerRequest?, onNotification?, onReconnect?, onClose?})
```

It is dependency-free ESM for browsers and Node over `ws://`/`wss://` (bearer subprotocol), `unix://PATH` and
`stdio` (Node; spawns `codex app-server`).

- The session's `attach`, `update`, `detach`, `read`, `event`, `action` (serialized), `render`, `resource`,
  `recovery` and `request(method, params)` cover every `omd/*` and app-server method.
- After a disconnect it reconnects with backoff, re-initializes, re-attaches, replays the last update, resumes the
  threads it resumed through `request('thread/resume', …)` and reports `onReconnect({epoch, previousEpoch})`.
- `unsupported(component, renderer, drawable)` returns null or an `unsupported_element: <type> '<id>': <reason>;
  drawing its fallback "<text>"` error for a component the renderer cannot draw (a type outside `drawable`, a
  `raster` without `cells`, an `image` without an image format), with `fallback` set to its alt text, text or
  label.

`mods/examples/external_client` (a text renderer) and `mods/examples/approval_desk` (a GUI-shaped renderer that
answers approvals) are complete adapters for unrelated mods.

#### Desktop apps and editor webviews

The same contract backs an independently packaged desktop app or editor webview; Oh My Diff ships neither.

- A desktop app spawns `codex app-server --listen unix://PATH` (or connects to a user's `codex --listen` session)
  from its main process and runs the SDK there.
- A VS Code extension's host starts or finds the listener, writes a base64url capability token, and passes the URL
  and token to its webview, which loads the SDK as ESM and connects over `ws://127.0.0.1:PORT` with `--ws-auth
  capability-token` and `--ws-allowed-origin` set to the webview origin.

Either renderer:

- draws `snapshot.view.sites` by component type and calls `unsupported()` for the rest;
- reads images with `omd/resource/read`;
- sends `omd/action` and `omd/client/event`;
- answers approval server requests through `onServerRequest`;
- re-renders from the full snapshot after `onReconnect`.

`python3 -m scripts.client_acceptance --binaries DIR` drives both example adapters against headless and co-attached
hosts with a scripted local provider and is the conformance check for a new client.

## Packages, limits and registration rules

Binary evidence and SVG assets, the package controls a mod can call, the host limits `host.json` can set and the
rules the host enforces on registration, views and callbacks. Use this page to check what a mod may register, draw
and run.

### Binary evidence and package controls

#### `evidence.write` and binary evidence (`binary_evidence_v1`)

```ts
evidence.write {media_type: 'image/png' | 'image/jpeg' | 'image/svg+xml' | 'application/octet-stream', base64}
```

It accepts up to 8 MiB (`binary_evidence_v1`). PNG and JPEG references can be attached through `composer.write` and
image-capable app methods.

#### SVG assets (`svg_assets_v1`)

SVG (`svg_assets_v1`) is UTF-8 XML of at most 1 MiB whose root element is `svg`, after an optional XML declaration
and comments. Every element must be in the SVG namespace (an unprefixed element without a default namespace counts
as SVG).

The check refuses:

- a DOCTYPE and other processing instructions;
- `script`, `foreignObject`, `iframe`, `object`, `embed`, `audio` and `video` elements;
- `animate*`/`set` targeting `href` or an `on*` attribute;
- `on*`, `src`, `srcset`, `data`, `action`, `formaction` and `ping` attributes;
- `href`/`xlink:href` other than `#fragment` or a base64 PNG/JPEG `data:` URI;
- in any attribute or `<style>` text (case-insensitive, after resolving references) a `url(` other than
  `url(#...)`, `image-set(` (including `-webkit-image-set(`), `src(`, `@import`, `@font-face` or a backslash
  escape.

A refusal fails with `evidence_record_invalid: svg_<reason>`.

- `terminal.import_file` labels SVG text `image/svg+xml`, so it passes the same check.
- External renderers draw SVG natively.
- The terminal shows an `image` component's alt text, refuses SVG in `terminal.image_sample` and never attaches it
  to the composer.

#### Package controls (`package_controls_v1`)

`packages.list`, `packages.index`, `packages.preview`, `packages.apply` and `packages.reload`
(`package_controls_v1`) install, update, remove, roll back, enable and disable packages from local directories, Git
repositories, curated index releases and npm packages (sources and references are listed under [Package
commands](#package-commands)); `index` resolves dependencies. A request names its package with `source`
or with a `reference` string and an optional `version`.

#### `packages.list`

`packages.list` reports every store selection: managed packages and trusted `omd-mod` selections (`source:
'selection'`, which enable, disable and `trust` but do not update).

- `source` is also `npm` for npm packages.
- `blocked` is the quarantine reason or `null`.
- `packages.list {fields}` keeps only the named keys of each package, so a listing view can skip schemas, settings
  and grants it does not show.
- `packages.list` reports each mod's `settings` and `settings_schema`.
- `required` marks a selection the installer keeps on: `/mods` and `/omd` don't turn it off, `omd mods disable`
  still does.

#### `packages.index`

`packages.index {index?, query?, cursor?, limit?}` is read-only and returns:

```ts
{index, packages: [{id, latest, description, support, versions: [{version, blocked}], installed}], total, cursor}
```

It reads the named index (the store's `package-index.json` by default), filtered by `query`, one page of `limit`
entries (1-200, default 200) in id order. `total` counts every match; pass the returned `cursor` to read the next
page, and it is `null` on the last one. Paging requires `package_index_paging_v1`. It fails with
`package_index_unavailable` when no index exists.

#### Package state fields

- `effective`, `pending: 'reload'` and `failed` describe the serving session, so a change shows as pending until
  that session's next safe boundary, and a removed mod stays listed with `installed: false` until it stops.
- `reload_error` names a rejected change while the previous mods keep running.

#### `packages.apply`, `packages.preview` and `packages.reload`

`apply` and `reload` run from user contexts. The `trust` action re-approves an edited selection's current source and
capabilities and keeps it enabled.


- `apply` shows a native confirmation naming every new grant, dependencies as `id:capability`, and applies exactly
  the confirmed plan or refuses if the package, lock or selection changed.
- Installing never enables a package: an update keeps it on only if it was on and its grant, authority scopes and
  origin are unchanged, otherwise it stays off until enabled.
- The preview lists per package `authority {from, to}`, `grant {from, to}` and `renewed_approval`.
- Once a confirmed package mutation starts, it returns its definitive result even if its writes reload or disable
  the calling mod. Queued calls still reject cancellation, changed source, originating generation or client
  context.
- An update resolves dependencies through the index the package came from and previews the capabilities it adds.
- `packages.reload` makes every enabled selection revalidate at the next safe boundary, retrying failed mods.

#### `settings.write`

`settings.write {id?, values}` saves schema-checked settings (`null` removes one) from user contexts and redraws at
once. Without `id` it writes the caller's own settings; with `id` it needs `packages`.

Callbacks receive explicit settings over the schema's `default` values.

`/omd` stays the native recovery path.

#### Settings file (`settings_file_v1`)

Experimental. A user can set a mod's settings in a file instead of through `settings.write`:
`settings/<mod_id>.json`, `.yaml` or `.yml` in the mod store, the directory that holds `mods.json`.

- At most one of the three files may exist (more than one is invalid), at most 64 KiB, and its top level must be an
  object whose keys are the mod's setting names.
- Its keys override the saved settings (and the schema `default` values) in every callback, render and chain
  digest. The file is validated like `settings.write`: a key outside a schema with `additionalProperties: false`,
  a wrongly typed value and a missing `required` setting are invalid.
- Administrator-managed selections ignore the file (status `ignored`).
- The saved settings must be valid on their own, so a `required` setting without a `default` is saved through
  `settings.write` or `/omd`; the file then overrides it.
- An unreadable, oversize, unparsable or invalid file is skipped whole: the saved settings apply, the mod stays on and
  its view diagnostics carry `settings_file_invalid: <reason>`.
- Creating, editing or deleting the file applies at the refresh points of a `mods.json` change.
- `api.settingsFile` is `{path, status: 'missing' | 'loaded' | 'invalid' | 'ignored', error: string | null}`. `path` is the
  absolute file to tell the user to edit (the `.json` one while none exists); `error` is the reason when `invalid`.
- `settings.write` of a key the file sets fails with `setting_set_by_file: <key>`. `omd-mod selection-status` lists
  such keys with origin `file` and the file under `settings_file`.

Require `settings_file_v1` to use it.

### Host limits

`host.json` may set `mod_limits`:

| Limit | Default | Maximum |
| --- | --- | --- |
| `watches_per_mod` | 16 | 64 |
| `paths_per_watch` | 32 | 256 |
| `timers_per_mod` | 16 | 64 |
| `pty_panes_per_mod` | 4 | 8 |
| `completion_items` | 200 | 1000 |

#### Fault limit

Five consecutive failed callbacks (commands, tools, hooks and render hooks all count) in one host process turn a mod
off; any successful callback resets the count. These failures don't count: errors starting `state_conflict`,
`state_thread_unavailable`, `state_checkout_unavailable`, `callback_cancelled`, `host_receipt_limit`,
`host_result_limit`, `host_call_limit` or `callback_execution_budget`, and failures of `service` and `component`
events. The count lives in the process and is not persisted, so each `omd-mod command` starts at 0 and
`omd-mod status` shows `faults: 0` afterwards. The TUI says once in the transcript when a mod is turned off, and
`/omd` and `omd mods list` show why. A mod turned off in a running host comes back with `/omd` > Reload mods.

### Registration, view and callback rules

The host enforces these; `scripts/mod_host_check.py` (`mise run mods:host-check`) loads every first-party package
and example through the real host and reports any it refuses.

#### Registration limits

- At most 32 tools and 32 commands per mod.
- Commands are invoked as `/<id>:<name>`; the bare `/<name>` works only when no built-in command or other mod uses
  that name.
- Mod ids use `a-z`, `0-9` and `_` up to 24 bytes and never equal the host `origin.caller` labels `model`,
  `engine`, `code_mode` or `user`.
- Command and tool names use up to 32.

#### View limits

Keybindings:

- Each mod's view or patch has at most 24 keybindings.
- The view composed from every mod has at most 128, and a key bound by two mods rejects the later mod's patch.

Components:

- A view holds at most 64 components nested at most 6 deep.
- Component ids use `a-z`, `0-9` and `_`, up to 48 bytes, and are unique across the composed view.
- A `select` or `multiselect` has at most 16 options and a `list` at most 200 rows.
- A `wrap` site contains exactly one `slot`.

Links and hotkeys:

- A span `link` is an http(s) URL of at most 2,048 bytes on `line` and `list` spans (documents refuse it), drawn as
  an OSC 8 hyperlink, and `markdown` links become hyperlinks too.
- A control `hotkey` uses the keybinding names.

Text sizes:

- Row values, labels and spans are at most 256 bytes.
- `text`, `code`, `markdown`, `diff` and `document` are at most 49,152 bytes. The terminal keeps recent markdown
  renders, so a large `markdown` costs its parse, about 1 ms per KiB, only when its text or width changes; stream
  into `code` or `text`.
- A view or patch is at most 256 KiB of JSON and the composed view 1 MiB. Those JSON limits still apply to
  text-heavy views, and escaping can double a text (`\n`, `"` and `\` take two bytes), so clip long text on its
  `JSON.stringify` size rather than its 48 KiB length.
- Text fields refuse control characters except newlines where a field is multi-line.
- The status row holds at most 4 segments of 40 characters across all mods.

An invalid view is dropped with the failing field named and the mod's last valid view stays; `omd-mod status`
reports the composed view's diagnostics under `terminal`.

#### Input and focus

- A dialog focuses its first item when it opens, or the control it `autofocus`es.
- Tab and Shift+Tab cycle focus while a dialog shows or a control has focus; otherwise they stay the composer's, and
  a click, a `hotkey`, `autofocus` or a `{focus}` keybinding focuses a control first. Up and Down move within a
  list, multiselect, document or scrolled pane and, at its first or last row (or on any other control), focus the
  previous or next control; entering a list from above starts at its first row, from below at its last; key panes
  and terminals are reached with Tab once a control has focus, a click or a `{focus}` keybinding.
  Left and Right change a `select`.
- While a dialog shows or a control has focus, held arrow, page, Home, End, Backspace, Delete and character keys
  repeat; Enter, Space, Tab and Esc act once per press, and a held key never fires a hotkey or view binding.
- In a dialog, typing that no binding takes goes to its `autofocus` input.
- Esc, Ctrl+] or a click outside releases focus and hides the dialog until a mod command runs, and Esc reaches the
  focused component's owner as `component_event {kind: 'input', events: [{key: 'Esc'}]}`.
- A shown dialog is modal: keys it does not bind never reach the composer behind it (Ctrl+C still interrupts).
- Space on a focused `list` row or `button` activates it like Enter; on a `select` it steps to the next option.
- On a focused `multiselect`, Space toggles the current option and Enter runs its action with the checked values as
  a JSON array argument.
- A `hotkey` on a button, input, select, multiselect or list focuses it (a button runs its action) unless a text
  input has focus. It obeys the keybinding collision rules, is checked before view `keybindings`, and when two
  controls share one the first wins.
- `autofocus` focuses the control when it first appears and nothing has focus, reported as a `focus` event with
  origin `mod`.
- An `input`, `select` or `multiselect` is controlled: the user's edits stay while the view repeats a value, an
  echo of one of the user's own recent values is ignored, and a new `value` from the mod resets the field.

#### Callback lifetime

- General callbacks get a fresh VM context and activation.
- A package's later callbacks may reuse its sandboxed runner process and a bounded cache of stripped source and
  bytecode; runners are never shared between packages.
- Work a callback leaves running settles before its result is returned, and a host call from it after the callback
  returned fails that callback.
- Persist state through `api.state`; module globals do not survive general callbacks.
- Render hooks retain activation under their existing matching-input rules.

#### Text encoding and `crypto`

Every context has the standard `TextEncoder`. Host limits count UTF-8 bytes:

- `new TextEncoder().encode(text).length` measures a string.
- `text.slice(0, encoder.encodeInto(text, new Uint8Array(limit)).read)` cuts it to `limit` bytes without splitting
  a character.
- `encode` feeds `crypto.subtle`.

The `crypto` environment provides `getRandomValues`, `randomUUID` and the `crypto.subtle` methods.

- `crypto.subtle` implements the Web Cryptography API's standard algorithms: SHA-1/256/384/512, HMAC, AES-GCM,
  AES-CBC, AES-CTR, AES-KW, PBKDF2, HKDF, ECDSA and ECDH (P-256, P-384, P-521), Ed25519, X25519,
  RSASSA-PKCS1-v1_5, RSA-PSS and RSA-OAEP, with `raw`, `spki`, `pkcs8` and `jwk` keys as each algorithm allows.
- Limits: AES-GCM takes a 96-bit `iv` and a 128-bit tag; AES-KW keys are 128 or 256 bits; ECDSA signs P-256 with
  SHA-256, P-384 with SHA-384 and P-521 with SHA-256, SHA-384 or SHA-512; RSA keys are 2048–8192 bits with exponent
  65537, and RSA-PSS `saltLength` equals the hash length. Anything else fails with `NotSupportedError`. Generated
  HMAC keys and derived bits are at most 8,388,608 bits (1 MiB) and PBKDF2 `iterations` at most 4,294,967,295;
  larger values fail with `OperationError`.
- Their results are copied into the mod's context.
- A `CryptoKey` is a frozen handle with `type`, `extractable`, `algorithm` and `usages`.
- Failures are plain `Error`s whose `name` is the Web Crypto error name.

There is no `TextDecoder`, `Buffer` or `structuredClone`, and no code is compiled from strings (`eval`, `new
Function`), in the mod's context or the runner process. The runner has no event loop, so `Atomics.waitAsync` is absent:
wait with `Atomics.wait` or the `time.sleep` operation.

#### Manifest `environment`

`"environment": ["crypto"]` in `mod.json` admits the `crypto` global above. It is the only environment a mod can
declare (another or repeated name fails with `unsupported_or_duplicate_environment_access`).

Source that uses `crypto.` or `crypto[` outside string literals without it is refused at load with
`undeclared_environment_use: crypto (crypto.)`, naming the matched text. The same error names these, which no
manifest admits:

- `network` (`fetch(`, `WebSocket(`)
- `process` (`process.`, `Deno.`, `Bun.`)
- `dom` (`document.`, `window.`)
- `filesystem` (`node:fs` or `require('fs`, matched inside literals too)

#### Experimental session UI state

`api.uiState.get()` / `.set(value)` requires `terminal`.

- Values are bounded to 65,536 UTF-8 bytes of compact `JSON.stringify(value)` output, including quotes, keys and
  escapes.
- Strings and object keys must contain valid Unicode scalars (no lone surrogates).
- The host checks the original serialized bytes before parsing; number reformatting does not change the limit.
- Values are shared by host instances in the same process, store, repository, thread and package identity.
- Commands and component events may write; other callbacks may read.
- Writes commit only after successful validation and cancellation checks, with revision conflicts using the
  existing receipt-replay rules.
- Authority polling with unchanged configuration preserves UI state and command views.
- State is cleared on explicit reload, revocation, package changes and session teardown, and is never written to
  disk.
- A reload during a command or component event (such as one its own `packages.apply` caused) does not cancel it,
  and its `set` lands on the cleared state, even with the value it read; a change of repository during it cancels
  it.

Durable `api.state` is unchanged. Use UI state for open dialogs and filters, and durable state for preferences that
must survive a restart.

#### Experimental command views

Return `{terminal: patch}` with a `TerminalPatch` to replace your complete terminal contribution, or `{terminal:
null}` to clear it.

- The host validates capability, ownership and generation, composes it with other owners' last valid contributions
  and displays it before asynchronously refreshing expired callbacks.
- Keep a `terminal` handler that reconstructs the same contribution from UI state for subsequent view updates.
- This opt-in path changes when other owners refresh; commands without `terminal` retain their synchronous preview
  behavior.
- Migration from durable dialog state consists of moving only transient presentation fields to `api.uiState` and
  returning the view from the command; persisted settings, replay and module lifetimes are unchanged.

#### Callback contexts

`terminal` renders and `render` hooks get no host operations; draw from `api.state`.

Slash commands, buttons and keybindings run in the terminal as user actions and reach only:

- `exec.*`
- `workspace.read/list/stat/check_access/transaction/backup/restore`
- `store.*`
- the terminal operations (`app.request`, `credentials.*`, `terminal.*`, `composer.*`, `builtins.invoke`,
  `packages.*`, `routes.add`, `routes.write`, `contract.select`, `sessions.ports`, `settings.write`)
- `app.routes`
- `turns.activity`
- `events.publish`

A service call works only while its provider needs no other host operation.

Component input callbacks run there too but not as user actions, so `packages.apply`, `settings.write`,
`builtins.invoke`, `credentials.request` and `terminal.import_file` are refused.

Anything else (`task.*`, `contract.*`, other `routes.*`, `evidence.*`, `workspace.snapshot/fingerprint`, `process.*`,
`agents.*`) goes through `events.publish` to the mod's own `channel` handler, which runs with the session.

#### Settings defaults

Callbacks receive explicit settings over each `settings_schema` property's `default`; give every property a
default.

A property may also carry a `title` (up to 64 bytes) and a `description` (up to 300 bytes), which `/mods` shows
instead of the raw name, and `choices: "routes"` on a string property without `enum`: `packages.list` then fills its
`enum` with the names of the `host.json` worker routes open to that mod.

#### Runner memory limits

Each runner process has a 64 MiB V8 old-space limit, and the host kills a runner whose physical memory
(ArrayBuffers and other off-heap data included) passes 512 MiB. Either fails the callback with `mod_out_of_memory`.

## Authoring

The commands and tools for writing a mod: scaffolding, checks, tests, watch-and-reload, JSX, multi-file packages and
diagnostics. For packaging and publishing, see [Packaging, publishing and offline scenarios](#packaging-publishing-and-offline-scenarios).

### Author commands

| Command | Result |
| --- | --- |
| `omd-mod-author create DIR ID` | Minimal typed package with pnpm scripts and offline tests |
| `omd-mod-author example DIR NAME` | Copy one named author example into a new project |
| `omd-mod-author examples DIR` | Every public author example |
| `pnpm check` | Syntax validation, plus strict validation against this exact SDK when TypeScript is installed; prints `check: ok` when it passes |
| `pnpm test` | Engine-owned scenario execution with no provider requests, then (once TypeScript is installed) the `pnpm check` type check, which fails the run before the report prints, then every `*.test.ts` and `*.test.mjs` beside `mod.test.json` under `node --test` (see [TypeScript tests](#typescript-tests)) |
| `pnpm run run` | Runs the same deterministic scenario and prints the full trace |
| `pnpm debug` | Runs an intentional failure and retains its mapped source location |
| `pnpm run package` | Produces a checked package directory, JavaScript debug build, source map, and digest report |
| `pnpm watch STORE` | Re-inspects reviewed local source, approves the edited digest, queues reload, and copies the store's declarations into `.omd/` (see [Watch and reload](#watch-and-reload)) |
| `omd-mod-author report STORE` | Declared-versus-used capabilities, services, operations, and environment |
| `omd-mod-author events STORE` | Composition order, scope precedence, events, replacements, and conflicts |
| `omd-mod-author diagnostics STORE OUTPUT` | Reproducible JSON bundle with paths, settings, environment, and credentials removed |
| `omd-mod-author explain DENIAL` | Cause, safe remedy, and the authority boundary for a denial |

#### Author toolchain

- The `omd-mod` binary is part of the OMD engine. Set `OMD_MOD_BIN` only when a development build is not already on
  `PATH`.
- Set `OMD_MOD_NODE` to the supported Node 24.x executable, 24.18 or later.
- pnpm is the package manager. The repository also publishes equivalent `mise run mods:*` tasks without making pnpm a
  mise tool.

### Typed tool declarations

A running host stores the lead thread's tool inventory (`tools.list`) in its store. `omd-mod declarations STORE`
renders it as `tool-types.d.ts`: a module augmentation of the empty `ToolArguments` interface, keyed by tool name.

Each tool's type is converted from its original JSON schema:

- Supported keywords: `type`, `properties`, `required`, `items`, `enum`, `anyOf`, `additionalProperties`.
- Anything else is `Json`; a freeform tool is `string`.

`omd-mod-author watch` copies the file into `.omd/` beside `active-host.d.ts` and `installed-contracts.d.ts`. The
scaffold's `tsconfig.json` already includes `.omd/*.d.ts`.

Once `ToolArguments` lists tools, the `tool` interceptor input and `tools.invoke`/`tools.check` arguments are exactly
one of those tools with its own argument type, so a tool the snapshot lacks needs a cast. Scenario runs use a
throwaway store, so they leave an existing `.omd/tool-types.d.ts` alone.

#### How current the declarations are

The declarations are as current as the last turn that built the thread's tools:

- MCP servers connected later, and tools a `tool_specs` interceptor hid, appear as the host last listed them.
- A mod's runtime check of the call is the host's `tool_arguments_invalid` validation, not these types.

### TypeScript tests

`pnpm test` runs `mod.test.json` and then every `*.test.ts` and `*.test.mjs` next to it with `node --test`:

- Assertions are `node:assert` (built into Node, no extra dependency or framework).
- Test files are plain TypeScript under Node's type stripping.
- `@oh-my-diff/mod-api/testing` builds and runs scenarios for them. It needs `omd-mod` like `pnpm test` and sends no
  provider request.

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advance, clock, environment, find, invoke, key, mount, packages, pointer, runScenario, storeMock, tiers, waitUntil } from '@oh-my-diff/mod-api/testing';

test('panel opens', () => {
  const trace = runScenario('.', clock(1000), environment({ MODE: 'ci' }), storeMock({ get: [null] }), packages('../policy'), tiers({ append: ['policy'] }), {
    steps: [mount('panel'), key('panel', 'F2', { expect: { action: { command: 'panel:open', args: '' }, result: 'opened' } })],
  });
  assert.ok(find(trace.steps[0].value, 'open'));
});
```

#### Scenario fields

| Helper | Sets |
| --- | --- |
| `clock(ms)` | `virtual_time_ms` |
| `environment(values)` | The environment |
| `settings(id, values)` | A mod's settings |
| `hostOperations({op: [{result} \| {error}]})` | Mocked host operation replies |
| `storeMock({get, put, delete})` | Ordered `store.*` replies, `null` for a missing key |
| `packages(...paths)` | Extra packages (a policy package, a user package), trusted in that order before the project |
| `tiers({prepend, append})` | Mod IDs run as [administrator-managed](#administrator-policy-and-managed-deployment) packages in that tier, so a test sees the composed order and the managed guard rule; an `intercept` step's trace shows the order |

- `scenario(...parts)` merges parts: queues and packages append, settings and tiers merge, and the last value of any
  other field wins.
- `runScenario(directory, ...parts)` runs the project and returns the engine trace.
- `calls(trace, operation)` lists the trace's host calls.

#### Mocked host operations

Mock operation names, arguments and results derive from `HostOperations`.

- Each reply can include `arguments` for exact JSON matching and `optional: true` for a call that may be absent.
- Reply queues are ordered per operation. An optional reply with different expected arguments can be skipped to reach
  the next reply.
- Fixture records must contain exactly one of `result` or `error`.
- An explicit queue for a timer or environment operation replaces its virtual implementation; exhausted queues never
  fall back to simulated behavior.

**Required replies must be consumed.** Unexpected calls, argument mismatches and unused required replies fail the
scenario. Unexpected-call and argument-mismatch failures remain scenario failures even when the mod catches the
operation error.

Validation:

- Every normal mock validates request and result shapes. Shared pure validators additionally check store keys,
  values and revision syntax, environment inputs and timer inputs.
- Malformed result fixtures fail before the scenario runs unless explicitly marked unsafe.
- Authority, declarations, persistence, revision conflicts, quotas, filesystem resolution and process/network state
  require real-host boundary tests; a valid mock cannot prove those behaviors.

Negative tests:

- `unsafeHostOperations({op: [{result, unsafe: {result: true}}]})` deliberately bypasses result validation.
  `unsafe.arguments` separately bypasses request validation. Neither grants runtime authority, and unknown operations
  still fail in the engine.
- `unsafeStep({...})` bypasses the SDK's discriminated step type to test malformed scenario input.

#### Scenario steps

- Time and events: `invoke(mod, event, name, payload)`, `emit(event, payload)`, `advance(ms)`,
  `waitUntil(check, until, {everyMs, maxMs})`, `reload()`.
- Views and input: `mount(mod)`, `key(mod, name)`, `activate(mod, component)`, `input(mod, component, value)`,
  `select(mod, component, value)`, `pointer(mod, component, {column, row, action})` (with `{client}` for an attached
  client's event).
- Clients: `attach(name, {renderer})`, `detach(id)`.
- Interceptors: `intercept(surface, payload, {core: [coreValue(v) | coreError(e)]})`.

- The last argument takes `expect`, `expectError` and `cancelled`.
- Interactions and `mount` also take `payload`, the `terminal` event input (default `{event: 'draw', ledger: null}`).

#### View queries and interceptor assertions

View queries over a mounted view's value: `find(view, id | fields | fn)`, `findAll` and `text(view)`.

Interceptor assertions over an `intercept` step's value:

| Assertion | Passes when |
| --- | --- |
| `assertWrapped` | The mod called `next` and the chain reached the core |
| `assertShortCircuit` | The mod answered, so the core never ran |
| `assertFailure(chain, mod, /reason/)` | Its link failed with that reason: skipped, kept, caught or rejected |

#### What tests don't prove

Mounting and interacting run the mod's `terminal` event and callbacks on fixture data. They show what a mod returns
and how it reacts, not how a terminal or an attached client draws or delivers it. A supported-client claim needs the
client conformance harness (`scripts/client_acceptance.py`) or a real terminal check.

### Watch and reload

#### Interactive watch

While a mod is written, `omd-mod-author watch DIR STORE` (or `pnpm watch STORE`):

1. Inspects the directory.
2. Approves its current digest in `STORE` as the user would with `omd-mod trust`.
3. Queues a reload of that store's host and refreshes `.omd/`.

Saving an entry point, asset or lifecycle file reloads again after 100 ms, and reports a half-written file instead of
stopping. A running session picks the reload up at its next turn boundary; `/omd` reloads at once while no turn runs,
and also disables or resets a mod.

**Because `watch` approves what it watches, point it only at a scratch store** (`omd-mod init STORE`) that holds
no other trusted mods, and run it only on code you wrote or reviewed. To try the mod in a real store, review the
digest and approve it there yourself with `/omd` or `omd-mod trust`. Code an agent wrote is never trusted
automatically.

#### Watching an installed package

For a local package installed with `omd install`, watch updates it through the package preview/apply path, preserving
its scope, settings, grants and enabled or disabled choice.

- It refuses a plan that changes any installed package's scope, including a shared dependency, as well as changed
  grants, authority or state versions. The refusal leaves the package lock and selections unchanged; review those
  changes separately before watching again.
- An installed Git or npm package, or a rollback pointing at cached source, needs a fresh local install of the
  editable directory before watch can update it.

#### Noninteractive watch and CI

- `omd-mod-author watch DIR STORE --once` does one inspect, approve and reload and exits, which suits a build step
  against a scratch store.
- `omd-mod-author test DIR` (or `pnpm test`) is the CI check. It needs no store, since it builds a throwaway store for
  every run. It fails (`no_tests`) when the project has neither `mod.test.json` nor a `*.test.ts` or `*.test.mjs`
  file.

Neither starts a provider request.

### JSX/TSX

Writing terminal components as JSX is optional and author-side only.

#### Entry point compilation

When a project has `index.tsx`, `omd-mod-author` (check, test, run, debug, package, and each watch reload) compiles it
with the project's own TypeScript into a self-contained `index.ts`. It inlines the small JSX factory, so the host still
sees one module with no value imports.

- The project needs `typescript` installed (`pnpm add -D typescript@5.9.3`); without it the command fails with
  `jsx_requires_typescript`.
- Edit `index.tsx` and treat `index.ts` as generated output. A hand-written `index.ts` beside `index.tsx` is never
  overwritten and fails with `jsx_entrypoint_conflict`.
- The scaffolded `tsconfig.json` sets `jsx: "react-jsx"`, `jsxImportSource: "@oh-my-diff/mod-api"` and
  `allowImportingTsExtensions`; `check` type-checks `index.tsx` itself.

#### `.tsx` assets

A `.tsx` file in any subdirectory is an asset source too (skipping `node_modules`, `dist` and dot directories):

- Each compiles to the `.ts` file beside it with the same rules and its own inlined factory.
- A relative import of `./row.tsx` becomes `./row.ts` in the output.
- List the compiled name in `mod.json` `assets` (`"row.ts"`). The host accepts only `.ts`, `.mjs` and `.json` assets,
  and `package` ships only the compiled files, never the `.tsx`.
- The 512 KiB package file limit applies to each compiled file.
- A hand-written `.ts` beside a `.tsx` fails with `jsx_entrypoint_conflict`.

#### Elements and children

Each `TerminalComponent` kind is an intrinsic element (`<box>`, `<line>`, `<text>`, ...) with the component's fields
as props.

| Element | Children become |
| --- | --- |
| `box`, `pane`, `dialog` | `children` |
| `text`, `button`, `markdown`, `code` | `text` (string and number children) |
| `line` | `spans` (string and span children) |

- Function components returning a component work.
- The factory is pure object construction with no Node or DOM authority and grants no capability.
- Unsupported elements and props fail at compile time through the types. A dynamic unknown tag fails with
  `jsx_unsupported_element`; children on a kind that takes none fail with `jsx_children_unsupported`.
- Fragments are not supported.

### Diagnostics and source maps

#### Multi-file packages

A package spans several files by importing its declared assets with relative specifiers:
`import { draw } from './draw.ts'`, `'./lib/util.mjs'`, or a `'./table.json'` default export.

- The runner links them in the callback's context, so they share module state for that callback.
- Anything else, including value imports of the SDK and any dynamic `import()`, fails with `unsupported_import`.
- Imported code counts toward the source-use report like the entrypoint; assets that are only read (for example
  scripts passed to `exec.run`) do not.
- Declare the required features `package_text_assets_v1` for assets and `package_imports_v1` for relative imports;
  `mod_host_check.py --static` fails a package that omits them.

#### Stacks and source maps

The engine strips TypeScript types in place, so callback stacks report the authored line and column as
`<package>/<file>:line:col`. `omd-mod-author package` also writes a `.js` file and `.js.map` source map beside every
`.ts` file it ships.

Only erasable syntax loads: `enum`, namespaces with values and constructor parameter properties fail with
`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`, and `pnpm check` reports them before packaging.

Status retains a bounded per-mod log containing event, handler, generation, outcome, and elapsed microseconds plus
aggregate timing. It never adds mod-side filesystem or process access.

#### Source-use report

The source-use report is derived from registrations and literal host/service calls. It compares declared
capabilities, service imports/exports, and admitted environment access with what the source uses:

- Undeclared use is rejected.
- Unused grants are reported. A declared `network` grant counts as used when `exec.run`, `process.start` or
  `terminal.pty` source passes a `unix_sockets` or `network` option outside comments and strings.

Diagnostics explain how to narrow or explicitly approve authority, but tooling cannot grant permissions by itself.

## Packaging, publishing and offline scenarios

How packages are planned, installed, locked, protected and published, and how `mod.test.json` scenarios test a mod
offline. For the author-side commands, see [Authoring](#authoring).

### Package commands

#### Install, update and remove

| Command | Result |
| --- | --- |
| `omd-mod package-plan STORE REQUEST_JSON` | Resolve and preview the exact graph, per-package authority and grant changes, settings, and enablement |
| `omd-mod package-apply STORE REQUEST_JSON CONFIRMATION` | Re-resolve and atomically apply only the unchanged preview |
| `omd-mod package-lock STORE` | Print exact current versions, sources, integrity, trust, settings, and rollback history |
| `omd-mod package-rollback-plan STORE ID` | Preview the prior integrity-addressed package version |
| `omd-mod package-rollback STORE ID CONFIRMATION` | Restore the prior cached package disabled, preserving explicit settings |
| `omd-mod package-uninstall-plan STORE ID` | Preview removal and reject installed dependents |
| `omd-mod package-uninstall STORE ID CONFIRMATION` | Remove the managed selection while retaining local source, state, cache, and history |
| `omd-mod plugin-preview CODEX_BIN CODEX_HOME NAME@MARKETPLACE CANDIDATE` | Compare a local plugin candidate and its skills/hooks against the installed cache without applying it |

#### Trust, credentials and runner

| Command | Result |
| --- | --- |
| `omd-mod credentials STORE` | List credential profiles (id, label, kind, provider, origin, status) without secret material |
| `omd-mod credentials STORE add-secret MOD_ID LABEL ORIGIN` | Store stdin as a secret owned by `MOD_ID` (replacing that mod's same-label secret) and print the profile |
| `omd-mod authorize-runner STORE` | With the authority broker deployed, grant the `omd-runner` beside this `omd-mod` as the store's runner (the installer runs it after each update); without the broker it does nothing |
| `omd-mod trust-all STORE PACKAGES_JSON` | Trust several exact packages (`[{path, sha256, capabilities, scope?}]`) in one configuration write, so a store protected by the authority broker asks once |
| `omd-mod broker-grants-import STORE [SNAPSHOT_JSON]` | Without a snapshot, capture the exact current configuration. With that unchanged snapshot, protect existing valid selections without changing capabilities, secret grants, expiry, settings or activation; report stale selections as skipped. Also grants the `omd-runner` beside this `omd-mod` as the runner; imports no package-source provenance. |

#### Selection, policy and protection

| Command | Result |
| --- | --- |
| `omd-mod selection-status STORE` | Show managed, project and user selections, precedence, administrator refusals, source errors, and each setting's origin without running mod code |
| `omd-mod package-sync STORE [--offline\|--rollback]` | Deploy the [administrator policy](#administrator-policy-and-managed-deployment)'s packages unattended, or reactivate the previous generation |
| `omd-mod policy show\|clear\|rollback`, `policy check\|set FILE`, `policy explain STORE [PROJECT_DIR]` | Print, validate, store (administrator) or explain the administrator policy |
| `omd-mod package-enable STORE ID` | Re-enable an unchanged trusted package at the next turn boundary, retaining settings and state |
| `omd-mod package-disable STORE ID` | Disable a managed package without deleting source, state, or cache |
| `omd-mod package-quarantine STORE ID REASON` | Disable the package and block its installed version and integrity; enable, reinstall and rollback of it are refused while data, cache and sources stay |
| `omd-mod package-unblock STORE ID` | Lift the blocks; the package stays disabled |
| `omd-mod revoke STORE MOD_ID_OR_PACKAGE` | Disable the mod and drop its grant (capabilities and secret environment cleared) |
| `omd-mod security-events STORE` | Print the store's redacted security log |

### Package requests

#### Native `package-plan` and `package-apply` requests

For native `package-plan` and `package-apply`, `REQUEST_JSON` is:

```ts
{action?, source, index?, scope?, offline?, trust, settings?}
```

| Field | Meaning |
| --- | --- |
| `action` | `install` (the default) or `update` |
| `trust` | `{packages: {ID: {capabilities, lifecycle?, dependencies?, secret_environment?}}}`: each package needs its exact capability and lifecycle grants, and dependencies need explicit trust too |
| `settings` | Maps package IDs to setting objects; an update preserves existing settings when omitted |

Apply the identical request with the preview's `confirmation` string.

#### `packages.preview` and `packages.apply` requests

The higher-level `packages.preview`/`packages.apply` operations and `omd` CLI use:

```ts
{action, id?, source?, reference?, version?, index?, scope?}
```

`action` is one of `install`, `update`, `remove`, `rollback`, `enable`, `disable` or `trust`. A request names a package
with `source` or with a `reference` (and optional `version`), never both.

#### Package sources

A `source` is one of:

| `source.kind` | Fields |
| --- | --- |
| `local` | `path` |
| `repository` | `repository`, `revision`, `subdirectory?`; `revision` is a 40-hex commit or a branch or tag name, resolved when the plan is made and locked as the commit (an offline install needs a commit) |
| `package` | `index`, `id`, `version`; `version` is empty (newest unblocked release), exact or `^x.y.z` |
| `npm` | `package`, `version?`, `registry?` (default from the user's npmrc, else `https://registry.npmjs.org`; `https` or loopback `http` only), `integrity?` (a sha512 SRI pin) |

#### Package references

A `reference` is the same choice as one string, shared by the `/mods` directory and the `omd` CLI:

| Reference | Meaning |
| --- | --- |
| `ID[@VERSION]` | A release from the curated index |
| `npm:NAME[@VERSION]` | An npm package; scoped names work (`npm:@author/omd-mod@1.2.3`) |
| `git+URL[#REF[:DIRECTORY]]` | A Git repository; `REF` defaults to `HEAD`; `git+file:///path` and a local path work |
| a folder | A local directory (absolute in the directory; `./`, `../`, `~/` or absolute in the CLI) |

Local package files reached through a symlinked directory outside the package are refused (`package_path_escape`).

### npm packages

#### Version and tarball checks

npm resolution reads the registry metadata and picks the exact version: empty is `dist-tags.latest`; otherwise an
exact version or `^x.y.z`.

The tarball must match the registry's sha512 `dist.integrity` and is extracted safely:

| Tarball rule | Limit |
| --- | --- |
| Entry types | Regular files only; symlinks, hardlinks and path escapes are rejected |
| Tarball size | At most 4 MiB |
| Unpacked size | At most 16 MiB |
| Entries | At most 1024 |

#### Package contents

- Its `package.json` `name` and `version` must match the request.
- `dependencies` must be empty: ship runtime code as the entrypoint and its imported assets (`peerDependencies` and
  `devDependencies` on `@oh-my-diff/mod-api` are fine).
- The package must publish `mod.json` (same version as `package.json`), the entrypoint, the assets and the lifecycle
  scripts.
- npm `scripts` such as `preinstall` and `postinstall` never run. Only the manifest's OMD `lifecycle` scripts run,
  sandboxed and only with an exact grant.

The lock records the exact version and the tarball SRI, and an offline install reuses the content-addressed cache.

#### Registries, tokens and proxies

Without `registry`, the host follows the user's npmrc (`$NPM_CONFIG_USERCONFIG` or `~/.npmrc`) like npm and pnpm:
`@scope:registry=`, then `registry=`, then the public registry.

- A `//host/path/:_authToken=` entry (with `${ENV}` expansion) authenticates requests under that prefix. The token
  reaches curl on stdin and never appears in arguments, the lock or the security log.
- Proxy variables (`HTTPS_PROXY`, `NO_PROXY` and lower-case forms) pass through.

### Package indexes

The store's `package-index.json` is the default curated index. An index file is bounded JSON with schema 1:

```json
{
  "schema": 1,
  "packages": {
    "example": [
      {
        "version": "1.2.3",
        "source": {
          "kind": "repository",
          "repository": "https://example.invalid/example.git",
          "revision": "0123456789abcdef0123456789abcdef01234567",
          "subdirectory": "mod"
        },
        "integrity": "SHA256_FROM_OMD_MOD_INSPECT",
        "description": "What this release adds",
        "support": "Where to get help"
      },
      {
        "version": "1.2.2",
        "source": { "kind": "npm", "package": "@author/example", "version": "1.2.2" },
        "integrity": "SHA256_FROM_OMD_MOD_INSPECT",
        "blocked": "Reason this release can't be selected"
      }
    ]
  }
}
```

`blocked` (a reason string) makes a release unselectable: planning it fails with `package_version_blocked: REASON`,
and `packages.index` lists it with that reason.

#### Index resolution

Resolution selects the highest unblocked exact or caret-compatible semantic version and then checks the index
integrity against the manifest, entrypoint, and every declared lifecycle script.

- Each dependency needs its own exact trust entry.
- Index files do not grant capabilities or script execution.

### Managed package manifests

A managed package manifest must declare `license` and `provenance`; the scaffold emits both with placeholders to
change.

#### `provenance.source` for Git installs

- For a Git install, `provenance.source` must equal the repository URL exactly, without the `git+` prefix or
  `#REF:DIRECTORY` suffix. For example, use `https://github.com/author/repo` for
  `git+https://github.com/author/repo#v1.2.3:mod`.
- For a local source such as `git+file:///absolute/repo#REF:mod`, use the repository's canonical absolute filesystem
  path, without `git+`, `file://`, the revision or the mod subdirectory; resolve symlinks first.
- Commit that manifest at the selected Git revision. A mismatch is refused with `repository_provenance_mismatch`.

#### Package `description`

An optional `description` of 1–160 printable characters says what the mod adds; `packages.list` and the `/mods`
screen show it.

### Enablement, rollback and history

#### Enablement on install and update

**Installing never enables a package.** An update keeps a package on only if it was on and its grant, authority
scopes and origin are unchanged; otherwise it is off until enabled.

`package-plan` shows per package:

| Field | Meaning |
| --- | --- |
| `authority {from, to}` | Exposure text plus the `os_access`, `approves`, `http_access`, `fs_access`, `mcp_servers`, `policy`, `peer_access` and `autonomy` scopes |
| `grant {from, to}` | The grant change |
| `renewed_approval` | True for a new install or a changed grant, authority or origin |
| `state_version {from, to, migration_required, handler_required}` | The state version change |

#### Rollback and cleanup

Package rollback repoints the selection at the immutable store cache, so returning to editable local development is a
fresh local install of the rolled-back source.

Successful local package updates retain eight rollback history entries. After commit, the package manager removes
local snapshots evicted from that history when no installed package, retained history, selection or managed
deployment references them.

- Cleanup leaves editable sources and remote package caches alone; uninstall retains its cache.
- This is best-effort cleanup of history evictions, not a store-wide size limit: abandoned previews, older orphaned
  snapshots, interrupted cleanup and deletion failures can retain extra files.

### Protection, recovery and the security log

`omd-mod`'s protection and recovery commands work without any control mod. Quarantine keeps the package's data, cache
and sources, so unblocking and enabling restores it.

`security-events` prints `security-events.jsonl`, bounded to 64 KiB (the oldest half is dropped) and redacted: sources
lose credentials and query strings. Its events:

- `install`, `update`, `uninstall`, `rollback`, `enable`, `disable`, `quarantine`, `unblock`, `revoke`, `trust`,
  `lifecycle`
- `package_refused` (with an error code and the stripped source)
- `load_denied` (a selection rejected at reload)

#### What the checks don't guarantee

Permissions a user deliberately grants (`os` unsandboxed, network, `approve`, secrets) still run with that authority.
Scanning, integrity checks, signatures and directory inclusion do not make a mod safe, and a trusted service provider
acts with its own authority for any caller.

### Publish a mod to npm

`omd-mod-author package .` (`pnpm run package`) writes the checked directory `dist/ID-VERSION` with a JavaScript build,
source map and digest report. It doesn't produce a tarball, so check the npm tarball with `pnpm pack`.

1. In `package.json` remove `"private": true` (the scaffold's publish guard) and set the scoped `name` (for example
   `@author/omd-mod`) and a `version` equal to `mod.json`'s; set `license` and `provenance` in `mod.json`.
2. Keep `files` listing `mod.json` and the entrypoint (the scaffold starts with both) and add every declared asset and
   lifecycle script.
3. Keep `dependencies` empty: ship runtime code as the entrypoint and its imported assets, and keep
   `@oh-my-diff/mod-api` a `peerDependency` or `devDependency`.
4. Run `pnpm check`, `pnpm test`, then `pnpm pack`. The tarball must stay under 4 MiB and 1024 entries and list only
   regular files. Inspect it with `tar -tzf *.tgz`.
5. Run `pnpm publish --access public`.
6. Share `npm:@author/omd-mod@1.2.3`; users run `omd install` with it or paste it into `/mods` under Add from source.
   Catalog inclusion isn't needed.

### Offline scenarios

A `mod.test.json` file uses schema 1 and runs a mod with no external work.

#### Scenario file fields

| Field | Meaning |
| --- | --- |
| `virtual_time_ms` | Fixes `Date.now()` and zero-argument `new Date()` inside every callback |
| `host_operations` | An ordered result/error queue for each approved host operation |
| `settings` | A map from mod ID to that mod's explicit settings; the author commands apply it through `omd-mod settings` before the run, so configured behaviour is testable offline |
| `packages` | Additional trusted packages, enabling provider/consumer and conflict fixtures without shared globals or ambient authority |
| `tiers` | Maps loaded mod IDs to `prepend` or `append` and runs them as administrator-managed packages in that tier for the scenario only, so a test sees the managed interceptor order and that its answers can't skip a managed required guard |
| `environment` | Nonsecret names mapped to string values (see [Offline environment](#offline-environment)) |

- Any unmocked call fails before external work, and every result records `paid_requests: 0`.
- `expect` is deep equality of the step's whole value, not a subset (`offline_expectation_failed`). A render `intercept`
  result includes `trace[].location` (`index.ts:75:7`), so an exact expectation breaks when lines move: test
  interceptors in a `*.test.ts` file ([TypeScript tests](#typescript-tests)).
- A store-level `omd-mod test STORE SCENARIO` uses the store's own settings instead of `settings`.
- A mod that fails to activate reports its retained cause, so a missing service provider, denied capability or source
  error names itself instead of only asking for a reload.

#### What steps can do

Every step has a `type`:

| `type` | Meaning |
| --- | --- |
| `invoke` | Calls one mod's tool, command or hook by `mod`, `event` and `name` with `payload` |
| `event` | Dispatches `event` with `payload` to every mod that handles it |
| `tool_outcome`, `agent` | Dispatches a `tool_result` or `agent` lifecycle event |
| `advance_time` | Moves virtual time forward by `ms`, running due timers |
| `wait_until` | Repeats a `check` step as time advances until it equals `until` |
| `reload`, `status` | Reloads the mods at a safe boundary; returns the host's status |
| `state` | Returns (or with `value`, first writes) a mod's persisted `api.state` |
| `tool_exposure` | Returns the tool names the mods expose for a `payload` ledger |
| `terminal_mount`, `terminal_interact` | Draws a mod's terminal view; sends it a `key` or a `component` interaction |
| `component` | Steps one `api.component` module instance |
| `client_attach`, `client_detach` | Adds or removes an external client |
| `intercept` | Runs an interceptor chain for `surface`, answering `next` from `core` |

Steps can:

- advance virtual time;
- invoke tools or commands;
- dispatch ordinary events, interceptor chains (an `intercept` step answers `next` from its `core` replies), tool
  outcomes and agent lifecycle;
- reload at a safe boundary;
- mount a terminal view, and interact with a mounted key or component ID. Component interaction activates buttons,
  inputs, and selectors with an optional `value`; copy actions return without touching the system clipboard.

A step can carry `expect`, `expect_error`, or `cancelled`, and `thread_id` to run in that thread when its payload names
none. Thread-scoped state, timers and component events follow it; the `THREAD` argument of `omd-mod test` binds every
step and takes precedence. In a TypeScript test, pass `threadId` in a step's options.

#### Offline environment

`environment` maps nonsecret names to string values (4096 bytes at most) that `environment.read` answers in place of a
`host_operations` queue, so a scenario never reads the host's environment.

- An unlisted name is `{set: false}`.
- A secret-like name (`*KEY*`, `*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `AWS_*`, ...) fails the scenario with
  `offline_environment_secret_name`.

#### `state` step

```json
{"type": "state", "mod": ID, "value"?: VALUE, "thread_id"?: ID}
```

Returns that mod's persisted `api.state` from the scenario's store, so `expect` can check it after any step. With
`value` it first writes that state (the mod needs `store`, and the usual state limits apply), seeding a test without a
setup command.

#### `component` step

```json
{"type": "component", "mod": ID, "module": NAME, "instance"?: NAME, "props"?: VALUE, "columns"?: 80, "rows"?: 0, "events"?: [...]}
```

Steps one instance of the mod's `api.component` module at the scenario's virtual time, delivering the `key` and
`pointer` events and every due tick, and returns `{tree, post, next_ms}`.

- The instance mounts on its first step and keeps its state until the scenario ends, so `advance_time` steps drive
  `every` ticks.
- The module gets no host authority and its tree is validated as for a terminal.
- `omd-mod test` and `mod_host_check --scenarios` run it like any other step.

#### `wait_until` step

```json
{"type": "wait_until", "check": STEP, "until": VALUE, "every_ms": 1000, "max_ms": N}
```

Runs `check`, and while its value differs from `until` advances virtual time by `every_ms` and checks again (at most
256 checks). It returns `{waited_ms, value}` or fails with `offline_wait_timeout` at `max_ms`.

#### Pointer and client steps

- A `terminal_interact` `key` runs the view's `keybindings` entry, else the first `key_contexts` binding for that key
  (offline steps have no focus).
- `terminal_interact` also takes `pointer: {column, row, half?, action, button?}` with `component`. The mounting mod
  receives `component_event {kind: 'pointer'}` with `origin: 'user'`, only for a `box`, `image` or `raster` mounted
  with `pointer: true` (`offline_terminal_component_not_pointer`). Adding `client: ID` delivers it as that attached
  client's event (`client`, no `origin`).
- `client_attach {name, renderer?, viewport?, focused?}` adds an external client as `client-1`, `client-2`, ... and
  `client_detach {id}` removes it (`offline_client_not_attached`).
- A mounted `terminal` payload carries the roster as `clients` unless it sets its own.

These steps run the mod's callbacks on fixture data; they are not terminal or client rendering evidence.

#### Task-scoped tools and `tool_exposure`

`task_scoped: true` on `api.tool` and the `tool_exposure` event (host feature `task_tool_exposure_v1`) expose optional tools per task.

- Before each sampling step, the event receives the host `ledger`, thread ID, and only the current mod's optional tool
  names. It returns `{enable: [...]}` for a subset of those names.
- A missing or failed decision exposes none of that mod's optional tools; an invalid or foreign name disables the mod
  with a visible error.
- Ordinary registered tools and every native tool keep their existing exposure. A tool still executes through native
  permission, cancellation, accounting, and workflow gates.
- Context contributors can attach a bounded subordinate fragment for the same task without replacing base
  instructions.
- In an offline scenario, `{"type":"tool_exposure", "payload": {...ledger...}}` records the exact names registered for
  that step.

## Composition and safety

How mods share the single-threaded runtime and compose with each other, how the macOS authority broker protects
credentials and grants, and how an administrator policy restricts and deploys mods. Read it when you reason about
ordering, hook skips, protected authority or managed deployment.

### Runtime waits and hook skips

The mod runtime is single-threaded and never runs re-entrantly. Request and stream hooks wait up to 2 s while
another request or stream hook holds the runtime.

When a non-hook callback holds it, such as a tool waiting for the agent it spawned, a mod-spawned agent's request
and every response stream proceed at once without hooks; other requests wait up to 2 s first.

- Each skip is recorded as `middleware_skipped` with the hook and reason.
- A skipped or unsubscribed stream runs without stream hooks for the rest of that response.
- The middleware log records only selections, transformations and fallbacks, and stops growing at 8 MiB.
- These skips apply to `api.middleware` hooks. Interceptors hold the runtime only while a handler starts or
  settles, never while `next` waits, and follow the required/optional waits of [continuation
  middleware](#continuation-middleware-continuation_middleware_v1-tool_continuation_v2).

### Service dispatch (`service_dispatch_v1`)

`service_dispatch_v1` keeps a service provider's own capability grants, source identity, storage namespace and
host-operation provenance when a consumer calls it.

- A nested call shares the initiating callback's cancellation, 128-call and 5 s execution budgets.
- Recursive providers and chains beyond eight callback frames fail closed.
- Standalone invocations without a provider-aware host dispatcher refuse that provider's host operation.
- Offline `host_calls` records the actual mod caller for every mocked operation.

### Callback budgets and the clock

The host answers each host call, including `next` and `time.sleep`, inside the running callback, so a callback runs
once and makes at most 512 host calls. Offline runners without an interactive host replay the callback once per
host call instead.

`Date.now()` and `new Date()` return the callback's start time, advanced only by each `time.sleep`'s `slept_ms`,
including in a state-conflict retry.

- `hook_budget_ms` bounds the callback's own JavaScript time.
- A separate 5 s total bounds the callback's JavaScript time plus its waits on terminal operations that need no
  user answer. Exceeding it fails the callback with `callback_execution_budget`.
- Confirmations and prompts may wait longer, and other host operations keep their own timeouts.

### Composition order

Dependencies run before consumers and remaining mods use lexical ID order. Managed scope shadows project scope,
which shadows user scope, without inheriting its state or grants. Observers compose in that order; interceptors
follow the [interceptor order](#interceptor-order).

Exclusive replacements, contract IDs, service providers, and namespaced tools fail closed when contested. Native
permissions, credentials, accounting, cancellation, evidence, workflow enforcement, and provider authorization
remain outside the mod API.

### Terminal patch composition (`ui_composition_v1`)

Every mod's `terminal` patch composes in the same order (`ui_composition_v1`):

- Sites wrap or replace. A wrap encloses the site's replacement whichever composes first. A site's `overlay` is not
  claimed, so the last patch that sets one wins, even a wrap over another mod's.
- Presentation fields merge.
- Exclusive fields (layout, panels, header, footer, placeholder, replaced sites, keys, glyphs and the status
  budget) go to the first claimant. Each later claim is reported in `omd-mod status` under `terminal.conflicts` as
  `{field, owner, rejected, origin}`.
- A patch that breaks the composed view's limits is dropped whole.

### Reuse of `terminal` patches

The host reuses a mod's last `terminal` patch without a callback while its settings, durable state, UI state and
the `terminal` event input are unchanged.

- A patch from a callback that read the clock (`Date.now()` or `new Date()`) is reused for at most one second, so
  elapsed times and countdowns stay current on the next redraw.
- A command's `{terminal}` result likewise stands for at most one second; after that the next view update runs the
  `terminal` handler.

### Protected authority (macOS)

Without the broker, credential profiles, the trusted grant set, the task ledger and contract state are files in the
mod store, so any process running as the user can read or change them, including an explicitly unsandboxed child,
and `status.authority` reports `unprotected (same-user)`. Agent commands that Codex runs in its sandbox can't reach
the mod store, workspace leases, `host.json` protected paths or secret files; commands it runs without one (approved
escalations, allow rules, full access, an external sandbox) can.

#### The broker

`omd-package broker install` (sudo) deploys an OS-separated broker: a LaunchDaemon running as the hidden
`_omdbroker` account owns `/Library/Application Support/OhMyDiff/broker` (mode 0700) and answers on
`/var/run/dev.ohmydiff.broker.sock` only to peers whose kernel audit token resolves to a hardened-runtime binary
whose code directory hash root has pinned. The broker asks the kernel for the running peer's signing status and
code directory hash, never reading the executable, so binaries installed under a private home folder verify too.
It also installs a root LaunchDaemon, `omd-broker power`, that answers only the broker's account on
`/var/run/dev.ohmydiff.broker.power.sock` and does one thing: set `SleepDisabled` for [power holds](#power-holds-power_hold_v1)
and put the previous value back when the last hold ends, the broker exits or it restarts after a crash, then sleep
the Mac if its lid is closed.

#### What the broker protects

While the root-owned daemon plist exists, `status.authority` reports `protected (OS-separated broker)` and the
host:

- keeps credential profiles, secrets and sign-in tokens in the broker (enrollment never writes them to the user's
  disk);
- runs mod callbacks only under the `omd-runner` beside the host executable whose path and digest the broker holds
  as a runner grant (`runner_unverified` otherwise, `runner_changed` when the binary changes after verification).
  Only `omd-mod init`, `omd-mod authorize-runner STORE` (the installer runs it after each update) and broker grant
  import grant a runner; trusting or installing packages never does. A missing runner fails with
  `runner_unavailable`, with no fallback to another program;
- accepts a mod selection only when the broker holds the same grant (path, digest, capabilities, scope and secret
  environment), otherwise `grant_not_brokered`; enabling, disabling and settings changes don't touch the grant.
  `trust`, `trust-all`, exact broker grant import and package installs or updates add grants, and only for the
  selections they change, so an entry another process adds to `mods.json` is never granted by an unrelated change.
  Removing a selection revokes its grant without authorization. A running mod whose grant disappears is unloaded at
  the next reload, and all mods unload while the broker can't be reached. The host re-reads grants when `mods.json`
  changes and at most every 2 s otherwise;
- anchors every task-ledger record and contract-state write in the broker and refuses a ledger or contract state
  that differs from its anchor (`evidence_anchor_mismatch`, `contract_state_anchor_mismatch`), including a deleted
  one. State that was never anchored (created before `broker install` or after `broker reset`) is anchored as found
  when it is next opened. A record is written before it is anchored, and a record whose anchor fails is removed;
- fails closed with `authority_broker_unavailable` when the broker can't be reached; mods stay inactive and the
  session continues without them.

#### Authenticating changes

Changing grants or enrolled credentials makes the broker ask the logged-in user to authenticate in a system dialog
(right `dev.ohmydiff.broker.grant`). Without a GUI login session, for example over SSH, OMD asks for the macOS
login password in the TUI or terminal instead, and the broker checks it against the connecting user's own account.

- Mods can't produce that prompt: their prompts always name the asking mod.
- Each change carries a single-use broker challenge bound to its digest and a generation check, so a stale writer
  is refused.
- Broker policy values need an administrator (`dev.ohmydiff.broker.policy`).

#### Trust boundary and limits of the broker

The trust boundary is the OS plus the pinned binaries. Broker install and pin accept only the helper and binaries
listed in a release manifest signed by the Oh My Diff release key, and later privileged steps run from a root-owned
copy of the broker tooling, so a locally built or replaced binary can't be pinned.

The broker doesn't protect against an administrator or root. Same-user processes can still:

- read every user-readable file (for example `~/.codex/auth.json` or other secret files);
- edit the mod store (the host then rejects what the broker doesn't confirm);
- drive OMD interactively, in which case the authentication dialog still appears;
- use enrolled credentials against their enrolled origins through OMD or a sidecar's gateway path.

Credential tokens leave OMD only toward their enrolled origin, but a mod's own secrets (`OMD_SECRETS`) are placed
in its sidecar's environment, and service grants in `host.json` are user-writable, so a same-user process that
edits a grant can read those secrets. OMD offers no secrets-read API.

#### Broker pinning, reset and uninstall

- Installs, upgrades and rollbacks of signed releases pin their binaries (one sudo prompt), and `omd-package broker
  pin` re-pins by hand.
- `omd-package broker reset` clears grants and anchors but keeps credentials.
- `omd-package broker uninstall` removes the daemon, account, rights and all broker state, returning to same-user
  mode.

### Administrator policy and managed deployment

An organization restricts and deploys mods through one administrator policy. OMD reads it from the broker (key
`mods`) when the broker is deployed and holds one, otherwise from the root-owned file `/Library/Application
Support/OhMyDiff/policy.json` (`/etc/oh-my-diff/policy.json` on Linux).

#### Installing and replacing the policy

- With the broker, `omd-mod policy set FILE` stores the policy in the broker and needs an administrator
  (`dev.ohmydiff.broker.policy`); `policy rollback` swaps it with the value it replaced and `policy clear` removes
  it.
- Without the broker, `omd-package policy install FILE` (sudo) checks the policy and writes the file (mode 0644,
  keeping the replaced one), `policy rollback` swaps them back and `policy remove` deletes it.
- A policy file or folder that isn't owned by root or is writable by anyone else fails with
  `managed_policy_untrusted` and no mod loads until it is fixed.

OMD never contacts a vendor for policy and there is no remote disable: restrictions are an organization's own
decision, made on the machine.

#### Policy file example

```json
{"schema": 1,
 "managed_only": false, "sideload": true, "updates": "user",
 "sources": ["/Library/OhMyDiff/packages/", "npm:https://npm.example.com/@corp/"],
 "deny": ["old_tool"], "capabilities": ["commands", "interception", "store"],
 "index": {"sha256": "…", "locations": ["/Volumes/mirror/index.json", "/Library/OhMyDiff/index.json"]},
 "registry": "https://npm.example.com",
 "packages": [
  {"id": "corp_guard", "source": "corp_guard@2.0.0", "sha256": "…", "capabilities": ["interception"],
   "tier": "append", "settings": {"mode": "strict"}, "percent": 20},
  {"id": "corp_guard", "source": "/Library/OhMyDiff/packages/corp_guard", "sha256": "…",
   "capabilities": ["interception"], "tier": "append",
   "mirrors": ["git+https://git.example.com/guard.git#0123…"]}]}
```

#### Policy controls and refusals

The controls apply to user and project selections; packages the policy lists are never refused by them:

| Field | Refusal |
| --- | --- |
| `deny` | `managed_denied`: the mod IDs are revoked. |
| `managed_only` | `managed_only`: only managed packages load. |
| `capabilities` | `managed_capability_denied`: a capability outside the list, for example `approve.override`, is withheld from every unmanaged mod. |
| `sideload: false` | `managed_sideload_denied`: user packages need broker-protected install provenance, and `trust` refuses. |
| `sources` | `managed_source_denied`: installs and loads need an allowed source namespace: a folder path, `git+URL`, `index:PATH#ID` or `npm:REGISTRY/NAME`. Matching requires an exact reference or a `/` or `#` boundary; traversal segments are refused. Loads without protected provenance report `managed_source_unverified`. |
| `updates: "managed"` | `managed_updates_denied`: users can't update or roll back installed packages. |

These refusals apply at every reload, so revoking takes effect immediately, and `/omd` lists them. Approval floors
stay in Codex's managed requirements, which `approve.override` never overrides; the capability list withholds
approval authority itself.

#### Package-source provenance

Package-source provenance binds the package ID, path and content hash in the broker's protected grants.

- Only a verified online package install records it; editable locks, offline cache claims and broker grant import
  cannot establish origin.
- Under source or sideload restrictions, user packages without this evidence stay unloaded, including file-policy
  deployments without a broker.
- Git verification reads fresh fetched objects with isolated configuration; cached URL rewrites, replacement refs
  and editable cached objects cannot certify origin.
- Reinstall from a verified source with the broker deployed to establish evidence.
- Managed packages use the administrator's pins directly.

#### Managed `packages` entries

Each `packages` entry pins a package's exact content (`sha256`) and its grant (`capabilities`, `dependencies`,
`secret_environment`); the policy is the grant, so a managed package needs no broker grant or user prompt. A policy
can't grant install scripts.

| Entry field | Meaning |
| --- | --- |
| `users` | Lists account names. |
| `percent` | `percent` (1–100) admits a stable share of accounts per package ID. |
| `projects` | Lists folders the session's repository must be inside, compared after resolving symlinks. |
| `tier` | Places the package's interceptors: `prepend` outside every other mod, `append` inside. |

- For each ID the first entry that applies is the target and later entries are fallbacks, so a rollout lists the
  new content first and the current content after it.
- Managed selections take precedence over project and user ones (`shadowed_by_managed_scope`), and `/omd` and
  `omd-mod disable` refuse them (`managed_by_policy`).
- Only the policy grants the managed scope and tiers: a `mods.json` selection that claims either is refused
  (`unsupported_scope`).
- A handler that answers without `next`, other than with a deny, is invalid when a required interceptor of a
  managed package sits beneath it, so other mods can skip optional transforms but never a managed guard.

#### Deploying with `omd-mod package-sync`

`omd-mod package-sync STORE` deploys the policy unattended for the account that owns the store, typically from the
organization's own launch agent or configuration tool after it installs the policy; it takes no confirmation.

Every applicable entry, across projects, comes from the content-addressed package cache, otherwise from its
`source` and then each mirror in order, through the normal package resolver:

- `ID@VERSION` uses the first `index` location whose bytes match its sha256.
- `npm:` sources without a registry use `registry` and the user's own `.npmrc` tokens (the policy carries no
  secrets).

These are refused:

- content that differs from the pin (`managed_integrity_mismatch`);
- dependencies the policy doesn't list;
- packages with lifecycle scripts (`managed_lifecycle_requires_approval`, installed interactively instead).

Only when every entry verifies does sync record a new generation in `STORE/managed.json`; otherwise it fails with
`managed_sync_incomplete` and the previous generation stays active. `--offline` uses the cache and local sources
only, and `--rollback` makes the previous generation active again.

#### Managed load behavior

- At load, a target that is deployed runs; otherwise a deployed fallback keeps running and `managed_pending_sync`
  is reported.
- Dependencies and their versions are read from hash-verified package manifests, never from editable deployment
  metadata. The dependencies of a running entry load with it under their own policy entry, even when that entry
  doesn't target the account or project.
- Content the policy no longer lists never runs, so removing an entry or changing its pin revokes it at once and an
  administrator's `policy rollback` with an unchanged cache restores the previous generation offline.
- A target with nothing running (not deployed yet, a reset or unreadable `managed.json`, stale content or a package
  that never inspected) fails every interception surface its policy `capabilities` reach closed with
  `intercept_required_failed: ID: REASON` until `package-sync` deploys it, so tool calls stay blocked between
  installing a policy and its first sync; a broken `mods.json` then drops only user and project mods.
- Managed reloads reject broken selections individually so a user mod cannot prevent policy updates.
- If authority cannot be read or authenticated, interception fails closed until authority recovers.
- Generated type-file errors appear in `reload_error` and do not prevent host startup or policy enforcement.

#### Inspecting managed state

- `omd-mod policy show` prints the effective policy and its origin.
- `policy check FILE` validates one.
- `policy explain STORE [PROJECT_DIR]` lists the account, each target and whether it is deployed, the deployment
  generation, and every selection with its scope, tier, effective state, refusal and the origin of each setting
  (`managed`, `user` or `default`).
- `status.managed` and `selection-status` report the same; `status.managed.unserved` lists the targets failing
  closed and why, and an unreadable deployment record appears as `managed_error` instead of failing the view.

#### Recovery

Recovery stays local and offline. `/omd`, `omd-package mod disable` and `omd-mod reset STORE mods.json` recover
user and project mods; managed packages keep running while the policy lists them. Running the upstream `codex`
recovers from every customization.

When a managed package fails, its required interceptors fail closed (`intercept_required_failed`) until an
administrator changes or rolls back the policy. `omd-mod reset STORE managed.json` then `package-sync` repairs an
unreadable deployment record, and until that sync the policy's targets fail closed as above.

## Plugin components and shell commands

How a plugin carries a mod component, how the `omd` shell command dispatches exported CLI aliases, and how session
reads and request helpers behave outside the TUI.

### Plugin component descriptor

A plugin can contain `.codex-plugin/omd.json` with:

```json
{"schema":1,"component":"component","sha256":"<inspected package digest>"}
```

The contained directory is an ordinary public-API package with `mod.json` and `index.ts`.

- Inspect it with `omd-mod plugin-component PLUGIN_ROOT`; the inspector rejects traversal, symlinks and digest
  changes.
- Trust and enable the inspected component through the existing mod-store workflow. The descriptor does not
  activate it.

### `omd COMMAND` shell dispatch

`omd COMMAND --repo PATH [--store STORE] [--home CODEX_HOME] [--sqlite-home DIR]` dispatches an exported CLI alias. It offers
`evidence.*` and `sessions.*` only; model and process operations are unavailable. The host store must be protected
from agent process writes. Ambiguous command ownership fails closed.

### Independent examples

Independent examples live in [`examples/virtual_reader`](examples/virtual_reader),
[`examples/scoped_data`](examples/scoped_data), [`examples/review_probe`](examples/review_probe), and
[`examples/workspace`](examples/workspace). They demonstrate shared interfaces, not production
implementations.

### Evidence across compaction

Completed-turn packets retain bounded original visible records across a host-observed compaction, tagging each
segment's records with its history revision. Compaction summaries do not replace those records. An unobserved
history reset or interrupted compaction still rejects evidence explicitly. The extension decides how to select and
summarize a truncated packet.

### Session reads and the SQLite home

Live session reads use the runtime's configured state database, including a separate SQLite home. Standalone
commands resolve the selected user configuration/profile and `CODEX_SQLITE_HOME`; `--sqlite-home` explicitly
selects the state directory.

- If a repository or system configuration redirects SQLite, standalone dispatch requires that explicit directory
  rather than guessing.
- Relative SQLite directories are rejected.
- The pinned reader consults `state_5.sqlite` read-only before and after a read, and does not modify transcripts or
  opt-out state.

### Request helper supervision

Granted request helpers use the host's bounded request supervisor. It captures a completed helper result before
returning it, then terminates the process group; cancellation, deadline and loss of the host also terminate the
group. Existing long-running service supervision remains separate. The helper, supplied by the extension, owns
request parsing, remote protocols and content selection.
