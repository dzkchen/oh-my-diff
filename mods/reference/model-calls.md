# One-shot model calls and forks (`model_complete_v2`)

Use it when a mod calls a model itself: a one-shot `model.complete` on a route, a `model.fork` of the current
conversation, and prompt cache marks. `api.classify` wraps `model.complete`; see [SDK helpers](sdk-helpers.md).
To change the model requests that a lead turn or another caller sends, use
[Model requests and streams](model-requests.md) instead.

Mod API `1.0.0`: `model.complete` is frozen; `model.fork` is experimental. Platform: Apple Silicon macOS.

## `model.complete`

`model.complete` (capability `agents`) runs one tool-less, read-only worker turn.

```text
model.complete {route, prompt, system?, context?, output?, effort?, max_output_tokens?, timeout_ms?, cache?}
```

| Argument | Meaning |
| --- | --- |
| `route` | A configured worker route the mod may use, or `lead`: the thread's lead route, only when that route lists the mod in its `mods`. |
| `prompt` | The prompt (8 KiB). |
| `system` | Added beneath the host's own role instructions (8 KiB). |
| `context` | Up to 8 string blocks, 32 KiB in total across all blocks; precedes the prompt. |
| `output.schema` | Asks for structured JSON output (a JSON object of at most 16 KiB). |
| `effort` | Picks the reasoning effort. |
| `max_output_tokens` | At most 128,000, never above a paid route's own ceiling; sent on every route, the included subscription too. |
| `timeout_ms` | The call's timeout: default 120 s, at most 300 s, and never past the task's remaining time. |
| `cache` | `{through: 'system' \| N}` marks a cacheable prefix; see [Prompt cache marks](#prompt-cache-marks-model_cache_v1). |

```ts
const summary = api.host.call('model.complete', { route: 'worker', prompt: `Summarize in three bullets:\n${text}` });
```

## `model.fork`

Experimental.

`model.fork {prompt, route?, tools?, …}` (capabilities `agents`, `sessions` and `sessions_tools`) runs the same kind
of call on a snapshot of the current conversation, the thread's committed model-visible history. It runs on `lead`
unless `route` names a worker route. Opaque reasoning is kept for a same-provider route and left out for another
provider.

It is tool-less unless `tools` lists tools; their calls come back in `tool_calls` with `executed: false` and never
run.

## Results of `model.complete` and `model.fork`

Both return `{status, text, content, tool_calls, stop_reason, error, route, model, request_ids, usage, cache, cost,
timing}` from the worker's `model_response` records:

- `usage` is the last request's raw value.
- `cache` sums `read_tokens` and `write_tokens` over the call's requests that reported them (`null` when none did).
- `cost` sums the settled charges (`null` when a request is unsettled or unpriced) with their basis.
- A response the provider cut at its token limit returns `status: 'incomplete'` with the text that streamed and
  `stop_reason` (`max_output_tokens`).
- A provider failure returns `status: 'failed'` with `error`.
- A timeout or cancellation ends the worker and throws.

| Error | When |
| --- | --- |
| `model_route_required` | `model.complete` without `route` |
| `model_call_option_invalid` | `system`, `context`, `output.schema`, `effort`, `max_output_tokens` or `cache` is out of range |
| `model_tools_require_fork` | `tools` on `model.complete` |
| `capability_denied: sessions`, `capability_denied: sessions_tools` | `model.fork` without those capabilities |
| `model_complete_timeout` | The call reached its timeout |
| `callback_cancelled` | The callback was cancelled |

Every request passes the `model_request` and `response_stream` interceptors and its own admission and settlement
under `worker_limits`; no task or turn is started for the caller.

## Where model calls run

`model.complete` and `model.fork` run in event, tool, timer and channel callbacks and in terminal slash commands,
which reach the session in the same process. Elsewhere they fail with `no session in this process`.

`cache.read_tokens` reports prompt cache reuse, but reuse isn't guaranteed. A fork is a separate internal session
whose cache key and instructions differ from the lead's.

## Prompt cache marks (`model_cache_v1`)

`cache: {through: 'system' | N}` (`model_cache_v1`) marks the request prefix as cacheable, through the worker's
instructions or through context block `N`. The instructions are the last developer message before the turn's user
message. That message contains the host's role text, a fork's frozen parent conversation and the mod's `system`.
Environment context after it isn't included.

On each of the call's requests the host:

- sets `prompt_cache_key` and the `session-id` header to `omd-cache-` plus a hash of the model, instructions, tools
  and the prefix's model-visible fields. The `session-id` header is the ChatGPT backend's cache routing. Calls that
  share a prefix share the provider's cache routing, and OpenAI Responses caches prefixes automatically;
- sends `x-omd-cache-breakpoint: ITEM:PART`, the last cacheable `input[ITEM].content[PART]` of the final body, for
  provider transports with explicit breakpoints.

`omd_profiles` turns the breakpoint into Anthropic `cache_control` on that block (or on the system prompt when it
falls in the leading developer messages) and, for profiles set up with `--cache-control`, passes it on in Chat
Completions content for providers such as OpenRouter.

Cache reads and writes come back in `cache` and in each request's `model_response` record, priced with the route's
cached and cache-write rates; a provider that ignores the mark reports no reads.
