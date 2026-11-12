# Routes

Use it when a mod chooses, adds or writes model routes, settles provider-billed requests, reads the ledger, or runs
a provider service. Route credentials and origins are in [Credentials](credentials.md); intercepting a single
request is in [Model requests and streams](model-requests.md).

Entries are frozen in Mod API `1.0.0` unless marked experimental (see the
[registry table](stability-and-migration.md#experimental-entries-in-the-registry)). Runs on Apple Silicon macOS.

## Route fields

`<OMD_MOD_STORE>/host.json` lists `routes`. A route entry:

```json
{"name": "reviewer", "provider": "openai", "model": "gpt-6.1-sol", "reasoning_effort": "medium",
 "responses_url": "https://api.openai.com/v1/responses", "roles": ["worker"], "tools": ["exec_command"],
 "mods": ["omd_workflow"], "credential": null, "data": null,
 "grant": {"path": "/abs/grant.json", "sha256": "<sha256 of the file>"},
 "rates": {"input_microusd_per_million": 1250000, "cached_microusd_per_million": 125000,
           "output_microusd_per_million": 10000000, "reservation_microusd": 200000, "max_output_tokens": 32000,
           "input_token_ceiling": 400000, "included_subscription": false}}
```

| Field | Meaning |
| --- | --- |
| `name` | The name mods and grants use for the route |
| `provider`, `model`, `reasoning_effort` | The model provider id, model and reasoning effort of its requests |
| `responses_url` | The Responses API URL its requests go to |
| `rates` | Prices and request bounds, described below |
| `roles` | `lead`, `worker` or both |
| `tools` | When not empty, the only tools an agent spawned on the route may list; the route then refuses `isolated_worktree` agents |
| `mods` | The mod ids the route is open to, at most 16; an empty list opens it to every mod, but `agents.spawn` on the `lead` alias needs the caller listed |
| `grant` | `{path, sha256}` of its [route grant file](#route-grant-files) |
| `credential` | A credential profile whose token authorizes its requests; see [Credentials](credentials.md#route-credentials-and-sidecar-secrets) |
| `data` | Any JSON up to 2 KiB for the route's provider mod, ignored by the host; see [Route writes](#route-writes-route_write_v1) |

`rates` also accepts optional `cache_write_microusd_per_million` and `provider_billed` (see
[Provider-billed routes](#provider-billed-routes-provider_billing_v1)). `external_subscription` marks a subscription
billed outside OMD. Its settled charge counts toward the ledger's list-equivalent total
(`subscription_list_equivalent_microusd`) instead of the task charge (`settled_task_charge_microusd`), and the route
needs a grant.

## Choosing a route

- [`routes.list`](#routeslist) returns the routes visible to the calling mod, plus `data` on the caller's own routes
  ([route writes](#route-writes-route_write_v1)) and each route's provider-published [status](#route-status-route_status_v1).
- [`routes.select`](#routesselect) applies a lead route to the next request, the thread or future new threads.
- The `routing` replacement returns `{route}` to choose a configured lead route at thread start.
- A `model_request` interceptor switches one request among the thread's lead routes (see [Model requests and
  streams](model-requests.md#model-requests-and-streams-model_turn_interception_v1)).
- `agents.spawn.route` names one of:
  - a worker route. It needs a grant file whose hash, repository (or one of its `repositories`), provider, model and
    URL are rechecked on every request.
  - a lead route of a registered provider (its model is in that provider's runtime catalog) whose `mods` is empty or
    lists the caller. That agent is admitted like a cross-provider native child, with no grant.
- [`routes.add`](#routesadd) adds a worker route on the user's ChatGPT plan for one mod.
- [`routes.models`](#routesmodels) lists the ChatGPT models `routes.add` accepts.

## `routes.list`

```text
routes.list null → RouteInfo[]
```

`routes.list` (capability `model`) takes no arguments and returns the routes visible to the calling mod. Each
`RouteInfo` is `{name, model, provider, reasoning, roles, billing, tools, available, credential, data?, status?}`; `billing` is
`included_subscription`, `explicit_paid_api_grant` or `provider_billed`, and `data` and `status` are experimental.

This call from the `coordination` example picks the worker routes on the user's subscription:

```ts
const routes = api.host.call('routes.list', null).filter(route => route.available && route.roles.includes('worker') && route.billing === 'included_subscription');
```

### Route status (`route_status_v1`)

Experimental (added after 1.0.0). Each `RouteInfo` from `routes.list` has `status`: the latest status the route's
provider mod published in this OMD process, or `null` before it publishes one.

```text
routes.status {route, installed, signed_in, version?, models?, usage?, detail?} → {route, checked_at}
```

`routes.status` (capability `model`) publishes a route's status. Only a mod with a host-approved provider grant in
`host.json` (`services[].route.provider`) for the route's provider may call it, so a provider mod reports on its own
routes and no other mod can. The host keeps the latest status per route in memory, stamps `checked_at` (Unix
milliseconds) and returns it to every mod that can see the route. A restart forgets it; the provider mod probes again.

| Field | Type | Meaning |
| --- | --- | --- |
| `installed` | boolean | The provider's client or runtime is present |
| `signed_in` | boolean | The route's account is signed in |
| `version` | string, at most 128 bytes | The client version |
| `models` | up to 64 strings of at most 128 bytes | Models the account can use now |
| `usage` | up to 4 `{label, used_percent, window_minutes?, resets_at?}` | Usage windows; `used_percent` is 0 to 100 and `resets_at` is Unix milliseconds |
| `detail` | string, at most 256 bytes | Why the route is not usable, in words a person can act on |

Readers decide how old a status may be from `checked_at`. A field the provider can't measure is left out; it is never
guessed. `route_status_invalid` reports a missing or out-of-range field, `route_not_configured: ROUTE` an unknown
route and `route_status_not_provider: ROUTE` a caller without that provider's grant.

```ts
api.host.call('routes.status', { route: 'claude-work', installed: true, signed_in: true, models: ['claude-sonnet-5-5.work'] });
const ready = api.host.call('routes.list', null).filter(route => route.status?.signed_in);
```

## `routes.select`

```text
routes.select {route, scope} → {route: RouteInfo, effective_at: 'next_request' | 'new_thread'}
```

`routes.select` (capability `model`) selects a configured lead route.

| Argument | Type | Meaning |
| --- | --- | --- |
| `route` | string | The name of a lead route the caller may use |
| `scope` | `'next_request'`, `'thread'` or `'new_threads'` | Apply to the next request, the calling thread, or future new threads in this terminal session |

`new_threads` requires `route_new_threads_v1` and a local user command. It selects model, provider and effort for
`/new` and other fresh terminal threads, returning `effective_at: 'new_thread'`. Existing and resumed threads keep
their settings. It overrides launch defaults for those new threads, never writes global Codex config, and is lost
when the terminal process exits. Missing, ambiguous or changed-owner routes fail without falling back to another
account. Routes must have a unique model/provider pair. Routes that do not delegate billing to the provider
start with hosted web search disabled, because separate tool charges are outside their token rates.

The other scopes take effect from the next request. A lead route added to `host.json` after the thread started is
admitted when it is on the thread's provider ([route reload](#route-reload-route_reload_v1)).

| Error | When |
| --- | --- |
| `route_scope_invalid` | `scope` is not `next_request`, `thread` or `new_threads` |
| `route_not_configured: ROUTE` | No lead route with that name is open to the caller; after an invalid `host.json` edit the message adds why |
| `route_unavailable_for_thread: ROUTE` | The thread has no lead route account, or the route is on another provider |

```ts
api.host.call('routes.select', { route: 'fast_lead', scope: 'next_request' });
```

## `routes.add`

`routes.add {mod?, model?, effort?}` (user only) gives a mod a worker route on the user's ChatGPT plan. Without `mod`
it is for the caller itself and needs `agents` (`routes_add_self_v1`); naming a mod needs `packages`. It asks the user,
then adds the worker route `plan-MODEL-MOD`. The route is open only to that mod, and the host adds this repository to
its grant.

Without `model` the route uses the conversation's model and effort. With `model` (`routes_add_model_v1`) it uses that
model from the ChatGPT catalog of the Codex ChatGPT sign-in, the list `routes.models` returns, and `effort`, which
defaults to the model's own default. This works while the conversation, or Codex itself, uses another provider. The
host reads that catalog from the Codex model cache and refreshes it from the ChatGPT models endpoint only when the
cache is stale; it never sends a model request. For the route's input limit, the host uses the first available
context window in this order:

1. A window set with `models.context_window`.
2. Codex's `model_context_window` setting, when the chosen model is the configured model.
3. The ChatGPT catalog.
4. The host's bundled model metadata.
5. 272,000 tokens.

It returns `{route}`, or `{status: 'declined'}`. It refuses with `routes_add_needs_chatgpt` without a ChatGPT sign-in
(an API key doesn't count), or without `model` when the conversation's provider doesn't use it. A model outside the
catalog fails with `routes_add_model_unknown`, an effort the model doesn't list with `routes_add_effort_unsupported`,
and `effort` without `model` with `routes_add_effort_needs_model`.

## `routes.models`

Experimental (added after 1.0.0, `routes_add_model_v1`). `routes.models {mod?}` (user only) lists the models
`routes.add` accepts with `model`: `{model, display_name, efforts, default_effort, context_window}[]`, at most 64
picker-visible models with up to 16 efforts each. `context_window` is the usable window a route on that model gets.
Like `routes.add`, it needs `agents` without `mod` and `packages` naming a mod. It fails with
`routes_add_needs_chatgpt` without a ChatGPT sign-in.

## Route reload (`route_reload_v1`)

Route lookups recheck `host.json` (`route_reload_v1`): an edited route list applies to new threads, `routes.list`
and `routes.select` without restarting.

- At each turn, worker start and `task.status`, the host applies edited `limits` and `worker_limits` and records
  them in the thread's ledger. Spend so far still counts. It also refreshes the rates, credential and model of routes
  a running thread already uses.
- Services, secrets and protected paths stay as loaded at start.
- An invalid edit keeps the previous routes and `routes.select` reports why.
- `routes.select` also accepts a lead route added after the thread started when it is on the thread's provider.

## Route writes (`route_write_v1`)

Experimental (added after 1.0.0).

`routes.write {routes, services?}` (capability `packages`, user only) replaces the caller's own routes in `host.json`
after the user confirms a dialog listing every change. It returns `{routes, services}` (the caller's route names and
service ids afterwards), `{status: 'declined'}`, or `{routes: [], services: [], unchanged: true}` without asking when
nothing would change.

- `routes` replaces every route whose `provider` is the caller's mod id and that has no `grant`. Each new route must
  name that provider, have the single role `lead`, and have no `grant` or `credential`.
- A paid route (neither `included_subscription` nor `provider_billed`) needs `limits.exposure_microusd` above zero
  (`routes_write_allowance_required`).
- The host ignores a route's `data` (any JSON, at most 2 KiB). `routes.list` returns it only to the route's provider
  mod, and the mod's provider service can read it from `host.json`.
- `services`, when given, updates service grants that belong to the caller. Each entry is
  `{id, credentials?, route?}` and replaces those fields of the caller's grant with that `id`.
- An entry with any other id fails with `routes_write_service_unknown`, and one with any other field fails with
  `routes_write_service_field`.
- A grant's program, arguments, network, paths and secrets are never written here.
- Credentials must be existing profiles. A `secret` profile is allowed only when it belongs to the caller.
- The dialog lists every route and grant field that changes, with its new value.
- The host validates the resulting `host.json` as it does at load. A failure is `routes_write_invalid: REASON` and
  changes nothing.
- A `host.json` that changed between the dialog and the write fails with `routes_write_changed`.
- Routes apply through `route_reload_v1`. A service picks up a changed grant at its next
  [`providers.register`](#providersregister) or `sidecars.start`.

## Route grant files

An operator writes a grant file. A mod can't create one to authorize itself.

The grant file binds `{"schema": 1, "repository": "<repository identity>", "provider", "model", "responses_url",
"revocable": true}` plus either:

- `"included_subscription": true`: an `openai` ChatGPT route at the Codex subscription URL, zero reservation; or
- `"paid_api_key": true`.

A route on any other provider, including a local one, is a paid API route. It needs:

- `paid_api_key`;
- a nonzero `reservation_microusd`;
- a nonzero `limits.exposure_microusd` (lead) or `worker_limits.exposure_microusd` (workers) in `host.json`. Both
  limits are `0` by default.

## Provider-billed routes (`provider_billing_v1`)

A route with `"provider_billed": true` is billed by its provider. It has zero reservation and isn't
`included_subscription`.

- The host admits and counts its requests without reserving exposure or bounding the body.
- It records the provider's own cost from `usage.cost_microusd` on the completed response as basis
  `provider_reported`, and leaves it `unsettled` when absent.
- A lead whose provider is a service grant's provider-billed route is accounted under that route.

`ledger.settle {request_id, microusd, source}` (capability `model`) is experimental. It lets the grant's own mod
settle one such unsettled request later, by the `x-omd-request-id` the host sent to the provider. It appends a
`request_provider_settled` ledger event and adds the amount to the task charge. It refuses requests of other
providers or mods, settled requests and unknown ids.

## Ledger

Every lead and native subagent request is observed and recorded in the session ledger (`task.status`, the `ledger`
field of `context` and `terminal` events). The ledger a mod receives contains the cost totals, the newest 64
attempts and `observed_requests` (a count).

- Limits are enforced only on mod-initiated agents, and on the lead when its model matches a configured lead route
  with rates.
- OMD sessions use the observed HTTP Responses transport; WebSocket transport is disabled for their threads and
  refused if any request would use it.

## Sidecars

A sidecar is a process a mod starts from a `host.json` service grant. The grant fixes its program, arguments,
network, credentials and route. The `exec` capability allows the `sidecars.*` operations.

| Operation | Returns |
| --- | --- |
| `sidecars.start {id, secrets?}` | JSON from the host; `secrets` names the caller's own secrets to inject |
| `sidecars.status {id}` | `{id, running, started_at_ms}` for a sidecar or provider service the caller started in this process; `started_at_ms` is experimental |
| `sidecars.invoke {id, input}` | `{provider, program_sha256, source_hashes, result, untrusted: true}` |
| `sidecars.stop {id}` (experimental) | JSON from the host |

`sidecars.start` injects the caller's own secrets into the sidecar only, as `OMD_SECRETS`, JSON
`[{id, label, origin, value}]`. The values never reach the mod runtime or the model. Credential tokens reach a sidecar
only through the [credential gateway](credentials.md#credential-gateway).

Compare `started_at_ms` with a store entry's `provenance.at` to tell whether a store entry was written before the
sidecar last started.

### Service launch snapshots

Sidecars, [provider services](#provider-services) and [request helpers](#request-helper-supervision) start from a
service grant. The host launches each one from a private, read-only snapshot of the package's loaded entrypoint and
assets, with their relative paths preserved. Original package paths are denied to the child.

A grant may include `code_roots`. Each entry maps a canonical dependency directory to the SHA-256 of its sorted JSON
`[relativePath, kind, value]` rows. `kind` is `file` with a content SHA-256 or `link` with an internal relative
target. Verified bytes are copied without reopening the source. `OMD_SERVICE_ROOT` names the snapshot root, under
which absolute dependency paths are mirrored.

Changed dependencies require a new grant. Reload and disable stop stale services before their ids can be reused.

### Request helper supervision

A request helper is the program of a service grant that `sidecars.invoke {id, input}` runs once per call. The host
runs it under its bounded request supervisor. The supervisor captures a completed helper result before returning
it, then terminates the process group. Cancellation, the deadline or loss of the host also terminates the group.

Long-running services use a separate supervisor. The helper itself, which the mod supplies, does the request parsing,
remote protocols and content selection.

## Provider services

A provider service is a mod-owned service process that a routed `host.json` service grant runs as a model provider.

### `providers.register`

- `providers.register {id, secrets?}` delivers the caller's own secrets to a provider service, as `sidecars.start`
  does.
- It reads the store's `host.json` services at call time, so a grant written during the session needs no restart.
- A routed grant with a loopback `responses_url` defines its `route.provider` for the process unless the
  configuration already defines it. The host does this at startup when the mod is active, and at each registration.
- A grant with exactly one secret uses it as the bearer token.
- A thread resumed after its provider is gone continues on the configured provider.

### `models.context_window` (`model_context_window_v1`)

`models.context_window` (capability `model`, experimental) sets how much of a thread a model sees before Codex
compacts it.

- `models.context_window {model, tokens?}` returns `{model, tokens, max}`. A number sets the window for that model
  slug, `null` clears it, and leaving `tokens` out only reads it.
- It applies from each thread's next turn in this session. Other sessions on the same mod store read it when a turn
  starts, so they use it from the turn after. It persists across restarts.
- The window is capped at the model's `max_context_window`, or at its catalog window when it has no maximum. A
  provider model's maximum is the `context_window` its `providers.models` entry published, so it can only be lowered.
- `max` is that cap for a provider model and `null` for a Codex catalog model.
- An explicit `model_context_window` in `config.toml` or `-c` wins over it.
- `tokens` is a whole number from 1 to 10,000,000, and at most 64 models keep a window. Errors:
  `model_context_window_invalid`, `model_context_window_limit`.

### `providers.models`

`providers.models` puts a provider service's models in the `/model` picker.

- `providers.models {provider, name?, models}` lists up to 16 models
  `{slug, display, context_window, efforts, default_effort?}` in `/model`, grouped under `name` (1–64 bytes, default
  `provider`).
- It needs a running `providers.register` registration whose grant `route.provider` equals `provider`.
- Each call replaces that provider's list. Unregistering, a stopped service or disabling the mod drops it.
- It returns `{provider, models}`, where `models` is the count.

#### Switching to a provider's model

- The models get Codex's standard tools: shell, freeform `apply_patch`, tool search and multi-agent v2.
- They are picked only in `/model`. `codex -m`, `codex exec -m` and the config's default model don't route to the
  provider: the name goes to OpenAI, which refuses it.
- While one is selected, OpenAI's prompt to switch to a lower-cost model near the ChatGPT limit doesn't show.
- Picking one switches the thread to that provider from the next turn.
- The thread keeps its history, except reasoning another provider produced.
- Codex replays an item id to the next provider only when the id contains `_`. Give items ids without `_`, and mark
  plaintext function arguments with `encrypted_function_args: []`.
- A compaction checkpoint that only another provider can read is first rewritten as a plaintext summary by that
  provider, in one request on its account. If that fails, the turn shows a warning and runs without the summary.

### `providers.unregister`

`providers.unregister {id}` is the counterpart of `providers.register`. It stops the provider service, which drops the
provider's `providers.models` list, and returns `{stopped: true}`. It fails with `unknown_or_foreign_sidecar` for an id
this mod didn't start in its current generation.

### Streaming providers

Mod-owned model providers need no additional primitive: a `services` grant with a `route` runs a loopback server
that Codex uses as a Responses provider, which streams normally. `max_request_bytes` in `host.json` bounds request
size and has no host maximum, so a provider's context window is configuration.
