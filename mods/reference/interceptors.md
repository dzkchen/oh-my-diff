# Interceptors

Use it when a mod wraps an operation with `api.intercept`: the surfaces it can select, what a handler may change,
how `next`, retries, ordering and failures work, and what the host records. The input of each surface is described
on the page of the operation it wraps; [Every interceptor surface](#every-interceptor-surface) links to it.

## Continuation middleware (`continuation_middleware_v1`, `tool_continuation_v2`)

This section covers `api.intercept`, its `match` option, the surfaces and what a handler may change, the `next`
object, interceptor order, handler failures and chain status.

### `api.intercept`

`api.intercept(pattern, [options,] (e, next) => result)` wraps an operation. `pattern` is a surface name, `*`, a
`*` glob or a `!` negation, and selects only surfaces the package's capabilities entitle (all 25 surfaces are in
[Every interceptor surface](#every-interceptor-surface)):

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
executor. Only the listed fields may change (surfaces not listed here are described on the page in
[Every interceptor surface](#every-interceptor-surface)):

| Surface | Replaceable | `next` resolves to | A handler may return |
| --- | --- | --- | --- |
| `tool` | `tool`, `arguments` (see [Tool inputs and answers](tools.md#tool-inputs-and-answers)) | `{output, success, truncated, bytes}` | that result, a changed `{output, success}` of at most 256 KiB (the model sees at most 64 KiB, or the original's length if larger; a longer replacement is dropped with a diagnostic and the original stands), an answer without calling `next`, or `{deny}` |
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
| `render` | `props` keys the native drawing reads (see [Render hooks](render-hooks.md#render-hooks-render_hooks_v1)) | `{tree}` | a `{tree}` of presentation components holding `{type: 'native'}` at most once, with or without calling `next` |
| `composer_key` (experimental) | `key` (one printable character or a mod key name) | `{key}` | `{key}` with or without calling `next`, or `{deny}` to drop the key |
| `mention` (experimental) | `path` | `{path}` | `{path}` with or without calling `next`, or `{deny}` to skip the read |

A `{deny}` refuses only before the native executor runs. Once `next` has run a `command`, `config_set`, `peer_send`
or `agent_spawn`, a deny is an invalid result, so an ordinary handler's inner result stands and a required handler
fails.

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

## Every interceptor surface

`InterceptSurfaces` in [`api.d.ts`](../api.d.ts) lists 25 surfaces. Each row gives the capability that entitles
it, its status in the conformance registry and the page that describes its input and what a handler may return.
A surface marked experimental may change in any release ([Stability and migration](stability-and-migration.md)).

| Surface | Capability | Status | Input, result and answer |
| --- | --- | --- | --- |
| `tool` | `interception` | frozen; experimental fields: `value`, `bytes` | [Tools](tools.md#tool-inputs-and-answers) |
| `tool_specs` | `tools` | frozen | [Tools](tools.md#intercepttool_specs) |
| `host_operation` | `middleware` | frozen | [Admission and interception](admission-and-interception.md#host_operation-interceptors) |
| `admission` | `policy` | frozen | [Admission and interception](admission-and-interception.md#admission-and-api-policy-admission_api_policy_v1) |
| `command_list` | `commands` | frozen | [Commands and composer](commands-and-composer.md#command-and-configuration-interceptor-surfaces) |
| `command` | `commands` | frozen | [Commands and composer](commands-and-composer.md#command-and-configuration-interceptor-surfaces) |
| `config_list` | `config` | frozen | [Commands and composer](commands-and-composer.md#command-and-configuration-interceptor-surfaces) |
| `config_set` | `config.write` | frozen | [Commands and composer](commands-and-composer.md#command-and-configuration-interceptor-surfaces) |
| `input` | `input` | frozen | [Commands and composer](commands-and-composer.md#submitted-drafts-and-prompt_expanded) |
| `composer_edit` | `composer` | frozen | [Commands and composer](commands-and-composer.md#composer_edit-interceptor) |
| `composer_key` | `composer` | experimental | [Commands and composer](commands-and-composer.md#composer_key-interceptor) |
| `mention` | `input` | experimental | [Commands and composer](commands-and-composer.md#mention-interceptor) |
| `model_request` | `middleware` | frozen | [Model requests and streams](model-requests.md#model_request-input) |
| `response_stream` | `middleware` | frozen | [Model requests and streams](model-requests.md#response_stream-chunks) |
| `model_send` | `middleware` | frozen | [Final-request policy](final-request-policy.md#model_send-input-pages) |
| `compaction` | `compaction` | experimental | [History and compaction](history.md#compaction-interception-compaction_intercept_v1) |
| `history_persist` | `history_persist` | frozen | [History and compaction](history.md#store-time-history-rewriting-history_persist_v1) |
| `render` | `terminal` | frozen | [Render hooks](render-hooks.md#render-interceptor-and-hook-results) |
| `component_change` | `terminal` | experimental | [Terminal input](terminal-input.md#component_change-interceptor) |
| `agent_offers` | `agents` | experimental | [Agents](agents.md#agent-definitions) |
| `agent_spawn` | `agents` | experimental | [Agents](agents.md#agent_spawn-interceptors) |
| `peer_send` | `peers` | experimental | [Sessions and turns](sessions-and-turns.md#peer-message-authentication-and-delivery) |
| `peer_receive` | `peers` | experimental | [Sessions and turns](sessions-and-turns.md#peer-message-authentication-and-delivery) |
| `turn_stop` | `autonomous` | experimental | [Sessions and turns](sessions-and-turns.md#turn_stop-interceptors) |
| `elicitation` | `approvals` | experimental | [Events and lifecycle](events-and-lifecycle.md#elicitation-interceptor) |

## Example: guard one tool

This handler wraps `apply_patch`, the freeform tool whose `arguments` is the raw patch text. It refuses a patch that
names `package.json` before the native executor runs, and adds a line to a failed result after `next` resolves.

```ts
import type { ModAPI } from '@oh-my-diff/mod-api';

export default function activate(api: ModAPI): void {
  api.intercept('tool', { match: { tool: 'apply_patch' } }, async (e, next) => {
    if (typeof e.arguments === 'string' && e.arguments.includes('package.json')) {
      return { deny: 'this mod keeps package.json unchanged' };
    }
    const result = await next(e);
    if (!result.success) {
      return { output: `${result.output}\nRead the file again before the next patch.`, success: false };
    }
    return result;
  });
}
```

- `match` limits the callback to calls whose input has `tool: 'apply_patch'`, so other tool calls never start it.
- The `{deny}` answer is returned before `next` runs, so nothing is written.
- The changed `{output, success}` is one of the results the `tool` row of
  [Surfaces and what a handler may change](#surfaces-and-what-a-handler-may-change) allows.
- The package needs the `interception` capability.
