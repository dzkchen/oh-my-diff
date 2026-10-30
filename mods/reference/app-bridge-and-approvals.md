# App bridge and approvals

Use it when a mod sends app-server methods with `app.request`, answers a pending server request with
`app.respond`, or takes part in approvals through `approval` middleware. The capability each method class needs is
in [Capabilities](capabilities.md); interceptors in general are in [Interceptors](interceptors.md).

## App-server bridge (`app_v1`)

This section covers the `app.request` routes and their parameter rules, contexts and native confirmations, config
writes and redaction, the excluded methods, and `app.respond`.

### `app.request` routes

`app.request {method, params}` sends a method listed by `app.routes` (experimental). Each route names:

- a capability class;
- allowed contexts: `user` commands or `event` callbacks;
- whether a native confirmation is needed;
- the thread scope.

### `app.request` parameter rules

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

### `thread/attachmentOwner/list`

`thread/attachmentOwner/list` searches the whole configured thread store across projects. Omitting `archived`
includes both archived and non-archived threads.

It requires `account`, a user action and native confirmation naming the mod and exact lookup parameters; event
callbacks cannot invoke it.

### Contexts and native confirmations

- Turn-starting methods run only from user contexts.
- `turn/steer` runs from events into a running turn.
- `mcpServer/tool/call` asks for a native confirmation on every call.
- A confirmation names the mod, the method and its exact parameters. A confirmed request whose parameters exceed
  2,000 bytes is refused (`app_confirmation_too_large`).

### Config writes

Config writes accept only writable keys, never a table that contains an authority key (`features` as a whole), and
check every leaf of a table value as its own key.

- Under the protected `mcp_servers` table only `mcp_servers.<name>.enabled` is writable.
- Plugin keys are limited to `plugins.<id>.enabled` and a plugin server's `enabled`, `enabled_tools` and
  `disabled_tools`.
- Config writes, `config.set` included, refuse any Codex value containing `<redacted>`
  (`app_config_value_redacted`), so a read value cannot be written back masked; mod settings may hold the literal
  text.

### `config/read` redaction

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

### Excluded methods and subscriptions

`command/exec`, `process/*`, `fs/*`, `thread/shellCommand`, `thread/inject_items` and credential flows are
excluded.

Declare `subscriptions.app` in the manifest to receive `app_notification` and `app_server_request` phases. For
`app_notification`, deltas are coalesced, with 256 events / 1 MiB per mod, and the oldest are dropped with a count.

Only the session's own app-server (TUI, `codex exec` or a headless `codex app-server`, see [External
clients](external-clients.md)) is reachable; hosts without one return
`client_surface_unavailable`.

### `app.respond` (`app_respond_v1`)

`app.respond {request_id, result}` (capability `approvals`) answers a server request that is still pending and
whose method the mod subscribes to, from user or event contexts, as the terminal's own answer. The first answer
wins and `serverRequest/resolved` closes the native confirmation.

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

`approval` middleware sees exec, patch, MCP, network and permission requests before hooks, automatic review and
full-access shortcuts. It returns `null`, `{deny}`, `{ask}` or `{approve}`.

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
  Only a mod holding `approve.override` (experimental) can approve it; anything else keeps it forbidden.
- Managed requirements and other host denials never reach the middleware.
- Permission-escalation requests are not delegable.
- `assessment: true` marks a `tools.check` assessment, which never runs or prompts.
- `approval_result` reports the decision and its source.
