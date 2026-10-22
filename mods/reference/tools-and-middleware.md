# App bridge, approvals and tools

How a mod reaches the app-server, takes part in approvals, wraps operations with interceptors, and shapes tool
output, tool lists and dynamic tools.

## App-server bridge (`app_v1`)

### `app.request` routes

`app.request {method, params}` sends a method listed by `app.routes`. Each route names:

- a capability class;
- allowed contexts: `user` commands or `event` callbacks;
- whether a native confirmation is needed;
- the thread scope.

### `app.request` parameter rules

Each route lists the parameter fields it accepts; any other non-null field is refused. Authority fields (approval
policy, sandbox, permissions, config, roots, environments, dynamic tools, base instructions, service tier) and
fields added by a later upstream stay closed until reviewed.

- `model` and `modelProvider` are allowed only as a configured route: each must match a `host.json` lead route, and
  when both are given, the same one. `thread/settings/update {modelProvider}` moves the current thread to that provider from its next turn, as
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
clients](external-clients.md#external-clients-omd-client1)) is reachable; hosts without one return
`client_surface_unavailable`.

### `app.respond` (`app_respond_v1`)

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

## Approvals (`approval_v1`)

`approval` middleware sees exec, patch, MCP, network and permission requests before hooks, automatic review and
full-access shortcuts. It returns `null`, `{deny}`, `{ask}` or `{approve}`.

### How answers combine

1. Any deny rejects.
2. Then any `ask` forces the native prompt, bypassing remembered session approvals.
3. Then an `{approve}` from a mod with a current `approve` grant whose `approves` scope covers the request (see
   [Unrestricted processes and delegated
   approvals](capabilities.md#unrestricted-processes-and-delegated-approvals)) runs it without a prompt. The host
   shows a native notice naming the mod and reports `approval_result` with source `mod`.

An approve outside the grant, an expired grant, an error, a timeout or an invalid result counts as `ask`.

### Forbidden commands and non-delegable requests

- A command that the user's own execpolicy rules forbid reaches the middleware with `host_decision: 'forbidden'`.
  Only a mod holding `approve.override` can approve it; anything else keeps it forbidden.
- Managed requirements and other host denials never reach the middleware.
- Permission-escalation requests are not delegable.
- `assessment: true` marks a `tools.check` assessment, which never runs or prompts.
- `approval_result` reports the decision and its source.

## Continuation middleware (`continuation_middleware_v1`, `tool_continuation_v2`)

### `api.intercept`

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

### `match` option

In `match`:

- a scalar matches by `===`;
- a RegExp tests a scalar as a string;
- an array is any-of and matches any element of an array value;
- an object matches part of an object.

`match` is checked against the input each interceptor actually receives, so a rewrite by an outer interceptor
reaches every guard that matches the new input.

A mod registers up to 16 interceptors during activation; `intercept` returns a registration whose `.catch(handler)`
sets a fallback handler.

### Surfaces and what a handler may change

`e` is a frozen copy of the effective input, and `await next(e2)` runs the rest of the chain and then the native
executor. Only the listed fields may change:

| Surface | Replaceable | `next` resolves to | A handler may return |
| --- | --- | --- | --- |
| `tool` | `tool`, `arguments` | `{output, success, truncated}` | that result, a changed `{output, success}` of at most 64 KiB, an answer without calling `next`, or `{deny}` |
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
| `render` | `props` keys the native drawing reads (see [Render hooks](terminal-ui.md#render-hooks-render_hooks_v1)) | `{tree}` | a `{tree}` of presentation components holding `{type: 'native'}` at most once, with or without calling `next` |
| `composer_key` | `key` (one printable character or a mod key name) | `{key}` | `{key}` with or without calling `next`, or `{deny}` to drop the key |
| `mention` | `path` | `{path}` | `{path}` with or without calling `next`, or `{deny}` to skip the read |

A `{deny}` refuses only before the native executor runs. Once `next` has run a `command`, `config_set`, `peer_send`
or `agent_spawn`, a deny is an invalid result, so an ordinary handler's inner result stands and a required handler
fails.

### Tool inputs and answers

Tool inputs also carry `call_id`, `thread_id`, `agent_id`, `schema`, `raw_arguments` and `batch`. `arguments` is an
object for function tools and the raw string for freeform tools such as `apply_patch`, and a rewrite keeps that
shape.

- Native, MCP (retarget by the model-visible name, such as `mcp__server__tool`), mod, subagent, code-mode and
  batched calls all pass through the same chain with their own call IDs.
- Output beyond 48 KiB arrives truncated with `truncated: true`.
- For a code-mode call, `next` also resolves with `value` when a mod intercepting `tool` requires `code_mode_values_v1`, the structured result the cell receives (omitted above
  32 KiB or when it and `output` together exceed 48 KiB), and an answer given without calling `next` may carry `value` (at most 64 KiB) for the cell instead of
  `output` (`code_mode_values_v1`). The model and every other caller see `output`. A `value` returned after `next`
  ran is ignored: the cell keeps the executed result.
- A tool or host-operation answer runs nothing: the host records the answering mod as `answered_by` on
  `tool_result` and in turn evidence, and the answer cannot attest that a file changed or a process ran.
- Input handlers cannot answer for the engine, so an outer handler cannot bypass an inner required one.
- A model-request answer skips the interceptors beneath it but sends nothing to a provider; its tool calls still
  pass every tool interceptor and native check.
- When a chain changes a tool's output, the host keeps the original as readable evidence of the mod that settled
  the result.

### The `next` object and retries

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

### Interceptor order

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

### `tools.invoke`

`tools.invoke {tool, arguments}` runs a model-visible tool through the current turn's executor under a new
`mod-<id>-<n>` call ID, with interception, permissions, approvals, sandbox, accounting, cancellation and its own
`tool_result`, and returns `{call_id, output, success, truncated}`.

Calls from `timer`, `channel`, `process_event` and `approval_result` wait for the turn's running tools like a model
call, so they never overlap a tool that is not parallel-safe. Failures and denials come back as `success: false`.

### `tools.check`

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

### Availability of `tools.invoke` and `tools.check`

Both operations need `interception` and a turn in progress in the thread (`tools_unavailable` otherwise). Each
model request publishes its dispatch, so they work from the turn's first model request until it ends: in
interceptors, tool and output callbacks, timers and channel events that run meanwhile.

A tool interceptor can hold a call for a person with `terminal.prompt`. The wait does not count against its budget;
cancelling the call stops the wait, and a later answer is discarded.

### Handler failures and skipped interceptors

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

### Chain status and offline scenarios

Interceptors call host operations under their own grants with lifecycle-event access, including `terminal.prompt`.

The host keeps the last 16 chains in status `chains` with bounded inputs and results (values over 2 KiB become a
sha256 and byte count). Each trace entry names the mod, `location`, `outcome` (`returned`, `passed`, `skipped`,
`kept`, `caught` or `rejected`), attempts, own time and bounded inputs and results. Model-request chains are also
appended to the session's `mod-middleware.jsonl`.

The offline scenario step `{"type":"intercept","surface":"tool","payload":{...},"core":[{"value":...}]}` runs a
chain against queued engine results (`{"error":...}` rejects) and returns it without timings.

## Tool output, feedback, batches and specs

### `tool_output` observers

`on('tool_output')` observers (`tool_feedback_v1`) return `{append}` of at most 4 KiB, 16 KiB per call in total,
added after any interceptor result at any output size.

- Handlers receive the first 48 KiB as `text`, the last 16 KiB as `tail` when the output is longer, and the total
  `bytes`.
- Image and audio items appear as `[image]` and `[audio]` markers.
- Tool-output callbacks may call every host operation their grants allow in lifecycle events, such as
  language-server exchanges or `model.complete`, before the model sees the result. The output waits for them.

### `replace('tool_batch')`

`replace('tool_batch')` (`tool_batch_v1`) may merge parallel-safe calls of one response into one call of a tool the
mod registered. The merged call runs through ordinary admission and approvals, and results fan out by call id: the
merged tool returns an object keyed by call id whose values are the output text. A merge with
`success_per_call: true` (`tool_batch_success_v1`) instead reads each value that is exactly `{output, success}` as
that call's output and own success flag; any other value stays text.

### `intercept('tool_specs')`

`intercept('tool_specs')` (`tool_continuation_v2`, `tools`) composes model-visible tool lists per route and request
without host operations: drop a tool, re-describe it, or set `deferred: true` to move it behind `tool_search`. A
model without tool search keeps deferred tools visible so they stay callable. Execution is unchanged.

### `tools.list`

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

### Argument validation after a rewrite

When a `tool` interceptor rewrote a call, or a `tool_specs` interceptor replaced the tool's `parameters`, the host
validates the call's final arguments against the tool's original schema before dispatch. It checks `type`,
`properties`, `required`, `items`, `enum`, `anyOf` and `additionalProperties`; other keywords are not checked.

A mismatch refuses the call with `tool_arguments_invalid: <tool>: <json-pointer>: <reason>`, with `/` for the root.
Freeform tools and tools without a schema are not validated.

## Dynamic tools (`dynamic_tools_v1`)

`api.dynamicTools(handler)` lets a mod define tools at run time.

| Operation | What it does |
| --- | --- |
| `tools.define {name, description, parameters}` | Adds or replaces a tool (at most 64 per mod, names distinct from its static tools) |
| `tools.undefine {name}` | Removes a tool |

Definitions take effect at the next model request, reach the handler as `{name, arguments}`, run from native event
and tool callbacks, and reset when the mod reloads.
