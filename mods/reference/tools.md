# Tools

Use it when a mod runs or checks a model-visible tool, keeps a tool's complete output, adds feedback to tool
output, merges a batch of calls, shapes the model's tool list or defines tools at run time. How a `tool`
interceptor chain runs is in [Interceptors](interceptors.md); the tool-specific inputs and answers are below.

## Tool calls through interceptors

This section covers tool inputs and answers, argument validation after a rewrite, and `tool_result_fingerprints_v1`.

### Tool inputs and answers

Tool inputs also carry `call_id`, `thread_id`, `agent_id`, `schema`, `raw_arguments` and `batch`. `arguments` is an
object for function tools and the raw string for freeform tools such as `apply_patch`, and a rewrite keeps that
shape.

- Native, MCP (retarget by the model-visible name, such as `mcp__server__tool`), mod, subagent, code-mode and
  batched calls all pass through the same chain with their own call IDs.
- Output beyond 256 KiB arrives truncated with `truncated: true`; `next` also resolves with the output's complete
  `bytes` (an experimental field), and [`tools.original`](#toolsoriginal-tool_original_v1) keeps the complete text as
  evidence.
- For a code-mode call, `next` also resolves with `value` (an experimental field) when a mod intercepting `tool`
  requires `code_mode_values_v1`, the structured result the cell receives (omitted above 32 KiB or when it and `output`
  together exceed 256 KiB), and an answer given without calling `next` may carry `value` (at most 64 KiB) for the cell
  instead of `output` (`code_mode_values_v1`). The model and every other caller see `output`. A `value` returned after
  `next` ran is ignored: the cell keeps the executed result.
- A tool or host-operation answer runs nothing: the host records the answering mod as `answered_by` on
  `tool_result` and in turn evidence, and the answer cannot attest that a file changed or a process ran.
- Input handlers cannot answer for the engine, so an outer handler cannot bypass an inner required one.
- A model-request answer skips the interceptors beneath it but sends nothing to a provider; its tool calls still
  pass every tool interceptor and native check.
- When a chain changes a tool's output, the host keeps the original as readable evidence of the mod that settled
  the result.

### Argument validation after a rewrite

When a `tool` interceptor rewrote a call, or a `tool_specs` interceptor replaced the tool's `parameters`, the host
validates the call's final arguments against the tool's original schema before dispatch. It checks `type`,
`properties`, `required`, `items`, `enum`, `anyOf` and `additionalProperties`; other keywords are not checked.

A mismatch refuses the call with `tool_arguments_invalid: <tool>: <json-pointer>: <reason>`, with `/` for the root.
Freeform tools and tools without a schema are not validated.

### `tool_result_fingerprints_v1`

`tool_result_fingerprints_v1` supplies observe-only `thread_id`, `call_sha256`, `result_sha256` and
`result_complete` fields on `tool_result`. The result digest covers the accepted model-visible output with a fixed
call ID; blocked, failed, aborted and unavailable lifecycle results have no result digest. `answered_by` names the
mod that answered the call without running it.

## Running and checking tools

This section covers `tools.invoke`, `tools.check`, when they're available, and `tools.original`.

### `tools.invoke`

`tools.invoke {tool, arguments}` (experimental) runs a model-visible tool through the current turn's executor under a
new `mod-<id>-<n>` call ID, with interception, permissions, approvals, sandbox, accounting, cancellation and its own
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

### `tools.original` (`tool_original_v1`)

`tools.original {call_id}` (experimental) keeps the complete output of a call whose result is passing through a `tool`
interceptor chain as the mod's own evidence, up to 16 MiB (`blob_too_large` beyond), and returns
`{reference, sha256, bytes}`. `reference` is a `ResourceRef` to read with `evidence.read` in pages of at most 64 KiB,
`sha256` hashes the complete text and `bytes` is its length. Call it after `await next(e)` in the same callback with the
input's `call_id`: the `output` a handler sees is cut at 256 KiB, and `next` resolves with the complete length as
`bytes` so the handler can tell. It needs `interception`.

It fails with `tool_original_unavailable` when the call's result is not in a chain, such as before `next` has resolved,
after the callback ended, for a call an interceptor answered without running it, or for an unknown call. A retried call
(`:retryN`) yields its latest attempt's original, and that `next` also resolves with `bytes`. Only a host call made from
inside that call's own `tool` chain can read it; a timer, another event or another call's chain gets
`tool_original_unavailable`. The evidence is the mod's rotating evidence (the newest 1,024 records per mod and
repository are kept, older ones are dropped down to 768, and the oldest go first while the blobs those records hold
exceed 256 MiB; a process checks on its first write and then every 16 writes or 16 MiB).

## Tool output, feedback, batches and specs

This section covers `tool_output` observers, `replace('tool_batch')`, `intercept('tool_specs')`, `tools.list` and
task-scoped tools.

### `tool_output` observers

`on('tool_output')` observers (`tool_feedback_v1`) return `{append}` of at most 4 KiB, 16 KiB per call in total,
added after any interceptor result at any output size.

- Handlers receive the first 256 KiB as `text`, the last 16 KiB as `tail` when the output is longer, and the total
  `bytes`.
- Image and audio items appear as `[image]` and `[audio]` markers.
- Tool-output callbacks may call every host operation their grants allow in lifecycle events, such as
  language-server exchanges or `model.complete`, before the model sees the result. The output waits for them.

### `replace('tool_batch')`

`replace('tool_batch')` (`tool_batch_v1`) may merge parallel-safe calls of one response into one call of a tool the mod
registered. The merged call runs through ordinary admission and approvals, and results fan out by call id: the merged
tool returns an object keyed by call id whose values are the output text. A merge with `success_per_call: true`
(`tool_batch_success_v1`, an experimental field) instead reads each value that is exactly `{output, success}` as that
call's output and own success flag; any other value stays text. `tool` interceptors see the merged call with call ID
`<batch id>-merge-<index>` and that `batch` position.

### `intercept('tool_specs')`

`intercept('tool_specs')` (`tool_continuation_v2`, `tools`) composes model-visible tool lists per route and request
without host operations: drop a tool, re-describe it, or set `deferred: true` to move it behind `tool_search`. A
model without tool search keeps deferred tools visible so they stay callable. Execution is unchanged.

### `tools.list`

`tools.list` (`inventory`, experimental) returns the lead thread's tools from the latest router build:

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

### Task-scoped tools and `tool_exposure`

`task_scoped: true` on `api.tool` and the experimental `tool_exposure` event (host feature `task_tool_exposure_v1`)
expose optional tools per task.

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

## Dynamic tools (`dynamic_tools_v1`)

`api.dynamicTools(handler)` lets a mod define tools at run time.

| Operation | What it does |
| --- | --- |
| `tools.define {name, description, parameters, label?}` | Adds or replaces a tool (at most 64 per mod, names distinct from its static tools) |
| `tools.undefine {name}` (experimental) | Removes a tool |

Definitions take effect at the next model request, reach the handler as `{name, arguments}`, run from native event
and tool callbacks, and reset when the mod reloads.

`tools.define` fails with `dynamic_tool_invalid` for an invalid name, an empty description or one over 4,096
bytes, a `task_scoped` tool or the name of one of the mod's static tools; with `tool_name_conflict` when another
mod already exposes the same tool name; and with `dynamic_tool_limit` beyond 64 tools.
