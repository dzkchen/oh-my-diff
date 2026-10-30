# Model requests and streams (`model_turn_interception_v1`)

Use it when a mod rewrites, reroutes, answers or watches model requests and their response streams. The policy
stage that runs on the exact bytes sent is [Final-request policy](final-request-policy.md).

Every lead, native subagent and mod worker request passes the `model_request` and `response_stream` interceptors
(capability `middleware`) before and while it streams; see [Continuation
middleware](interceptors.md#continuation-middleware-continuation_middleware_v1-tool_continuation_v2) for
ordering, `required` and failure rules.

## `model_request` input

- `request_id`: unique across processes, also sent as `x-omd-request-id`.
- `attempt`: 2 or 3 after a mod's stop-and-retry.
- `scope {thread_id, agent_id, kind}`.
- `routes`, `original`, `route`, `model`, `provider`, `effort` and `tools` (names).
- `sections`: see [`model_request` sections](#model_request-sections).

A handler may change `route`, `effort` and `sections`.

## `model_request` `route` and `effort`

- `route`: one of `routes`. The lead sees its thread's lead routes: those on its provider, and those on another
  provider that name their own credential profile.
- Switching provider sends the request to that route's URL with its credential and rates, leaves the thread's
  opaque reasoning items out of that request (the transcript keeps them) and strips item metadata the provider does
  not accept.
- A route without its own credential cannot cross providers.
- `effort`: `none`, `minimal`, `low`, `medium`, `high` or `xhigh`, only when the request carries reasoning.

## `model_request` sections

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

## `model_request` `next` and synthetic responses

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

## `response_stream` chunks

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

## Stopping a response and retrying

At a `message`, `tool_done` or `stop` chunk a handler may return `{stop: {reason}}` or `{stop: {reason}, retry:
{inject}}`.

- The host keeps the item, records a developer note that a mod stopped the response, ends it and optionally retries
  with `inject` as developer context, at most twice per turn.
- The retried request is a new attempt with its own admission and settlement.

## `on('model_response')`

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
