# SDK helpers (`sdk_helpers_v1`)

Use it when a mod wants the small helpers the runner adds to `api`, such as `api.session()`, `api.fs`,
`api.classify` and `api.usage`, or looks up another `api` member. The timer helpers `api.time.*` are in
[Events and lifecycle](events-and-lifecycle.md#apitime-helpers).

The runner adds small helpers to `api`; each calls the host operations named here under the mod's own grants, and
none starts paid work implicitly.

- `api.package` is `{id, version, sha256}` of the running source.
- `api.session()` calls `session.info` (`inventory`):
  `{thread_id, root, cwd, codex_version, omd_version, model, provider, route, turns_started, process_id}` for the
  session thread, also from terminal commands in the same process. `cwd` and `model` are the thread's current working
  directory and model (a settings change shows at once), and `turns_started` counts turns this process started in the
  thread. `process_id` is an opaque ID of the OMD process, the same for every thread and mod in it; key per-process
  records in shared state, such as watch IDs, by it. `process_id` is experimental. `omd_version` (experimental) is the
  OMD release, as in the terminal `identity`.
- `api.fs.exists(path)`, `api.fs.canonical(path)` (`{path, kind, sha256}`) and `api.fs.ancestors(name, from?)`
  (nearest first, up to the workspace root from `from`, else from the session's cwd with `inventory` or the root)
  normalize workspace-relative paths and read through `workspace.stat` (`fs.read`); symlinked components and paths
  outside the workspace are refused there.
- `api.classify(text, labels, {route, instructions?, effort?, timeout_ms?, max_output_tokens?, cache?})` makes one
  `model.complete` on the named route with a JSON schema enumerating `labels` and returns `{label, result}`
  (`label` is `null` when the answer is not one of them). See [`model.complete`](model-calls.md#modelcomplete).
- `api.usage.summarize(response)` turns a [`model_response`](model-requests.md#onmodel_response) into
  `{measured, tokens, context, cost, timing, …}`. Tokens are provider facts (`measured: false` without usage),
  `context.ratio` uses the session's context window when known, and `cost.source` says whether a charge is projected
  from configured rates (`configured_rates`), reported by the provider (`provider`), covered by a subscription,
  synthetic or unknown.
- `api.usage.rateLimits()` reads `account/rateLimits/read` when the mod holds `account`; window expiry stays as the
  provider reports it.

## Other `api` members

These members are typed in [`api.d.ts`](../api.d.ts) and listed here by signature. Pages that describe their use are
linked.

| Member | Signature |
| --- | --- |
| `api.version` | `'1.0.0'` |
| `api.settings` | `Readonly<Record<string, Json>>`; see [Settings](settings.md) |
| `api.settingsFile` | `{path, status, error}`; see [Settings file](settings.md#settings-file-settings_file_v1) |
| `api.fieldPolicies` | `Readonly<Record<string, Readonly<Record<string, FieldPolicy>>>>` |
| `api.assets.read(name)` | Returns `{text, sha256}` |
| `api.services.call(name, method, input?)` | Returns the service's JSON result; the host transport is the internal `mods.service` operation (capability `services`) |
| `api.provide(contract, handlers)` | Registers handlers for a `ServiceContract` |
| `api.tool(spec, handler)` | Registers a tool (capability `tools`) |
| `api.command(name, handler, options?)` | Registers a command; `options` is `{description?, cli?, args_hint?, immediate?}` (capability `commands`) |
| `api.virtualRead(definition, handler)` | Registers a virtual read for `{scheme, version}` (capability `virtual_reads`) |
| `api.progress(text)` | Returns nothing |
| `api.unsupported(operation)` | Never returns |

The registration limits for tools and commands are in [Host model](host-model.md#registration-limits).
