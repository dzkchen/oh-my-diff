# Routes

Use it when a mod chooses, adds or writes model routes, settles provider-billed requests, reads the ledger, or runs
a provider service. Route credentials and origins are in [Credentials](credentials.md); intercepting a single
request is in [Model requests and streams](model-requests.md).

Routes are configuration, not names in the API.

## Route fields

`<OMD_MOD_STORE>/host.json` lists `routes` with `name, provider, model, reasoning_effort, responses_url, rates,
roles (lead|worker), tools, mods, grant, credential, data`.

A route entry:

```json
{"name": "reviewer", "provider": "openai", "model": "gpt-6.1-sol", "reasoning_effort": "medium",
 "responses_url": "https://api.openai.com/v1/responses", "roles": ["worker"], "tools": ["exec_command"],
 "mods": ["omd_workflow"], "credential": null, "data": null,
 "grant": {"path": "/abs/grant.json", "sha256": "<sha256 of the file>"},
 "rates": {"input_microusd_per_million": 1250000, "cached_microusd_per_million": 125000,
           "output_microusd_per_million": 10000000, "reservation_microusd": 200000, "max_output_tokens": 32000,
           "input_token_ceiling": 400000, "included_subscription": false}}
```

`rates` also accepts optional `cache_write_microusd_per_million`, `provider_billed` (see [Provider-billed
routes](#provider-billed-routes-provider_billing_v1)) and `external_subscription` (a subscription billed outside OMD:
its settled charge counts as a subscription list-equivalent, not a task charge, and needs a granted route).

## Choosing a route

- `routes.list` returns the routes visible to the calling mod with `billing` and `available`, plus `data` on the
  caller's own routes ([route writes](#route-writes-route_write_v1); `data` is experimental).
- The `routing` replacement returns `{route}` to choose a configured lead route at thread start.
- A `model_request` interceptor switches one request among the thread's lead routes (see [Model requests and
  streams](model-requests.md#model-requests-and-streams-model_turn_interception_v1)).
- `agents.spawn.route` names a worker route or a registered provider.
- It may also name a lead route of a registered provider (its model is in that provider's runtime catalog) whose `mods`
  is empty or lists the caller; the agent is admitted like a cross-provider native child, with no grant.
- Worker routes require a grant file whose hash, repository (or one of its `repositories`), provider, model and URL
  are rechecked on every request.
- `routes.add {mod}` (capability `packages`, user only) asks the user, then adds the worker route `plan-MODEL-MOD`
  for the conversation's model and effort on the user's ChatGPT plan, open only to `mod`, and adds this repository
  to its grant. It returns `{route}`, or `{status: 'declined'}`. It refuses `routes_add_needs_chatgpt` without a
  ChatGPT sign-in or when the conversation's provider doesn't use it.

## Route reload (`route_reload_v1`)

Route lookups recheck `host.json` (`route_reload_v1`): an edited route list applies to new threads, `routes.list`
and `routes.select` without restarting.

- Each turn, worker start and `task.status` also apply edited `limits` and `worker_limits` (recorded in the
  thread's ledger, with spend so far still counted) and refresh the rates, credential and model of routes a running
  thread already uses.
- Services, secrets and protected paths stay as loaded at start.
- An invalid edit keeps the previous routes and `routes.select` reports why.
- `routes.select` also admits a lead route added after the thread started when it is on the thread's provider.

## Route writes (`route_write_v1`)

Experimental (added after 1.0.0).

`routes.write {routes, services?}` (capability `packages`, user only) replaces the caller's own routes in `host.json`
after the user confirms a dialog listing every change. It returns `{routes, services}` (the caller's route names and
service ids afterwards), `{status: 'declined'}`, or `{routes: [], services: [], unchanged: true}` without asking when
nothing would change.

- `routes` replaces every route without a `grant` whose `provider` is the caller's mod id. Each must name that provider,
  have the single role `lead` and no `grant` or `credential`. A paid route (neither `included_subscription` nor
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
  through `route_reload_v1`; a service picks up a changed grant at its next [`providers.register`](#providersregister)
  or `sidecars.start`.

## Route grant files

The grant file binds `{"schema": 1, "repository": "<repository identity>", "provider", "model", "responses_url",
"revocable": true}` plus either:

- `"included_subscription": true`: an `openai` ChatGPT route at the Codex subscription URL, zero reservation; or
- `"paid_api_key": true`.

Any other provider, including a local one, is a paid API route. It needs `paid_api_key`, a nonzero
`reservation_microusd` and a nonzero `limits.exposure_microusd` (lead) or `worker_limits.exposure_microusd`
(workers) in `host.json`, both `0` by default.

Grant files are operator actions; a mod cannot create one to authorize itself.

## Provider-billed routes (`provider_billing_v1`)

A route with `"provider_billed": true` (`provider_billing_v1`; zero reservation, not `included_subscription`) is
billed by its provider.

- The host admits and counts its requests without reserving exposure or bounding the body.
- It records the provider's own cost from `usage.cost_microusd` on the completed response as basis
  `provider_reported`, and leaves it `unsettled` when absent.
- A lead whose provider is a service grant's provider-billed route is accounted under that route.

`ledger.settle {request_id, microusd, source}` (`model`, experimental) lets the grant's own mod settle one such
unsettled request later, by the `x-omd-request-id` the host sent to the provider. It appends a
`request_provider_settled` ledger event, adds the amount to the task charge and refuses requests of other providers or
mods, settled requests and unknown ids.

## Ledger

Every lead and native subagent request is observed and recorded in the session ledger (`task.status`, the `ledger`
field of `context` and `terminal` events). The ledger a mod receives carries the cost totals, the newest 64
attempts and `observed_requests` (a count).

- Limits are enforced only on mod-initiated agents, and on the lead when its model matches a configured lead route
  with rates.
- OMD sessions use the observed HTTP Responses transport; WebSocket transport is disabled for their threads and
  refused if any request would use it.

## Provider services

A provider service is a mod-owned service process that a routed `host.json` service grant runs as a model provider.

### `providers.register`

`providers.register {id, secrets?}` delivers owned secrets to a provider service as `sidecars.start` does. It reads the
store's `host.json` services at call time, so a grant written during the session needs no restart. A routed grant with a
loopback `responses_url` defines its `route.provider` for the process (at startup when its mod is active, and at each
registration) unless the configuration already defines it; a grant with exactly one secret uses it as the bearer token.
A thread resumed after its provider is gone continues on the configured provider.

### `providers.models`

`providers.models {provider, name?, models}` lists up to 16 models
`{slug, display, context_window, efforts, default_effort?}` in `/model`, grouped under `name` (1–64 bytes, default
`provider`). It needs a running `providers.register` registration whose grant `route.provider` equals `provider`. Each
call replaces that provider's list; unregistering, a stopped service or disabling the mod drops it. It returns
`{provider, models}` (the count). The models get Codex's standard tools (shell, freeform `apply_patch`, tool search,
multi-agent v2). Picking one switches the thread to that provider from the next turn; history carries over except
reasoning another provider produced. Codex replays an item id to the next provider only when it contains `_`, so give
items ids without `_`, and mark plaintext function arguments with `encrypted_function_args: []`. A compaction checkpoint
only another provider can read is first rewritten as a plaintext summary by that provider (one request on its account);
if that fails, the turn shows a warning and runs without the summary.

### `providers.unregister`

`providers.unregister {id}` is the counterpart of `providers.register`. It stops the provider service, which drops the
provider's `providers.models` list, and returns `{stopped: true}`. It fails with `unknown_or_foreign_sidecar` for an id
this mod didn't start in its current generation.

### Streaming providers

Mod-owned model providers need no additional primitive: a `services` grant with a `route` runs a loopback server
that Codex uses as a Responses provider, which streams normally. `max_request_bytes` in `host.json` bounds request
size and has no host maximum, so a provider's context window is configuration.
