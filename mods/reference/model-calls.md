# One-shot model calls and forks (`model_complete_v2`)

Use it when a mod calls a model itself: a one-shot `model.complete` on a route, a `model.fork` of the current
conversation, and prompt cache marks. `api.classify` wraps `model.complete`; see [SDK helpers](sdk-helpers.md).

## `model.complete`

`model.complete {route, prompt, system?, context?, output?, effort?, max_output_tokens?, timeout_ms?}` (capability
`agents`) runs one tool-less, read-only worker turn.

| Argument | Meaning |
| --- | --- |
| `route` | A configured worker route the mod may use, or `lead`: the thread's lead route, only when that route lists the mod in its `mods`. |
| `prompt` | The prompt (8 KiB). |
| `system` | Added beneath the host's own role instructions (8 KiB). |
| `context` | Up to 8 blocks, 32 KiB in total across all blocks; precedes the prompt. |
| `output.schema` | Asks for structured JSON output. |
| `effort` | Picks the reasoning effort. |
| `max_output_tokens` | At most 128,000, never above a paid route's own ceiling; sent on every route, the included subscription too. |
| `timeout_ms` | The call's timeout (at most 300 s; see [Results](#results-of-modelcomplete-and-modelfork)). |

## `model.fork`

Experimental.

`model.fork {prompt, route?, tools?, …}` (capabilities `agents`, `sessions` and `sessions_tools`) does the same on
a snapshot of the current conversation: the thread's committed model-visible history, with opaque reasoning kept
for a same-provider route and left out for another provider, on `lead` unless `route` names a worker route.

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
- A timeout (at most 300 s) or cancellation ends the worker and throws.

Every request passes the `model_request` and `response_stream` interceptors and its own admission and settlement
under `worker_limits`; no task or turn is started for the caller.

They run in event, tool, timer and channel callbacks and in terminal slash commands, which reach the session in the
same process (`no session in this process` otherwise). Prompt cache reuse is reported by `cache.read_tokens`, not
promised: a fork is a separate internal session whose cache key and instructions differ from the lead's.

## Prompt cache marks (`model_cache_v1`)

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
