# Tools

Use it when a mod runs or checks a model-visible tool, keeps a tool's complete output, adds feedback to tool
output, merges a batch of calls, shapes the model's tool list or defines tools at run time. How a `tool`
interceptor chain runs is in [Interceptors](interceptors.md); the tool-specific inputs and answers are below.

Mod API `1.0.0`: the `tool` and `tool_specs` interceptors, `tools.check` and `tools.define` are frozen;
`tools.invoke`, `tools.original`, `tools.list`, `tools.undefine` and the fields marked below are experimental.
Platform: Apple Silicon macOS.

## Tool calls through interceptors

Every model-visible tool call passes the `tool` interceptor chain before it runs. The host checks a rewritten call
against the tool's schema and can report a digest of each result.

### Tool inputs and answers

Tool inputs also contain `call_id`, `thread_id`, `agent_id`, `schema`, `raw_arguments` and `batch`. `arguments` is an
object for function tools and the raw string for freeform tools such as `apply_patch`, and a rewrite keeps that
shape.

- Native, MCP (retarget by the model-visible name, such as `mcp__server__tool`), mod, subagent,
  [code-mode](glossary.md#sessions-and-models) and batched calls all pass through the same chain with their
  own call ids.
- Output beyond 256 KiB arrives truncated with `truncated: true`; `next` also resolves with the output's complete
  `bytes` (an experimental field), and [`tools.original`](#toolsoriginal-tool_original_v1) keeps the complete text as
  evidence.
- For a code-mode call, when a mod intercepting `tool` requires `code_mode_values_v1`:
  - `next` also resolves with `value` (an experimental field), the structured result the cell receives. `value` is
    omitted above 32 KiB, or when it and `output` together exceed 256 KiB.
  - An answer given without calling `next` may return `value` (at most 64 KiB) for the cell instead of `output`.
  - A `value` returned after `next` ran is ignored, and the cell gets the executed result.
  - The model and every other caller see `output`.
- A tool or host-operation answer runs nothing: the host records the answering mod as `answered_by` on
  `tool_result` and in turn evidence, and the answer cannot attest that a file changed or a process ran.
- `input` interceptors cannot answer for the engine, so an outer handler cannot bypass an inner required one.
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

### Result digests on `tool_result`

Host feature `tool_result_fingerprints_v1` adds observe-only `thread_id`, `call_sha256`, `result_sha256` and
`result_complete` fields on `tool_result`. The result digest covers the accepted model-visible output with a fixed
call id; blocked, failed, aborted and unavailable lifecycle results have no result digest. `answered_by` names the
mod that answered the call without running it.

## Running and checking tools

A mod can run a model-visible tool itself, ask what the host would decide about a call, and keep a call's complete
output.

### `tools.invoke`

`tools.invoke {tool, arguments}` (experimental) runs a model-visible tool through the current turn's executor and
returns `{call_id, output, success, truncated}`. The call gets a new `mod-<id>-<n>` call id and its own
`tool_result`, and goes through interception, permissions, approvals, sandbox, accounting and cancellation.

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

During `tools.check`, `approval` middleware sees the request with `assessment: true`, and no prompt follows. A mod's
deny or ask is reported with `authority: 'mod'`, and so is a granted `{approve}` of an `ask` or of an overridable
user-rule denial.

Adapted from `mods/examples/tool_workflows`:

```ts
api.intercept('tool', { match: { tool: 'exec_command', arguments: { cmd: /\bgit\s+push\b/ } } }, async (e, next) => {
  const check = api.host.call('tools.check', { tool: e.tool, arguments: e.arguments });
  if (check.decision === 'deny') return { deny: check.reason ?? 'command policy forbids this push' };
  return next(e);
});
```

### Availability of `tools.invoke` and `tools.check`

Both operations need `interception` and a turn in progress in the thread (`tools_unavailable` otherwise). They work
from the turn's first model request until the turn ends: in interceptors, tool and output callbacks, and timers and
channel events that run meanwhile.

A tool interceptor can pause a call for a person with `terminal.prompt`. The wait does not count against its budget;
cancelling the call stops the wait, and a later answer is discarded.

### `tools.original` (`tool_original_v1`)

`tools.original {call_id}` (experimental) stores the complete output of a call as the mod's own evidence and returns
`{reference, sha256, bytes}`. The call's result must be passing through a `tool` interceptor chain. Outputs over 16 MiB
fail with `blob_too_large`. `reference` is a `ResourceRef` to read with `evidence.read` in pages of at most 64 KiB,
`sha256` hashes the complete text and `bytes` is its length. Call it after `await next(e)` in the same callback with the
input's `call_id`: the `output` a handler sees is cut at 256 KiB, and `next` resolves with the complete length as
`bytes` so the handler can tell. It needs `interception`.

It fails with `tool_original_unavailable` when the call's result is not in a chain, such as before `next` has resolved,
after the callback ended, for a call an interceptor answered without running it, or for an unknown call. A retried call
(`:retryN`) yields its latest attempt's original, and that `next` also resolves with `bytes`. Only a host call made from
inside that call's own `tool` chain can read it; a timer, another event or another call's chain gets
`tool_original_unavailable`.

The evidence is the mod's rotating evidence:

- the host retains the newest 1,024 records per mod and repository, and drops older ones down to 768;
- while those records' blobs exceed 256 MiB, the oldest are dropped first;
- a process checks on its first write, then every 16 writes or 16 MiB.

## Tool output, feedback, batches and specs

These registrations change what the model sees: feedback after a tool's output, merged batches of calls, and the
tool list itself.

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
registered.

- The merged call runs through ordinary tool admission and approvals.
- The merged tool returns an object keyed by call id whose values are the output text, and the host passes each
  value to its call.
- With `success_per_call: true` (`tool_batch_success_v1`, an experimental field), a value that is exactly
  `{output, success}` gives that call its output and its own success flag. Any other value is text.
- `tool` interceptors see the merged call with call id `<batch id>-merge-<index>` and that `batch` position.

### `intercept('tool_specs')`

`intercept('tool_specs')` (`tool_continuation_v2`, `tools`) composes model-visible tool lists per route and request
without host operations: drop a tool, re-describe it, or set `deferred: true` to move it behind `tool_search`. A
model without tool search keeps deferred tools visible so they stay callable. Execution is unchanged.

The input is:

```text
{thread_id, route: {name, model, provider} | null, tools: [{name, description, parameters, deferred}]}
```

- `tools` lists at most 512 tools. A description is cut to 4,096 characters, and `parameters` over 16 KiB arrive
  as `null`.
- `next` resolves to `{tools}`, and a handler returns `{tools}` in the same shape. A handler can't answer the chain
  without `next`.
- The returned list may only drop, defer or re-describe tools it was given: names are unique and come from the
  input, each entry has only `name`, `description` (at most 4,096 characters), `parameters` (an object or null) and
  a boolean `deferred`. Any other result is invalid.

### `tools.list`

`tools.list` (`inventory`, experimental) returns the lead thread's tools from the latest router build:

```text
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

- Before each sampling step, the event receives the host `ledger`, thread id, and only the current mod's optional tool
  names. It returns `{enable: [...]}` for a subset of those names.
- A missing or failed decision exposes none of that mod's optional tools; an invalid or foreign name disables the mod
  with a visible error.
- Ordinary registered tools and every native tool keep their existing exposure. A tool still executes through native
  permission, cancellation, accounting, and workflow gates.
- A [`context` event](events-and-lifecycle.md#context) handler can add a bounded subordinate fragment for the same
  task without replacing base instructions.
- In an offline scenario, `{"type":"tool_exposure", "payload": {...ledger...}}` records the exact names registered for
  that step.

## Dynamic tools (`dynamic_tools_v1`)

`api.dynamicTools(handler)` lets a mod define tools at run time.

| Operation | What it does |
| --- | --- |
| `tools.define {name, description, parameters, label?}` | Adds or replaces a tool (at most 64 per mod, names distinct from its static tools) |
| `tools.undefine {name}` (experimental) | Removes a tool |

- A definition takes effect at the next model request.
- A call reaches the handler as `{name, arguments}`.
- `tools.define` can be called from native event and tool callbacks.
- Definitions reset when the mod reloads.

| Error | When |
| --- | --- |
| `dynamic_tool_invalid` | An invalid name, an empty description or one over 4,096 bytes, a `task_scoped` tool, or the name of one of the mod's static tools |
| `tool_name_conflict` | Another mod already exposes the same tool name |
| `dynamic_tool_limit` | The mod defines more than 64 tools |
