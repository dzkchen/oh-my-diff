# Models and routing

How routes are configured and chosen, how the ledger records model spend, how mods intercept and police model
requests and streams, and how they make their own model calls. Read it when you route requests, edit what a
provider receives, or call a model from a mod.

## Routes

Routes are configuration, not names in the API.

### Route fields

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

### Choosing a route

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

### Route reload (`route_reload_v1`)

Route lookups recheck `host.json` (`route_reload_v1`): an edited route list applies to new threads, `routes.list`
and `routes.select` without restarting.

- Each turn, worker start and `task.status` also apply edited `limits` and `worker_limits` (recorded in the
  thread's ledger, with spend so far still counted) and refresh the rates, credential and model of routes a running
  thread already uses.
- Services, secrets and protected paths stay as loaded at start.
- An invalid edit keeps the previous routes and `routes.select` reports why.
- `routes.select` also admits a lead route added after the thread started when it is on the thread's provider.

### Route writes (`route_write_v1`)

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

### Route grant files

The grant file binds `{"schema": 1, "repository": "<repository identity>", "provider", "model", "responses_url",
"revocable": true}` plus either:

- `"included_subscription": true`: an `openai` ChatGPT route at the Codex subscription URL, zero reservation; or
- `"paid_api_key": true`.

Any other provider, including a local one, is a paid API route. It needs `paid_api_key`, a nonzero
`reservation_microusd` and a nonzero `limits.exposure_microusd` (lead) or `worker_limits.exposure_microusd`
(workers) in `host.json`, both `0` by default.

Grant files are operator actions; a mod cannot create one to authorize itself.

### Provider-billed routes (`provider_billing_v1`)

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

### Selecting a workflow contract

Users select a workflow contract with `omd-package contract select ID@VERSION` (or `omd-contract select STORE
REPOSITORY ID@VERSION`) in the repository, or from the terminal through a mod's `contract.select {contract}`
(`contracts`, user actions only).

The host shows a native confirmation that names any assurance the choice lowers, writes the same user selection and
returns `{selected, applies: 'next_session'}` or `{status: 'declined'}`. It applies from the next session.

## Ledger

Every lead and native sub-agent request is observed and recorded in the session ledger (`task.status`, the `ledger`
field of `context` and `terminal` events). The ledger a mod receives carries the cost totals, the newest 64
attempts and `observed_requests` (a count).

- Limits are enforced only on mod-initiated agents, and on the lead when its model matches a configured lead route
  with rates.
- OMD sessions use the observed HTTP Responses transport; WebSocket transport is disabled for their threads and
  refused if any request would use it.

## Model requests and streams (`model_turn_interception_v1`)

Every lead, native sub-agent and mod worker request passes the `model_request` and `response_stream` interceptors
(capability `middleware`) before and while it streams; see [Continuation
middleware](tools-and-middleware.md#continuation-middleware-continuation_middleware_v1-tool_continuation_v2) for
ordering, `required` and failure rules.

### `model_request` input

- `request_id`: unique across processes, also sent as `x-omd-request-id`.
- `attempt`: 2 or 3 after a mod's stop-and-retry.
- `scope {thread_id, agent_id, kind}`.
- `routes`, `original`, `route`, `model`, `provider`, `effort` and `tools` (names).
- `sections`: see [`model_request` sections](#model_request-sections).

A handler may change `route`, `effort` and `sections`.

### `model_request` `route` and `effort`

- `route`: one of `routes`. The lead sees its thread's lead routes: those on its provider, and those on another
  provider that name their own credential profile.
- Switching provider sends the request to that route's URL with its credential and rates, leaves the thread's
  opaque reasoning items out of that request (the transcript keeps them) and strips item metadata the provider does
  not accept.
- A route without its own credential cannot cross providers.
- `effort`: `none`, `minimal`, `low`, `medium`, `high` or `xhigh`, only when the request carries reasoning.

### `model_request` sections

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

### `model_request` `next` and synthetic responses

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

### `response_stream` chunks

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

### Stopping a response and retrying

At a `message`, `tool_done` or `stop` chunk a handler may return `{stop: {reason}}` or `{stop: {reason}, retry:
{inject}}`.

- The host keeps the item, records a developer note that a mod stopped the response, ends it and optionally retries
  with `inject` as developer context, at most twice per turn.
- The retried request is a new attempt with its own admission and settlement.

### `on('model_response')`

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

## Final-request policy (`final_request_policy_v1`)

`model_send` (capability `middleware`) runs on the exact body each request sends, after history, `model_request`
and the host's route, effort, section and output-ceiling edits; only the removal of item metadata a provider
rejects and compression follow.

- It covers lead, sub-agent and mod worker requests (`model.complete`, `model.fork`) and the session's internal
  requests (titles, reviews, memory, guardian), whose `scope.kind` is `internal` and which have no `provider` or
  `route`.
- Every attempt runs it again: turn and stream retries, a mod's stop-and-retry, compaction and route switches
  rebuild the body, and a transport retry resends the bytes that passed.
- A synthetic answer sends nothing and skips it.

### `model_send` input pages

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

### `model_send` edits and denials

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

### `model_send` verdict reuse

Verdicts are reused by segment digest, kind, role and `editable` for the same policy mods, their trusted sources,
settings and the host generation, and the same provider, route, model and `scope` (thread, agent and kind), so a
request pages only new text (`cached` counts the rest).

- An edit that leaves the text unchanged is ignored.
- A policy whose decision depends on anything else adds `cache: false` to its result, which every handler above it
  must keep, and those segments are paged again on the next request.
- At least one page runs for every request, with no segments when all are cached.

### When a request is refused (`final_request_refused`)

A request is refused, visibly as a turn or call error starting `final_request_refused`, when:

- a required `model_send` interceptor fails, times out, returns an invalid result, belongs to a faulted mod or
  waits more than 5 s for a busy runtime;
- any policy denies; or
- edits are invalid.

### Declared policies (`request_policy`)

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

### Records and coverage of final-request policy

Records keep digests, never segment text: chain traces hash each page's input and result, and the request evidence
records `final_request` (pages, scanned and cached segments, each edit's segment, range and the digest of the
replaced bytes) or `final_request_refused` with its reason.

- Transcripts, rollouts and resume data keep the original text; a retried or later request applies the same cached
  edits again.
- Coverage is the text listed above; images, audio, files, encrypted reasoning, provider-side tools, mods' own HTTP
  and sidecars, and terminal, log and resume originals are outside it, and the stage proves only what its policies
  detect.

## Built-in controls

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

## One-shot model calls and forks (`model_complete_v2`)

### `model.complete`

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

### `model.fork`

`model.fork {prompt, route?, tools?, …}` (capabilities `agents`, `sessions` and `sessions_tools`) does the same on
a snapshot of the current conversation: the thread's committed model-visible history, with opaque reasoning kept
for a same-provider route and left out for another provider, on `lead` unless `route` names a worker route.

It is tool-less unless `tools` lists tools; their calls come back in `tool_calls` with `executed: false` and never
run.

### Results of `model.complete` and `model.fork`

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

### Prompt cache marks (`model_cache_v1`)

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

## SDK helpers (`sdk_helpers_v1`)

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

### `api.time` helpers

- `api.time.sleep(ms)` calls `time.sleep {ms}` (`events`, at most 60 s): the callback waits in place, holding no
  runtime lock, and the wait does not count as own time; cancellation wakes it and ends the callback.
- `api.time.wait(check, {interval_ms, timeout_ms})` polls `check` between sleeps within the 128 host calls.
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

## Streaming providers

Mod-owned model providers need no additional primitive: a `services` grant with a `route` runs a loopback server
that Codex uses as a Responses provider, which streams normally. `max_request_bytes` in `host.json` bounds request
size and has no host maximum, so a provider's context window is configuration.
