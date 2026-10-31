# App bridge and approvals

Use it when a mod sends app-server methods with `app.request`, answers a pending server request with
`app.respond`, or takes part in approvals through `approval` middleware. The capability each method class needs is
in [Capabilities](capabilities.md); interceptors in general are in [Interceptors](interceptors.md).

Entries are frozen in Mod API `1.0.0` unless marked experimental (see the
[registry table](stability-and-migration.md#experimental-entries-in-the-registry)). Runs on Apple Silicon macOS.

## App-server bridge (`app_v1`)

A mod calls methods of the session's own Codex app-server (the TUI, `codex exec` or a headless `codex app-server`;
see [External clients](external-clients.md)) through `app.request`, and answers server requests with `app.respond`.
Hosts without an app-server return `client_surface_unavailable`.

### `app.request`

```text
app.request {method, params} → the method's result, or {status: 'declined'}
```

| Argument | Type | Meaning |
| --- | --- | --- |
| `method` | string | An app-server method that `app.routes` lists |
| `params` | JSON | The method's parameters, limited by the [parameter rules](#apprequest-parameter-rules) |

It returns the app-server's result, or `{status: 'declined'}` when the user declines a native confirmation. The
capability is the route's `class`.

This call from the `worktree_task` example starts a thread in a worktree folder:

```ts
const started = api.host.call('app.request', { method: 'thread/start', params: { cwd } }) as { thread?: { id?: string } };
```

| Error | When |
| --- | --- |
| `capability_denied: NAME` | The package lacks the route's `class` |
| `app_route_model_required` | `modelProvider` comes without `model` |
| `app_confirmation_too_large` | A confirmed request's parameters exceed 2,000 bytes |
| `app_config_value_redacted` | A config write contains `<redacted>` |
| `client_surface_unavailable` | The host has no app-server of its own |

### `app.routes`

`app.routes` (capability `inventory`, experimental) returns one entry per method `app.request` accepts:

| Field | Meaning |
| --- | --- |
| `method` | The app-server method |
| `class` | The capability it needs, such as `threads`, `config.write`, `inventory` or `exec` |
| `contexts` | Where it may run: `user` commands, `event` callbacks or both |
| `confirm` | Whether each call asks for a native confirmation |

Each route also has a thread scope, which `app.routes` doesn't report; the thread rules are under
[parameter rules](#apprequest-parameter-rules).

### `app.request` parameter rules

Each route lists the parameter fields it accepts; any other non-null field is refused. The host refuses authority
fields (approval policy, sandbox, permissions, config, roots, environments, dynamic tools, base instructions, service
tier) and any field a later upstream Codex version adds, until each is reviewed.

- `model` and `modelProvider` must name a configured route. Each must match a `host.json` lead route, and when both
  are given, they must match the same route. `modelProvider` needs `model` with it (`app_route_model_required`).
  `thread/settings/update {model, modelProvider}` moves the current thread to that provider from its next turn, as
  picking another provider's model in `/model` does.
- `thread/start` and `fuzzyFileSearch` roots must be the session root or one of its `git worktree list` entries.
- Thread-scoped methods reach the current thread and threads the mod itself started or forked. Their other thread
  ids (`beforeThreadId`) must name one of those.
- Local image and audio inputs must be `{resource}` references; raw paths are refused.

### `thread/attachmentOwner/list`

`thread/attachmentOwner/list` searches the whole configured thread store across projects. Omitting `archived`
includes both archived and non-archived threads.

It requires `account`, a user action and native confirmation naming the mod and exact lookup parameters; event
callbacks cannot invoke it.

### Contexts and native confirmations

- Turn-starting methods run only from [user contexts](host-model.md#callback-contexts).
- `turn/steer` runs from events into a running turn.
- `mcpServer/tool/call` asks for a native confirmation on every call.
- A confirmation names the mod, the method and its exact parameters. A confirmed request whose parameters exceed
  2,000 bytes is refused (`app_confirmation_too_large`).

### Config writes

Config writes accept only writable keys. They refuse a table that contains an authority key, such as `features` as a
whole, and check every leaf of a table value as its own key.

- Under the protected `mcp_servers` table only `mcp_servers.<name>.enabled` is writable.
- Plugin keys are limited to `plugins.<id>.enabled` and a plugin server's `enabled`, `enabled_tools` and
  `disabled_tools`.
- Config writes, `config.set` included, refuse any Codex value containing `<redacted>`
  (`app_config_value_redacted`), so a read value cannot be written back masked. Mod settings may contain the
  literal text.

### `config/read` redaction

`config/read` replaces these values with `<redacted>` in its results:

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

### Excluded methods

`command/exec`, `process/*`, `fs/*`, `thread/shellCommand`, `thread/inject_items` and credential flows are
excluded.

### App notifications and server requests

Declare `subscriptions.app` in the manifest to receive `app_notification` and `app_server_request` phases. For
`app_notification`, the host coalesces deltas and queues at most 256 events and 1 MiB per mod. It drops the oldest
and reports how many it dropped.

### `app.respond` (`app_respond_v1`)

`app.respond {request_id, result}` (capability `approvals`) answers a pending server request as if the terminal
answered it. The mod must subscribe to the request's method, and the call runs from user or event contexts. The first
answer wins, and `serverRequest/resolved` closes the native confirmation.

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

## Approvals (`approval_v1`)

Register approval middleware with `api.middleware('approval', handler)`. It needs the `approvals` and `middleware`
capabilities. It sees exec, patch, MCP, network and permission requests before hooks, automatic review and
full-access shortcuts, and returns `null`, `{deny}`, `{ask}` or `{approve}`.

### How answers combine

1. Any deny rejects.
2. Then any `ask` forces the native confirmation, bypassing remembered session approvals.
3. Then an `{approve}` from a mod with a current `approve` grant whose `approves` scope covers the request (see
   [Unrestricted processes and delegated
   approvals](authority-grants.md#unrestricted-processes-and-delegated-approvals)) runs it without a prompt. The host
   shows a native notice naming the mod and reports `approval_result` with source `mod`.

An approve outside the grant, an expired grant, an error, a timeout or an invalid result counts as `ask`.

### Forbidden commands and non-delegable requests

- A command that the user's own execpolicy rules forbid reaches the middleware with `host_decision: 'forbidden'`.
  Only a mod with `approve.override` (experimental) can approve it; anything else keeps it forbidden.
- Managed requirements and other host denials never reach the middleware.
- `permissions` requests (`request_permissions`) are not delegable: `approves.kinds` can't list them, so a mod's
  `{approve}` counts as `ask`.
- An `exec` or `stdin` grant also covers requests of that kind that ask to leave the sandbox or widen it.
  `details.sandbox_permissions` (`use_default`, `require_escalated` or `with_additional_permissions`) and
  `details.additional_permissions` show what a request asks for; return `{ask}` to leave escalated ones to the user.
- `assessment: true` marks a `tools.check` assessment, which never runs or prompts.
- `approval_result` reports the decision and its source.
