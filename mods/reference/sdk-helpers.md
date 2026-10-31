# SDK helpers (`sdk_helpers_v1`)

Use it when a mod wants the small helpers the runner adds to `api`, such as `api.session()`, `api.fs`,
`api.classify` and `api.usage`, or looks up another `api` member. The timer helpers `api.time.*` are in
[Events and lifecycle](events-and-lifecycle.md#apitime-helpers).

Entries are frozen in Mod API `1.0.0` unless marked experimental (see the
[registry table](stability-and-migration.md#experimental-entries-in-the-registry)). The helpers run in the mod
runner on every surface.

The runner adds small helpers to `api`; each calls the host operations named here under the mod's own grants, and
none starts paid work implicitly.

- `api.package` is `{id, version, sha256}` of the running source.
- `api.session()` calls `session.info` (capability `inventory`) for the session thread, also from terminal commands
  in the same process. Its fields are in the table after this list.
- `api.fs.exists(path)`, `api.fs.canonical(path)` and `api.fs.ancestors(name, from?)` normalize workspace-relative
  paths and read through `workspace.stat` (capability `fs.read`). `workspace.stat` refuses symlinked components and
  paths outside the workspace.
  - `api.fs.canonical` returns `{path, kind, sha256}`.
  - `api.fs.ancestors` returns matches nearest first, up to the workspace root. It starts from `from`, else from the
    session's cwd (with `inventory`), else from the root.
- `api.classify(text, labels, {route, instructions?, effort?, timeout_ms?, max_output_tokens?, cache?})` makes one
  `model.complete` on the named route with a JSON schema enumerating `labels` and returns `{label, result}`
  (`label` is `null` when the answer is not one of them). See [`model.complete`](model-calls.md#modelcomplete).
- `api.usage.summarize(response)` turns a [`model_response`](model-requests.md#onmodel_response) into
  `{measured, tokens, context, cost, timing, …}`. Tokens are provider facts (`measured: false` without usage).
  `context.ratio` uses the session's context window when known. `cost.source` says where a charge comes from:
  `configured_rates` (projected from configured rates), `provider` (reported by the provider), a subscription,
  synthetic or unknown.
- `api.usage.rateLimits()` reads `account/rateLimits/read` when the mod has the `account` capability. Window expiry is
  returned as the provider reports it.

`api.session()` fields:

| Field | Meaning |
| --- | --- |
| `thread_id`, `root`, `codex_version`, `provider`, `route` | The session thread, its root, the Codex build, provider and route |
| `cwd`, `model` | The thread's current working directory and model; a settings change shows at once |
| `turns_started` | Turns this process started in the thread |
| `process_id` (experimental) | An opaque id of the OMD process, the same for every thread and mod in it; key per-process records in shared state, such as watch ids, by it |
| `omd_version` (experimental) | The OMD release, as in the terminal [`identity`](terminal-operations.md#terminal-identity-terminal_identity_v1) |

## Other `api` members

These members are typed in [`api.d.ts`](../api.d.ts) and listed here by signature. Pages that describe their use are
linked.

| Member | Signature |
| --- | --- |
| `api.version` | `'1.0.0'` |
| `api.settings` | `Readonly<Record<string, Json>>`; see [Settings](settings.md) |
| `api.settingsFile` | `{path, status, error}`; see [Settings file](settings.md#settings-file-settings_file_v1) |
| `api.fieldPolicies` | `Readonly<Record<string, Readonly<Record<string, FieldPolicy>>>>`; for each event and interceptor surface, whether a handler may only observe (`observe_only`), alter (`alterable`) or replace (`replaceable`) each field |
| `api.assets.read(name)` | Returns `{text, sha256}`; see [`api.assets.read`](packaging.md#package-assets) |
| `api.services.call(name, method, input?)` | Returns the service's JSON result; the host transport is the internal `mods.service` operation (capability `services`) |
| `api.provide(contract, handlers)` | Registers handlers for a `ServiceContract` |
| `api.tool(spec, handler)` | Registers a tool (capability `tools`) |
| `api.command(name, handler, options?)` | Registers a command; `options` is `{description?, cli?, args_hint?, immediate?}` (capability `commands`) |
| `api.virtualRead(definition, handler)` | Registers a virtual read for `{scheme, version}` (capability `virtual_reads`) |
| `api.progress(text)` | Returns nothing; reports a progress update while the mod's tool runs, and only from a `tool` callback |
| `api.unsupported(operation)` | Never returns; throws `unsupported_operation: OPERATION` |

The registration limits for tools and commands are in [Host model](host-model.md#registration-limits).
