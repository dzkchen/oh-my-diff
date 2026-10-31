# Mod API reference

This is every [mod API reference page](reference/README.md) in one file, for agents and search. Generated from
the pages in the order of their contents table; edit the pages, not this file.

This reference matches `@oh-my-diff/mod-api` and host API `1.0.0` and Codex `0.166.0`.
`omd-mod status` reports the OMD release as `host.omd`. A package's `compatibility.releases` is matched against that
version. The host loads only mods for this API version. [`api.d.ts`](api.d.ts) is the complete typed surface.

## Glossary

Use it when a reference page uses a term you don't know, or uses a word such as "grant", "store" or "managed" that
means more than one thing. Each entry gives the meaning used in this reference and links to the page that describes
it.

### Mods and the host

| Term | Meaning |
| --- | --- |
| Mod | A TypeScript package with `mod.json` and an entrypoint that the host loads to change how `codex` behaves or looks. See [How OMD works](https://github.com/dzkchen/oh-my-diff/blob/main/docs/how-omd-works.md). |
| Manifest | A mod's `mod.json`. It declares the mod's id, version, API version, capabilities, required host features and settings schema. |
| First-party mod | A mod the OMD project writes, in `mods/first-party`, against the same public API as any other mod. See [Included mods](https://github.com/dzkchen/oh-my-diff/blob/main/docs/collection.md). |
| Port | A mod adapted from a Claude Code mod, such as `burn_meter`. Ports are in `mods/ports`. No install profile includes them, so you install one from the curated directory. |
| Curated directory | The mods OMD reviews and offers in `/mods` under Available and through `omd mods catalog`: its first-party mods and its ports, each pinned to a hash. The store's `package-index.json` is its index. See [Package indexes](reference/packaging.md#package-indexes). |
| Mod component | A mod that a Codex plugin contains in its own folder (`mod/` in the OMD+ plugins), named by the plugin's `.codex-plugin/omd.json` descriptor. Adding the plugin doesn't run it: you trust and enable it like any other mod. See [Plugin components](reference/plugin-components.md). |
| Package | A mod as installed: its source, version and integrity in the package lock. One package is one mod. See [Packaging](reference/packaging.md). |
| Host | The native mod host inside the `codex` process. One host runs in a process at a time. See [Host model](reference/host-model.md#one-host-per-process). |
| Handler | A function a mod registers, for example with `api.on`, `api.intercept` or `api.command`. |
| Callback | One run of a handler by the host. Budgets, contexts and the fault limit apply per callback. See [Host model](reference/host-model.md). |
| User context | A callback a user starts in the terminal: a slash command, button or keybinding. It can call the user-action operations and a short list of others. See [Host model](reference/host-model.md#callback-contexts). |
| Event context | A callback that runs for an event with the session, such as a lifecycle event, timer or channel message. It can call operations a user context can't, such as `process.*` and `agents.*`. See [Host model](reference/host-model.md#callback-contexts). |
| Runner | An `omd-runner` process that runs one package's callbacks. Runners are never shared between packages. See [Host model](reference/host-model.md#callback-lifetime). |
| Host operation | A named operation a mod calls through `api.host.call`, such as `exec.run` or `store.get`. Each one needs a capability. See [Capability by operation](reference/capabilities.md#capability-by-operation). |
| Host call | One invocation of a host operation from a callback. A callback makes at most 512. See [Host model](reference/host-model.md#callback-budgets-and-the-clock). |
| Interceptor | A handler registered with `api.intercept` that runs in a chain and may call `next`, change its input or answer without it. See [Interceptors](reference/interceptors.md). |
| Middleware event | An event a mod receives with `api.middleware`: `prompt`, `session`, `agent`, `tool_call`, `tool_result`, `host_operation` or `approval`. |
| Replacement | A handler registered with `api.replace` for one exclusive point: `context`, `routing`, `compaction`, `tool_batch`, `completion` or `history`. |
| Observer | A handler that receives an event and changes nothing, for example a `tool_output` observer. |
| Interceptor surface | A name `api.intercept` selects, such as `tool`, `command` or `render`. See [Every interceptor surface](reference/interceptors.md#every-interceptor-surface). |
| `next` | The function an interceptor calls to run the rest of the chain and then the native executor. See [Interceptors](reference/interceptors.md#the-next-object-and-retries). |
| Required interceptor | An interceptor registered with `required: true`; when it fails, the operation fails instead of continuing without it (fails closed). See [Interceptors](reference/interceptors.md#handler-failures-and-skipped-interceptors). |
| Managed process | A helper process a mod starts with `process.start` and talks to with framed messages. See [Managed processes](reference/managed-processes.md). |
| Host feature | A name such as `routes_v1` that the host advertises and a package lists in `required_features`. "Require X" on a reference page means listing feature X. |
| Generation | A number the host raises each time a reload changes which mods are loaded. It rejects a callback from an older generation with `stale_mod_generation` (retry on the next turn), and raster handles from an older generation stop working. Each runtime counts its own, and the `generation` in `store.*` and `packages.*` results is a different number. See [Host model](reference/host-model.md#callback-admission-and-completion). |
| Workspace | The session's current local repository, at its canonical path. `workspace.*` operations, which `fs.read` and `fs.write` allow, work only there unless an `fs.external` root is named. The `omd_workspace` mod's panel layout is a different thing. See [Workspace files](reference/workspace-files.md). |

### Trust and authority

| Term | Meaning |
| --- | --- |
| Capability | A name in `mod.json` `capabilities` that allows one group of host operations, events and registrations. See [Capabilities](reference/capabilities.md). |
| Permission | The user-facing word for a capability. The user docs say permission; the reference says capability. |
| Authority grant | A capability that gives a mod authority beyond its sandbox, such as `os`, `http` or `approve`. Its scope is declared in the manifest and covered by the trust digest. It can expire and be revoked. See [Authority grants](reference/authority-grants.md). |
| Sandbox | Two meanings. The session sandbox is the one Codex runs the agent's commands in. `exec.run` uses it too, and an `os` grant runs listed programs outside it (`sandbox: "none"`, see [Running commands](reference/running-commands.md#execrun-with-sandbox-none)). The runner sandbox is the macOS sandbox profile every `omd-runner` process runs under. It denies by default, so a runner can't write files and has no network ([Trust and permissions](https://github.com/dzkchen/oh-my-diff/blob/main/docs/trust-and-permissions.md#the-sandbox)). |
| Grant | Used alone, the set of capabilities and secret environment a user trusted for one selection. Other uses always carry a qualifier: authority grant, service grant, route grant file, runner grant. |
| Service grant | An entry in `host.json` `services` that lets a mod run a sidecar or provider service, with its program, network, credentials and route. See [Routes](reference/routes.md#provider-services). |
| Route grant file | A JSON file an operator writes and a route's `grant` names by path and SHA-256, binding the route to a repository, provider, model and URL. See [Routes](reference/routes.md#route-grant-files). |
| Runner grant | The `omd-runner` path and digest the authority broker stores for a store. See [Protected authority](reference/protected-authority.md#what-the-broker-protects). |
| Credential profile | An enrolled token (ChatGPT sign-in, an API key or a provider key) bound to one origin. See [Credentials](reference/credentials.md#credential-profiles-and-secrets). |
| Secret | A credential profile of kind `secret` that belongs to one mod. Only that mod sees it in `credentials.list` and can remove it. |
| Trust | A user's approval of one package's exact content, capabilities and scope. Changed content or a wider scope needs a new trust. |
| Trust digest | The hash of a package's content and declared authority. A trust applies to this exact hash. |
| Native confirmation | A confirmation Codex draws itself, outside every mod's view, such as an approval or the check before a mod writes Codex config. Its decision text, options and keys stay native. Pages use this term, not "native prompt" or "native dialog". See [Render hooks](reference/render-hooks.md). |
| Selection | One package a store runs, at managed, project or user scope. User and project selections are in `mods.json`; managed ones come from the administrator policy. |
| Scope | The selection level, `managed`, `project` or `user`; managed overrides project, and project overrides user. Also used for the store scope of data (`thread`) and for the scopes of an authority grant. |
| Managed | Deployed by an administrator policy. A managed package's grant is the policy itself. See [Administrator policy](reference/administrator-policy.md). |
| Tier | Where a managed package's interceptors sit: `prepend` outside every other mod, `append` inside. |
| Authority broker | The macOS system service (LaunchDaemon) that stores credentials and grants outside the user's reach. See [Protected authority](reference/protected-authority.md). |
| Provenance | Three meanings. Package-source provenance is the broker's record of a verified install's origin ([Administrator policy](reference/administrator-policy.md#package-source-provenance)). Manifest `provenance.source` is the repository a package says it comes from ([Packaging](reference/packaging.md#provenancesource-for-git-installs)). A store record's `provenance` is the host-attested writer of that record. |
| Receipt | Two meanings. A contract receipt is evidence a mod submits with `receipts.submit` ([Contracts and receipts](reference/contracts.md#receiptssubmit)). An access receipt is the host's record of an HTTP, MCP, external file or environment call ([Authority grants](reference/authority-grants.md#access-receipts)). |
| Producer | Who made a contract receipt: `any`, `lead`, `host`, `integration` or `separate_agent`. See [Contracts and receipts](reference/contracts.md#registering-a-contract). For rasters, a producer is the process that publishes frames ([Graphics](reference/graphics.md#raster-processes-process_raster_v1)). |
| Contract | A versioned document that gates task completion and workspace integration on receipts. See [Contracts and receipts](reference/contracts.md). |
| Snapshot | A frozen copy of the workspace or of an agent's workspace, made with `workspace.snapshot`. See [Workspace files](reference/workspace-files.md#snapshots-workspacesnapshot). |
| Candidate | The workspace change a receipt or `workspace.integrate` is about, identified by `candidate_sha256`. See [Workspace files](reference/workspace-files.md#snapshots-workspacesnapshot). |

### Stores and data

| Term | Meaning |
| --- | --- |
| Mod store | The directory that contains `mods.json`, `host.json`, package caches, settings and mod data. `STORE` in a command is its path. |
| Install profile | Which mods the installer adds: OMD+ (`--profile full`) or OMD Core (`--profile platform`). Each keeps its own mod choices. Written "install profile" to tell it from an account profile. See [Install Oh My Diff](https://github.com/dzkchen/oh-my-diff/blob/main/docs/install.md). |
| Account profile | A ChatGPT account, API key or provider that `omd_profiles` switches between with `/profile`. Written "account profile" to tell it from an install profile. See [Use other providers](https://github.com/dzkchen/oh-my-diff/blob/main/docs/use-other-providers.md). |
| `direct` | A recovery state, not an install profile: `omd-package activate direct` runs plain Codex behavior with no mods. See [Troubleshooting](https://github.com/dzkchen/oh-my-diff/blob/main/docs/troubleshooting.md#a-mod-breaks-codex). |
| Scratch store | An empty mod store made with `omd-mod init` for testing. |
| `store.*` | The key-value data operations a mod calls. See [State and storage](reference/state-and-storage.md#store-operations). |
| `api.state` | A mod's saved state, read during renders. See [State and storage](reference/state-and-storage.md#apistate-compare-and-swap). |
| Evidence | Records written with `evidence.write` and read with `evidence.read`, plus the host's records of a turn. |
| Settings | A mod's user-set values, checked against `settings_schema`. See [Settings](reference/settings.md). |

### Sessions and models

| Term | Meaning |
| --- | --- |
| Thread | One Codex conversation. Thread-scoped data follows it through forks. |
| Turn | One user input and the model's work on it. |
| Code mode | A Codex feature (`features.code_mode`) in which the model runs JavaScript cells that call the session's tools from code. A tool call from a cell has `origin.caller` `code_mode` and a `cell_id`. Configured kernels add persistent interpreters, such as the Python and Bun ones the `omd-code-execution` plugin ships. See [Tools](reference/tools.md) and [Code-mode kernels](reference/managed-processes.md#code-mode-kernels). |
| Session | Two meanings. A live session is one running `codex` process and its host: `sessions.ports`, peer sessions and "when the session ends" use this meaning. A recorded session is one thread's history, as `sessions.list` and `sessions.read` return it. It contains read-only messages and tool records from this repository's rollouts, and only threads whose Codex memory mode is on are listed ([`sessions.list`](reference/threads-and-sessions-store.md#sessionslist)). `session_id` is the thread's id, so a recorded session can be a past thread or a subagent thread (`parent_id`). See [Thread data and recorded sessions](reference/threads-and-sessions-store.md). |
| Rollout | The file a thread's history is recorded in. Resume, search and export read it. |
| Transcript | The persisted conversation a user sees, rewritten only through `thread/rewrite`. See [History](reference/history.md). |
| Compaction checkpoint | The installed result of a compaction, which resume reads. |
| Route | A model configuration in `host.json` `routes`: provider, model, URL, rates and roles. See [Routes](reference/routes.md). |
| Lead, worker | Route roles. A lead route serves a thread; a worker route serves mod-started agents and `model.complete`. |
| Provider service | A mod-owned service process that a routed service grant runs as a model provider. See [Routes](reference/routes.md#provider-services). |
| Sidecar | A process a mod starts from a service grant with `sidecars.start`. See [Routes](reference/routes.md#sidecars). |
| Ledger | The session's record of model requests, costs and limits. See [Routes](reference/routes.md#ledger). |
| Reservation, exposure | `reservation_microusd` is the most one request on a route can cost, set aside when the host admits it. Exposure is a thread's running total of what its requests have cost plus what unsettled ones could still cost. `limits.exposure_microusd` caps it for the whole thread and `worker_limits.exposure_microusd` for each worker, and the host denies a request that would pass either cap. Both caps default to `0`. See [Route grant files](reference/routes.md#route-grant-files). |
| Agent handle | The `agent_id` a mod gets from `agents.spawn`; agent operations address only the caller's own handles. See [Agents](reference/agents.md#agent-handles-and-limits). |
| Peer session | Another live session whose package accepts messages from `peers.send`. See [Peers, power holds and mod-started turns](reference/sessions-and-turns.md#peer-sessions-peer_sessions_v1). |
| Microusd | One millionth of a US dollar, the unit of route rates and costs. |

### Terminal

| Term | Meaning |
| --- | --- |
| View | What a mod's `terminal` handler returns: components, panes, layout and other fields the host composes with other mods' views. See [Terminal UI](reference/terminal-ui.md#views-sites-layouts-and-components). |
| Terminal patch | A view a mod contributes, composed with every other mod's patch in one order. |
| Site | A named place in the terminal a patch can fill, wrap or replace: native sites such as `welcome`, and mod sites named `owner/name`. |
| Region | A focus region: the chat is region 0 and each drawn `site:` layout leaf is a region. A layout region is the area a layout leaf draws in. See [Terminal input](reference/terminal-input.md#focus-regions-key-contexts-and-help-terminal_focus_v1). |
| Composer | The prompt box, where the user types a message or a command. The user docs call it the prompt. See [Commands, configuration and composer](reference/commands-and-composer.md). |
| Layout | A tree of splits and tabs over the transcript, the composer and `site:` leaves. See [Layout and styling](reference/layout-and-styling.md#layouts-and-component-types). |
| Component | One node of a view, of 20 types such as `box`, `list` and `raster`. See [Component types](reference/layout-and-styling.md#component-types). |
| Overlay | A mod site drawn above the layout at an anchor. See [Layout and styling](reference/layout-and-styling.md#overlays). |
| Raster | A keyed canvas of cells that `terminal.blit` draws into. See [Graphics](reference/graphics.md#raster-component). |
| Underlay | One cell raster drawn under the whole fullscreen screen. See [Graphics](reference/graphics.md#underlay-terminal_underlay_v1). |
| Component module | A view region drawn by the handlers a mod registers with `api.component`. See [Terminal input](reference/terminal-input.md#component-modules-component_modules_v1). |
| Key context | View key bindings that apply only while their `when` condition holds. See [Terminal input](reference/terminal-input.md#focus-regions-key-contexts-and-help-terminal_focus_v1). |
| External client | A renderer other than the terminal that attaches over `omd-client/1` and draws the same view. See [External clients](reference/external-clients.md). |
| Epoch, revision | An epoch identifies one run of the host's view; a new epoch means the host restarted. A revision grows within an epoch. See [`omd-client/1` protocol](reference/omd-client-protocol.md#ordering-epochs-and-reconnecting). |
| Action token | A per-connection token bound to the view's epoch and revision that `omd/action` spends. See [`omd-client/1` protocol](reference/omd-client-protocol.md#actions-and-tokens). |
| Roster | The list of attached external clients. See [`omd-client/1` protocol](reference/omd-client-protocol.md#renderer-capabilities-and-fallback). |

## Host model

Use it when you need the rules every host operation and callback follows: one host per process, callback
admission, budgets and contexts, composition order, registration limits, the fault limit and the runner
environment. For when to write a mod instead of a skill, hook or plugin, see
[How OMD works](https://github.com/dzkchen/oh-my-diff/blob/main/docs/how-omd-works.md).
Every limit on this page is also in [Limits](reference/limits.md).

Entries are frozen in Mod API `1.0.0` unless marked experimental (see the
[registry table](reference/stability-and-migration.md#experimental-entries-in-the-registry)). Runs on Apple Silicon macOS.

### `OMD_MODE`

The `OMD_MODE` environment variable sets whether `codex` starts the mod host.

| Value | Runs |
| --- | --- |
| `OMD_MODE=omd` | The mod host in the default session |
| `OMD_MODE=upstream_direct` (or no `OMD_MODE`) | Pinned upstream behavior without mods |

Any other `OMD_MODE` value is rejected.

### What mods can't replace or bypass

A mod runs inside the host, asks for only the capabilities it needs, and composes with other mods by the
[composition rules](#composition-order). A mod can never replace or bypass:

| Area | Reserved to the host |
| --- | --- |
| Authority and acceptance | Workflow-contract enforcement, permissions, spending grants, accounting, cancellation, provider credentials, provider authorization, workspace integrity, evidence and final acceptance |
| History | History beyond the documented rewrite points, reasoning or call/output pairs, the compaction engine, and prompts for provider-side compaction |
| Terminal | Raw terminal escapes, arbitrary widgets or DOM/canvas access, approval key bindings, the transcript and clipboard authorization |
| Runtime | Arbitrary providers, runtime imports other than adapter-declared aliases, and a second scheduler |
| Other mods | `requires` declares presence and order only; mods never call each other or share state |

### Host lifetime and callback authority

Which host runs in a process, how its runtimes differ, when a callback's completion is accepted and which failures
report a category.

#### One host per process

One native host runs the process-wide session dispatcher and client bridge at a time. A second live installation is
rejected. Stopping that host releases its registrations, and teardown from an older registration cannot remove a
newer one.

#### Runtimes

The host runs mod code in a main, an input and a persistence runtime. The input runtime runs `input` and `mention`
interceptors and `workspace_pre_rename` handlers, the persistence runtime runs `history_persist` interceptors, and the
main runtime runs other callbacks. Each runtime may have its own idle snapshot, generation numbers, telemetry and
callback failure state.

- Generation numbers are local to each runtime. Don't use one as an authority token in another runtime.
- Each callback uses the selected source and grants of the runtime that runs it.
- The persistence runtime refreshes itself and applies its own required-interceptor decision, including the failure
  fallback. When required persistence work fails, the host withholds the text. When the host drops persistence work,
  it cancels the callback.

#### Callback admission and completion

The host checks the mod's current source and authority when it admits a callback and again when the callback
completes. It rejects the completion, and accepts none of the callback's state or results, when the callback was
cancelled, the mod was disabled or revoked, its source was replaced or the executing generation changed.

**Effects already performed by a host call are not rolled back.** Don't rely on a disabled or replaced callback
committing state after its host call finishes. Restoring the previous mods after a failed reload follows separate
rules. A runtime the host keeps from before a reload doesn't authorize stale callbacks.

#### Failure categories

Some failures report a category you can branch on instead of parsing the message. Raster producers report a failure
as retryable, revoked or fatal, whatever the diagnostic wording. A thread-store destination conflict reports the
native `AlreadyExists` category.

### Host primitives

The host is feature-agnostic: every operation, event and capability in this reference is available to any trusted mod
on equal terms, and none of them names a product feature. The [`release_check` example](examples/release_check) is
an independent author package that uses only this surface. Other independent examples are
[`virtual_reader`](examples/virtual_reader), [`scoped_data`](examples/scoped_data),
[`review_probe`](examples/review_probe) and [`workspace`](examples/workspace). They show the shared interfaces
and aren't production implementations.

Each primitive (an operation, event or capability) advertises a [host feature](reference/glossary.md#mods-and-the-host) that a
package can list in `required_features` or `optional_features` (Mod API `1.0.0`; at most 32 unique host features in each
list, none in both). With no mod registered for a primitive the host allocates
nothing for it and changes no decision.

### Callback budgets and the clock

The host answers each host call, including `next` and `time.sleep`, inside the running callback, so the callback runs
once. A callback makes at most 512 host calls. Offline runners without an interactive host instead replay the
callback once per host call.

`Date.now()` and `new Date()` return the callback's start time. Only `time.sleep` advances it, by its `slept_ms`. This
also applies in a state-conflict retry.

- `hook_budget_ms` bounds the callback's own JavaScript time.
- A separate 5 s total bounds the callback's JavaScript time plus its waits on
  [user-action operations](#callback-contexts) that need no user answer. Exceeding it fails the callback with
  `callback_execution_budget`.
- Confirmations and prompts may wait longer, and other host operations keep their own timeouts.

#### Host call transport budget

Host call arguments and results share a 1 MiB transport budget per callback.

- A result that would exceed the remaining budget becomes a `host_result_limit` error the mod can catch. The
  operation has still run.
- Each operation's own limits keep a single result inside that budget. For larger data, read it in pages or use an
  output artifact.

### Callback lifetime

What a callback keeps from earlier runs, and when its work ends.

- Every callback except a render hook gets a fresh VM context and activation. Render hooks keep their activation
  while the package revision, settings and persisted state stay unchanged
  ([Render callback runtime](reference/render-hooks.md#render-callback-runtime)).
- A package's later callbacks may reuse its sandboxed runner process and a bounded bytecode cache. Runners are never
  shared between packages.
- Before the host returns a callback's result, it waits for work the callback left running to settle. If that work
  makes a host call after the callback returned, the callback fails.
- Persist state through `api.state`. Module globals don't survive from one callback to the next.

### Callback contexts

The context a callback runs in sets which host operations it can call. `terminal` renders and `render` hooks get no host
operations, so draw from `api.state`.

Slash commands, buttons and keybindings run in the terminal as user actions. Reference pages call these callbacks
user contexts. A user context can call only:

- `exec.*`
- `workspace.read/list/stat/check_access/transaction/backup/restore`
- `store.*`
- the user-action operations (`app.request`, `credentials.*`, `terminal.*`, `composer.*`, `builtins.invoke`,
  `packages.*`, `routes.add`, `routes.write`, `contract.select`, `sessions.ports`, `settings.write`)
- `app.routes`
- `turns.activity`
- `events.publish`

A service call from a user context works only when its provider needs no other host operation.

Component input callbacks also run in the terminal, but not as user actions. They can't call `terminal.selection`,
`terminal.copy`, `terminal.panel`, `credentials.request`, `terminal.import_file`, `builtins.invoke`,
`commands.invoke`, `config.set`, `packages.apply`, `routes.add`, `routes.write`, `contract.select` or
`settings.write`.

To run any other operation (`task.*`, `contract.*`, other `routes.*`, `evidence.*`,
`workspace.snapshot/fingerprint`, `process.*`, `agents.*`), publish an event with `events.publish` and do the work in
the mod's own `channel` handler, which runs with the session.

### Runtime waits and hook skips

These waits and skips apply to `api.middleware` hooks. The mod runtime is single-threaded and never runs
re-entrantly. While one request or stream hook is using the runtime, another waits up to 2 s.

A non-hook callback can also occupy the runtime, for example a tool waiting for the agent it spawned. A mod-spawned
agent's request and every response stream then go ahead at once without hooks. Other requests wait up to 2 s first.

- Each skip is recorded as `intercept_skipped` with the surface and reason (`mod_callback_in_flight` or
  `mod_runtime_busy`).
- A skipped or unsubscribed stream runs without stream hooks for the rest of that response.
- The middleware log records only selections, transformations and fallbacks, and stops growing at 8 MiB.
- Interceptors occupy the runtime only while a handler starts or settles, never while `next` waits. They follow the
  [required and optional interceptor waits](reference/interceptors.md#handler-failures-and-skipped-interceptors).

### Service dispatch (`service_dispatch_v1`)

A service is a set of handlers one mod registers with `api.provide` and another calls with `api.services.call`. When
a consumer calls a provider, the provider runs with its own capability grants, source identity, storage namespace and
host-operation provenance.

- A nested call shares the initiating callback's cancellation, 512-call and 5 s execution budgets.
- Recursive providers and chains beyond eight callback frames fail closed.
- Standalone invocations without a provider-aware host dispatcher refuse that provider's host operation.
- Offline `host_calls` records the actual mod caller for every mocked operation.

### Composition order

Dependencies run before consumers, and remaining mods use lexical id order. Managed scope shadows project scope, which
shadows user scope. A selection doesn't inherit state or grants from the selection it shadows. Observers compose in
that order. Interceptors follow the [interceptor order](reference/interceptors.md#interceptor-order).

Exclusive replacements, contract ids, service providers and namespaced tools fail closed when contested. Native
permissions, credentials, accounting, cancellation, evidence, workflow enforcement and provider authorization stay
outside the Mod API.

### Registration limits

The host refuses a registration past these limits. `mise run mods:host-check` (`scripts/mod_host_check.py`) loads
every first-party package and example through the real host and reports any it refuses.

- At most 32 tools and 32 commands per mod.
- Commands are invoked as `/<id>:<name>`; the bare `/<name>` works only when no built-in command or other mod uses
  that name.
- Mod ids use `a-z`, `0-9` and `_` up to 24 bytes and never equal the host `origin.caller` labels `model`,
  `engine`, `code_mode` or `user`.
- Command and tool names use up to 32 bytes of `a-z`, `0-9` and `_`.

### Fault limit

Five consecutive failed callbacks in one host process turn a mod off. Commands, tools, hooks and render hooks all
count, and any successful callback resets the count.

These failures don't count:

- errors starting `state_conflict`, `state_thread_unavailable`, `state_checkout_unavailable`, `callback_cancelled`,
  `host_receipt_limit`, `host_result_limit`, `host_call_limit` or `callback_execution_budget`;
- failures of `service` and `component` events.

The count is kept in process memory and is not persisted, so each `omd-mod command` starts at 0 and `omd-mod status`
shows `faults: 0` afterwards.

When a mod is turned off, the TUI says so once in the transcript, and `/omd` and `omd mods list` show why. A mod
turned off in a running host comes back with `/omd` > Reload mods.

### Runner environment

Each runner process gives mod code the globals below and has the memory limits after them. The manifest
`environment` field that allows `crypto` is described in [Settings](reference/settings.md#manifest-environment).

#### Text encoding and `crypto`

Every context has the standard `TextEncoder`. Host limits count UTF-8 bytes:

- `new TextEncoder().encode(text).length` measures a string.
- `text.slice(0, encoder.encodeInto(text, new Uint8Array(limit)).read)` cuts it to `limit` bytes without splitting
  a character.
- Pass the bytes from `encode` to `crypto.subtle`.

The `crypto` environment provides `getRandomValues`, `randomUUID` and the `crypto.subtle` methods.

- `crypto.subtle` implements the Web Cryptography API's standard algorithms: SHA-1/256/384/512, HMAC, AES-GCM,
  AES-CBC, AES-CTR, AES-KW, PBKDF2, HKDF, ECDSA and ECDH (P-256, P-384, P-521), Ed25519, X25519,
  RSASSA-PKCS1-v1_5, RSA-PSS and RSA-OAEP, with `raw`, `spki`, `pkcs8` and `jwk` keys as each algorithm allows.
- These inputs are supported. Anything else fails with `NotSupportedError`.
  - AES-GCM takes a 96-bit `iv` and a 128-bit tag.
  - AES-KW keys are 128 or 256 bits.
  - ECDSA signs P-256 with SHA-256, P-384 with SHA-384 and P-521 with SHA-256, SHA-384 or SHA-512.
  - RSA keys are 2048–8192 bits with exponent 65537.
  - RSA-PSS `saltLength` equals the hash length.
- Generated HMAC keys and derived bits are at most 8,388,608 bits (1 MiB), and PBKDF2 `iterations` are at most
  4,294,967,295. Larger values fail with `OperationError`.
- `crypto.subtle` results are copied into the mod's context.
- A `CryptoKey` is a frozen handle with `type`, `extractable`, `algorithm` and `usages`.
- Failures are plain `Error`s whose `name` is the Web Crypto error name.

There is no `TextDecoder`, `Buffer` or `structuredClone`, and no code is compiled from strings (`eval`, `new
Function`), in the mod's context or the runner process. The runner has no event loop, so `Atomics.waitAsync` is
absent. Wait with `Atomics.wait` or the `time.sleep` operation.

A runner loads ICU data on its first `Intl` or `localeCompare` use, which takes about 5 ms. On hot paths, compare ASCII
ids and versions with plain string and digit comparisons.

#### Runner memory limits

Each runner process has a 64 MiB V8 old-space limit, and the host kills a runner whose physical memory
(ArrayBuffers and other off-heap data included) passes 512 MiB. Either fails the callback with `mod_out_of_memory`.

## Limits

Use it when you check whether a design fits the host. Each row gives one limit and links its owner page, which
states the exact rule and the error a call gets. The `host.json` limits an operator can change are under
[Host limits](#host-limits).

Values are those of Mod API `1.0.0` on Codex `0.166.0`; limits of experimental entries may change in any release.

### Limits by area

Each table covers one area, and the Owner column links the page with the exact rule.

#### Host and runner

| Limit | Value | Owner |
| --- | --- | --- |
| Host operations per callback | 512 | [Host model](reference/host-model.md#callback-budgets-and-the-clock) |
| Callback JavaScript time plus waits on user-action operations | 5 s (`callback_execution_budget`) | [Host model](reference/host-model.md#callback-budgets-and-the-clock) |
| Host operation arguments and results per callback | 1 MiB transport budget (`host_result_limit`) | [Host model](reference/host-model.md#host-call-transport-budget) |
| Request and stream hook wait for a busy runtime | 2 s | [Host model](reference/host-model.md#runtime-waits-and-hook-skips) |
| Middleware log | 8 MiB | [Host model](reference/host-model.md#runtime-waits-and-hook-skips) |
| Service provider chain | 8 callback frames | [Host model](reference/host-model.md#service-dispatch-service_dispatch_v1) |
| Consecutive failed callbacks before a mod turns off | 5 | [Host model](reference/host-model.md#fault-limit) |
| Tools and commands per mod | 32 each | [Host model](reference/host-model.md#registration-limits) |
| Mod id | 24 bytes of `a-z`, `0-9` and `_` | [Host model](reference/host-model.md#registration-limits) |
| Command and tool names | 32 bytes of `a-z`, `0-9` and `_` | [Host model](reference/host-model.md#registration-limits) |
| Runner V8 old space | 64 MiB (`mod_out_of_memory`) | [Host model](reference/host-model.md#runner-memory-limits) |
| Runner physical memory | 512 MiB (`mod_out_of_memory`) | [Host model](reference/host-model.md#runner-memory-limits) |
| Generated HMAC keys and derived bits | 8,388,608 bits (1 MiB) | [Host model](reference/host-model.md#text-encoding-and-crypto) |
| PBKDF2 `iterations` | 1 to 4,294,967,295 (`OperationError`) | [Host model](reference/host-model.md#text-encoding-and-crypto) |
| RSA key size | 2,048 to 8,192 bits, exponent 65537 | [Host model](reference/host-model.md#text-encoding-and-crypto) |
| AES-GCM `iv` and tag | 96 bits and 128 bits | [Host model](reference/host-model.md#text-encoding-and-crypto) |
| Subagent depth and concurrent workers | 2 and 4 by default (`host.json` `limits`) | [Host limits](#host-limits) |
| Watches, paths per watch, timers, PTY panes, completion items | `host.json` `mod_limits` | [Host limits](#host-limits) |

#### Packages and settings

| Limit | Value | Owner |
| --- | --- | --- |
| npm tarball | 4 MiB, 16 MiB unpacked, 1,024 entries | [Packaging](reference/packaging.md#version-and-tarball-checks) |
| Rollback history per local package | 8 entries | [Packaging](reference/packaging.md#rollback-and-cleanup) |
| Security log | 64 KiB | [Packaging](reference/packaging.md#protection-recovery-and-the-security-log) |
| `packages.index` page | 1-200 entries, default 200 | [Packaging](reference/packaging.md#packagesindex) |
| Package `description` | 1–160 printable characters | [Packaging](reference/packaging.md#package-description) |
| Settings file | 64 KiB | [Settings](reference/settings.md#settings-file-settings_file_v1) |
| Setting `title` and `description` | 64 and 300 bytes | [Settings](reference/settings.md#settings-defaults) |
| Package files | 16 assets, 8 KiB `mod.json`, 512 KiB per file | [Packaging](reference/packaging.md#package-assets) |
| `required_features` and `optional_features` | 32 each | [Host model](reference/host-model.md#host-primitives) |

#### Authority, admission and credentials

| Limit | Value | Owner |
| --- | --- | --- |
| `os_access` programs | 32 | [Authority grants](reference/authority-grants.md#os_access-manifest-field) |
| `http_access` origins and credential profiles | 32 | [Authority grants](reference/authority-grants.md#http_access-manifest-field) |
| `http.request` timeout | 30 s default, 120 s maximum | [Authority grants](reference/authority-grants.md#httprequest) |
| `http.request` response | 64 KiB default, 128 KiB maximum | [Authority grants](reference/authority-grants.md#httprequest) |
| `http.request` body and headers | 1 MiB; 32 headers in 8 KiB | [Authority grants](reference/authority-grants.md#httprequest) |
| `http.request` redirects | 5 | [Authority grants](reference/authority-grants.md#httprequest-redirects-and-credentials) |
| HTTP streams per mod | 4, closed after 60 s idle; 64 KiB per read | [Authority grants](reference/authority-grants.md#httpopen-httpread-and-httpclose) |
| `fs_access` roots | 16 | [Authority grants](reference/authority-grants.md#fs_access-manifest-field) |
| `mcp_servers` servers | 8 | [Authority grants](reference/authority-grants.md#mcp_servers-manifest-field) |
| Access receipts in status | the last 32 | [Authority grants](reference/authority-grants.md#access-receipts) |
| `environment.read` | 16 names; values over 4,096 bytes read as unset | [Authority grants](reference/authority-grants.md#environmentread) |
| `environment.set` | 4,096-byte values; 16 names and 16 KiB per scope | [Authority grants](reference/authority-grants.md#environmentset) |
| `exec_environment` names | 16 | [Authority grants](reference/authority-grants.md#exec_environment-names) |
| `policy.namespaces` patterns | 16 | [Admission and interception](reference/admission-and-interception.md#admission-and-api-policy-admission_api_policy_v1) |
| Credential gateway | 16 connections, 4 forwards per registration, 30 s timeout, 10 min deadline | [Credentials](reference/credentials.md#credential-gateway) |

#### Routes, models and history

| Limit | Value | Owner |
| --- | --- | --- |
| `providers.models` | 16 models; `name` 1–64 bytes | [Routes](reference/routes.md#providersmodels) |
| Route `data` | 2 KiB | [Routes](reference/routes.md#route-writes-route_write_v1) |
| Ledger attempts given to a mod | the newest 64 | [Routes](reference/routes.md#ledger) |
| `model_request` section previews | 48 KiB in all, 4 KiB each; 8 inserted sections | [Model requests](reference/model-requests.md#model_request-sections) |
| Synthetic `model_request` response | at most 16 items | [Model requests](reference/model-requests.md#model_request-next-and-synthetic-responses) |
| Stop-and-retry | twice per turn | [Model requests](reference/model-requests.md#stopping-a-response-and-retrying) |
| `model.complete` prompt, `system`, `context` | 8 KiB, 8 KiB, 8 blocks and 32 KiB in total | [Model calls](reference/model-calls.md#modelcomplete) |
| `model.complete` output and timeout | 128,000 tokens; 300 s | [Model calls](reference/model-calls.md#modelcomplete) |
| `model_send` page | 96 KiB; pieces of 80 KiB with 1 KiB of context | [Final-request policy](reference/final-request-policy.md#model_send-input-pages) |
| `model_send` pages per request | 128 (`final_request_too_large`) | [Final-request policy](reference/final-request-policy.md#model_send-input-pages) |
| `model_send` edits | 256, 4 KiB of replacement text each | [Final-request policy](reference/final-request-policy.md#model_send-edits-and-denials) |
| Model-bound history view | 2,048 items within a 4 MiB runner request; 2 KiB previews | [History](reference/history.md#model-bound-history-history_v1) |
| `history_persist` batch | 48 KiB of JSON per callback | [History](reference/history.md#history_persist-returns-and-batching) |
| `thread/rewrite` edits | 1 to 256 | [History](reference/history.md#edits) |
| Compaction history view | 1,024 items, 512-byte previews within 128 KiB | [History](reference/history.md#compaction-input) |

#### Interceptors, tools, commands and the app bridge

| Limit | Value | Owner |
| --- | --- | --- |
| Dynamic tools per mod | 64 | [Tools](reference/tools.md#dynamic-tools-dynamic_tools_v1) |
| Interceptors per mod | 16, registered during activation | [Interceptors](reference/interceptors.md#apiintercept) |
| `next` calls per interceptor | 3 | [Interceptors](reference/interceptors.md#the-next-object-and-retries) |
| Interceptor chains kept in status | the last 16; values over 2 KiB become a digest | [Interceptors](reference/interceptors.md#chain-status-and-offline-scenarios) |
| Interceptor wait for a busy runtime | 5 s for a required one, 2 s for an optional one | [Interceptors](reference/interceptors.md#handler-failures-and-skipped-interceptors) |
| Tool output a handler sees | 256 KiB; the model sees at most 64 KiB of a replacement | [Interceptors](reference/interceptors.md#surfaces-and-what-a-handler-may-change) |
| `tools.original` | 16 MiB; read in 64 KiB pages | [Tools](reference/tools.md#toolsoriginal-tool_original_v1) |
| `tool_output` append | 4 KiB, 16 KiB per call | [Tools](reference/tools.md#tool_output-observers) |
| `tools.list` | 512 tools, 4,096-character descriptions, 16 KiB `parameters` | [Tools](reference/tools.md#toolslist) |
| Confirmed `app.request` parameters | 2,000 bytes | [App bridge and approvals](reference/app-bridge-and-approvals.md#contexts-and-native-confirmations) |
| `app_notification` queue | 256 events / 1 MiB per mod | [App bridge and approvals](reference/app-bridge-and-approvals.md#app-notifications-and-server-requests) |
| `app.respond` question answers | 16 questions of 16 answers, 16,384 bytes | [App bridge and approvals](reference/app-bridge-and-approvals.md#apprespond-app_respond_v1) |
| `commands.invoke` nesting | 4 deep | [Commands and composer](reference/commands-and-composer.md#commandsinvoke) |
| Completion triggers | 4 per mod | [Commands and composer](reference/commands-and-composer.md#token-completion) |
| `composer.suggest` | 4 KiB | [Commands and composer](reference/commands-and-composer.md#composersuggest) |
| `@` file mentions | 16 per turn, 256 KiB of returned text | [Commands and composer](reference/commands-and-composer.md#read-checks-and-limits) |

#### Workspace, commands and processes

| Limit | Value | Owner |
| --- | --- | --- |
| `exec.run` | 10 s default, 120 s timeout; 1 MiB captured output; 4 concurrent runs | [Running commands](reference/running-commands.md#execrun-limits) |
| `process.exchange` | 256 KiB of messages, at most 64 | [Managed processes](reference/managed-processes.md#processexchange) |
| `exec.run` output artifact | 16 MiB; 16 KiB pages; 64 MiB per binding | [Running commands](reference/running-commands.md#output_artifact-and-execoutput_page) |
| `exec.run` `guards` | 4 guards of 10 s and 1 MiB | [Running commands](reference/running-commands.md#guards-for-live-workspace-writes) |
| `exec.run` `required_access` | 128 paths | [Running commands](reference/running-commands.md#required_access) |
| `exec.run` `unix_sockets` | 4 variables | [Running commands](reference/running-commands.md#unix_sockets) |
| Execution records | 64 per mod generation and thread, 256 per host | [Running commands](reference/running-commands.md#execrun-against-a-snapshot) |
| `workspace.read` | 128 paths, 4 MiB | [Workspace files](reference/workspace-files.md#workspace-reads-and-transactions) |
| `workspace.list` | 20,000 entries | [Workspace files](reference/workspace-files.md#other-workspace-operations) |
| `workspace.check_access` | 128 paths | [Workspace files](reference/workspace-files.md#other-workspace-operations) |
| `workspace.backup`, `workspace.restore` | 256 files, 64 MiB | [Workspace files](reference/workspace-files.md#other-workspace-operations) |
| `workspace_change` batch | 128 paths, 16,000 bytes of path names; a rescan after 64 unannounced changes | [Workspace files](reference/workspace-files.md#workspace_change-delivery) |
| Workspace snapshots | 128 MiB per capture; 8 snapshots and 128 MiB per mod generation and thread; 32 snapshots and 256 MiB per host | [Workspace files](reference/workspace-files.md#snapshots-workspacesnapshot) |
| Raw process streams | 8,000-byte chunks, 128 queued messages | [Managed processes](reference/managed-processes.md#raw-streams-process_streams_v1) |
| `process.start` `environment` | 8 variables | [Managed processes](reference/managed-processes.md#process-environment-and-sandbox) |

#### State and events

| Limit | Value | Owner |
| --- | --- | --- |
| `store.*` | 256-byte keys, 64 KiB values, 16 MiB and 4,096 keys per scope | [State and storage](reference/state-and-storage.md#store-operations) |
| `api.state` in the mod store | 512 KiB | [State and storage](reference/state-and-storage.md#state_scope-state_scopes_v1) |
| `evidence.write` | PNG and JPEG 8 MiB, SVG 1 MiB, `application/octet-stream` and text 16 MiB | [State and storage](reference/state-and-storage.md#evidencewrite-and-evidenceread) |
| `time.sleep` | 60 s | [Events and lifecycle](reference/events-and-lifecycle.md#apitime-helpers) |
| `api.time` timers | 16 ms to 24 h | [Events and lifecycle](reference/events-and-lifecycle.md#apitime-helpers) |
| `api.uiState` | 65,536 bytes of JSON | [State and storage](reference/state-and-storage.md#session-ui-state-apiuistate) |
| Reactive subscriptions | 64 per mod; cascades stop after 8 rounds | [State and storage](reference/state-and-storage.md#reactive-state-reactive_state_v1) |
| Channel events | 256 events / 1 MiB per subscriber; 256 counters per publisher, 4,096 per process | [Events and lifecycle](reference/events-and-lifecycle.md#eventspublish) |
| Timer delay | 16 ms to 24 h (`timers_16ms_v1` below 1,000 ms) | [Events and lifecycle](reference/events-and-lifecycle.md#timers-timers_v1) |

#### Sessions, agents and contracts

| Limit | Value | Owner |
| --- | --- | --- |
| `sessions.read` | 2,048 characters per record, 16 KiB pages, 4,096 records | [Thread data and recorded sessions](reference/threads-and-sessions-store.md#sessionsread) |
| Peer messages | 64 KiB data, TTL 1 s to 1 h, 64 waiting per recipient | [Peers, power holds and mod-started turns](reference/sessions-and-turns.md#peerslist-and-peerssend) |
| Power holds | 4 live leases per mod; 60 s to 24 h | [Peers, power holds and mod-started turns](reference/sessions-and-turns.md#power-holds-power_hold_v1) |
| Agent definitions per mod | 8 | [Agents](reference/agents.md#agent-definitions) |
| Agents | 16 held handles; `agents.wait` 30 s; 64 finished records | [Agents](reference/agents.md#agent-handles-and-limits) |
| Parent history | 8,192 records or 1 MiB | [Agents](reference/agents.md#parent-history) |
| `sessions.snapshot` `call_ids` | 1–32 call ids | [Thread data and recorded sessions](reference/threads-and-sessions-store.md#sessionssnapshot) |
| Contract restrictions and resolutions | 64 scoped rules of 1–8 predicates; 32 findings per `resolves` | [Contracts and receipts](reference/contracts.md#scoped-restrictions) |
| `turns.queue` | 8 KiB prompt; deadline 1 s to 24 h | [Peers, power holds and mod-started turns](reference/sessions-and-turns.md#turnsqueue) |
| `prompts.consent` | 61,440 bytes, 8 images, 64 pending per mod and thread | [Peers, power holds and mod-started turns](reference/sessions-and-turns.md#promptsconsent) |

#### Terminal

| Limit | Value | Owner |
| --- | --- | --- |
| View keybindings | 24 per mod, 128 composed | [Layout and styling](reference/layout-and-styling.md#view-limits) |
| View components | 64, nested 6 deep; ids up to 48 bytes | [Layout and styling](reference/layout-and-styling.md#view-limits) |
| View text | 256 bytes per row value, label and span; 49,152 bytes per text block | [Layout and styling](reference/layout-and-styling.md#view-limits) |
| View JSON | 256 KiB per view or patch, 1 MiB composed | [Layout and styling](reference/layout-and-styling.md#view-limits) |
| Status row | 4 segments of 40 characters across all mods | [Layout and styling](reference/layout-and-styling.md#view-limits) |
| Component modules per mod | 16; 4 mounted in the terminal and 4 per external client | [Terminal input](reference/terminal-input.md#component-modules-component_modules_v1) |
| Layout tree | 6 levels, 2–4 children per split, 1–6 tabs per node, 12 leaves | [Layout and styling](reference/layout-and-styling.md#layouts-and-component-types) |
| Overlays | width 1–200, height 1–60 | [Layout and styling](reference/layout-and-styling.md#overlays) |
| `key_contexts` | 8 contexts and 32 keys per mod; 16 and 128 composed | [Terminal input](reference/terminal-input.md#focus-regions-key-contexts-and-help-terminal_focus_v1) |
| Component key input | 64 events and 64 KiB per batch; 256 queued events | [Terminal input](reference/terminal-input.md#component-key-and-paste-input-terminal_input_v1) |
| Images | 8 MiB PNG or JPEG, 4,096 pixels a side | [Graphics](reference/graphics.md#image-formats-and-pixel-mapping) |
| `terminal.image_sample` | 120 columns, 60 rows, 8 MiB source | [Graphics](reference/graphics.md#terminalimage_sample) |
| Rasters | 1–512 × 1–256 cells; 16 per mod; 256 KiB per `terminal.blit` | [Graphics](reference/graphics.md#raster-component) |
| Pixel frames | 4,096 pixels per side (64 MiB for RGBA) | [Graphics](reference/graphics.md#pixel-buffer-safety-and-limits) |
| `terminal.panel` | 1–200 items, 8 tabs, 32 options; 128-byte title | [Terminal operations](reference/terminal-operations.md#terminalpanel) |
| `terminal.notice` | 512 bytes; 4 toast or status notices per mod; 8 model notices queued per thread | [Terminal operations](reference/terminal-operations.md#terminalnotice) |
| `terminal.selection`, `terminal.copy` | 64 KiB | [Terminal operations](reference/terminal-operations.md#selection-and-clipboard) |
| `above_composer`, `below_composer` sites | 8 and 6 rows | [Terminal UI](reference/terminal-ui.md#alternate-screen-inline-mode-and-composer-sites) |
| `omd/client/event` | 64 KiB per event | [`omd-client/1` protocol](reference/omd-client-protocol.md#omdclientevent) |
| `session_title_suffix`, `greeting` | 80 and 256 bytes | [Layout and styling](reference/layout-and-styling.md#title-suffix-and-greeting) |
| Layout leaf `title` | 64 bytes | [Layout and styling](reference/layout-and-styling.md#layouts-and-component-types) |
| `terminal.pane` | 8 rows shown | [Terminal operations](reference/terminal-operations.md#terminalpane-and-terminalpanes) |
| `terminal.prompt` choices | 32 options | [Terminal operations](reference/terminal-operations.md#terminalprompt) |
| `terminal.notify` | 1 per 2 s | [Terminal operations](reference/terminal-operations.md#notifications-and-ports) |
| `terminal.import_file` | 8 MiB | [Terminal operations](reference/terminal-operations.md#threads-and-imports) |
| `sessions.ports` | 32 ports, 3 s per probe | [Terminal operations](reference/terminal-operations.md#notifications-and-ports) |
| `document` component | 100,000 lines; 10,000 find matches | [Layout and styling](reference/layout-and-styling.md#documents) |

### Host limits

These are the limits an operator can change in `host.json`.

`host.json` `limits.max_depth` (default 2) and `limits.concurrent_workers` (default 4) cap a session's subagents. The
host refuses a mod worker or a model `spawn_agent` past either limit with `subagent_depth_limit` or
`subagent_concurrency_limit`. The concurrency limit counts:

- running mod workers (`agents.spawn`)
- running model children: a child in a turn or not yet through its first turn
- children on another provider while they run a turn

Idle or ended children don't count, so a child woken by a message can briefly take the count past the cap. A provider
service process, such as the `omd_claude_cli` relay, needs a free slot to start but takes none once it runs.

`host.json` `mod_limits` changes these per-mod limits:

| Limit | Default | Maximum |
| --- | --- | --- |
| `watches_per_mod` | 16 | 64 |
| `paths_per_watch` | 32 | 256 |
| `timers_per_mod` | 16 | 64 |
| `pty_panes_per_mod` | 4 | 16 |
| `completion_items` | 200 | 1000 |

## Stability and migration

Use it when you need to know which API entries keep their shape, which may change in any release, and what changed
after `1.0.0`. The conformance registry, `mods/conformance/contract.json`, is the source of truth for every status
on this page.

Entries are frozen in Mod API `1.0.0` unless marked experimental (see the
[registry table](#experimental-entries-in-the-registry)). Runs on Apple Silicon macOS.

### Stability

API `1.0.0` is stable.
[The conformance registry](https://github.com/dzkchen/oh-my-diff/blob/main/mods/conformance/contract.json) marks each
public operation, event, capability, interceptor, component, render site, view field, classic hook and author command as
frozen or experimental:

- Frozen entries keep their shape through `2027-10-19`. A breaking change to one needs a major version and a migration
  note.
- Experimental ones may change in any release.
- A frozen entry's `experimental_fields` (fields added after 1.0.0, such as the `workspace.watch` `key`) are
  experimental too.

Version and support rules are in
[COMPATIBILITY.md](https://github.com/dzkchen/oh-my-diff/blob/main/mods/conformance/COMPATIBILITY.md).

#### Experimental entries in the registry

The registry marks these entries experimental in Mod API `1.0.0`:

| Kind | Experimental entries |
| --- | --- |
| Capabilities | `approve.override`, `autonomous`, `fs.external`, `history_write`, `mcp`, `peers`, `power`, `unix_sockets` |
| Events | `config_change`, `contract`, `elicitation_result`, `focus`, `host_operation`, `instructions_loaded`, `migrate`, `mods_changed`, `peer_message`, `peer_receipt`, `prompt`, `prompt_expanded`, `session`, `tool_batch_end`, `tool_exposure`, `turn_queue`, `view`, `worktree` |
| Interceptors | `agent_offers`, `agent_spawn`, `compaction`, `component_change`, `composer_key`, `elicitation`, `mention`, `peer_receive`, `peer_send`, `turn_stop` |
| Operations | `agents.list`, `agents.message`, `app.routes`, `builtins.invoke`, `commands.describe`, `config.describe`, `config.set`, `environment.read`, `exec.output_page`, `http.close`, `http.open`, `http.read`, `ledger.settle`, `mcp.connect`, `mcp.disconnect`, `model.fork`, `models.context_window`, `mods.service`, `peers.list`, `peers.send`, `power.hold`, `power.release`, `prompts.consent`, `prompts.revoke`, `prompts.status`, `prompts.submit`, `routes.write`, `sidecars.stop`, `store.export`, `store.list`, `store.reset`, `terminal.blit`, `terminal.image_sample`, `terminal.panes`, `time.sleep`, `tools.invoke`, `tools.list`, `tools.original`, `tools.undefine`, `turns.dequeue`, `turns.queue`, `turns.queued`, `workspace.check_access`, `workspace.unwatch` |
| Components | `raster` |
| Render sites | `composer_hint`, `notice`, `session_mode`, `tool_result`, `turn_duration`, `user_message` |
| View fields | `background`, `footer`, `foreground`, `header`, `key_contexts`, `panels`, `placeholder`, `surface_styles`, `underlay` |
| View sites | `header` |
| Classic hooks | `ConfigChange`, `CwdChanged`, `DirectoryAdded`, `Elicitation`, `ElicitationResult`, `FileChanged`, `InstructionsLoaded`, `MessageDisplay`, `Notification`, `PermissionDenied`, `PermissionRequest`, `PostCompact`, `PostModelSwitch`, `PostToolBatch`, `PostToolUse`, `PostToolUseFailure`, `PreCompact`, `PreModelSwitch`, `PreToolUse`, `SessionEnd`, `SessionStart`, `Setup`, `Stop`, `StopFailure`, `SubagentStart`, `SubagentStop`, `TaskCompleted`, `TaskCreated`, `TeammateIdle`, `UserPromptExpansion`, `UserPromptSubmit`, `WorktreeCreate`, `WorktreeRemove` |
| Author commands | `cost` |

#### Experimental features without a registry entry

These experimental features have no registry entry of their own:

| Feature | Covers |
| --- | --- |
| `api.uiState` and command views | [Session UI state](reference/state-and-storage.md#session-ui-state-apiuistate) and [command views](reference/commands-and-composer.md#command-views) |
| `process_streams_v1` | `framing: "raw"` on `process.start` |
| `process_raster_v1`, `raster_pixels_v1` | Processes that feed a raster frames or raw pixel buffers |
| `completion_tokens_v1` | `api.completion` token triggers |
| `settings_file_v1` | `api.settingsFile` and the settings file |
| `terminal_focus_v1` | Focus regions, the `region` and `help` key actions, `keys: 'all'` and a layout leaf's `style.focus` |
| `terminal_pty_v2` | The terminal pane extension: keys, mouse, cursor, OSC signals, session directories, binary pins and `autofocus` |

#### Frozen entries with experimental fields

These frozen entries have experimental fields:

| Frozen entry | Experimental fields | Host feature the registry names |
| --- | --- | --- |
| `events:agent` | `provider`, `model`, `billing` | none |
| `events:component_event` | `content`, `target`, `edge`, `columns`, `rows` | `terminal_layout_dock_v1` |
| `events:terminal` | `omd_version`, `welcome`, `chat`, `colors`, `sites` | `terminal_welcome_area_v1`, `terminal_chat_area_v1`, `terminal_colors_v1`, `terminal_site_area_v1` |
| `replacements:tool_batch` | `success_per_call` | `tool_batch_success_v1` |
| `intercepts:tool` | `value`, `bytes` | `code_mode_values_v1`, `tool_original_v1` |
| `operations:agents.inventory` | `provider`, `model`, `billing` | none |
| `operations:agents.spawn` | `model` | none |
| `operations:routes.list` | `data` | `route_write_v1` |
| `operations:session.info` | `process_id`, `omd_version` | none |
| `operations:sidecars.status` | `started_at_ms` | none |
| `operations:terminal.panel` | `group`, `keywords`, `detail`, `query`, `selected`, `close_args` | `terminal_panel_navigation_v1` |
| `operations:workspace.watch` | `key`, `git` | `workspace_watch_key_v1`, `workspace_watch_git_v1` |
| `components:code` | `start` | `terminal_code_highlight_v1` |
| `view_fields:keybindings` | `region`, `help` | `terminal_focus_v1` |
| `view_fields:layout` | `title`, `focus` | `terminal_layout_title_v1`, `terminal_focus_v1` |
| `view_fields:welcome` | `hidden` | `terminal_welcome_hidden_v1` |

#### Features OMD doesn't provide

OMD doesn't provide closure-based client modules, vendor kill switches, raw secret access, hosted mobile or desktop
clients, rich children inside buttons (a button uses its typed `text`), audio, telemetry and floating panes.

### Migration notes

These changes ship in OMD 1.3.0.

- Only mod `owner` can replace or wrap a site named `owner/name`. The host refuses a patch to that site from any other
  mod and reports it under `terminal.conflicts`. Before this change, any mod could wrap or replace another mod's site.
  This is a safety fix to the frozen `ui_composition_v1` (Mod API `1.0.0`). A mod that composes into a site it
  doesn't own must ask its owner for a native slot or its own site. Native sites (names without `/`) compose as
  before.
- A layout may nest 6 levels instead of 4. The raise is additive, so every layout valid before stays valid.
- Host calls per callback rise from 128 to 512 (`budget.hostCalls` starts at 512). The raise is additive, so a mod
  that counted calls or stayed under 128 keeps working. Other limits rose with it and only allow more than before:
  the callback transport budget, `process.exchange` and tool interceptor output, `api.state`, package files, view
  JSON, evidence pages and registrations per mod. Two of these changes are visible to a mod:
  - `evidence.read` without `max_bytes` returns pages of up to 64 KiB instead of 16 KiB.
  - The host drops a `tool` replacement the model can't take with a diagnostic after the chain, instead of refusing
    it inside the chain. The model can't take a replacement over 64 KiB that is longer than the original output. For
    a retried call, the original is the latest attempt's output. Either way the original output stands.
- `exec.run` children start in their own session without a controlling terminal. A program that prompts on
  `/dev/tty` (git credentials, ssh passphrases, `sudo`) fails instead of drawing over the TUI and waiting. Pass input
  through `stdin` or the program's non-interactive flags. Runs with `sandbox: "none"` also receive `SSH_AUTH_SOCK`, so
  programs under an `os` grant can sign in through the user's SSH agent.

## Authoring

Use it when you look up an author command, the TypeScript test helpers, the `mod.test.json` format, JSX
compilation, multi-file packages, diagnostics or the cost report. For the step-by-step author loop, see
[Write your first mod](https://github.com/dzkchen/oh-my-diff/blob/main/docs/mod-authors/first-mod.md). For
packaging and publishing, see [Packaging](reference/packaging.md).

The author commands and test helpers are frozen in Mod API `1.0.0` except the experimental `cost` report (see the
[registry table](reference/stability-and-migration.md#experimental-entries-in-the-registry)). They need Node 24 and run on
Apple Silicon macOS.

### Author commands

In a package made with `create`, the `pnpm` scripts (`check`, `test`, `run`, `debug`, `package`, `watch`) run the
`omd-mod-author` command of the same name on the package directory.

| Command | Result |
| --- | --- |
| `omd-mod-author create DIR [ID]` | Minimal typed package with pnpm scripts and offline tests |
| `omd-mod-author example DIR NAME` | Copy one named author example into a new project |
| `omd-mod-author examples DIR` | Every public author example |
| `pnpm check` | Syntax validation, plus strict validation against this exact SDK when TypeScript is installed; prints `check: ok` when it passes |
| `pnpm test` | Runs the offline scenarios, the type check and the TypeScript tests (see [TypeScript tests](#typescript-tests)) |
| `pnpm run run` | Runs the same deterministic scenario and prints the full trace |
| `pnpm debug` | Runs `debug.test.json`, which expects an error, and exits 0 with the error's mapped source location |
| `pnpm run package` | Produces a checked package directory, JavaScript debug build, source map, and digest report |
| `omd-mod-author cost DIR [COMMAND [ARGS_JSON]] [--runs N]` | Activation, first render, callback time, runner count and runner footprint of one package (see [Cost report](#cost-report)) |
| `pnpm watch STORE` | Re-inspects reviewed local source, approves the edited digest, queues reload, and copies the store's declarations into `.omd/` (see [Watch and reload](#watch-and-reload)) |
| `omd-mod-author report STORE` | Declared-versus-used capabilities, services, operations, and environment |
| `omd-mod-author events STORE` | Composition order, scope precedence, events, replacements, and conflicts |
| `omd-mod-author diagnostics STORE [OUTPUT]` | Reproducible JSON bundle with paths, settings, environment, and credentials removed |
| `omd-mod-author explain DENIAL` | Cause, safe remedy, and the authority boundary for a denial |

`pnpm test` runs, in order:

1. every scenario in `mod.test.json`, with no provider requests
2. once TypeScript is installed, the `pnpm check` type check, which fails the run before the report prints
3. every `*.test.ts` and `*.test.mjs` beside `mod.test.json` under `node --test`

#### Author toolchain

- The `omd-mod` binary is part of OMD. Set `OMD_MOD_BIN` only when a development build is not already on `PATH`.
- Set `OMD_MOD_NODE` to the supported Node 24.x executable, 24.18 or later.
  [Support](https://github.com/dzkchen/oh-my-diff/blob/main/docs/support.md) lists the supported versions.
- pnpm is the package manager. The repository also publishes equivalent `mise run mods:*` tasks without making pnpm a
  mise tool.

### Generated declarations

A mod store generates TypeScript declarations for the running host. `omd-mod-author watch` copies them into `.omd/`,
which the scaffold's `tsconfig.json` includes:

- `active-host.d.ts` describes the running host.
- `installed-contracts.d.ts` describes the service contracts available to consumers.
- `tool-types.d.ts` appears once a session has listed its tools ([Typed tool declarations](#typed-tool-declarations)).

### Typed tool declarations

A running host stores the lead thread's tool inventory (`tools.list`) in its store. `omd-mod declarations STORE`
renders it as `tool-types.d.ts`: a module augmentation of the empty `ToolArguments` interface, keyed by tool name.

Each tool's type is converted from its original JSON schema:

- Supported keywords: `type`, `properties`, `required`, `items`, `enum`, `anyOf`, `additionalProperties`.
- Anything else is `Json`; a freeform tool is `string`.

Once `ToolArguments` lists tools, the `tool` interceptor input and `tools.invoke`/`tools.check` arguments are exactly
one of those tools with its own argument type, so a tool missing from `tool-types.d.ts` needs a cast. Scenario runs
use a throwaway store, so they leave an existing `.omd/tool-types.d.ts` alone.

#### How current the declarations are

The declarations are as current as the last turn that built the thread's tools:

- MCP servers connected later, and tools a `tool_specs` interceptor hid, appear as the host last listed them.
- At run time the host checks a call's arguments and rejects a bad call with `tool_arguments_invalid`. These types
  play no part in that check.

### TypeScript tests

`pnpm test` runs `mod.test.json` and then every `*.test.ts` and `*.test.mjs` next to it with `node --test`:

- Assertions are `node:assert` (built into Node, no extra dependency or framework).
- Test files are plain TypeScript under Node's type stripping.
- `@oh-my-diff/mod-api/testing` builds and runs scenarios for them. It needs `omd-mod` like `pnpm test` and sends no
  provider request.

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TerminalView } from '@oh-my-diff/mod-api';
import { advance, clock, environment, find, invoke, key, mount, packages, pointer, runScenario, storeMock, tiers, waitUntil } from '@oh-my-diff/mod-api/testing';

test('panel opens', () => {
  const trace = runScenario('.', clock(1000), environment({ MODE: 'ci' }), storeMock({ get: [null] }), packages('../policy'), tiers({ append: ['policy'] }), {
    steps: [mount('panel'), key('panel', 'F2', { expect: { action: { command: 'panel:open', args: '' }, result: 'opened' } })],
  });
  assert.ok(find(trace.steps[0].value as TerminalView, 'open'));
});
```

A step's `value` is typed as `Json | undefined`, so cast it to `TerminalView` before passing it to `find` or `text`.
For a walkthrough, see [Test a mod](https://github.com/dzkchen/oh-my-diff/blob/main/docs/mod-authors/test-a-mod.md).

#### Scenario helpers

Each helper sets one part of a scenario. Pass them to `runScenario` or `scenario`.

| Helper | Sets |
| --- | --- |
| `clock(ms)` | `virtual_time_ms` |
| `environment(values)` | The environment |
| `settings(id, values)` | A mod's settings |
| `hostOperations({op: [{result} \| {error}]})` | Mocked host operation replies |
| `storeMock({get, put, delete})` | Ordered `store.*` replies, `null` for a missing key |
| `packages(...paths)` | Extra packages (a policy package, a user package), trusted in that order before the project |
| `tiers({prepend, append})` | Mod ids to run as [administrator-managed](reference/administrator-policy.md) packages in that tier (see [`tiers`](#scenario-file-fields)) |

- `scenario(...parts)` merges parts: queues and packages append, settings and tiers merge, and the last value of any
  other field wins.
- `runScenario(directory, ...parts)` runs the project and returns the engine trace.
- `calls(trace, operation)` lists the trace's host calls.

#### Mocked host operations

Mock operation names, arguments and results derive from `HostOperations`.

- Each reply can include `arguments` for exact JSON matching and `optional: true` for a call that may be absent.
- Reply queues are ordered per operation. An optional reply with different expected arguments can be skipped to reach
  the next reply.
- Fixture records must contain exactly one of `result` or `error`.
- An explicit queue for a timer or environment operation replaces its virtual implementation; exhausted queues never
  fall back to simulated behavior.

Required replies must be consumed. Unexpected calls, argument mismatches and unused required replies fail the
scenario. Unexpected-call and argument-mismatch failures remain scenario failures even when the mod catches the
operation error.

#### Mock validation

- Every normal mock validates request and result shapes. Shared pure validators also check store keys,
  values and revision syntax, environment inputs and timer inputs.
- Malformed result fixtures fail before the scenario runs unless explicitly marked unsafe.
- Authority, declarations, persistence, revision conflicts, quotas, filesystem resolution and process/network state
  require real-host boundary tests; a valid mock cannot prove those behaviors.

#### Negative tests

These helpers skip the SDK's checks so a test can feed a mod malformed input.

- `unsafeHostOperations({op: [{result, unsafe: {result: true}}]})` deliberately bypasses result validation.
  `unsafe.arguments` separately bypasses request validation. Neither grants runtime authority, and unknown operations
  still fail in the engine.
- `unsafeStep({...})` bypasses the SDK's discriminated step type to test malformed scenario input.

#### Scenario steps

These helpers build the steps a scenario runs in order.

- Time and events: `invoke(mod, event, name, payload)`, `emit(event, payload)`, `advance(ms)`,
  `waitUntil(check, until, {everyMs, maxMs})`, `reload()`, `state(mod, {value})` (reads, or first writes, `api.state`).
- Views and input: `mount(mod)`, `key(mod, name)`, `activate(mod, component)`, `input(mod, component, value)`,
  `select(mod, component, value)`, `pointer(mod, component, {column, row, action})` (with `{client}` for an attached
  client's event), `component(mod, module, {instance, props, columns, rows, events})` (steps an `api.component` module).
- Clients: `attach(name, {renderer})`, `detach(id)`.
- Interceptors: `intercept(surface, payload, {core: [coreValue(v) | coreError(e)]})`.

`terminal_interact` steps are written with `key`, `activate`, `input`, `select` and `pointer`. `tool_outcome`,
`agent`, `status` and `tool_exposure` steps have no helper; write them as plain objects.

Step options:

- The last argument takes `expect`, `expectError` and `cancelled`.
- Interactions and `mount` also take `payload`, the `terminal` event input (default `{event: 'draw', ledger: null}`).

#### View queries and interceptor assertions

View queries over a mounted view's value: `find(view, id | fields | fn)`, `findAll` and `text(view)`.

Interceptor assertions over an `intercept` step's value:

| Assertion | Passes when |
| --- | --- |
| `assertWrapped` | The mod called `next` and the chain reached the core |
| `assertShortCircuit` | The mod answered, so the core never ran |
| `assertFailure(chain, mod, /reason/)` | The mod's link in the chain failed with that reason (skipped, kept, caught or rejected) |

#### What tests don't prove

Mounting and interacting run the mod's `terminal` event and callbacks on fixture data. They show what a mod returns
and how it reacts, not how a terminal or an attached client draws or delivers it. A supported-client claim needs the
client conformance harness (`scripts/client_acceptance.py`) or a real terminal check.

### Offline scenarios

A `mod.test.json` file uses schema 1 and runs a mod with no external work.
[Test a mod](https://github.com/dzkchen/oh-my-diff/blob/main/docs/mod-authors/test-a-mod.md) shows a complete
file.

#### Scenario file fields

| Field | Meaning |
| --- | --- |
| `virtual_time_ms` | Fixes `Date.now()` and zero-argument `new Date()` inside every callback |
| `host_operations` | An ordered result/error queue for each approved host operation |
| `settings` | A map from mod id to that mod's explicit settings |
| `packages` | Additional trusted packages |
| `tiers` | Maps loaded mod ids to `prepend` or `append` |
| `environment` | Nonsecret names mapped to string values (see [Offline environment](#offline-environment)) |

- The author commands apply `settings` through `omd-mod settings` before the run, so configured behavior is testable
  offline.
- `packages` allows provider/consumer and conflict fixtures without shared globals or ambient authority.
- `tiers` runs the named mods as administrator-managed packages in that tier for the scenario only. A test then sees
  the managed interceptor order, and that its answers can't skip a managed required guard. An `intercept` step's trace
  shows the order.

- Any unmocked call fails before external work, and every result records `paid_requests: 0`.
- `expect` is deep equality of the step's whole value, not a subset (`offline_expectation_failed`). A render `intercept`
  result includes `trace[].location` (`index.ts:75:7`), so an exact expectation breaks when lines move. Test
  interceptors in a `*.test.ts` file instead ([TypeScript tests](#typescript-tests)).
- A store-level `omd-mod test STORE SCENARIO` uses the store's own settings instead of `settings`.
- A mod that fails to activate reports its retained cause, so a missing service provider, denied capability or source
  error names itself instead of only asking for a reload.

#### Step types

Every step has a `type`:

| `type` | Meaning |
| --- | --- |
| `invoke` | Calls one mod's tool, command or hook by `mod`, `event` and `name` with `payload` |
| `event` | Dispatches `event` with `payload` to every mod that handles it |
| `tool_outcome`, `agent` | Dispatches a `tool_result` or `agent` lifecycle event |
| `advance_time` | Moves virtual time forward by `ms`, running due timers |
| `wait_until` | Repeats a `check` step as time advances until it equals `until` |
| `reload`, `status` | Reloads the mods at a safe boundary; returns the host's status |
| `state` | Returns (or with `value`, first writes) a mod's persisted `api.state` |
| `tool_exposure` | Returns the tool names the mods expose for a `payload` ledger |
| `terminal_mount`, `terminal_interact` | Draws a mod's terminal view; sends it a `key` or a `component` interaction |
| `component` | Steps one `api.component` module instance |
| `client_attach`, `client_detach` | Adds or removes an external client |
| `intercept` | Runs an interceptor chain for `surface`, answering `next` from `core` |

A `terminal_interact` component interaction activates buttons, inputs and selectors with an optional `value`. Copy
actions return without touching the system clipboard.

A step can include `expect`, `expect_error` or `cancelled`. It can also include `thread_id`, which runs the step in
that thread when its payload names none. Thread-scoped state, timers and component events use that thread. The
`THREAD` argument of `omd-mod test` sets the thread for every step and overrides `thread_id`. In a TypeScript test,
pass `threadId` in a step's options.

#### Offline environment

`environment` maps nonsecret names to string values (4096 bytes at most) that `environment.read` answers in place of a
`host_operations` queue, so a scenario never reads the host's environment.

- An unlisted name is `{set: false}`.
- A secret-like name (`*KEY*`, `*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `AWS_*`, ...) fails the scenario with
  `offline_environment_secret_name`.

#### `state` step

```text
{"type": "state", "mod": ID, "value"?: VALUE, "thread_id"?: ID}
```

Returns that mod's persisted `api.state` from the scenario's store, so `expect` can check it after any step. With
`value` it first writes that state (the mod needs `store`, and the usual state limits apply), seeding a test without a
setup command.

#### `component` step

```text
{"type": "component", "mod": ID, "module": NAME, "instance"?: NAME, "props"?: VALUE, "columns"?: 80, "rows"?: 0, "events"?: [...]}
```

Steps one instance of the mod's `api.component` module at the scenario's virtual time, delivering the `key` and
`pointer` events and every due tick, and returns `{tree, post, next_ms}`.

- The instance mounts on its first step and keeps its state until the scenario ends, so `advance_time` steps drive
  `every` ticks.
- The module gets no host authority and its tree is validated as for a terminal.
- `omd-mod test` and `mod_host_check --scenarios` run it like any other step.

#### `wait_until` step

```text
{"type": "wait_until", "check": STEP, "until": VALUE, "every_ms": 1000, "max_ms": N}
```

Runs `check`, and while its value differs from `until` advances virtual time by `every_ms` and checks again (at most
256 checks). It returns `{waited_ms, value}` or fails with `offline_wait_timeout` at `max_ms`.

#### Pointer and client steps

- A `terminal_interact` `key` runs the view's `keybindings` entry, else the first `key_contexts` binding for that key
  (offline steps have no focus).
- `terminal_interact` also takes `pointer: {column, row, half?, action, button?}` with `component`. The mounting mod
  receives `component_event {kind: 'pointer'}` with `origin: 'user'`, only for a `box`, `image` or `raster` mounted
  with `pointer: true` (`offline_terminal_component_not_pointer`). Adding `client: ID` delivers it as that attached
  client's event (`client`, no `origin`).
- `client_attach {name, renderer?, viewport?, focused?}` adds an external client as `client-1`, `client-2`, ... and
  `client_detach {id}` removes it (`offline_client_not_attached`).
- A mounted `terminal` payload includes the roster as `clients` unless it sets its own.

These steps run the mod's callbacks on fixture data; they are not terminal or client rendering evidence.

### Watch and reload

The author loop with `watch` is shown step by step in
[Run and debug a mod](https://github.com/dzkchen/oh-my-diff/blob/main/docs/mod-authors/run-and-debug.md).

#### Interactive watch

While a mod is written, `omd-mod-author watch DIR STORE` (or `pnpm watch STORE`):

1. Inspects the directory.
2. Approves its current digest in `STORE` as the user would with `omd-mod trust`.
3. Queues a reload of that store's host and refreshes `.omd/`.

Saving an entry point, asset or lifecycle file reloads again after 100 ms, and reports a half-written file instead of
stopping. A running session picks the reload up at its next turn boundary; `/omd` reloads at once while no turn runs,
and also disables or resets a mod.

**Because `watch` approves what it watches, point it only at a scratch store** (`omd-mod init STORE`) that contains
no other trusted mods, and run it only on code you wrote or reviewed. To try the mod in a real store, review the
digest and approve it there yourself with `/omd` or `omd-mod trust`. Code an agent wrote is never trusted
automatically.

#### Watching an installed package

For a local package installed with `omd install`, watch updates it through the package preview/apply path, preserving
its scope, settings, grants and enabled or disabled choice.

- Watch refuses a plan that changes any installed package's scope (a shared dependency's included), grants,
  authority or state version. The refusal leaves the package lock and selections unchanged; review those
  changes separately before watching again.
- An installed Git or npm package, or a rollback pointing at cached source, needs a fresh local install of the
  editable directory before watch can update it.

#### Noninteractive watch and CI

- `omd-mod-author watch DIR STORE --once` does one inspect, approve and reload and exits, which suits a build step
  against a scratch store.
- `omd-mod-author test DIR` (or `pnpm test`) is the CI check. It needs no store, since it builds a throwaway store for
  every run. It fails (`no_tests`) when the project has neither `mod.test.json` nor a `*.test.ts` or `*.test.mjs`
  file.

Neither starts a provider request.

### JSX/TSX

Writing terminal components as JSX is optional and author-side only. For an example, see
[Write terminal components in JSX](https://github.com/dzkchen/oh-my-diff/blob/main/docs/mod-authors/jsx.md).

#### Entry point compilation

When a project has `index.tsx`, `omd-mod-author` (check, test, run, debug, package, and each watch reload) compiles it
with the project's own TypeScript into a self-contained `index.ts`. It inlines the small JSX factory, so the host still
sees one module with no value imports.

- The project needs `typescript` installed (the scaffold includes it); without it the command fails with
  `jsx_requires_typescript`.
- Edit `index.tsx` and treat `index.ts` as generated output. A hand-written `index.ts` beside `index.tsx` is never
  overwritten and fails with `jsx_entrypoint_conflict`.
- The scaffolded `tsconfig.json` sets `jsx: "react-jsx"`, `jsxImportSource: "@oh-my-diff/mod-api"` and
  `allowImportingTsExtensions`; `check` type-checks `index.tsx` itself.

#### `.tsx` assets

A `.tsx` file in any subdirectory is an asset source too (skipping `node_modules`, `dist` and dot directories):

- Each compiles to the `.ts` file beside it with the same rules and its own inlined factory.
- A relative import of `./row.tsx` becomes `./row.ts` in the output.
- List the compiled name in `mod.json` `assets` (`"row.ts"`). The host accepts only `.ts`, `.mjs` and `.json` assets,
  and `package` ships only the compiled files, never the `.tsx`.
- The 512 KiB package file limit applies to each compiled file.
- A hand-written `.ts` beside a `.tsx` fails with `jsx_entrypoint_conflict`.

#### Elements and children

Each `TerminalComponent` kind is an intrinsic element (`<box>`, `<line>`, `<text>`, ...) with the component's fields
as props.

| Element | Children become |
| --- | --- |
| `box`, `pane`, `dialog` | `children` |
| `text`, `button`, `markdown`, `code` | `text` (string and number children) |
| `line` | `spans` (string and span children) |

- Function components returning a component work.
- The factory is pure object construction with no Node or DOM authority and grants no capability.
- Unsupported elements and props fail at compile time through the types. A dynamic unknown tag fails with
  `jsx_unsupported_element`; children on a kind that takes none fail with `jsx_children_unsupported`.
- Fragments are not supported.

### Multi-file packages

A package spans several files by importing its declared assets with relative specifiers:
`import { draw } from './draw.ts'`, `'./lib/util.mjs'`, or a `'./table.json'` default export.

- The runner links them in the callback's context, so they share module state for that callback.
- Anything else, including value imports of the SDK and any dynamic `import()`, fails with `unsupported_import`.
- Imported code counts toward the source-use report like the entrypoint; assets that are only read (for example
  scripts passed to `exec.run`) do not.
- Declare the required features `package_text_assets_v1` for assets and `package_imports_v1` for relative imports;
  `mod_host_check.py --static` fails a package that omits them.

### Diagnostics and source maps

Errors name their cause, and stacks point at the authored TypeScript lines.

#### Errors while writing a mod

| Error | Cause |
| --- | --- |
| `capability_denied` | The code used a capability missing from `capabilities` in `mod.json` |
| `conflict: NAME` | `activate` registered the same command, handler, timer or component name twice |
| `undeclared_environment_use: NAME (TEXT)` | The source uses an environment the manifest doesn't allow, such as `process.` (`process`) or `window.` (`dom`) outside a string; see [Manifest `environment`](reference/settings.md#manifest-environment) |
| `unsupported_import` | An import other than types from `@oh-my-diff/mod-api` or a declared asset |
| `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` | `enum`, a namespace with values or a constructor parameter property; `pnpm check` reports them first |

`omd-mod-author explain 'capability_denied: exec'` prints the cause, the fix and what tooling can't do for you.

#### Stacks and source maps

The engine strips TypeScript types in place, so callback stacks report the authored line and column as
`<package>/<file>:line:col`. `omd-mod-author package` also writes a `.js` file and `.js.map` source map beside every
`.ts` file it ships.

#### Per-mod callback log

`omd-mod status` keeps a bounded log per mod of each callback's event, handler, generation, outcome and elapsed
microseconds, plus aggregate timing. The log never adds mod-side filesystem or process access.

#### Source-use report

The source-use report is derived from registrations and literal host/service calls. It compares declared
capabilities, service imports/exports, and allowed environment access with what the source uses:

- Undeclared use is rejected.
- Unused grants are reported. A declared `network` grant counts as used when `exec.run`, `process.start` or
  `terminal.pty` source passes a `unix_sockets` or `network` option outside comments and strings.

Diagnostics explain how to narrow or explicitly approve authority, but tooling cannot grant permissions by itself.

### Cost report

Experimental (added after 1.0.0).

`omd-mod-author cost DIR` installs the package alone in a scratch store and measures it in the real host. It repeats
the measurement `--runs` times (1-100, default 10). Each run starts as a launch does, with no warm runners and no
inspection shared from an earlier host.
Name one of the package's commands, with an optional JSON payload, to time its callbacks too.

| Field | Meaning |
| --- | --- |
| `activation_ms` | Opening a host with the package: runner start, inspection, registration checks |
| `first_render_ms` | The first `terminal` render after activation; absent without a `terminal` handler |
| `fresh_callback_ms`, `reused_callback_ms` | The named command's first and second run after activation |
| `runners` | Runners the package keeps after the last run, idle spares excluded |
| `runner_peak_footprint_bytes` | Sum of those runners' peak physical memory |

Each timing reports `first`, `p50` and `p95` in milliseconds. `first` includes the cold code cache
(`<store>/cache/code`, safe to delete) and, for a newly written engine, the operating system's first-launch check, so
compare `p50` between versions of a package. The numbers are host-side and exclude the terminal's draw. The scratch
store has no Git checkout or session thread, so a command that writes `checkout` or `thread` state fails there, and a
package that requires another fails activation.

## Packaging

Use it when you plan, install, update, roll back, protect or inspect packages, from the shell with `omd-mod` or
from a mod with `packages.*`. For the author-side commands, see [Authoring](reference/authoring.md). To publish a mod to npm
or Git step by step, see
[Install, share and update a mod](https://github.com/dzkchen/oh-my-diff/blob/main/docs/mod-authors/publish-a-mod.md).

Entries are frozen in Mod API `1.0.0` unless marked experimental (see the
[registry table](reference/stability-and-migration.md#experimental-entries-in-the-registry)). `packages.*` operations need the
`packages` capability. The commands run on Apple Silicon macOS.

### Package commands

These `omd-mod` commands manage a package store.

#### Install, update and remove

| Command | Result |
| --- | --- |
| `omd-mod package-plan STORE REQUEST_JSON` | Resolve and preview the exact graph, per-package authority and grant changes, settings, and enablement |
| `omd-mod package-apply STORE REQUEST_JSON CONFIRMATION` | Re-resolve and atomically apply only the unchanged preview |
| `omd-mod package-lock STORE` | Print exact current versions, sources, integrity, trust, settings, and rollback history |
| `omd-mod package-rollback-plan STORE ID` | Preview the prior integrity-addressed package version |
| `omd-mod package-rollback STORE ID CONFIRMATION` | Restore the prior cached package disabled, preserving explicit settings |
| `omd-mod package-uninstall-plan STORE ID` | Preview removal and reject installed dependents |
| `omd-mod package-uninstall STORE ID CONFIRMATION` | Remove the installed package's selection while retaining local source, state, cache, and history |
| `omd-mod plugin-preview CODEX_BIN CODEX_HOME NAME@MARKETPLACE CANDIDATE` | Compare a local plugin candidate and its skills/hooks against the installed cache without applying it |

#### Trust, credentials and runner

| Command | Result |
| --- | --- |
| [`omd-mod credentials STORE`](reference/credentials.md#omd-mod-credentials) | List credential profiles (id, label, kind, provider, origin, status) without secret material |
| `omd-mod credentials STORE add-secret MOD_ID LABEL ORIGIN` | Store stdin as a secret owned by `MOD_ID` (replacing that mod's same-label secret) and print the profile |
| `omd-mod authorize-runner STORE` | With the [authority broker](reference/protected-authority.md) deployed, grant the `omd-runner` beside this `omd-mod` as the store's runner (the installer runs it after each update); without the broker it does nothing |
| [`omd-mod trust-program STORE MOD_ID PROGRAM`](reference/authority-grants.md#os_access-manifest-field) | Pin an unsandboxed program for a mod ahead of time, for headless runs; MOD_ID must be an active mod whose `os_access` lists the program |
| `omd-mod trust-all STORE PACKAGES_JSON` | Trust several exact packages (`[{path, sha256, capabilities, scope?}]`) in one configuration write, so a store protected by the authority broker asks once |
| `omd-mod broker-grants-import STORE [SNAPSHOT_JSON]` | Capture the current configuration, or protect existing selections with that snapshot (see below) |

`omd-mod broker-grants-import`:

- Without `SNAPSHOT_JSON`, captures the exact current configuration.
- With that unchanged snapshot, protects existing valid selections without changing capabilities, secret grants,
  expiry, settings or activation, and reports stale selections as skipped.
- Also grants the `omd-runner` beside this `omd-mod` as the runner.
- Imports no package-source provenance.

#### Selection, policy and protection

| Command | Result |
| --- | --- |
| `omd-mod selection-status STORE` | Show managed, project and user selections, precedence, administrator refusals, source errors, and each setting's origin without running mod code |
| `omd-mod package-sync STORE [--offline\|--rollback]` | Deploy the [administrator policy](reference/administrator-policy.md)'s packages unattended, or reactivate the previous generation |
| `omd-mod policy show\|clear\|rollback`, `policy check\|set FILE`, `policy explain STORE [PROJECT_DIR]` | Print, validate, store (administrator) or explain the [administrator policy](reference/administrator-policy.md#inspecting-managed-state) |
| `omd-mod package-enable STORE ID` | Re-enable an unchanged trusted package at the next turn boundary, retaining settings and state |
| `omd-mod package-disable STORE ID` | Disable an installed package without deleting source, state, or cache |
| `omd-mod package-quarantine STORE ID REASON` | Disable the package and block its installed version and integrity; enable, reinstall and rollback of it are refused while data, cache and sources stay |
| `omd-mod package-unblock STORE ID` | Lift the blocks; the package stays disabled |
| `omd-mod revoke STORE MOD_ID_OR_PACKAGE` | Disable the mod and drop its grant (capabilities and secret environment cleared) |
| `omd-mod security-events STORE` | Print the store's redacted security log |

### Package requests

A package change is a JSON request. `omd-mod package-plan` and `package-apply` take the native request. The
`packages.preview` and `packages.apply` operations and the `omd` CLI take the higher-level request, which names a
package by `source` or by `reference`.

#### Native `package-plan` and `package-apply` requests

For native `package-plan` and `package-apply`, `REQUEST_JSON` is:

```text
{action?, source, index?, scope?, offline?, trust, settings?}
```

| Field | Meaning |
| --- | --- |
| `action` | `install` (the default) or `update` |
| `trust` | `{packages: {ID: {capabilities, lifecycle?, dependencies?, secret_environment?}}}`: each package needs its exact capability and lifecycle grants, and dependencies need explicit trust too |
| `index` | An index file to resolve `package` sources from; the store's `package-index.json` when omitted |
| `scope` | The selection scope, `user` (the default) or `project` |
| `offline` | `true` for an offline install, `false` when omitted |
| `settings` | Maps package ids to setting objects; an update preserves existing settings when omitted |

Apply the identical request with the preview's `confirmation` string.

#### `packages.preview` and `packages.apply` requests

The higher-level `packages.preview`/`packages.apply` operations and `omd` CLI use:

```text
{action, id?, source?, reference?, version?, index?, scope?, expected_generation?}
```

`action` is one of `install`, `update`, `remove`, `rollback`, `enable`, `disable` or `trust`. A request names a package
with `source` or with a `reference` (and optional `version`), never both. `scope` is `user` or `project`.
`expected_generation` is described under
[`packages.apply`, `packages.preview` and `packages.reload`](#packagesapply-packagespreview-and-packagesreload).

#### Package sources

A `source` is one of:

| `source.kind` | Fields |
| --- | --- |
| `local` | `path` |
| `repository` | `repository`, `revision`, `subdirectory?`; `revision` is a 40-hex commit or a branch or tag name, resolved when the plan is made and locked as the commit (an offline install needs a commit) |
| `package` | `index`, `id`, `version`; `version` is empty (newest unblocked release), exact or `^x.y.z` |
| `npm` | `package`, `version?`, `registry?` (default from the user's npmrc, else `https://registry.npmjs.org`; `https` or loopback `http` only), `integrity?` (a sha512 SRI pin) |

#### Package references

A `reference` is the same choice as one string, shared by the `/mods` directory and the `omd` CLI:

| Reference | Meaning |
| --- | --- |
| `ID[@VERSION]` | A release from the curated index |
| `npm:NAME[@VERSION]` | An npm package; scoped names work (`npm:@author/omd-mod@1.2.3`) |
| `git+URL[#REF[:DIRECTORY]]` | A Git repository; `REF` defaults to `HEAD`; `git+file:///path` and a local path work |
| a folder | A local directory (an absolute path in the `/mods` directory; `./`, `../`, `~/` or an absolute path in the `omd` CLI) |

Local package files reached through a symlinked directory outside the package are refused (`package_path_escape`).

### npm packages

A package can come from an npm registry.

#### Version and tarball checks

npm resolution reads the registry metadata and picks the exact version: empty is `dist-tags.latest`; otherwise an
exact version or `^x.y.z`.

The tarball must match the registry's sha512 `dist.integrity` and is extracted safely:

| Tarball rule | Limit |
| --- | --- |
| Entry types | Regular files only; symlinks, hardlinks and path escapes are rejected |
| Tarball size | At most 4 MiB |
| Unpacked size | At most 16 MiB |
| Entries | At most 1,024 |

#### Package contents

- Its `package.json` `name` and `version` must match the request.
- `dependencies` must be empty: ship runtime code as the entrypoint and its imported assets (`peerDependencies` and
  `devDependencies` on `@oh-my-diff/mod-api` are fine).
- The package must publish `mod.json` (same version as `package.json`), the entrypoint, the assets and the lifecycle
  scripts.
- npm `scripts` such as `preinstall` and `postinstall` never run. Only the manifest's OMD `lifecycle` scripts run,
  sandboxed and only with an exact grant.

The lock records the exact version and the tarball SRI, and an offline install reuses the content-addressed cache.

#### Registries, tokens and proxies

Without `registry`, the host follows the user's npmrc (`$NPM_CONFIG_USERCONFIG` or `~/.npmrc`) like npm and pnpm:
`@scope:registry=`, then `registry=`, then the public registry.

- A `//host/path/:_authToken=` entry (with `${ENV}` expansion) authenticates requests under that prefix. The token
  reaches curl on stdin and never appears in arguments, the lock or the security log.
- Proxy variables (`HTTPS_PROXY`, `NO_PROXY` and lower-case forms) pass through.

### Package indexes

The store's `package-index.json` is the default curated index. An index file is bounded JSON with schema 1:

```json
{
  "schema": 1,
  "packages": {
    "example": [
      {
        "version": "1.2.3",
        "source": {
          "kind": "repository",
          "repository": "https://example.invalid/example.git",
          "revision": "0123456789abcdef0123456789abcdef01234567",
          "subdirectory": "mod"
        },
        "integrity": "SHA256_FROM_OMD_MOD_INSPECT",
        "description": "What this release adds",
        "support": "Where to get help"
      },
      {
        "version": "1.2.2",
        "source": { "kind": "npm", "package": "@author/example", "version": "1.2.2" },
        "integrity": "SHA256_FROM_OMD_MOD_INSPECT",
        "blocked": "Reason this release can't be selected"
      }
    ]
  }
}
```

`blocked` (a reason string) makes a release unselectable: planning it fails with `package_version_blocked: REASON`,
and `packages.index` lists it with that reason.

#### Index resolution

Resolution selects the highest unblocked exact or caret-compatible semantic version and then checks the index
integrity against the manifest, entrypoint, and every declared lifecycle script.

- Each dependency needs its own exact trust entry.
- Index files do not grant capabilities or script execution.

### Package assets

A mod reads its own entrypoint and declared text assets with `api.assets.read`.

```text
api.assets.read(name) → {text, sha256}
```

`api.assets.read(name)` returns a selected package's UTF-8 entrypoint or declared text asset with its SHA-256. It
reads only the caller's own hash-bound package. Installed package caches include declared assets, so a mod can pass
its own source to a sandboxed `exec.run` process without a copy in the workspace.

| Package limit | Value |
| --- | --- |
| Assets declared per package | At most 16 |
| `mod.json` | At most 8 KiB |
| Each other package file | At most 512 KiB (`file_limit` names the file) |
| Entrypoint and declared text together | At most 1 MiB per callback (`package_text_input_limit`) |

A package over the per-callback text limit is refused by inspection, install and `omd-mod-author check`.

```ts
const sent = api.host.tryCall('process.exchange', { session: session(m), send: [{ src: api.assets.read('github.mjs').text }], wait_ms: 0 });
```

That call is from [`omd_monitor`](first-party/omd_monitor/index.ts).

### Installed package manifests

The manifest of a package installed through the package manager must declare `license` and `provenance`. The
scaffold emits both with placeholders to change.

#### `provenance.source` for Git installs

- For a Git install, `provenance.source` must equal the repository URL exactly, without the `git+` prefix or
  `#REF:DIRECTORY` suffix. For example, use `https://github.com/author/repo` for
  `git+https://github.com/author/repo#v1.2.3:mod`.
- For a local source such as `git+file:///absolute/repo#REF:mod`, use the repository's canonical absolute filesystem
  path, without `git+`, `file://`, the revision or the mod subdirectory; resolve symlinks first.
- Commit that manifest at the selected Git revision. A mismatch is refused with `repository_provenance_mismatch`.

#### Package `description`

An optional `description` of 1–160 printable characters says what the mod adds; `packages.list` and the `/mods`
screen show it.

### Codex configuration (`codex_config_v1`)

A manifest's `codex_config` turns on Codex features the package depends on, for every lead thread the session
starts, resumes or forks while the package is active: `{"codex_config": {"tools.update_plan.enabled": true}}`.

- Keys come from a closed host allowlist (`tools.update_plan.enabled`, `tool_output_token_limit.raise`,
  `agents.completion_wake`) and must be `true`.
- `agents.completion_wake` starts a turn on an idle lead about 0.5 s after a subagent's result arrives, unless the
  lead is interrupted or in Plan mode. Without it, results wait for the lead's next turn.
- `tool_output_token_limit.raise` sets the thread's `tool_output_token_limit` to at least 65,536 tokens (about
  256 KiB). A larger configured value stays.
- `exec_command` and `write_stdin` still default to 10,000 tokens unless the call sets a larger `max_output_tokens`.
  A `tool` interceptor can set it.
- The raise makes no output smaller or safer. The package must budget model-visible outputs itself, or every long
  output reaches the model whole.
- The package must list `codex_config_v1` in `required_features`.
- Anything else fails inspection with `invalid_codex_config`.

The host recomputes the keys whenever it reloads the active packages (at the next turn boundary after a change), so
a package enabled mid-session applies to lead threads started after that reload. Threads that already exist keep
their configuration. For the threads it applies to, `codex_config` overrides an explicit `false` in the user's
config, and the host writes nothing to `config.toml`.

Install, update and trust previews and `omd-mod status` list a package's `codex_config` with its other authority.

### Package controls (`package_controls_v1`)

The `packages.*` operations (`package_controls_v1`) let a mod install, update, remove, roll back, enable and disable
packages. Packages come from local directories, Git repositories, curated index releases and npm packages.
[Package sources](#package-sources) and [Package references](#package-references) list the forms. `index` resolves
dependencies.

#### `packages.list`

```text
packages.list {fields} | null → {packages, generation, reload_error}
```

`generation` is the store's package generation, which `packages.preview` and `packages.apply` take as
`expected_generation`. `packages.list` reports every selection in the store: installed packages and trusted
`omd-mod` selections. A trusted selection has `source: 'selection'`. You can enable, disable and `trust` it, but not
update it.

- `source` is also `npm` for npm packages.
- `blocked` is the quarantine reason or `null`.
- `packages.list {fields}` keeps only the named keys of each package, so a listing view can skip schemas, settings
  and grants it does not show.
- `packages.list` reports each mod's `settings` and `settings_schema`.
- `required` marks a selection the installer keeps on. `/mods` and `/omd` don't turn it off, but `omd mods disable`
  does.

#### `packages.index`

`packages.index {index?, query?, cursor?, limit?}` is read-only and returns:

```text
{index, packages: [{id, latest, description, support, versions: [{version, blocked}], installed}], total, cursor}
```

It reads the named index (the store's `package-index.json` by default), filtered by `query`, one page of `limit`
entries (1-200, default 200) in id order. `total` counts every match; pass the returned `cursor` to read the next
page, and it is `null` on the last one. Paging requires `package_index_paging_v1`. It fails with
`package_index_unavailable` when no index exists.

#### Package state fields

These `packages.list` fields say whether a package change has taken effect.

- `effective`, `pending: 'reload'` and `failed` describe the session that serves the store. A change shows as
  pending until that session's next safe boundary. A removed mod stays listed with `installed: false` until it stops.
- `reload_error` names a rejected change while the previous mods keep running.

#### `packages.apply`, `packages.preview` and `packages.reload`

```text
packages.preview {...request, expected_generation?} → {action, id, changes, grants_added}
packages.apply {...request, expected_generation} → {status: 'applied', generation} | {status: 'declined'}
packages.reload → {generation, failed, applies: 'next_boundary'}
```

The request is the one under
[`packages.preview` and `packages.apply` requests](#packagespreview-and-packagesapply-requests).

| Argument | Meaning |
| --- | --- |
| `expected_generation` | The `generation` from `packages.list`; required on `apply`, optional on `preview` |

- `apply` returns the new generation, or `declined` when the user declines the confirmation.
- `reload` returns the generation, the ids of mods that failed, and `next_boundary`, when the revalidation applies.

| Error | When |
| --- | --- |
| `expected_generation_required` | `apply` without `expected_generation` |
| `package_state_changed: list again` | `expected_generation` isn't the current generation |
| `package_state_changed: preview again` | The packages changed between the confirmed preview and the apply |

```ts
const result = api.host.tryCall('packages.apply', { ...request, expected_generation: generation });
```

That call is from [`omd_mods`](first-party/omd_mods/index.ts).

`apply` and `reload` run only from [user contexts](reference/host-model.md#callback-contexts). The `trust` action re-approves
an edited selection's current source and capabilities and keeps it enabled.

- `apply` shows a native confirmation naming every new grant, dependencies as `id:capability`, and applies exactly
  the confirmed plan or refuses if the package, lock or selection changed.
- Installing never enables a package; see [Enablement on install and update](#enablement-on-install-and-update).
- The preview lists per package `authority {from, to}`, `grant {from, to}` and `renewed_approval`.
- Once a confirmed package mutation starts, it returns its definitive result even if its writes reload or disable
  the calling mod. A queued call is still rejected when it's cancelled or when the mod's source, the originating
  generation or the client context changed.
- An update resolves dependencies through the index the package came from and previews the capabilities it adds.
- `packages.reload` makes every enabled selection revalidate at the next safe boundary, retrying failed mods.

### Enablement, rollback and history

Installing and updating decide whether a package is on, and rollback returns it to an earlier install.

#### Enablement on install and update

**Installing never enables a package.** An update keeps a package on only if it was on and its grant, authority
scopes and origin are unchanged; otherwise it is off until enabled.

`package-plan` shows per package:

| Field | Meaning |
| --- | --- |
| `authority {from, to}` | Exposure text plus the `os_access`, `approves`, `http_access`, `fs_access`, `mcp_servers`, `policy`, `peer_access` and `autonomy` scopes |
| `grant {from, to}` | The grant change |
| `renewed_approval` | True for a new install or a changed grant, authority or origin |
| `state_version {from, to, migration_required, handler_required}` | The state version change |

#### Rollback and cleanup

Package rollback repoints the selection at the immutable store cache, so returning to editable local development is a
fresh local install of the rolled-back source.

Successful local package updates retain eight rollback history entries. After commit, the package manager removes
local snapshots evicted from that history when no installed package, retained history, selection or managed
deployment references them.

- Cleanup leaves editable sources and remote package caches alone; uninstall retains its cache.
- This is best-effort cleanup of history evictions, not a store-wide size limit: abandoned previews, older orphaned
  snapshots, interrupted cleanup and deletion failures can retain extra files.

### Protection, recovery and the security log

`omd-mod`'s protection and recovery commands work without any control mod. Quarantine keeps the package's data, cache
and sources, so unblocking and enabling restores it.

`security-events` prints `security-events.jsonl`, bounded to 64 KiB (the oldest half is dropped) and redacted: sources
lose credentials and query strings. Its events:

- `install`, `update`, `uninstall`, `rollback`, `enable`, `disable`, `quarantine`, `unblock`, `revoke`, `trust`,
  `lifecycle`, `lifecycle_failed` (an uninstall script failed), `managed_deploy`, `managed_sync_refused`
- `package_refused` (with an error code and the stripped source)
- `load_denied` (a selection rejected at reload)

#### What the checks don't guarantee

Permissions a user deliberately grants (`os` unsandboxed, network, `approve`, secrets) still run with that authority.
Scanning, integrity checks, signatures and directory inclusion do not make a mod safe, and a trusted service provider
acts with its own authority for any caller.

## Settings

Use it when a mod declares, reads or writes settings, when a user sets them in a settings file, or when you check
what the manifest `environment` field allows. `packages.list` reports each mod's settings; see
[Packaging](reference/packaging.md#packageslist).

Entries are frozen in Mod API `1.0.0` unless marked experimental (see the
[registry table](reference/stability-and-migration.md#experimental-entries-in-the-registry)); the settings file is
experimental.

### `settings.write`

```text
settings.write {id?, values} → {settings}
```

`settings.write` checks settings against the schema, saves them and redraws at once. A `null` value removes a setting.
It runs only from [user contexts](reference/host-model.md#callback-contexts). Without `id` it writes the caller's own settings.
With `id` it needs `packages`. `/omd` stays the native recovery path for settings.

Callbacks read the effective settings as `api.settings` (`Readonly<Record<string, Json>>`); see
[Settings defaults](#settings-defaults) and the [settings file](#settings-file-settings_file_v1).

### Settings defaults

Callbacks receive a setting's explicit value when one is set, else the `settings_schema` property's `default`. Give
every property a default. With `additionalProperties: false`, the host ignores a stored setting the package no longer
declares and drops it at the next settings write or update, so a release can remove a setting. A write that names an
undeclared setting is still refused with `unknown_setting`.

A property can also have a `title` (up to 64 bytes) and a `description` (up to 300 bytes), which `/mods` shows
instead of the raw name. A string property without `enum` can set `choices: "routes"`. `packages.list` then fills its
`enum` with the names of the `host.json` worker routes open to that mod.

### Settings file (`settings_file_v1`)

Experimental. A package that uses it lists `settings_file_v1` in `required_features`. A user can then set the mod's
settings in a file instead of through `settings.write`: `settings/<mod_id>.json`, `.yaml` or `.yml` in the mod store,
the directory that contains `mods.json`.

- Only one of the three files may exist. More than one is invalid.
- The file is at most 64 KiB, and its top level must be an object whose keys are the mod's setting names.
- Its keys override the saved settings (and the schema `default` values) in every callback, render and chain
  digest. The file is validated like `settings.write`: a key outside a schema with `additionalProperties: false`,
  a wrongly typed value and a missing `required` setting are invalid.
- Administrator-managed selections ignore the file (status `ignored`).
- The saved settings must be valid on their own. Save a `required` setting without a `default` through
  `settings.write` or `/omd`. The file can then override it.
- An unreadable, oversize, unparsable or invalid file is skipped whole: the saved settings apply, the mod stays on and
  its view diagnostics include `settings_file_invalid: <reason>`.
- Creating, editing or deleting the file applies at the refresh points of a `mods.json` change.
- `api.settingsFile` is `{path, status: 'missing' | 'loaded' | 'invalid' | 'ignored', error: string | null}`. `path` is
  the absolute file to tell the user to edit (the `.json` one while none exists); `error` is the reason when `invalid`.
- `settings.write` of a key the file sets fails with `setting_set_by_file: <key>`. `omd-mod selection-status` lists
  such keys with origin `file` and the file under `settings_file`.

### Manifest `environment`

`"environment": ["crypto"]` in `mod.json` allows the
[`crypto` global](reference/host-model.md#text-encoding-and-crypto). It is the only environment a mod can
declare (another or repeated name fails with `unsupported_or_duplicate_environment_access`).

Without that declaration, the host refuses at load any source that uses `crypto.` or `crypto[` outside string
literals, with `undeclared_environment_use: crypto (crypto.)`. The error names the matched text. The same error
reports these environments, which no manifest can declare:

- `network` (`fetch(`, `WebSocket(`)
- `process` (`process.`, `Deno.`, `Bun.`)
- `dom` (`document.`, `window.`)
- `filesystem` (`node:fs` or `require('fs`, matched inside literals too)

## SDK helpers (`sdk_helpers_v1`)

Use it when a mod wants the small helpers the runner adds to `api`, such as `api.session()`, `api.fs`,
`api.classify` and `api.usage`, or looks up another `api` member. The timer helpers `api.time.*` are in
[Events and lifecycle](reference/events-and-lifecycle.md#apitime-helpers).

Entries are frozen in Mod API `1.0.0` unless marked experimental (see the
[registry table](reference/stability-and-migration.md#experimental-entries-in-the-registry)). The helpers run in the mod
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
  (`label` is `null` when the answer is not one of them). See [`model.complete`](reference/model-calls.md#modelcomplete).
- `api.usage.summarize(response)` turns a [`model_response`](reference/model-requests.md#onmodel_response) into
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
| `omd_version` (experimental) | The OMD release, as in the terminal [`identity`](reference/terminal-operations.md#terminal-identity-terminal_identity_v1) |

### Other `api` members

These members are typed in [`api.d.ts`](api.d.ts) and listed here by signature. Pages that describe their use are
linked.

| Member | Signature |
| --- | --- |
| `api.version` | `'1.0.0'` |
| `api.settings` | `Readonly<Record<string, Json>>`; see [Settings](reference/settings.md) |
| `api.settingsFile` | `{path, status, error}`; see [Settings file](reference/settings.md#settings-file-settings_file_v1) |
| `api.fieldPolicies` | `Readonly<Record<string, Readonly<Record<string, FieldPolicy>>>>`; for each event and interceptor surface, whether a handler may only observe (`observe_only`), alter (`alterable`) or replace (`replaceable`) each field |
| `api.assets.read(name)` | Returns `{text, sha256}`; see [`api.assets.read`](reference/packaging.md#package-assets) |
| `api.services.call(name, method, input?)` | Returns the service's JSON result; the host transport is the internal `mods.service` operation (capability `services`) |
| `api.provide(contract, handlers)` | Registers handlers for a `ServiceContract` |
| `api.tool(spec, handler)` | Registers a tool (capability `tools`) |
| `api.command(name, handler, options?)` | Registers a command; `options` is `{description?, cli?, args_hint?, immediate?}` (capability `commands`) |
| `api.virtualRead(definition, handler)` | Registers a virtual read for `{scheme, version}` (capability `virtual_reads`) |
| `api.progress(text)` | Returns nothing; reports a progress update while the mod's tool runs, and only from a `tool` callback |
| `api.unsupported(operation)` | Never returns; throws `unsupported_operation: OPERATION` |

The registration limits for tools and commands are in [Host model](reference/host-model.md#registration-limits).

## Capabilities

Use it when you choose a mod's `capabilities` or review what a trusted mod can do. The tables list what each
manifest capability allows, and [Capability by operation](#capability-by-operation) lists the capability each host
operation needs. How the authority grants are scoped and ended is in [Authority grants](reference/authority-grants.md).

Entries are frozen in Mod API `1.0.0` unless marked experimental (see the
[registry table](reference/stability-and-migration.md#experimental-entries-in-the-registry)). Runs on Apple Silicon macOS.

A capability is a name in `mod.json` `capabilities` that allows a class of host operations, events and
registrations. User-facing pages call capabilities permissions. A call or registration outside the package's trusted
capabilities fails with `capability_denied: NAME` before any native work.

### Process, workspace, model and data capabilities

These capabilities allow processes, workspace files, models, agents, stored data, sessions and contracts, plus the
`history` replacement and `tool_output` observers.

| Capability | Allows |
| --- | --- |
| `exec` | `exec.run`, `exec.output_page`, `environment.read`, `environment.set`, `process.*`, `sidecars.*`, the `process_event` event; `app.request mcpServer/tool/call` |
| `pty` | `terminal.pty` (a writable pane also needs `fs.write`; `network: "loopback"` also needs `network`) |
| `history` | the `history` replacement |
| `outputs` | `tool_output` observers |
| `fs.read` | `workspace.read`, `workspace.list`, `workspace.stat`, read-only `workspace.check_access`, `workspace.snapshot`, `workspace.fingerprint`, `workspace.watch`, the `workspace_change` event; `app.request fuzzyFileSearch*` |
| `fs.write` | write-mode `workspace.check_access`, `workspace.transaction`, `workspace.backup`, `workspace.restore`, `workspace.request_rename`, the `workspace_pre_rename` event, `exec.run` with `write: true` |
| `network` | `exec.run`, `process.start` and `terminal.pty` with `network: "loopback"` |
| `unix_sockets` (experimental) | `exec.run` `unix_sockets` |
| `model` | `routes.list`, `routes.select`, `models.context_window`, `providers.*`, `ledger.settle`, the `routing` and `model_response` events |
| `agents` | `agents.*` (including `agents.inventory`), `api.agent`, `agent_offers` and `agent_spawn` interceptors, `model.complete`, `model.fork` (also needs `sessions` and `sessions_tools`), `task.status`, `workspace.integrate` |
| `store` | `store.*`, `evidence.write`, `evidence.read`, `api.state` |
| `sessions` | `sessions.list`, `sessions.read`, `sessions.snapshot`, `sessions.ports`, `turns.activity`, turn evidence on `turn_end` |
| `sessions_tools` | tool arguments and outputs in `sessions.read` records, `sessions.snapshot`, `model.fork` and `agents.spawn {parent_history}` (also needs `sessions`) |
| `contracts` | `api.contract`, `receipts.submit`, `task.complete`, `contract.status`, `contract.restrict`, `contract.select`, the `contract` event |
| `builtins` | `api.builtins`, `builtins.invoke`, `commands.invoke` |

### Terminal, thread and registration capabilities

These capabilities allow terminal, composer, thread, config, credential and package operations, and the registrations
a mod makes: tools, commands, interceptors, replacements, lifecycle events and services.

| Capability | Allows |
| --- | --- |
| `terminal` | the `terminal` event and `render` interceptors; `component_event`, `view`, `focus`; `terminal.notify`, `terminal.show_thread`, `commands.list`, `commands.describe`, `terminal.import_file`, `terminal.open`, `terminal.prompt`, `terminal.pane`, `terminal.panes`, `terminal.panel`, `terminal.notice`, `terminal.selection`, `terminal.copy`, `terminal.blit`, `terminal.image_sample`; the `component_change` interceptor |
| `threads` | `app.request` for the `threads` methods, the `app_notification` event, `turns.abort` |
| `config` | `app.request` for the `config` methods, `config.describe`, `config_list` interceptors, the `config_change` event |
| `config.write` | `app.request` for the `config.write` methods, `config.set`, `config_set` interceptors |
| `inventory` | `app.request` for the `inventory` methods, `app.routes`, `session.info`, `tools.list` |
| `account` | `app.request` for the `account` methods; lists ChatGPT workspaces (`accountSession/list`) and, from user actions only, switches them (`accountSession/switch`, confirmed natively on every call; browser sign-in stays native) |
| `approvals` | the `approval` middleware (which also needs `middleware`) and `approval_result`; `app_server_request` and `app.respond`; the `elicitation` interceptor and `elicitation_result` |
| `events` | `events.publish`, `events.schedule`, `events.cancel`, `time.sleep`, the `channel` and `timer` events |
| `credentials` | `credentials.list`, `credentials.request` |
| `composer` | `composer.read`, `composer.write`, `composer.suggest`, `prompts.*`, the `composer` event, the `composer_edit` and `composer_key` interceptors, `api.completion` and the `completion` replacement |
| `packages` | `packages.list`, `packages.index`, `packages.preview`, `packages.apply`, `packages.reload`, `routes.add`, `routes.write`, `settings.write` for another mod |
| `tools` | `api.tool`, `api.dynamicTools`, `tools.define`, `tools.undefine`, `tool_specs` interceptors |
| `interception` | `tool` interceptors, `tools.invoke`, `tools.check`, `tools.original` (`tool_original_v1`) and the `tool_batch` replacement |
| `input` | `input` and `mention` interceptors |
| `middleware` | `host_operation`, `model_request`, `response_stream` and `model_send` interceptors and the middleware events |
| `commands` | `api.command`, `command_list` and `command` interceptors, `settings.write` for the mod itself |
| `context` | the `context` replacement and the `context` event |
| `lifecycle` | the lifecycle events: `start`, `idle`, `stop`, `resume`, `tool_result`, `turn_start`, `turn_end`, `compaction_start`, `compaction_end`, `agent_end`, `tool_batch_end`, `instructions_loaded`, `thread_settings`, `worktree`, `mods_changed` |
| `compaction` | the `compaction` replacement, the `compaction` event and the `compaction` interceptor |
| `services` | `api.provide` and `api.services.call` |
| `virtual_reads` | `api.virtualRead` |

### Authority grant capabilities

Every capability in this table except `request_policy` is an authority grant. The manifest declares each grant's
scope. [Unrestricted processes and delegated approvals](reference/authority-grants.md#unrestricted-processes-and-delegated-approvals)
and [Structured access](reference/authority-grants.md#structured-access-structured_access_v1) describe how the grants are bound
and ended.

| Capability | Allows |
| --- | --- |
| `os` | `sandbox: "none"` on `exec.run`, `process.start` and `terminal.pty` start (`unrestricted_process_v1`) |
| `approve` | `{approve}` from the `approval` middleware inside the manifest's `approves` scope (`delegated_approval_v1`) |
| `approve.override` (experimental) | delegated approval of commands the user's own execpolicy rules forbid |
| `http` | `http.request`, `http.open`, `http.read`, `http.close` to the manifest's `http_access` origins (`structured_access_v1`) |
| `fs.external` (experimental) | `root` on `workspace.read`, `workspace.list`, `workspace.stat` and `workspace.transaction` for the manifest's `fs_access` roots |
| `mcp` (experimental) | `mcp.connect`, `mcp.disconnect` for the manifest's `mcp_servers` |
| `policy` | `admission` interceptors and namespace withholding inside the manifest's `policy.namespaces` (`admission_api_policy_v1`) |
| `request_policy` | a declared [final-request policy](reference/final-request-policy.md#declared-policies-request_policy) (needs `middleware`; `final_request_policy_v1`) |
| `peers` (experimental) | `peers.list`, `peers.send`, `peer_send` and `peer_receive` interceptors, the `peer_message` and `peer_receipt` events, within the manifest's `peer_access` (`peer_sessions_v1`) |
| `power` (experimental) | `power.hold` and `power.release`; lid-closed holds need the deployed [authority broker](reference/protected-authority.md) (`power_hold_v1`) |
| `autonomous` (experimental) | `turns.queue`, `turns.queued`, `turns.dequeue`, `turn_stop` interceptors and the `turn_queue` event, within the manifest's `autonomy` limits (`autonomous_turns_v1`) |
| `history_write` (experimental) | [`app.request thread/rewrite`](reference/history.md#durable-transcript-rewriting-history_rewrite_v1) on the current thread and threads the mod started (`history_rewrite_v1`) |
| `history_persist` | [`history_persist` interceptors](reference/history.md#store-time-history-rewriting-history_persist_v1), which see and may replace every stored history text (`history_persist_v1`) |

With `request_policy`, the host refuses every model request except web search unless the mod's required `model_send`
interceptor serves it. The grant exposure text shows `request_policy`, but it isn't an authority grant and doesn't
expire.

#### Who can issue or widen a grant

Two parties can issue a grant or widen its capabilities or scope:

- The user, by trusting the package's exact content and scope. The user trusts in the TUI trust dialog, with
  `omd-mod trust` or `trust-all`, or through the [`trust` entry](reference/packaging.md#package-requests) of an install or
  update they confirm. With the [authority broker](reference/protected-authority.md#authenticating-changes) deployed, the
  broker authenticates each change.
- An administrator, through a [managed `packages` entry](reference/administrator-policy.md#managed-packages-entries): the policy
  is the grant.

A package's install scripts, rendering, services, dependencies and model text can't issue or widen a grant.

#### Authority errors

| Error | When |
| --- | --- |
| `capability_denied: NAME` | A call or registration needs a capability the package wasn't trusted with. |
| `grant_expired: NAME` | An authority grant passed its `--expires` time or was revoked. |
| `capability_withheld: NAMESPACE` | An [admission policy](reference/admission-and-interception.md#admission-and-api-policy-admission_api_policy_v1) withheld the namespace. |
| `managed_capability_denied` | An [administrator policy](reference/administrator-policy.md#policy-controls-and-refusals) `capabilities` list withholds the capability. |
| `grant_not_brokered` | The broker doesn't store the same grant for the selection ([Protected authority](reference/protected-authority.md#what-the-broker-protects)). |
| `invalid_os_access`, `invalid_approves`, `invalid_http_access`, `invalid_fs_access`, `invalid_mcp_servers` | The manifest declares an authority grant without its scope field or prerequisites ([Authority grants](reference/authority-grants.md)). |

### Capability by operation

This table lists every host operation in the
[conformance registry](https://github.com/dzkchen/oh-my-diff/blob/main/mods/conformance/contract.json), the capability
it needs and its registry status. An operation marked experimental may change in any release; see
[Stability and migration](reference/stability-and-migration.md).

| Operation | Capability | Status |
| --- | --- | --- |
| `agents.cancel` | `agents` | frozen |
| `agents.inventory` | `agents` | frozen; experimental fields: `provider`, `model`, `billing` |
| `agents.list` | `agents` | experimental |
| `agents.message` | `agents` | experimental |
| `agents.result` | `agents` | frozen |
| `agents.spawn` | `agents`; `parent_history` also needs `sessions` and `sessions_tools` | frozen; experimental fields: `model` |
| `agents.wait` | `agents` | frozen |
| `app.request` | `threads`, `config`, `config.write`, `inventory` or `account` by method class; `exec` for `mcpServer/tool/call`; `fs.read` for `fuzzyFileSearch*`; `history_write` for `thread/rewrite` | frozen |
| `app.respond` | `approvals` | frozen |
| `app.routes` | `inventory` | experimental |
| `builtins.invoke` | `builtins` | experimental |
| `commands.describe` | `terminal` | experimental |
| `commands.invoke` | `builtins` | frozen |
| `commands.list` | `terminal` | frozen |
| `composer.read` | `composer` | frozen |
| `composer.suggest` | `composer` | frozen |
| `composer.write` | `composer` | frozen |
| `config.describe` | `config` | experimental |
| `config.set` | `config.write` | experimental |
| `contract.restrict` | `contracts` | frozen |
| `contract.select` | `contracts` | frozen |
| `contract.status` | `contracts` | frozen |
| `credentials.list` | `credentials` | frozen |
| `credentials.request` | `credentials` | frozen |
| `environment.read` | `exec` | experimental |
| `environment.set` | `exec` | frozen |
| `events.cancel` | `events` | frozen |
| `events.publish` | `events` | frozen |
| `events.schedule` | `events` | frozen |
| `evidence.read` | `store` | frozen |
| `evidence.write` | `store` | frozen |
| `exec.output_page` | `exec` | experimental |
| `exec.run` | `exec`; `fs.write` for `write: true`; `network` for `network: "loopback"`; `unix_sockets` for `unix_sockets`; `os` for `sandbox: "none"` | frozen |
| `http.close` | `http` | experimental |
| `http.open` | `http` | experimental |
| `http.read` | `http` | experimental |
| `http.request` | `http` | frozen |
| `ledger.settle` | `model` | experimental |
| `mcp.connect` | `mcp` | experimental |
| `mcp.disconnect` | `mcp` | experimental |
| `model.complete` | `agents` | frozen |
| `model.fork` | `agents`, `sessions` and `sessions_tools` | experimental |
| `models.context_window` | `model` | experimental |
| `mods.service` | `services` (internal service transport; mods use `api.services.call`) | experimental |
| `packages.apply` | `packages` | frozen |
| `packages.index` | `packages` | frozen |
| `packages.list` | `packages` | frozen |
| `packages.preview` | `packages` | frozen |
| `packages.reload` | `packages` | frozen |
| `peers.list` | `peers` | experimental |
| `peers.send` | `peers` | experimental |
| `power.hold` | `power` | experimental |
| `power.release` | `power` | experimental |
| `process.exchange` | `exec` | frozen |
| `process.start` | `exec`; `network` for `network: "loopback"`; `os` for `sandbox: "none"` | frozen |
| `process.status` | `exec` | frozen |
| `process.stop` | `exec` | frozen |
| `process.which` | `exec` | frozen |
| `prompts.consent` | `composer` | experimental |
| `prompts.revoke` | `composer` | experimental |
| `prompts.status` | `composer` | experimental |
| `prompts.submit` | `composer` | experimental |
| `providers.models` | `model` | frozen |
| `providers.register` | `model` | frozen |
| `providers.unregister` | `model` | frozen |
| `receipts.submit` | `contracts` | frozen |
| `routes.add` | `packages` | frozen |
| `routes.list` | `model` | frozen; experimental fields: `data` |
| `routes.select` | `model` | frozen |
| `routes.write` | `packages` | experimental |
| `session.info` | `inventory` | frozen; experimental fields: `process_id`, `omd_version` |
| `sessions.list` | `sessions` | frozen |
| `sessions.ports` | `sessions` | frozen |
| `sessions.read` | `sessions`; tool arguments and outputs need `sessions_tools` | frozen |
| `sessions.snapshot` | `sessions` and `sessions_tools` | frozen |
| `settings.write` | `commands` for the mod itself; `packages` for another mod | frozen |
| `sidecars.invoke` | `exec` | frozen |
| `sidecars.start` | `exec` | frozen |
| `sidecars.status` | `exec` | frozen; experimental fields: `started_at_ms` |
| `sidecars.stop` | `exec` | experimental |
| `store.delete` | `store` | frozen |
| `store.export` | `store` | experimental |
| `store.get` | `store` | frozen |
| `store.list` | `store` | experimental |
| `store.put` | `store` | frozen |
| `store.reset` | `store` | experimental |
| `task.complete` | `contracts` | frozen |
| `task.status` | `agents` | frozen |
| `terminal.blit` | `terminal` | experimental |
| `terminal.copy` | `terminal` | frozen |
| `terminal.image_sample` | `terminal` | experimental |
| `terminal.import_file` | `terminal` | frozen |
| `terminal.notice` | `terminal` | frozen |
| `terminal.notify` | `terminal` | frozen |
| `terminal.open` | `terminal` | frozen |
| `terminal.pane` | `terminal` | frozen |
| `terminal.panel` | `terminal` | frozen; experimental fields: `group`, `keywords`, `detail`, `query`, `selected`, `close_args` |
| `terminal.panes` | `terminal` | experimental |
| `terminal.prompt` | `terminal` | frozen |
| `terminal.pty` | `pty` (a writable pane also needs `fs.write`; `network: "loopback"` also needs `network`); `os` for `sandbox: "none"` | frozen |
| `terminal.selection` | `terminal` | frozen |
| `terminal.show_thread` | `terminal` | frozen |
| `time.sleep` | `events` | experimental |
| `tools.check` | `interception` | frozen |
| `tools.define` | `tools` | frozen |
| `tools.invoke` | `interception` | experimental |
| `tools.list` | `inventory` | experimental |
| `tools.original` | `interception` | experimental |
| `tools.undefine` | `tools` | experimental |
| `turns.abort` | `threads` | frozen |
| `turns.activity` | `sessions` | frozen |
| `turns.dequeue` | `autonomous` | experimental |
| `turns.queue` | `autonomous` | experimental |
| `turns.queued` | `autonomous` | experimental |
| `workspace.backup` | `fs.write` | frozen |
| `workspace.check_access` | `fs.read` (read-only); `fs.write` (write mode) | experimental |
| `workspace.fingerprint` | `fs.read` | frozen |
| `workspace.integrate` | `agents` | frozen |
| `workspace.list` | `fs.read`; `fs.external` for `root` | frozen |
| `workspace.read` | `fs.read`; `fs.external` for `root` | frozen |
| `workspace.request_rename` | `fs.write` | frozen |
| `workspace.restore` | `fs.write` | frozen |
| `workspace.snapshot` | `fs.read` | frozen |
| `workspace.stat` | `fs.read`; `fs.external` for `root` | frozen |
| `workspace.transaction` | `fs.write`; `fs.external` for `root` | frozen |
| `workspace.unwatch` | `fs.read` | experimental |
| `workspace.watch` | `fs.read` | frozen; experimental fields: `key`, `git` |

## Authority grants

Use it when a mod needs authority beyond its sandbox: unsandboxed programs, delegated approvals, HTTP origins,
folders outside the workspace, MCP servers or environment variables. It covers the manifest fields that scope each
grant, the operations they allow and how a grant ends. The capability names are listed in
[Capabilities](reference/capabilities.md#authority-grant-capabilities), with
[who can issue or widen a grant](reference/capabilities.md#who-can-issue-or-widen-a-grant).

Entries are frozen in Mod API `1.0.0` unless marked experimental (see the
[registry table](reference/stability-and-migration.md#experimental-entries-in-the-registry)). Runs on Apple Silicon macOS.

### Which capabilities are authority grants

An authority grant is a capability whose scope the manifest declares and the trust digest binds, so changed content
or a wider scope needs a new trust. The authority grants are `os`, `approve`, `approve.override`, `http`,
`fs.external`, `mcp`, `policy`, `peers`, `power`, `autonomous`, `history_write` and `history_persist`. Of these,
`approve.override`, `fs.external`, `mcp`, `peers`, `power`, `autonomous` and `history_write` are experimental.

### Unrestricted processes and delegated approvals

`os` lets a mod run the programs its manifest lists outside the sandbox, and `approve` lets it answer approval
requests for the user.

#### `os_access` manifest field

`os_access: {programs, network?}` lists up to 32 programs that may run without the sandbox. `network` sets whether
those runs have external network access.

Requires the `os` and `exec` capabilities. `os` without `os_access`, or the reverse, fails with `invalid_os_access`.

- A program is `*`, a bare name resolved on `PATH` outside the repository, or an absolute path.
- A program inside the repository runs only when its absolute path is listed.
- With `network: false`, unsandboxed runs use a profile that denies IP networking only.
- Every unsandboxed `exec.run`, `process.start` and `terminal.pty` start asks once per mod and binary ("Run NAME for
  mod ID?") and again when the binary's hash changes, as after an upgrade. A callback outside a command waits for the
  answer.
- `exec.run`, `process.start` and `terminal.pty` share the pins in `program-pins.json` in the mod store. For headless
  runs, pin a binary ahead of time with `omd-mod trust-program STORE MOD_ID PROGRAM`. Headless, an unpinned run fails
  with `program_unconfirmed`, and the error names the resolved path to pass as PROGRAM. MOD_ID must be an active mod
  whose `os_access` lists the program.
- A declined prompt fails `exec_program_declined` or `process_program_declined`, and a terminal start returns
  `{status: 'declined'}`.
- Unsandboxed runs get the user's `HOME`, `USER`, `LOGNAME`, `SHELL`, locale and `SSH_AUTH_SOCK`, so `ssh`-based tools
  reach the user's SSH agent; the full environment is listed under
  [`exec.run` with `sandbox: "none"`](reference/running-commands.md#execrun-with-sandbox-none).

#### `approves` manifest field

`approves: {kinds, tools?, roots?, hosts?}` lists the request kinds a mod may approve (`exec`, `stdin`, `patch`,
`mcp_tool`, `network`) and optional scopes. Empty scopes are broad.

Requires the `approve`, `approvals` and `middleware` capabilities; `approve.override` also needs `approve`. `approve`
without `approves`, or the reverse, fails with `invalid_approves`.

| Scope | Meaning |
| --- | --- |
| `tools` | The tools the mod may approve; see below |
| `roots` | Absolute directories that must contain the command's working directory or every patched file after symlinks resolve (a dangling symlink never qualifies). |
| `hosts` | Match network hosts (`*.example.com`). |

`tools` matches:

- the command's program as written (the first word inside an `sh`, `bash` or `zsh` `-c`/`-lc` wrapper);
- `apply_patch` and `write_stdin`;
- `server/tool` of an MCP call.

Patterns may be `*` or `prefix*`. A bare name or `prefix*` also matches an absolute path that `PATH` resolves that
name to outside the repository, but never a same-named file elsewhere.

#### Ending and showing the grants

Three settings limit or end the authority grants:

- `omd-mod trust ... --expires SECONDS` ends the authority grants at that time.
- Project scope limits them to one repository.
- `omd-mod revoke STORE MOD_ID_OR_PACKAGE` disables the mod and drops its grant at once. Its capabilities and secret
  environment are cleared, and enabling it again needs a new trust or install.

Trust output, the TUI trust dialog and status state what the grant exposes. In status, `mods[].authority` lists
`os_access`, `approves`, `expires_at`, `current` and `exposure`.

An expired or revoked grant fails `os` calls with `grant_expired: os`, stops the mod's unsandboxed managed
processes and panes at the next reload or call, and turns its approvals into `ask`.

### Structured access (`structured_access_v1`)

`http`, `fs.external` and `mcp` give scoped access without an unrestricted child process. They are authority grants
like `os`:

- The trusted digest includes their manifest scope.
- `--expires`, project scope and `omd-mod revoke` end them.
- Status `mods[].authority` shows the scope.
- An expired or revoked grant fails calls with `grant_expired`.

#### `http_access` manifest field

`http_access: {origins, credentials?}` lists up to 32 origins and credential profile ids. An origin is
`scheme://host[:port]` (`http` or `https`) or `scheme://*.suffix` for subdomains.

Requires the `http` capability. `http` without `http_access`, or the reverse, fails with `invalid_http_access`.

#### `http.request`

```ts
http.request {url, method?, headers?, body? | body_base64?, credential?, timeout_ms?, max_bytes?, redirects?}
// → {status, url, headers, body | body_base64, truncated, bytes, redirects}
```

The body is text when it is UTF-8.

| Limit | Default | Maximum |
| --- | --- | --- |
| Timeout | 30 s | 120 s |
| Response | 64 KiB | 128 KiB |
| Request body | | 1 MiB |
| Request headers | | 32 in 8 KiB |

No hop-by-hop or proxy headers are allowed.

#### `http.request` redirects and credentials

- Redirects are followed only up to `redirects` (at most 5).
- Every hop is re-checked against the caller's current grant (`http_origin_denied`).
- 303 and POST 301/302 become GET.
- `authorization`, `cookie` and `x-api-key` are dropped across origins.
- `set-cookie` and authorization response headers read `[redacted]`.

`credential` names a granted profile whose token the host attaches as `Authorization: Bearer` only for the
profile's enrolled origin. A first request to another origin fails with `credential_origin_mismatch` and the mod
never sees the token. Credential profiles need an `https` enrollment origin.

The entry `owned` in `credentials` grants every secret the mod enrolled itself (`credentials.request {kind:
'secret'}`), whose ids aren't known when the manifest is written. Another mod's secret fails with
`credential_secret_not_owned`.

#### `http.open`, `http.read` and `http.close`

Experimental.

`http.open` returns the status and headers with a `handle`. `http.close` ends the stream.

`http.read {handle, max_bytes?, wait_ms?}` returns up to 64 KiB (`data` or `data_base64`, never splitting a UTF-8
character) and `done`, or `http_stream_busy` while another read of the handle runs.

- Dropping an in-flight read closes its stream and releases its slot; later reads return `http_stream_unavailable`.
- Busy reads do not renew idle time.
- A mod has at most four streams open, including concurrent successful opens; excess responses are discarded with
  `http_stream_limit`. Pending requests do not reserve slots.
- Streams close after 60 s idle and at reload, disable, revoke or expiry.
- Cancelling the callback aborts a request in flight (`host_operation_cancelled`); the deadline fails it with
  `http_timeout`.

#### `fs_access` manifest field

`fs_access: {roots: [{path, write?}]}` lists up to 16 absolute roots. Writes need `write: true`.

Requires the `fs.external` and `fs.read` capabilities, and `fs.write` for a root with `write: true`. `fs.external`
without `fs_access`, or the reverse, fails with `invalid_fs_access`.

`root` on `workspace.read`, `workspace.list`, `workspace.stat` and `workspace.transaction` resolves the paths under
that root with the workspace rules:

- relative paths without `..`;
- no symlinked components, opened without following links;
- expected versions on every transaction path (`stale expected version for ...`).

The root must be canonical (`fs_root_not_canonical`) and cannot overlap the workspace, mod stores, Codex home,
credential directories or the `host.json` protected and secret paths (`fs_root_protected`). External changes are
not workspace changes.

#### `mcp_servers` manifest field

The `mcp` capability, `mcp.connect` and `mcp.disconnect` are experimental.

`mcp_servers: {name: {command, args?} | {url, credential?}}` lists up to 8 servers.

Requires the `mcp` capability. `mcp` without `mcp_servers`, or the reverse, fails with `invalid_mcp_servers`.

- `mcp.connect {server}` adds `mod_<id>_<name>` to the mod's thread through the engine's own MCP refresh, subject
  to managed MCP requirements.
- Its tools appear as `mcp__mod_<id>_<name>__<tool>` and run through normal tool admission and approvals
  (`tools.invoke` from the mod).
- A `credential` is sent only to the server URL's origin.
- `mcp.disconnect` removes it; servers also end at reload, disable, revoke or expiry.
- Command servers run as the user outside the sandbox like any configured MCP server.

#### Access receipts

Each HTTP request, MCP change, external file operation and `environment.read`/`environment.set` leaves a receipt
with the mod, the operation, the time and any error, plus:

| Operation | Also records |
| --- | --- |
| `http.request`, `http.open` | The origin, the path without query or fragment, the method, the credential profile id, the status and redirects |
| `workspace.read`, `workspace.list`, `workspace.stat`, `workspace.transaction` with `root` | The root |
| `mcp.connect`, `mcp.disconnect` | The server |
| `environment.read` | The names |
| `environment.set` | The name and whether the call set or reset the override |

Receipts never contain bodies, headers or values. Status `access` lists the last 32, and calls the session runs are
also appended to its `mod-access.jsonl`.

Servers and remote hosts can still log what they receive.

#### `environment.read`

Experimental.

`environment.read {names}` (`exec`) returns `{values: {NAME: {set, value}}}` for up to 16 names the manifest lists
in `exec_environment`.

- Secret-like names (`*KEY*`, `*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `AWS_*`, ...) report only `{set}`.
- A value over 4,096 bytes reads as `{set: false, value: null}`; read larger values from `exec.run {program:
  'env'}` output.
- Per-child values go in `exec.run` `env` and `process.start` `environment`, also limited to declared names.
  Nothing changes the host process environment.

#### `environment.set`

`environment.set {name, value}` (`exec`) sets an override for later `environment.read`, `exec.run` and
`process.start` calls. The override is local to the caller, its source and the thread. `value: null` removes the
override, restores the inherited value and frees its slot. The package must list host feature
`environment_overrides_v1` in `required_features`.

- Names must be declared and non-reserved. A secret-like name also needs explicit trust, bound to the package hash, and
  a read reports only whether it is set.
- Values are at most 4096 bytes without NUL, with 16 names and 16 KiB total per scope.
- Overrides and explicit per-call values (`exec.run` `env`, `process.start` `environment`) are validated separately.
  Managed processes allow 8 explicit names and 1024 bytes per explicit value. An explicit per-call value wins over an
  override.
- Overrides end on unload, source replacement or session end; they do not change providers, sidecars or existing
  processes.
- Receipts contain the name and override/reset action, never the value.

#### `exec_environment` names

A manifest may list up to 16 `exec_environment` names that `exec.run` passes through from the host environment. The
host refuses these names:

- `PATH`, `HOME` and `TMPDIR`;
- shell, loader and interpreter variables;
- names with the prefix `DYLD_`, `LD_`, `OMD_`, `CODEX_`, `SSH_`, `GPG_` or `GIT_CONFIG`.

## Admission and interception

Use it when a policy mod controls which other packages load, withholds host namespaces from them, or watches and
intercepts other mods' host operations. The interceptor chain itself (order, `required`, `next`) is described in
[Interceptors](reference/interceptors.md#apiintercept).

Entries are frozen in Mod API `1.0.0` unless marked experimental (see the
[registry table](reference/stability-and-migration.md#experimental-entries-in-the-registry)). Runs on Apple Silicon macOS.

### Admission and API policy (`admission_api_policy_v1`)

A policy mod controls which other packages load. It needs the `policy` authority grant, declared in the manifest as
`policy: {namespaces}` (up to 16 patterns, `*` wildcards). At every reload, after the native trust, digest and
dependency checks, the host passes each other active package to the `admission` interceptors with this input:

```ts
{package: {id, version, sha256, source, scope, capabilities, dependencies, requires, services, registrations, source_use},
 reason: 'load'}
```

`source_use` is what the package's source calls.

An `admission` interceptor answers in one of three ways:

- `next(e)` admits the package.
- `{deny: reason}` refuses it (`admission_denied`, listed in status `rejected`). Packages that depend on or require a
  refused package, or import a service only it provides, are refused with `dependency_not_admitted`.
- `{withhold: [namespace]}` admits the package without those host namespaces; its calls there fail with
  `capability_withheld: <namespace>`. A namespace is an operation's prefix (`exec`, `workspace`, `http`, `agents`,
  ...) or `service:<name>/<method>` for a service call. Each withheld namespace must match a pattern in the
  `policy.namespaces` of the policy mods, or the decision fails with `admission_policy_invalid`.

#### Admission rules

Admission runs without host operations. An outer handler may only tighten the decision beneath it, so an ordinary
handler cannot undo a required one.

- Policy mods and their dependencies are never judged and cannot judge themselves.
- Decisions are cached by the package and policy digests, so changed content is judged again.
- A failing, timed-out or faulted required admission interceptor refuses every judged package with
  `admission_policy_unavailable`. Disabling or reloading the policy mod in `/omd` (or with `omd-mod
  disable`) restores the refused packages. An expired or revoked `policy` grant stops judging.
- The `policy` grant gives a policy mod no authority of its own. It cannot add capabilities, issue or widen grants,
  change broker or managed policy, or reach authority operations, which are not host operations.
- Approving a command that the user's own execpolicy rules forbid needs the `approve.override` grant (see
  [forbidden commands](reference/app-bridge-and-approvals.md#forbidden-commands-and-non-delegable-requests)). Managed rules are
  never overridable.

### `host_operation` interceptors

Host and service calls are intercepted with `api.intercept('host_operation')` (`middleware`). Inputs contain
`{operation, namespace, arguments}`, so `match: {namespace: 'http'}` or `{namespace: /^service:/}` selects by
namespace.

`next.origin` names the actual `caller`, the service `provider` when a provider makes the call on someone's behalf,
and the caller `chain`; the host sets them and a mod cannot.

Interception covers every host operation and service call, including nested provider calls, with two exceptions:

- calls made inside an interceptor callback;
- `sessions.*` and `evidence.*` calls.

Pure SDK functions and local rendering are not host operations, so they are never intercepted.

### `host_operation` middleware event

Experimental.

The `host_operation` middleware event (`middleware`) reports every other mod's host call as `{phase, caller,
operation}` plus `arguments` before, and `result` or `error` after.

For `store.*`, `environment.read`, `credentials.*`, `http.*`, `exec.*`, `sessions.*` and `evidence.*` the
`arguments` and `result` are `null` and an error is `private_operation_failed`; the operation, caller and whether
it failed stay visible. Other operations are shown in full.

Masking applies to the event only: a `host_operation` interceptor still receives the `arguments` and answer of the
calls it matches, except `sessions.*` and `evidence.*`, which are never intercepted.

Because a `host_operation` interceptor sees unmasked arguments and answers, trust, install and status list
`middleware` in the grant exposure text. `middleware` is not an authority grant, so it doesn't expire.

## Interceptors

Use it when a mod wraps an operation with `api.intercept`: the surfaces it can select, what a handler may change,
how `next`, retries, ordering and failures work, and what the host records. The input of each surface is described
on the page of the operation it wraps; [Every interceptor surface](#every-interceptor-surface) links to it.

Entries are frozen in Mod API `1.0.0` unless marked experimental (see the
[registry table](reference/stability-and-migration.md#experimental-entries-in-the-registry)). Runs on Apple Silicon macOS.

### Registration, chain and failure rules

Every interceptor surface uses the same registration, chain and failure rules. Host features
`continuation_middleware_v1` and `tool_continuation_v2` provide them.

#### `api.intercept`

`api.intercept(pattern, [options,] (e, next) => result)` wraps an operation. `pattern` is a surface name, `*`, a
`*` glob or a `!` negation, and selects only surfaces the package's capabilities entitle. The capability each of
the 25 surfaces needs is in [Every interceptor surface](#every-interceptor-surface).

Options are `match`, `required` and `before`/`after` (mod ids).

A mod registers up to 16 interceptors during activation. `intercept` returns a registration whose `.catch(handler)`
sets a fallback handler.

Interceptors call host operations under their own grants with lifecycle-event access, including `terminal.prompt`.

#### `match` option

In `match`:

- a scalar matches by `===`;
- a RegExp tests a scalar as a string;
- an array matches when any of its elements matches, and against an array value it matches any element of that value;
- an object matches part of an object.

`match` is checked against the input each interceptor actually receives, so a rewrite by an outer interceptor
reaches every inner interceptor whose `match` fits the new input.

#### Surfaces and what a handler may change

`e` is a frozen copy of the effective input, and `await next(e2)` runs the rest of the chain and then the native
executor. Only the listed fields may change (surfaces not listed here are described on the page in
[Every interceptor surface](#every-interceptor-surface)):

| Surface | Replaceable | `next` resolves to | A handler may return |
| --- | --- | --- | --- |
| `tool` | `tool`, `arguments` (see [Tool inputs and answers](reference/tools.md#tool-inputs-and-answers)) | `{output, success, truncated, bytes}` | that result, a changed `{output, success}` (limits below), an answer without calling `next`, or `{deny}` |
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
| `render` | `props` keys the native drawing reads (see [Render hooks](reference/render-hooks.md#render-hooks-render_hooks_v1)) | `{tree}` | a `{tree}` of presentation components containing `{type: 'native'}` at most once, with or without calling `next` |
| `composer_key` (experimental) | `key` (one printable character or a mod key name) | `{key}` | `{key}` with or without calling `next`, or `{deny}` to drop the key |
| `mention` (experimental) | `path` | `{path}` | `{path}` with or without calling `next`, or `{deny}` to skip the read |

A changed `tool` output is at most 256 KiB. The model sees at most 64 KiB of it, or the original's length if that is
larger. The host drops a longer replacement with a diagnostic, and the original stands.

A `{deny}` refuses only before the native executor runs. On the `command`, `config_set`, `peer_send` and
`agent_spawn` surfaces, a `{deny}` after `next` has run is an invalid result. For an ordinary handler, the inner
result stands. A required handler fails.

#### The `next` object and retries

`next` also has these fields:

- `event`;
- `origin`, set by the host: `caller` is `model`, `code_mode` (with `cell_id`), `user`, `engine` or the calling mod,
  plus thread, agent and call ids;
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

#### Interceptor order

Ordinary interceptors wrap required ones, so required interceptors see the final effective input. Within each tier
the order is:

1. explicit `before`/`after`;
2. consumers outside their dependencies;
3. mod id;
4. registration order.

A cycle disables the mods that declared its edges with `interceptor_order_conflict` (a mod it only names stays
loaded). Naming one mod in both `before` and `after` is an invalid registration.

A mod never intercepts its own host calls, and host calls made inside an interceptor are not intercepted. A tool
call a mod starts with `tools.invoke` passes through every other mod's interceptors with that mod as
`origin.caller`.

#### Handler failures and skipped interceptors

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

#### Chain status and offline scenarios

The host keeps the last 16 chains in status `chains` with bounded inputs and results (values over 2 KiB become a
sha256 and byte count). Each trace entry names the mod, `location`, `outcome` (`returned`, `passed`, `skipped`,
`kept`, `caught` or `rejected`), attempts, own time and bounded inputs and results. Model-request chains are also
appended to the session's `mod-middleware.jsonl`.

In an [offline scenario](reference/authoring.md#offline-scenarios) (`omd-mod test`), the step
`{"type":"intercept","surface":"tool","payload":{...},"core":[{"value":...}]}` runs a chain against queued engine
results (`{"error":...}` rejects) and returns it without timings.

#### Terminal chain budget

The `composer_edit`, `composer_key` and `component_change` chains run while the terminal applies an edit, a key or a
focus or scroll change.

- The whole chain gets 50 ms, including any wait for a runtime busy with another callback.
- Handlers get no host operations.
- When the budget runs out, the terminal goes on without the chain's result: a native fill or the original key
  applies, a focus or scroll change applies unchanged, and a mod write to the composer is refused with
  `mod_runtime_busy`.

What each surface does on timeout is on its page: [`composer_edit`](reference/commands-and-composer.md#composer_edit-interceptor),
[`composer_key`](reference/commands-and-composer.md#composer_key-interceptor) and
[`component_change`](reference/terminal-input.md#component_change-interceptor).

### Every interceptor surface

`InterceptSurfaces` in [`api.d.ts`](api.d.ts) lists 25 surfaces. Each row gives the capability that entitles
it, its status in the conformance registry and the page that describes its input and what a handler may return.
A surface marked experimental may change in any release ([Stability and migration](reference/stability-and-migration.md)).

| Surface | Capability | Status | Input, result and answer |
| --- | --- | --- | --- |
| `tool` | `interception` | frozen; experimental fields: `value`, `bytes` | [Tools](reference/tools.md#tool-inputs-and-answers) |
| `tool_specs` | `tools` | frozen | [Tools](reference/tools.md#intercepttool_specs) |
| `host_operation` | `middleware` | frozen | [Admission and interception](reference/admission-and-interception.md#host_operation-interceptors) |
| `admission` | `policy` | frozen | [Admission and interception](reference/admission-and-interception.md#admission-and-api-policy-admission_api_policy_v1) |
| `command_list` | `commands` | frozen | [Commands and composer](reference/commands-and-composer.md#command-and-configuration-interceptor-surfaces) |
| `command` | `commands` | frozen | [Commands and composer](reference/commands-and-composer.md#command-and-configuration-interceptor-surfaces) |
| `config_list` | `config` | frozen | [Commands and composer](reference/commands-and-composer.md#command-and-configuration-interceptor-surfaces) |
| `config_set` | `config.write` | frozen | [Commands and composer](reference/commands-and-composer.md#command-and-configuration-interceptor-surfaces) |
| `input` | `input` | frozen | [Commands and composer](reference/commands-and-composer.md#submitted-drafts-and-prompt_expanded) |
| `composer_edit` | `composer` | frozen | [Commands and composer](reference/commands-and-composer.md#composer_edit-interceptor) |
| `composer_key` | `composer` | experimental | [Commands and composer](reference/commands-and-composer.md#composer_key-interceptor) |
| `mention` | `input` | experimental | [Commands and composer](reference/commands-and-composer.md#mention-interceptor) |
| `model_request` | `middleware` | frozen | [Model requests and streams](reference/model-requests.md#model_request-input) |
| `response_stream` | `middleware` | frozen | [Model requests and streams](reference/model-requests.md#response_stream-chunks) |
| `model_send` | `middleware` | frozen | [Final-request policy](reference/final-request-policy.md#model_send-input-pages) |
| `compaction` | `compaction` | experimental | [History and compaction](reference/history.md#compaction-interception-compaction_intercept_v1) |
| `history_persist` | `history_persist` | frozen | [History and compaction](reference/history.md#store-time-history-rewriting-history_persist_v1) |
| `render` | `terminal` | frozen | [Render hooks](reference/render-hooks.md#render-interceptor-and-hook-results) |
| `component_change` | `terminal` | experimental | [Terminal input](reference/terminal-input.md#component_change-interceptor) |
| `agent_offers` | `agents` | experimental | [Agents](reference/agents.md#agent-definitions) |
| `agent_spawn` | `agents` | experimental | [Agents](reference/agents.md#agent_spawn-interceptors) |
| `peer_send` | `peers` | experimental | [Peers, power holds and mod-started turns](reference/sessions-and-turns.md#peer-message-authentication-and-delivery) |
| `peer_receive` | `peers` | experimental | [Peers, power holds and mod-started turns](reference/sessions-and-turns.md#peer-message-authentication-and-delivery) |
| `turn_stop` | `autonomous` | experimental | [Peers, power holds and mod-started turns](reference/sessions-and-turns.md#turn_stop-interceptors) |
| `elicitation` | `approvals` | experimental | [Events and lifecycle](reference/events-and-lifecycle.md#elicitation-interceptor) |

### Example: guard one tool

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

## Tools

Use it when a mod runs or checks a model-visible tool, keeps a tool's complete output, adds feedback to tool
output, merges a batch of calls, shapes the model's tool list or defines tools at run time. How a `tool`
interceptor chain runs is in [Interceptors](reference/interceptors.md); the tool-specific inputs and answers are below.

Mod API `1.0.0`: the `tool` and `tool_specs` interceptors, `tools.check` and `tools.define` are frozen;
`tools.invoke`, `tools.original`, `tools.list`, `tools.undefine` and the fields marked below are experimental.
Platform: Apple Silicon macOS.

### Tool calls through interceptors

Every model-visible tool call passes the `tool` interceptor chain before it runs. The host checks a rewritten call
against the tool's schema and can report a digest of each result.

#### Tool inputs and answers

Tool inputs also contain `call_id`, `thread_id`, `agent_id`, `schema`, `raw_arguments` and `batch`. `arguments` is an
object for function tools and the raw string for freeform tools such as `apply_patch`, and a rewrite keeps that
shape.

- Native, MCP (retarget by the model-visible name, such as `mcp__server__tool`), mod, subagent,
  [code-mode](reference/glossary.md#sessions-and-models) and batched calls all pass through the same chain with their
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

#### Argument validation after a rewrite

When a `tool` interceptor rewrote a call, or a `tool_specs` interceptor replaced the tool's `parameters`, the host
validates the call's final arguments against the tool's original schema before dispatch. It checks `type`,
`properties`, `required`, `items`, `enum`, `anyOf` and `additionalProperties`; other keywords are not checked.

A mismatch refuses the call with `tool_arguments_invalid: <tool>: <json-pointer>: <reason>`, with `/` for the root.
Freeform tools and tools without a schema are not validated.

#### Result digests on `tool_result`

Host feature `tool_result_fingerprints_v1` adds observe-only `thread_id`, `call_sha256`, `result_sha256` and
`result_complete` fields on `tool_result`. The result digest covers the accepted model-visible output with a fixed
call id; blocked, failed, aborted and unavailable lifecycle results have no result digest. `answered_by` names the
mod that answered the call without running it.

### Running and checking tools

A mod can run a model-visible tool itself, ask what the host would decide about a call, and keep a call's complete
output.

#### `tools.invoke`

`tools.invoke {tool, arguments}` (experimental) runs a model-visible tool through the current turn's executor and
returns `{call_id, output, success, truncated}`. The call gets a new `mod-<id>-<n>` call id and its own
`tool_result`, and goes through interception, permissions, approvals, sandbox, accounting and cancellation.

Calls from `timer`, `channel`, `process_event` and `approval_result` wait for the turn's running tools like a model
call, so they never overlap a tool that is not parallel-safe. Failures and denials come back as `success: false`.

#### `tools.check`

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

#### Availability of `tools.invoke` and `tools.check`

Both operations need `interception` and a turn in progress in the thread (`tools_unavailable` otherwise). They work
from the turn's first model request until the turn ends: in interceptors, tool and output callbacks, and timers and
channel events that run meanwhile.

A tool interceptor can pause a call for a person with `terminal.prompt`. The wait does not count against its budget;
cancelling the call stops the wait, and a later answer is discarded.

#### `tools.original` (`tool_original_v1`)

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

### Tool output, feedback, batches and specs

These registrations change what the model sees: feedback after a tool's output, merged batches of calls, and the
tool list itself.

#### `tool_output` observers

`on('tool_output')` observers (`tool_feedback_v1`) return `{append}` of at most 4 KiB, 16 KiB per call in total,
added after any interceptor result at any output size.

- Handlers receive the first 256 KiB as `text`, the last 16 KiB as `tail` when the output is longer, and the total
  `bytes`.
- Image and audio items appear as `[image]` and `[audio]` markers.
- Tool-output callbacks may call every host operation their grants allow in lifecycle events, such as
  language-server exchanges or `model.complete`, before the model sees the result. The output waits for them.

#### `replace('tool_batch')`

`replace('tool_batch')` (`tool_batch_v1`) may merge parallel-safe calls of one response into one call of a tool the mod
registered.

- The merged call runs through ordinary tool admission and approvals.
- The merged tool returns an object keyed by call id whose values are the output text, and the host passes each
  value to its call.
- With `success_per_call: true` (`tool_batch_success_v1`, an experimental field), a value that is exactly
  `{output, success}` gives that call its output and its own success flag. Any other value is text.
- `tool` interceptors see the merged call with call id `<batch id>-merge-<index>` and that `batch` position.

#### `intercept('tool_specs')`

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

#### `tools.list`

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

#### Task-scoped tools and `tool_exposure`

`task_scoped: true` on `api.tool` and the experimental `tool_exposure` event (host feature `task_tool_exposure_v1`)
expose optional tools per task.

- Before each sampling step, the event receives the host `ledger`, thread id, and only the current mod's optional tool
  names. It returns `{enable: [...]}` for a subset of those names.
- A missing or failed decision exposes none of that mod's optional tools; an invalid or foreign name disables the mod
  with a visible error.
- Ordinary registered tools and every native tool keep their existing exposure. A tool still executes through native
  permission, cancellation, accounting, and workflow gates.
- A [`context` event](reference/events-and-lifecycle.md#context) handler can add a bounded subordinate fragment for the same
  task without replacing base instructions.
- In an offline scenario, `{"type":"tool_exposure", "payload": {...ledger...}}` records the exact names registered for
  that step.

### Dynamic tools (`dynamic_tools_v1`)

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

## App bridge and approvals

Use it when a mod sends app-server methods with `app.request`, answers a pending server request with
`app.respond`, or takes part in approvals through `approval` middleware. The capability each method class needs is
in [Capabilities](reference/capabilities.md); interceptors in general are in [Interceptors](reference/interceptors.md).

Entries are frozen in Mod API `1.0.0` unless marked experimental (see the
[registry table](reference/stability-and-migration.md#experimental-entries-in-the-registry)). Runs on Apple Silicon macOS.

### App-server bridge (`app_v1`)

A mod calls methods of the session's own Codex app-server (the TUI, `codex exec` or a headless `codex app-server`;
see [External clients](reference/external-clients.md)) through `app.request`, and answers server requests with `app.respond`.
Hosts without an app-server return `client_surface_unavailable`.

#### `app.request`

```text
app.request {method, params} → the method's result, or {status: 'declined'}
```

| Argument | Type | Meaning |
| --- | --- | --- |
| `method` | string | An app-server method that `app.routes` lists |
| `params` | JSON | The method's parameters, limited by the [parameter rules](#apprequest-parameter-rules) |

It returns the app-server's result, or `{status: 'declined'}` when the user declines a native confirmation. The
capability is the route's `class`.

This call from the `worktree_task` example starts a thread in a worktree folder:

```ts
const started = api.host.call('app.request', { method: 'thread/start', params: { cwd } }) as { thread?: { id?: string } };
```

| Error | When |
| --- | --- |
| `capability_denied: NAME` | The package lacks the route's `class` |
| `app_route_model_required` | `modelProvider` comes without `model` |
| `app_confirmation_too_large` | A confirmed request's parameters exceed 2,000 bytes |
| `app_config_value_redacted` | A config write contains `<redacted>` |
| `client_surface_unavailable` | The host has no app-server of its own |

#### `app.routes`

`app.routes` (capability `inventory`, experimental) returns one entry per method `app.request` accepts:

| Field | Meaning |
| --- | --- |
| `method` | The app-server method |
| `class` | The capability it needs, such as `threads`, `config.write`, `inventory` or `exec` |
| `contexts` | Where it may run: `user` commands, `event` callbacks or both |
| `confirm` | Whether each call asks for a native confirmation |

Each route also has a thread scope, which `app.routes` doesn't report; the thread rules are under
[parameter rules](#apprequest-parameter-rules).

#### `app.request` parameter rules

Each route lists the parameter fields it accepts; any other non-null field is refused. The host refuses authority
fields (approval policy, sandbox, permissions, config, roots, environments, dynamic tools, base instructions, service
tier) and any field a later upstream Codex version adds, until each is reviewed.

- `model` and `modelProvider` must name a configured route. Each must match a `host.json` lead route, and when both
  are given, they must match the same route. `modelProvider` needs `model` with it (`app_route_model_required`).
  `thread/settings/update {model, modelProvider}` moves the current thread to that provider from its next turn, as
  picking another provider's model in `/model` does.
- `thread/start` and `fuzzyFileSearch` roots must be the session root or one of its `git worktree list` entries.
- Thread-scoped methods reach the current thread and threads the mod itself started or forked. Their other thread
  ids (`beforeThreadId`) must name one of those.
- Local image and audio inputs must be `{resource}` references; raw paths are refused.

#### `thread/attachmentOwner/list`

`thread/attachmentOwner/list` searches the whole configured thread store across projects. Omitting `archived`
includes both archived and non-archived threads.

It requires `account`, a user action and native confirmation naming the mod and exact lookup parameters; event
callbacks cannot invoke it.

#### Contexts and native confirmations

- Turn-starting methods run only from [user contexts](reference/host-model.md#callback-contexts).
- `turn/steer` runs from events into a running turn.
- `mcpServer/tool/call` asks for a native confirmation on every call.
- A confirmation names the mod, the method and its exact parameters. A confirmed request whose parameters exceed
  2,000 bytes is refused (`app_confirmation_too_large`).

#### Config writes

Config writes accept only writable keys. They refuse a table that contains an authority key, such as `features` as a
whole, and check every leaf of a table value as its own key.

- Under the protected `mcp_servers` table only `mcp_servers.<name>.enabled` is writable.
- Plugin keys are limited to `plugins.<id>.enabled` and a plugin server's `enabled`, `enabled_tools` and
  `disabled_tools`.
- Config writes, `config.set` included, refuse any Codex value containing `<redacted>`
  (`app_config_value_redacted`), so a read value cannot be written back masked. Mod settings may contain the
  literal text.

#### `config/read` redaction

`config/read` replaces these values with `<redacted>` in its results:

- every value of a `*headers`, `env` or `query_params` table;
- `shell_environment_policy.set`;
- the `args` of anything with a `command` (MCP servers, also under profiles and plugins);
- every string whose key ends in a secret word (`*_token`, `*secret`, `password`, API keys; not
  `*_credentials_store`);
- a provider's `env_key` unless it is an upper-case variable name with an underscore (`OPENAI_API_KEY`);
- every line that looks like a credential (bearer tokens, key prefixes, private keys, user information in URLs; the
  other lines of multi-line text stay).

They also reduce an MCP server `url` or provider `base_url` to scheme, host and port: user information becomes
`<redacted>@`, and anything after the host becomes `/<redacted>`. This applies in the effective config and in each
layer. `hooks/list` applies the same line rule to hook `command` strings.

#### Excluded methods

`command/exec`, `process/*`, `fs/*`, `thread/shellCommand`, `thread/inject_items` and credential flows are
excluded.

#### App notifications and server requests

Declare `subscriptions.app` in the manifest to receive `app_notification` and `app_server_request` phases. For
`app_notification`, the host coalesces deltas and queues at most 256 events and 1 MiB per mod. It drops the oldest
and reports how many it dropped.

#### `app.respond` (`app_respond_v1`)

`app.respond {request_id, result}` (capability `approvals`) answers a pending server request as if the terminal
answered it. The mod must subscribe to the request's method, and the call runs from user or event contexts. The first
answer wins, and `serverRequest/resolved` closes the native confirmation.

`result` can never grant authority (`app_response_refused` otherwise):

- Command and file-change approvals take only `{decision: 'decline' | 'cancel'}`.
- Permission requests take only `{permissions: {}}`.
- MCP elicitations take only `{action: 'decline' | 'cancel'}`.
- `item/tool/requestUserInput` takes `{answers: {id: {answers: string[]}}}` (at most 16 questions of 16 answers,
  16,384 bytes).

Approving stays with the `approval` middleware and the `approve` grant; a question answer still reaches the model
as the user's reply.

| Error | When |
| --- | --- |
| `app_request_not_pending` | The request was already answered |
| `client_context_changed` | The call is bound to a thread the terminal is not showing |
| `client_surface_context_changed` | The call's terminal binding changed before it ran (another client surface attached, or the shown thread changed); retryable |

`app.respond` needs the terminal; headless hosts and `codex exec` refuse it, and it is never delegated to external
clients.

### Approvals (`approval_v1`)

Register approval middleware with `api.middleware('approval', handler)`. It needs the `approvals` and `middleware`
capabilities. It sees exec, patch, MCP, network and permission requests before hooks, automatic review and
full-access shortcuts, and returns `null`, `{deny}`, `{ask}` or `{approve}`.

#### How answers combine

1. Any deny rejects.
2. Then any `ask` forces the native confirmation, bypassing remembered session approvals.
3. Then an `{approve}` from a mod with a current `approve` grant whose `approves` scope covers the request (see
   [Unrestricted processes and delegated
   approvals](reference/authority-grants.md#unrestricted-processes-and-delegated-approvals)) runs it without a prompt. The host
   shows a native notice naming the mod and reports `approval_result` with source `mod`.

An approve outside the grant, an expired grant, an error, a timeout or an invalid result counts as `ask`.

#### Forbidden commands and non-delegable requests

- A command that the user's own execpolicy rules forbid reaches the middleware with `host_decision: 'forbidden'`.
  Only a mod with `approve.override` (experimental) can approve it; anything else keeps it forbidden.
- Managed requirements and other host denials never reach the middleware.
- `permissions` requests (`request_permissions`) are not delegable: `approves.kinds` can't list them, so a mod's
  `{approve}` counts as `ask`.
- An `exec` or `stdin` grant also covers requests of that kind that ask to leave the sandbox or widen it.
  `details.sandbox_permissions` (`use_default`, `require_escalated` or `with_additional_permissions`) and
  `details.additional_permissions` show what a request asks for; return `{ask}` to leave escalated ones to the user.
- `assessment: true` marks a `tools.check` assessment, which never runs or prompts.
- `approval_result` reports the decision and its source.

## Commands, configuration and composer

Use it when a mod adds or wraps slash commands, reads or writes configuration, removes built-in controls, or takes
part in the composer: `@` completion, drafts, suggestions, key interception and file mentions. `api.command`
itself is listed in [SDK helpers](reference/sdk-helpers.md#other-api-members) and its registration limits in
[Host model](reference/host-model.md#registration-limits).

Entries are frozen in Mod API `1.0.0` unless marked experimental (see the
[registry table](reference/stability-and-migration.md#experimental-entries-in-the-registry)). Composer and command operations
act on the OMD terminal session.

### Commands and configuration (`command_config_middleware_v1`)

A mod lists, describes and invokes slash commands, and reads and sets Codex configuration.

#### Command listing and description

```text
commands.list → {commands: CommandRow[]}
commands.describe {command} → CommandRow
```

Both need `terminal`. `commands.list` returns every built-in, service-tier and mod command the composer can offer;
`commands.describe` (experimental) returns the row for one `command`.

A `CommandRow` is `{command, description, owner, hidden, args_hint, immediate, protected}`:

| Field | Meaning |
| --- | --- |
| `command` | The command name. |
| `description` | The description shown in the popup. |
| `owner` | Names the mod, or is `null`. |
| `hidden` | Whether the command is hidden. |
| `args_hint` | Comes from `api.command(name, handler, {args_hint})` and shows beside the description in the popup. |
| `immediate` | Whether the command may run during a turn. |
| `protected` | Whether the row is protected (list below). |

- A mod command registered with `api.command(..., {immediate: false})` is refused while a turn runs
  (`command_unavailable_during_turn`). Built-ins report the engine's own rule.
- Protected rows (`/omd`, `/quit`, `/exit`, `/approvals`, `/permissions`, `/status`, `/logout`) keep recovery and
  authority reachable.

```ts
const commands = api.host.call('commands.list', null).commands.filter(item => !item.hidden);
```

That line is from [`command_help`](examples/command_help/index.ts).

#### `commands.invoke`

```text
commands.invoke {command, args?} → {command, result} | {status: 'declined'}
```

It needs `builtins` and runs from [user contexts](reference/host-model.md#callback-contexts). It runs a built-in or any mod
command.

| Argument | Meaning |
| --- | --- |
| `command` | The command name, with or without its leading `/` |
| `args` | The argument text |

`result` is a mod command's returned value, or `{invoked: true}` for a built-in, which the terminal dispatches with
the effective arguments. `{status: 'declined'}` means the user declined the confirmation.

- Another mod's command runs only after a native confirmation, since its handler runs with that mod's grants.
- A mod command's display, insert and submit outcomes still apply.

| Error | When |
| --- | --- |
| `command_unknown: NAME` | No command has that name |
| `command_invoke_refused: NAME` | The permissions, sandbox elevation, logout, quit, exit, feedback and test-approval built-ins |
| `command_recursion_limit` | Runs nest more than four deep |
| `command_unavailable_during_turn` | An `immediate: false` mod command while a turn runs |

```ts
api.host.tryCall('commands.invoke', { command: 'theme' });
```

That call is from [`omd_theme`](first-party/omd_theme/index.ts).

#### Command views

Command views are experimental. A command may return `{terminal: patch}` with a `TerminalPatch` to replace its mod's
complete terminal contribution, or `{terminal: null}` to clear it.

- The host checks capability, ownership and generation. It composes the patch with other owners' last valid
  contributions and displays it, then refreshes expired callbacks asynchronously.
- The result stands for at most one second, under
  [Reuse of `terminal` patches](reference/terminal-ui.md#reuse-of-terminal-patches). After that the mod's `terminal` handler
  draws the view, so it needs to rebuild the same contribution, for example from
  [`api.uiState`](reference/state-and-storage.md#session-ui-state-apiuistate).
- Other owners refresh at different times when a command returns a view. Commands without `terminal` keep their
  synchronous preview behavior.
- Moving a dialog from durable state to a command view moves only its transient presentation fields to
  `api.uiState`; persisted settings, replay and module lifetimes are unchanged.

#### `config.describe`

```text
config.describe → {rows: ConfigRow[]}
```

It needs `config` and is experimental. It returns each enabled mod's settings as `mods.<id>.<name>` rows, then the
host-writable Codex keys present in the effective config.

A `ConfigRow` is `{key, label, value, source, version, scope, editable, managed, secret, hidden}` plus `type` and
`enum` for mod settings:

| Field | Meaning |
| --- | --- |
| `source` | The config layer (`user`, `project`, `system`, `mdm`, ...). |
| `version` | The layer version. |
| `managed` | Marks managed layers. |

Secret keys and secret-bearing tables (headers, environment, tokens) show `<redacted>` and are never editable.

#### `config.set`

```text
config.set {key, value, expected?} → {key, effective} | {status: 'declined'}
```

It needs `config.write`, runs from user contexts and is experimental. It writes an `editable` row.

| Argument | Meaning |
| --- | --- |
| `key` | A `config.describe` row key |
| `value` | The new value |
| `expected` | The value read earlier; the write is refused if it changed |

It returns the key and its `effective` value, or `{status: 'declined'}` when the user declines the confirmation.

- Codex keys are written after a native confirmation through `config/value/write` with the described layer version,
  under the [config write rules](reference/app-bridge-and-approvals.md#config-writes).
- Mod settings are written through the same validation as [`settings.write`](reference/settings.md#settingswrite) (another mod's
  settings after a native confirmation).
- A concurrent Codex write fails with the server's version conflict.

| Error | When |
| --- | --- |
| `config_key_required`, `config_value_required` | `key` or `value` is missing |
| `config_key_unknown: KEY` | No row has that key |
| `config_not_editable: KEY` | The row isn't `editable` |
| `config_stale: KEY changed since it was read` | `expected` no longer matches |
| `config_set_denied: REASON` | A [`config_set` interceptor](#command-and-configuration-interceptor-surfaces) denied it |

Every successful `config.set` and `settings.write` change raises the experimental
`config_change {key, original, effective, source, scope, caller}` for the other mods registered for it.

#### Command and configuration interceptor surfaces

Four [interceptor](reference/interceptors.md#registration-chain-and-failure-rules) surfaces wrap the operations on this page:

- `command_list` (`commands`) and `config_list` (`config`) compose rows without host operations. A handler may hide,
  relabel (`description`, `label`) or hint (`args_hint`) ordinary rows, and a dropped ordinary row becomes hidden.
- On those two surfaces, protected, managed and secret rows can't change or be dropped, and no row can be added or
  renamed. A failing list chain keeps the native rows. Hidden commands leave the popup and the typed-command lookup.
- `command` (`commands`) wraps typed, popup and `commands.invoke` runs of built-in and mod commands: rewrite
  `args`, transform `{result}`, answer with `{result}` or refuse with `{deny}` (`command_denied: reason`).
  Protected built-ins never pass through it, so a broken required interceptor cannot lock out `/omd`.
- `config_set` (`config.write`) wraps `config.set` and `settings.write` per key: change `value` or `{deny}`
  (`config_set_denied: reason`); the host re-checks editability, managed floors and the writable-key allowlist
  after the chain.

Interceptors of these surfaces skip their own mod's calls like every other surface, which bounds recursion through
`commands.invoke` and `settings.write`.

### Built-in controls

`api.builtins({commands: {hide}, modes: {disable}, surfaces: {disable}, features: {remove}})` removes slash commands,
collaboration modes, native surfaces and Codex features. Call it during activation. The removal starts at the next idle
boundary and lasts until the mod is disabled, unloaded or fails. Controls apply to the directory OMD was launched in and
cover every thread of that session, including threads in its worktrees.

- `surfaces: {disable: ['status_line']}` turns off the upstream `/statusline` row at its source: its configured
  items are neither computed nor polled and reserve no height, the user's `tui.status_line` setting is untouched,
  and the row still draws when other mods publish `status` segments.
- `features: {remove: ['prevent_idle_sleep']}` (`builtins_features_v1`) takes Codex features out of the session:
  they read as off everywhere, whatever `config.toml` or `-c` sets, and they leave `/experimental`, the app-server's
  experimental feature list, `codex features list` and tips. Removing `code_mode` also removes `code_mode_only`.
  Nothing is written to `config.toml`; disabling the mod brings back the rows and the saved values. A feature that
  managed requirements pin on stays on. Keys must be Codex feature keys (`invalid_builtins` otherwise).
- `/quit`, `/exit`, `/approvals`, `/permissions`, `/status`, `/logout` and the default mode cannot be removed.
- A disabled mode is absent from `collaborationMode/list`. A thread that requests a disabled mode, or is still in one,
  is reported in the default mode. Its next turn runs in the default mode with the disabled mode's instructions
  cleared and a warning (a `warning` notification for app-server clients). This applies to the turn at whose boundary
  the mod loads too.
- Tools limited to collaboration modes lose the disabled ones and are not offered when none remain.

#### `builtins.invoke`, key bindings and command routing

`builtins.invoke {action}` (experimental) runs a key action from user contexts. It is refused (`builtins_view_active`)
while a dialog, popup, overlay or focused mod component would take the key, and `list.*` and the permission-mode actions
are never invoked (`keymap_action_refused`).

`api.builtins({keys, commands: {replace}})` overlays key bindings (never `approval.*`) and routes a built-in
command to a mod command; the slash popup lists the built-in with that command's description and arguments.

### Composer completion (`completion_v1`)

A mod can supply the completions for `@` mentions, command arguments and tokens.

#### `@` mention completion

`replace('completion')` receives each `@` mention query with up to 200 upstream candidates by default
(`completion_items` in [Host limits](reference/limits.md#host-limits)) and returns `{items: [{path}]}` in the order to show. Paths
must be workspace-relative. When no mod registers `replace('completion')`, the upstream ranking is used. Stale
results are dropped.

#### Command argument completion

While the user types arguments to a mod command (`completion_arguments_v1`), the mod that registered the command
receives `{kind: 'argument', command, query, line}` if it handles `completion` (with `api.on` or `replace`). Otherwise
the mod that registered `replace('completion')` receives it. The handler returns `{items: [{insert}]}` and the list
opens only when it has items.

Accepting an argument choice advances past a separator and keeps completion closed until the draft or cursor changes, so
the next Enter submits the command.

#### Token completion

`api.completion({trigger}, handler)` (capability `composer`, `completion_tokens_v1`, experimental) completes
arbitrary tokens. `trigger` is one ASCII punctuation character other than `@`, `/` and `$`, and a mod registers at
most four during activation.

While the token before the cursor (from the last whitespace) starts with the trigger, the handler receives
`{kind: 'token', trigger, query, line}` (`query` without the trigger, `line` up to the cursor) and returns
`{items: [{insert}]}` with the same limits, debounce and stale-result dropping as argument completion.

The host shows the rows in the composer's completion list and, on Tab or Enter, replaces the whole token with the
selected `insert` and advances past a separator so the accepted token does not immediately reopen completion. When
two mods register the same trigger, the first loaded mod keeps it and the other gets a status notice.

### Composer drafts and suggestions (`composer_v2`)

`composer.read`, `composer.write` and `composer.suggest` need `composer`.

#### `composer.read`

```text
composer.read → {text, cursor, selection, revision, attachments, suggestion}
```

`cursor` and `selection` (`{start, end}` or null) are byte offsets. `revision` advances whenever the draft's text or
attachments change, whoever changed them. `suggestion` is the shown suggestion's `{owner, id}`, or null.

Each attachment has:

- a stable `id`;
- its placeholder `label`;
- its `owner` (`user` or the mod that attached it);
- an image `resource` for PNG and JPEG images up to 8 MiB, otherwise `null`. The resource is immutable, bound to the
  reading mod, its source hash and the repository, and lasts as long as the package, across configuration revisions
  and thread forks;
- the image's `width` and `height` in pixels when its header decodes.

#### `composer.write`

```text
composer.write {revision, edit?, cursor?, selection?, attach?, detach?} → {text, cursor, revision}
```

| Argument | Meaning |
| --- | --- |
| `revision` | The draft revision the write applies to |
| `edit` | `{kind: 'fill' \| 'insert' \| 'append', text}` or `{kind: 'splice', start, end, text}`; `fill` replaces the draft, `insert` inserts at the cursor, and `splice` takes byte offsets on character boundaries |
| `cursor`, `selection` | Place the cursor or select `{start, end}` in the edited draft |
| `attach` | Image resources to add, as `[{image}]` |
| `detach` | Attachments to remove, by placeholder |

It returns the new draft text, cursor and revision. The complete edit, positions and detach list are validated
before the draft changes; rejected writes leave its content and attachments intact.

- Queued client calls stay bound to the thread they were accepted for, their source generation and their active
  authority, including after a confirmation.
- A write never submits.
- Images a mod attached leave the draft when that mod is unloaded, reloaded or disabled.

| Error | When |
| --- | --- |
| `stale_revision` | The draft has a newer revision |
| `composer_edit_invalid` | Another `edit.kind` |
| `composer_range_invalid` | A `splice` range is reversed or off a character boundary |
| `composer_cursor_invalid`, `composer_selection_invalid` | A position outside the edited draft or off a character boundary |
| `composer_detach_invalid` | A `detach` entry names no attachment |

```ts
const { revision } = api.host.call('composer.read', null);
api.host.call('composer.write', { revision, edit: { kind: 'insert', text: `${mention(path)} ` } });
```

That pair is from [`omd_lazygit`](first-party/omd_lazygit/index.ts).

#### `composer.suggest`

```text
composer.suggest {revision, id, text} → {shown: true}
composer.suggest {clear: true} → {cleared: true}
```

It shows one dimmed suggestion after the cursor while the cursor is at the end of that revision; a newer suggestion
replaces an older one. `id` is 1–128 bytes and `text` 1–4,096 bytes, of which the first line shows.

- The user accepts it with the move-right key at the end of the draft (so a remapped `editor.move_right` applies)
  or by clicking it, and dismisses it with Esc.
- Any draft change, a turn start, an open dialog or the owner's reload clears it.
- `{clear: true}` withdraws the caller's own.

| Error | When |
| --- | --- |
| `composer_suggest_arguments_invalid` | A missing field, or `id` or `text` outside its size |
| `composer_unavailable: a dialog is open` | A dialog, popup or other view replaces the composer |

```ts
api.host.tryCall('composer.suggest', {
  revision: draft.revision, id: `h${draft.revision}`, text: match.slice(draft.text.length),
});
```

That call is from [`ghost_history`](examples/ghost_history/index.ts).

#### `composer` event

The `composer` event (capability `composer`) reports two kinds of payload:

- `{kind: 'change', revision, attachments_revision, origin}` to every subscriber (`attachments_revision` advances
  only when the attached images change), debounced to 250 ms.
- `{kind: 'suggestion', id, status: 'accepted' | 'dismissed' | 'cleared', reason?}` to the suggestion's owner.

#### `composer_edit` interceptor

A policy or redaction `composer_edit` interceptor must be `required`, because a busy optional one lets a paste or fill
through unmodified.

`api.intercept('composer_edit', …)` sees every mod write and native fill before it reaches the draft:
`{source: 'mod' | 'paste' | 'history' | 'completion', caller, revision, edit}`.

- Handlers may change only `edit.text`, or answer `{deny}`, which leaves the draft unchanged and tells the user.
- Handlers run while the terminal applies the edit, so they get no host operations and run under the
  [terminal chain budget](reference/interceptors.md#terminal-chain-budget).
- When the budget runs out, a native fill applies unmodified with a status notice, and a mod write is refused with
  `mod_runtime_busy`.
- While a required interceptor selects `composer_edit`, a native fill is refused the same way.

#### `composer_key` interceptor

`api.intercept('composer_key', …)` (`composer_key_v1`, experimental) sees each key press or repeat that reaches the
prompt box, after mod key components, dialogs, chords and app key bindings and before popups and the editor keymap:
`{key, text, revision, cursor}`.

- A printable character without Ctrl or Alt is `key` and `text` as typed (`'a'`, `'#'`, `' '`).
- Any other key is its mod key name (`Ctrl+w`, `Enter`, `Shift+Tab`) with `text: null`.
- `text` is also `null` in vim normal mode, where characters are commands.

Handlers may set `key` to another character or to a key name valid in view `keybindings` or an unmodified named key
(`Left`, `Backspace`), which the composer then applies as if typed, or answer `{deny}` to drop the key silently.

- Paste bursts, bracketed paste and non-ASCII characters (IME) bypass the chain.
- Each keystroke gets the [terminal chain budget](reference/interceptors.md#terminal-chain-budget) and no host operations.
  When it runs out, or the result is invalid, the original key applies and a status notice shows.
- Use `match` on `key` so other keystrokes never start a callback.

#### Submitted drafts and `prompt_expanded`

The `input` interceptors also receive the submitted draft's `revision`, `attachments` (`{kind, source}`) and
placeholder `elements` (`{kind: 'paste' | 'mention' | 'skill' | 'image', start?, end?, name?, source}`).

After skills and mentions are expanded, the experimental `prompt_expanded` event (capability `middleware`) lists them by
name, path and SHA-256 only (`{kind: 'skill' | 'mention' | 'paste' | 'image', …}`), never their content, and the
`prompt` event's `effective` is the text the model receives.

### `@` file mentions (`mention_read_v1`)

The host reads the files a prompt mentions with `@` and a mod can intercept each read.

#### What the host reads

When a turn starts, the host reads each `@path` or `@"path with spaces"` of the submitted text that names an
existing workspace file, and gives the model its contents after the prompt as
`<mentioned_file><path>…</path>…</mentioned_file>`.

- At most 16 mentions are read per turn.
- A leading `./` and unquoted trailing punctuation are ignored.
- Quoted paths use JSON string escaping and preserve punctuation, quotes and backslashes. An `@` inside a quoted
  path is part of that path.
- Picking a file from the `@` list inserts it in this form, except in a slash command or shell command, which get
  the bare path.

#### Read checks and limits

Reads use the `workspace.read` checks:

- paths are repository-relative, without `..`, `.git`, backslashes or symlink components;
- the read must be allowed by both the selected turn environment's filesystem permissions and the thread's
  effective read permissions and deny rules.

- Expansion requires exactly one local environment at the thread's repository; other environments or working
  directories skip expansion.
- Each file is read once, in mention order, while the turn's mentioned files total at most 256 KiB of returned
  UTF-8 bytes, checked again after reading.
- A file that fails the checks, does not fit or is not UTF-8 is left to the model's own tools.

#### `mention` interceptor

Before each read, `api.intercept('mention', …)` (capability `input`, experimental) receives `{thread_id, path}`.
Handlers may set `path` to another workspace file, which is read under the same checks, or answer `{deny}` to skip
the read. They run beside the session like `input` interceptors and may call host operations; a failing chain skips
the read, and interrupting the turn cancels the chain.

## Running commands

Use it when a mod runs one program with `exec.run`: its arguments, sandbox and environment, limits, result,
complete-output artifacts, guards and access checks, and runs against a frozen snapshot. Long-lived helper
processes use [Managed processes](reference/managed-processes.md) instead.

Mod API `1.0.0`: `exec.run` is frozen; `exec.output_page`, `environment.read` and the `unix_sockets` capability are
experimental. Platform: Apple Silicon macOS; `exclusive_workspace` needs a Unix filesystem that reports creation
identity.

### `exec.run`

`exec.run` (capability `exec`) runs one program in the session's effective sandbox and returns when it exits.

```text
exec.run {program, sha256?, argv?, cwd?, env?, stdin?, timeout_ms?, max_output_bytes?, output_artifact?, write?,
          network?, unix_sockets?, snapshot?, guards?, required_access?, exclusive_workspace?, sandbox?}
```

#### `exec.run` arguments

| Argument | Meaning |
| --- | --- |
| `program` | A bare name resolved on `PATH`, or a canonical absolute path; see [program and environment](#execrun-program-working-directory-and-environment) |
| `sha256` | Pins the resolved file |
| `argv` | At most 128 arguments and 8,192 bytes, no NUL |
| `cwd` | Repository-relative working directory (absolute with `sandbox: "none"`) |
| `env` | At most 16 entries and 16 KiB, each name a declared `exec_environment` name |
| `stdin` | At most 64 KiB |
| `timeout_ms` | Default 10 s, at most 120 s |
| `max_output_bytes` | Stdout capture, at most 1 MiB (16 MiB with `output_artifact`) |
| `output_artifact` | Keeps complete stdout as an artifact; see [`output_artifact`](#output_artifact-and-execoutput_page) |
| `write` | Makes the repository writable (`fs.write`) |
| `network` | `"none"` (default) or `"loopback"` (`network`) |
| `unix_sockets` | Up to 4 declared names whose values are sockets; see [`unix_sockets`](#unix_sockets) |
| `snapshot` | Runs against a frozen copy; see [against a snapshot](#execrun-against-a-snapshot) |
| `guards` | Up to 4 read-only preconditions for a write; see [`guards`](#guards-for-live-workspace-writes) |
| `required_access` | `{write: [paths]}`; see [`required_access`](#required_access) |
| `exclusive_workspace` | An absolute checkout to lock; see [`exclusive_workspace`](#exclusive_workspace) |
| `sandbox` | `"none"` with the `os` grant; see [`sandbox: "none"`](#execrun-with-sandbox-none) |

#### `exec.run` result

```text
{exit_code, signal, stdout, stdout_sha256, stdout_bytes, output_artifact, stderr,
 stdout_truncated, stdout_preview_truncated, stderr_truncated, stderr_preview_truncated,
 timed_out, duration_ms, program: {path, sha256}, guards_verified, candidate_sha256?, evidence?}
```

`stdout_sha256` covers the raw captured stdout bytes. `candidate_sha256` and `evidence` are present for a run against a
snapshot ([`exec.run` against a snapshot](#execrun-against-a-snapshot)).

#### `exec.run` errors

| Error | When |
| --- | --- |
| `exec_arguments_invalid` | `argv`, `stdin`, `env` or `unix_sockets` is over its limit, or names an undeclared variable |
| `exec_network_invalid` | `network` is not `"none"` or `"loopback"` |
| `exec_network_unavailable_in_commands` | `network: "loopback"` from a command, button or keybinding |
| `exec_sandbox_invalid` | `sandbox` is not `"none"` |
| `exec_unrestricted_arguments_invalid` | `sandbox: "none"` with `network`, `unix_sockets`, `guards` or `required_access` |
| `exec_access_requires_write` | `required_access` without `write: true` |
| `exec_guards_invalid` | More than 4 guards, guards without `write`, or a malformed guard digest |
| `exec_guard_timeout`, `exec_guard_failed`, `exec_guard_changed` | A guard timed out, failed or printed other output |
| `exec_program_unavailable` | `program` does not resolve |
| `exec_program_changed` | The resolved file does not match `sha256` |
| `exec_program_declined` | The user declined the first unsandboxed run of the program |
| `exec_cwd_invalid`, `exec_cwd_unavailable` | `cwd` is malformed or cannot be opened |
| `exec_socket_unavailable` | A `unix_sockets` value is not a usable socket |
| `exec_concurrency_limit` | The mod already runs 4 commands |
| `exec_output_artifact_limit` | Stdout exceeds the capture limit with `output_artifact: true` |
| `exec_cancelled` | The call was cancelled; the host killed the process group |
| `capability_denied: <capability>` | `write`, `network`, `unix_sockets` or `sandbox: "none"` without its capability |

#### `exec.run` example

```ts
const run = api.host.call('exec.run', { program: 'git', argv: ['status', '--porcelain'], timeout_ms: 5000 });
if (run.exit_code !== 0) throw new Error(run.stderr);
```

#### `exec.run` program, working directory and environment

- A bare program name resolves on `PATH` outside the repository. An absolute path must be canonical and outside the
  repository. `sha256` pins the resolved file.
- `cwd` is repository-relative.
- The environment starts empty except `PATH`, a private `HOME`/`TMPDIR`, `TERM=dumb`, locale variables, the
  declared [`exec_environment` names](reference/authority-grants.md#exec_environment-names) and `env` entries limited to
  those names.
- Commands, buttons and keybindings run `exec.run` without network; `network: "loopback"` there fails with
  `exec_network_unavailable_in_commands`.
- Without `write` the repository is read-only. With `network: "loopback"` only local binding is allowed.
- The command starts in its own session without a controlling terminal, so a program that would prompt on
  `/dev/tty` (git credentials, ssh passphrases) fails instead of drawing over the TUI.
- Cancellation kills the process group and returns `exec_cancelled`.

#### `exec.run` limits

| Limit | Default | With `output_artifact` |
| --- | --- | --- |
| Timeout | 10 s, at most 120 s | unchanged |
| Captured stdout | 1 MiB | 16 MiB |
| Captured stderr | 1 MiB | unchanged |
| Returned `stdout` preview | 64 KiB | 4 KiB |
| Returned `stderr` preview | 16 KiB | unchanged |
| Concurrent runs per mod | 4 | unchanged |

- The host captures at most `max_output_bytes` of stdout (at most 1 MiB, which is also the default, or at most
  16 MiB with `output_artifact`) and 1 MiB of stderr, and reports `stdout_truncated`/`stderr_truncated`.
  `stdout_sha256` and `stdout_bytes` cover the captured stdout.
- The returned `stdout` and `stderr` are previews so the result fits a callback's host-call transport;
  `stdout_preview_truncated`/`stderr_preview_truncated` report a shortened preview. Use `output_artifact` for
  complete output.
- Output draining shares the command's deadline and cancellation, so a descendant that keeps a pipe open cannot
  keep the call running past its timeout.

#### `unix_sockets`

`unix_sockets` names up to 4 declared `exec_environment` variables whose host values are Unix sockets the command
may connect to. It needs the `unix_sockets` capability (experimental).

- Each value must be an absolute, canonical path outside the repository to an existing socket owned by the current
  user, or the call fails with `exec_socket_unavailable`.
- The mod never supplies the path and no IP network is added.

#### `exec.run` with `sandbox: "none"`

With the `os` grant, `sandbox: "none"` runs a program listed in `os_access` without the session sandbox.

- `cwd` may be absolute.
- The first run of a binary asks the user, who can decline (`exec_program_declined`); see [Authority
  grants](reference/authority-grants.md#os_access-manifest-field).
- A program reached through a symlink outside the repository runs as the link, so a version-manager shim such as
  `node` from mise or Volta runs the version it manages.
- The environment is cleared and then contains `PATH`, the real `HOME`, `USER`, `LOGNAME`, `SHELL`, locale,
  `SSH_AUTH_SOCK` (so `ssh` and `git` over SSH can use the user's SSH agent), a private `TMPDIR`, `TERM=dumb`, the
  declared `exec_environment` names and `env`. No other host credential or Codex variable is passed and no secrets
  API exists.
- Limits, timeouts, cancellation and process-group teardown are unchanged.
- `network`, `unix_sockets`, `guards`, `required_access` and `snapshot` need the sandbox.

The child runs as the user: it can read every user-readable file (including secret files such as `~/.ssh` or
`~/.codex/auth.json`), change mod stores and control files and start processes the host does not supervise. The host
cannot undo its effects; only the OS-separated broker (see
[Protected authority (macOS)](reference/protected-authority.md#protected-authority-macos)) keeps grants, credentials and evidence
anchors out of its reach.

#### `output_artifact` and `exec.output_page`

With `output_artifact: true`, the host raises the stdout capture to 16 MiB of UTF-8, or to `max_output_bytes` if that
is smaller. The result contains a 4 KiB preview, `{reference, sha256}` in `output_artifact`, `stdout_bytes` and
`stdout_preview_truncated`. Oversize output fails with `exec_output_artifact_limit` without creating an artifact.

`exec.output_page {artifact, cursor?, max_bytes?}` (experimental) reads at most 16 KiB per call with a byte cursor and
returns `{text, cursor, bytes, sha256}`.

The artifact is bound to the repository, the current mod source and the thread. Reads check its hash, and each
repository, source and thread combination has a 64 MiB quota. Large command output stays outside mod callback
receipts, and later callbacks can page it in.

#### `exclusive_workspace`

Use `exclusive_workspace` for a command that removes a checkout, so that it fails while another session is using
that checkout. It names an absolute writable checkout. The host locks it before the guards run and keeps the lock
until the command exits.

- It needs sandboxed write mode (`write: true`), and a session of this OMD version must already have enrolled the
  checkout.
- Each local session takes a shared lease on the local roots it selects, including inherited roots and roots it
  selects later.
- Removing a checkout fails closed when its ownership is unavailable or another participating session has a lease on
  it.
- Older OMD versions and other applications don't take part in leasing. Before removing a checkout, get the user's
  explicit confirmation that those applications aren't using it.
- Exclusive ownership is unavailable on non-Unix hosts and on filesystems that can't report creation identity. The
  host uses creation identity so that a new checkout on a reused inode doesn't inherit an older enrollment.

#### `guards` for live-workspace writes

For a live-workspace write, `guards` may contain up to four read-only command preconditions: `{program, sha256?,
argv?, cwd?, env?, stdout_sha256}`.

- The host runs them without network, while it holds its per-repository workspace operation lock, and compares their
  full, non-truncated stdout to the expected digest immediately before the write.
- Each guard is limited to 10 s and 1 MiB of output, and its time counts against the write's timeout.
- A failed or changed guard prevents the write.
- Guarded writes cannot target a frozen snapshot.
- Other processes outside the host can still modify the workspace between a guard and the write; commands that
  support their own locking or expected-version options should use them.

#### `required_access`

Use `required_access` for commands that change metadata on behalf of selected files, such as staging.

`required_access: {write: [paths]}` checks up to 128 named workspace paths for write permission after the `guards`
commands and before the write, while the host still holds the same workspace operation lock. It requires `write: true`
and cannot target a snapshot. The command itself still runs under the effective filesystem sandbox; the host cannot
infer which files an arbitrary command represents.

#### `exec.run` against a snapshot

`exec.run` accepts `snapshot` (from [`workspace.snapshot`](reference/workspace-files.md#snapshots-workspacesnapshot)) to run
against a private copy of frozen input. Normal command, filesystem and
cancellation permissions still apply. It may create build artifacts, but changing captured source rejects the
result.

- The result includes `candidate_sha256` and host-recorded `evidence`.
- Submit that reference with [`receipts.submit`](reference/contracts.md#receiptssubmit) `{execution: true, ...}` for a `host`
  producer; the host verifies ownership, candidate, reference and outcome.
- A successful receipt requires exit zero, no signal or timeout, and untruncated output.
- Each mod generation and thread keeps at most 64 execution records, the host at most 256.
- The record includes the [`environment.set`](reference/authority-grants.md#environmentset) overrides and explicit per-call
  values used by that execution, captured once before
  launch. Secret-like values are represented by hashes rather than plaintext; reproducing those runs requires the
  same secrets.

### See also

- [Use a host integration from a mod](../docs/mod-authors/use-a-host-integration.md): read the variables an
  integration such as herdr or Neovim sets, then run its binary and socket.
- [Packaging](reference/packaging.md) for package assets that a mod can pass to a sandboxed command.

## Workspace files

Use it when a mod reads, lists or changes workspace files, guards a change with expected fingerprints, reacts to
file changes, watches for external edits or freezes the workspace in a snapshot. Running a command against the
workspace is in [Running commands](reference/running-commands.md).

Entries are frozen in Mod API `1.0.0` unless marked experimental (see the
[registry table](reference/stability-and-migration.md#experimental-entries-in-the-registry)).

### Workspace reads, transactions, and write observation

`fs.read` grants `workspace.read` and the `workspace_change` event; `fs.write` grants `workspace.transaction`,
`workspace.request_rename` and the `workspace_pre_rename` event (see [Capabilities](reference/capabilities.md#capabilities)).
These operations work only in the session's current local repository, at its canonical path, and the host checks the
effective read and write permissions for every path.

#### Workspace reads and transactions

```text
workspace.read {paths, root?} → {files: {PATH: {text, sha256} | null}}
workspace.transaction {expected, writes?, deletes?, renames?, backup?, root?} → {files: {PATH: sha256 | null}, backup}
```

| Argument | Meaning |
| --- | --- |
| `paths` | At most 128 repository-relative paths |
| `expected` | Maps every affected path to its fingerprint: a SHA-256, `{size, mtime_ms}` or `null` for absent |
| `writes`, `deletes`, `renames` | Paths to write with their text, paths to delete, and `{old, new}` moves |
| `backup` | `true` stores the prior bytes outside the repository and returns them as the `backup` `ResourceRef` |
| `root` | An absolute root from the manifest's [`fs_access`](reference/authority-grants.md#fs_access-manifest-field) instead of the repository; needs `fs.external` |

`root` is also accepted by `workspace.list` and `workspace.stat`.

- Reads return UTF-8 text and SHA256 for at most 128 repository-relative paths and 4 MiB.
- A transaction rejects stale files, symlinks, `.git` paths, overlapping moves, and changes outside the declared
  scope.
- Files are replaced atomically one at a time. After cancellation or a failed multi-file operation, the host rolls
  back with checks.
- If an external writer changes a touched path during rollback, the host reports a visible conflict that needs
  inspection.
- `workspace.transaction` isn't atomic across the repository, and it doesn't replace user approval.

| Error | When |
| --- | --- |
| `workspace_path_scope_invalid` | No paths, more than 128, or a repeated path |
| `workspace_read_permission_denied`, `workspace_write_permission_denied` | The session can't read or write a path |
| `fs_root_invalid` | `root` isn't a string |
| `fs_root_not_granted: ROOT` | `root` isn't one of the mod's `fs_access` roots |
| `fs_root_not_canonical: ROOT` | `root` isn't a canonical directory |
| `fs_root_protected: ROOT` | `root` overlaps the workspace, a mod store, credentials or a protected path |

```ts
const read = api.host.tryCall('workspace.read', { paths: [path] });
```

That call is from [`omd_files`](first-party/omd_files/index.ts).

#### Other workspace operations

| Operation | What it does |
| --- | --- |
| `workspace.list {path?, recursive?, include_ignored?, max_entries?}` | Returns at most 20,000 readable entries, skipping `.git`, `.omd` and paths the session cannot read. |
| `workspace.stat {paths, hash?}` | Returns `{kind, size, mtime_ms, sha256?}` or `null`. |
| `workspace.check_access {paths, write?}` (experimental) | Verifies up to 128 distinct named paths against the caller's current read or write grant and effective workspace permissions, returning `{paths, write}` on success. |
| `workspace.backup {expected}` | Saves up to 256 files (64 MiB) under the same preconditions. |
| `workspace.restore {backup, expected}` | Restores up to 256 files (64 MiB) under the same preconditions. |

- A separate `workspace.check_access` does not reserve permission for a later command; guarded
  `exec.run.required_access` rechecks inside the write operation.
- Transactions and restores are exclusive per repository within the host.

#### `workspace.request_rename`

`workspace.request_rename {old, new}` moves a file and lets a subscribed mod add companion edits, such as a language
server's import updates, in the same transaction. It returns `{status: 'renamed', files}` or
`{status: 'fallback', reason}`.

1. The host captures the source and checks that the destination is absent.
2. Before the move, it calls the selected `workspace_pre_rename` subscribers with
   `{repository, old, new, expected, thread_id}`, in the requesting thread's state scope.
3. It accepts one `{status:"ready",expected,writes}` proposal.

- No proposal, an unsupported operation, or an unavailable server yields `{status:"fallback",reason}`.
- Conflicting proposals fail visibly.
- The host checks all expected hashes and effective write permissions, then applies the companion writes and move
  in one checked transaction.
- A subscriber can read additional companion files and use `process.start`, `process.exchange`, `process.status`,
  `process.stop` and `process.which` (no network, under its declared environment and the workflow contract's
  restrictions) before returning its proposal.

The [independent workspace example](examples/workspace) demonstrates this path without using a language server.
It also shows a direct transaction for a mod tool.

### Workspace changes and watches

A mod learns about file changes from the `workspace_change` event and from `workspace.watch`.

#### `workspace_change` delivery

The host delivers `workspace_change {repository, source, call_id, changes, status, reason}` after:

- a tool call changes readable files (`source: "tool"`, with `call_id`);
- a slash command or lifecycle callback runs `workspace.transaction`, `workspace.restore` or `workspace.integrate`
  (`source: "transaction"`);
- a slash command or lifecycle callback runs a writing `exec.run` (`source: "exec"`).

Each change contains the path's before and after hashes.

- Host operations inside a tool call are covered by that tool's single notification, and writes made by a
  `workspace_change` callback are not re-announced.
- Command and callback changes are delivered when the originating callback finishes, or at the next turn or tool
  boundary for slash commands.
- If more than 64 unannounced changes accumulate, subscribers receive one `source: "rescan"`, `unavailable`
  notification instead.
- A batch of more than 128 changed paths or 16,000 bytes of path names, or one with a path outside the read scope,
  arrives as `unavailable` with `reason` `workspace_change_batch_limit` or `workspace_change_scope_unavailable`.
- A change outside the thread's effective read scope reports `unavailable` without exposing its path or hash.
- The host scans the workspace only while a selected mod subscribes. The scan follows the repository's `.gitignore`,
  `.ignore` and `.git/info/exclude` rules and always skips `.git` and `.omd`. It is bounded to 20,000 files and
  128 MiB, and reports `unavailable` instead of partial coverage.

#### `workspace.watch`

`workspace.watch {paths, recursive?, debounce_ms?, include_ignored?, key?, git?}` reports external edits as
`workspace_change` with source `external`.

- At most 16 watches per mod by default (`watches_per_mod` in [Host limits](reference/limits.md#host-limits)).
- Protected paths are always excluded.
- Git-ignored paths are excluded unless `include_ignored` is true.

Watches end and deliver as described in [Callback delivery](reference/events-and-lifecycle.md#callback-delivery).

##### Watch keys

A `key` lets a mod find and replace one of its watches instead of adding another. Keys require
`workspace_watch_key_v1` and are an experimental field.

- A `key` (1-64 bytes) names one watch per mod in this OMD process.
- Calling again from the same thread with the same arguments keeps the watch.
- Other arguments or another thread replace it without counting against the limit. Changes it already queued are
  still delivered.
- `workspace.unwatch {key}` (experimental) stops it. `workspace.unwatch {watch_id}` stops one of the mod's watches.

##### Git metadata

`git: true` (`workspace_watch_git_v1`, an experimental field) also reports changes to the repository's Git metadata.

- Changes to `HEAD`, `index`, `packed-refs` and `refs/…` arrive as paths such as `.git/HEAD`, with `before` and
  `after` null. Lock files and objects are left out.
- The host finds the Git directory from the workspace root upward, including linked worktrees and submodules.
- A `.git` file is followed only to a Git directory that proves the link: a worktree's backlink, or a submodule
  directory under an enclosing repository's `.git/modules`.
- Outside a repository, for a `--separate-git-dir` repository, or for a submodule of a linked worktree, the call fails
  with `watch_git_unavailable`.

### Workspace snapshots

`workspace.snapshot` freezes the workspace files and `workspace.fingerprint` identifies them.

#### Snapshots: `workspace.snapshot`

`workspace.snapshot {agent?, expected?}` requires `fs.read` and returns `{snapshot: ResourceRef, candidate_sha256}`. It
freezes the current tracked files plus the untracked paths listed in the host config's `approved_untracked`, or a
completed owned agent's workspace (`agents` is also required). `expected` rejects a changed candidate.

- References are bound to the caller, package source, generation and thread.
- A capture contains at most 128 MiB of file contents and paths (`snapshot_bytes` in the host config can lower it).
  A larger workspace fails with `snapshot size limit`, but turn evidence still identifies it. Turn evidence reports
  `workspace_sha256: null` only when a captured path is unreadable.
- Each mod generation and thread keeps at most 8 snapshots and 128 MiB, the host at most 32 and 256 MiB; a full host
  evicts the oldest snapshot of the largest holder.
- Identical captures are deduplicated, and the registry clears on owner cleanup or session stop.
- Snapshots do not authorize reading denied paths.
- Reconstructed worktrees retain captured files even when snapshot ignore rules match them.

#### `workspace.fingerprint`

`workspace.fingerprint {agent?, expected?}` takes the same arguments and permissions and returns only
`{candidate_sha256}`, the digest `workspace.snapshot` would report. It stores nothing, so use it to check
freshness; it is also available in the `context` event, where `workspace.snapshot` is not.

## State and storage

Use it when a mod keeps data: `store.*` records, evidence and binary evidence, `api.state` and where it lives,
state migration, session UI state and the reactive helpers over `api.state`.

Entries are frozen in Mod API `1.0.0` unless marked experimental (see the
[registry table](reference/stability-and-migration.md#experimental-entries-in-the-registry)). Every operation here needs the
`store` capability except `api.uiState`, which needs `terminal`.

### Durable data: `store.*` and evidence

A mod stores durable values with `store.*` and larger records, including images and SVG assets, with `evidence.*`.

#### `store.*` operations

```text
store.get {key, scope?} → {value, revision, provenance} | null
store.put {key, value, expected_revision, scope?} → {revision}
store.delete {key, expected_revision, scope?} → {deleted}
store.list {prefix?, cursor?, limit?, scope?} → {keys, cursor, generation}
store.export {scope?, cursor?} → {schema, owner, scope, generation, entries, cursor}
store.reset {expected_generation, scope?} → {generation}
```

They operate on a per-mod namespace. `store.list`, `store.export` and `store.reset` are experimental.

| Argument | Meaning |
| --- | --- |
| `key` | 1–256 printable ASCII characters, no spaces or `\` |
| `scope` | `repository` (the default), `user` or `thread` (see [Thread-scoped store and `resume`](reference/threads-and-sessions-store.md#thread-scoped-store-and-resume)) |
| `value` | Any JSON except null, at most 64 KiB |
| `expected_revision` | The record's current revision, or `null` to create it; required on `put` and `delete` |
| `expected_generation` | The scope's current generation; required on `reset` |
| `prefix`, `limit` | Filter and page size for `list`; a page contains at most 256 keys |
| `cursor` | The cursor of the previous page |

Results:

- `provenance` is host-attested `{mod, source_sha256, thread_id, origin, at}` (`at` is milliseconds since the Unix
  epoch); every record has it.
- `list` returns `keys` as `{key, revision, bytes, provenance}`.
- `export` returns pages of at most 64 KiB; `entries` maps each key to `{value, revision, provenance}`.
- `cursor` is null on the last page.

A scope stores at most 16 MiB and 4,096 keys.

| Error | When |
| --- | --- |
| `store_key_invalid` | The key is missing or breaks the `key` rule |
| `store_scope_invalid` | Another scope |
| `store_value_required`, `store_value_limit` | `put` without a value, or with one over 64 KiB |
| `store_expected_revision_required` | `put` or `delete` without `expected_revision` |
| `store_revision_conflict` | The revision is stale; on `put` the message names the current one |
| `store_expected_generation_required`, `store_generation_conflict` | `reset` without the generation, or with a stale one |
| `store_quota` | The write would pass the scope's 16 MiB or 4,096 keys |
| `store_thread_unavailable` | `thread` scope before the session has a thread |

```ts
const current = api.host.call('store.get', { key: 'goal', scope: 'thread' });
api.host.call('store.put', {
  key: 'goal', value: String(text), expected_revision: current?.revision ?? null, scope: 'thread',
});
```

That example is from [`goal_store`](examples/goal_store/index.ts).

To export or reset a store namespace outside a session, without running any mod code, use
`omd store export|reset --mod ID [--repo PATH] [--store PATH] [--scope repository|user]`. Export writes the complete
namespace.

#### `evidence.write` and `evidence.read`

```text
evidence.write {media_type: 'application/json' | 'text/plain', content, label?} → ResourceRef
evidence.write {media_type: 'image/png' | 'image/jpeg' | 'image/svg+xml' | 'application/octet-stream', base64, label?} → ResourceRef
evidence.read {reference, cursor?, max_bytes?} → {reference, text, cursor, bytes}
```

`evidence.write` stores content-addressed evidence and returns a `ResourceRef` `{reference, sha256}`. The `base64`
form is binary evidence (`binary_evidence_v1`).

| Media type | Size |
| --- | --- |
| `image/png`, `image/jpeg` | At most 8 MiB |
| `image/svg+xml` | At most 1 MiB, checked as under [SVG assets](#svg-assets-svg_assets_v1) |
| `application/octet-stream`, text | At most 16 MiB |

`evidence.read` reads evidence back in pages: `max_bytes` is 1 to 65,536 and defaults to 65,536, and `cursor` is
null after the last page. PNG and JPEG references can be attached through `composer.write` and image-capable app
methods.

```ts
api.host.call('evidence.write', { media_type: 'image/svg+xml', base64: BADGE, label: 'external client badge' })
```

That call is from [`external_client`](examples/external_client/index.ts).

#### SVG assets (`svg_assets_v1`)

The host accepts an SVG asset in `evidence.write` and `terminal.import_file` only if it is UTF-8 XML of at most 1 MiB
whose root element is `svg`, after an optional XML declaration and comments. Every element must be in the SVG namespace
(an unprefixed element without a default namespace counts as SVG).

The check refuses:

- a DOCTYPE and other processing instructions;
- `script`, `foreignObject`, `iframe`, `object`, `embed`, `audio` and `video` elements;
- `animate*`/`set` targeting `href` or an `on*` attribute;
- `on*`, `src`, `srcset`, `data`, `action`, `formaction` and `ping` attributes;
- `href`/`xlink:href` other than `#fragment` or a base64 PNG/JPEG `data:` URI;
- in any attribute or `<style>` text (case-insensitive, after resolving references) a `url(` other than
  `url(#...)`, `image-set(` (including `-webkit-image-set(`), `src(`, `@import`, `@font-face` or a backslash
  escape.

A refusal fails with `evidence_record_invalid: svg_<reason>`.

- `terminal.import_file` labels SVG text `image/svg+xml`, so it passes the same check.
- External renderers draw SVG natively.
- The terminal shows an `image` component's alt text, refuses SVG in `terminal.image_sample` and never attaches it
  to the composer.

### `api.state`

`api.state` is a mod's state object. The manifest's [`state_scope`](#state_scope-state_scopes_v1) sets whether there
is one per mod store, per thread or per checkout.

#### `api.state` compare-and-swap

`api.state` is re-read before every callback and written back with a compare-and-swap. If another process wrote it
meanwhile, the host runs the callback again against the fresh state, within the callback's 5 s budget.

- The rerun's host calls get the results already recorded, so no operation runs twice.
- The clock stays at the first attempt's start, so `Date.now()` in arguments replays.
- If the rerun asks for a different host call, the host runs the callback fresh when every recorded call was
  read-only. Otherwise the callback fails with the transient `state_conflict`, because an operation that already ran
  is never repeated.

#### Durability of state and store writes

Commits of `api.state` in every scope and of `store.*` data use a write barrier, not a full fsync. They survive a
crash or quit in order, but the last commits can be lost on a power failure. Evidence is fully synced.

#### `state_scope` (`state_scopes_v1`)

The location of `api.state` follows the manifest's `state_scope` (`state_scopes_v1`).

- `"store"` (the default) stores one state of at most 512 KiB in the mod store, shared by every OMD process that
  uses that store.
- `"thread"` stores one state per session thread and selection scope, so a project copy can't inherit a same-id
  user copy's state. The state forks with the thread and is removed when the thread is deleted.
  - Routing and compaction decisions made while a thread is set up see that thread's state. For a fork, the host
    makes the fork's copy first.
  - Registration reads the state of the thread whose callback reloaded the mods. At process start there is no such
    thread.
- `"checkout"` stores one state per checkout, shared by every OMD process working there whatever its mod store: in
  `<git-dir>/omd/state/<mod>.json` for a Git checkout (a linked worktree has its own), read-only to agent commands
  as Codex keeps `.git` read-only. Outside a Git checkout, as in a projectless session, checkout state is unavailable
  (`state_checkout_unavailable`) and nothing is written to the directory.

These rules apply in every scope:

- Mods never run with the home directory or the filesystem root as the session directory. The host stays off with a
  notice in `/omd`.
- `omd-mod command STORE MOD NAME JSON [THREAD]` and `omd-mod test STORE SCENARIO [THREAD]` use the given THREAD and
  the checkout of their working directory. A `thread` mod run from `omd-mod command` without THREAD fails with
  `state_thread_unavailable`.
- In the TUI, a slash command typed before the session's thread exists runs once the thread exists.
- A callback result, including its state, is at most 1 MiB.

#### State migration (`state_version`)

A mod raises the manifest's `state_version` when its saved state changes shape. Thread and checkout state migrate
inside a session. Mod store state migrates with `omd-mod migrate`.

- Thread and checkout state stored at another `state_version` migrates before the mod's next callback in that thread or
  checkout: the host runs the mod's `migrate` handler (an experimental event that needs `store`) on it and keeps the
  previous file beside it as `<file>-backup-<sha256>`; until then registration and render reads see `null`.
- A package update that changes the `state_version` of a thread- or checkout-scoped mod with `store` is refused
  (`migration_handler_required`) unless the new version registers `migrate`; an adapter-wrapped package is not
  checked.
- The package update preview runs no new code: it marks such a package `state_version.handler_required`, and the
  confirmed apply loads it to check.
- Migration handlers can import declared package assets by relative path.

The `omd-mod migrate` and `rollback` commands act on `"store"` state only.

`omd-mod migrate STORE MOD_ID_OR_PACKAGE` and `omd-mod rollback STORE MOD_ID_OR_PACKAGE BACKUP` take a mod id or a
package folder. A bare name (no `/`) is a mod id resolved among the store's selected mods (watched folder or installed);
`.`, `..` and anything with a `/` are package folders. An id that matches copies in more than one scope fails with
`mod_ambiguous` (pass the folder), and a mod without saved store state fails with `migration_requires_saved_state`.

### Session UI state (`api.uiState`)

`api.uiState.get()` / `.set(value)` (experimental) stores session-only state, such as open dialogs and filters, and
requires `terminal`. Saved `api.state` is unchanged by it.

- Values are bounded to 65,536 UTF-8 bytes of compact `JSON.stringify(value)` output, including quotes, keys and
  escapes.
- Strings and object keys must contain valid Unicode scalars (no lone surrogates).
- The host checks the original serialized bytes before parsing; number reformatting does not change the limit.
- Values are shared by host instances in the same process, store, repository, thread and package identity.
- Commands and component events may write; other callbacks may read.
- Writes commit only after successful validation and cancellation checks. A revision conflict reruns the callback
  under the same replay rules as [`api.state` compare-and-swap](#apistate-compare-and-swap).
- Authority polling with unchanged configuration preserves UI state and
  [command views](reference/commands-and-composer.md#command-views).
- State is cleared on explicit reload, revocation, package changes and session teardown, and is never written to
  disk.
- A reload during a command or component event (such as one its own `packages.apply` caused) does not cancel it.
  Its `set` writes to the cleared state, even if the value came from a read before the reload. A change of repository
  during the callback cancels it.

Preferences that must survive a restart belong in `api.state` or `store.*`, under the power-failure rule in
[Durability of state and store writes](#durability-of-state-and-store-writes).

### Reactive state (`reactive_state_v1`)

Reactive state gives a mod typed handles on `api.state` keys and a way to react to their changes.

| Helper | What it is |
| --- | --- |
| `api.atom(key, fallback)` | A typed handle on one top-level key of an object `api.state` (`get`, `set`, `update`). |
| `api.member(key, id, fallback)` | One member of a map-valued key. |
| `api.derive(() => value)` | A memoized selector that recomputes when a key it read changes. |
| `api.subscribe(target, (value, previous) => …)` | Registers during activation and runs once per changed target after the handler that changed it, still inside that callback. |

- Writes go through the same compare-and-swap as `api.state.set`, so a concurrent writer reruns the callback rather
  than losing an update.
- A subscription's host calls and writes commit or rerun with the callback. A cascade stops after 8 rounds, and at
  most 64 subscriptions exist per mod.
- Subscriptions belong to the activation generation, so a reload or disable drops them.
- Render hooks report the keys they read; the host redraws a hooked component only when one of those keys, the
  mod's settings or its source changes, so several wrappers can watch the same state without redrawing the whole
  view on every key.

## Managed processes

Use it when a mod runs a long-lived helper process, such as a language server, and exchanges framed messages with
it, or when a package declares an adapter or the session configures code-mode kernels. A process that feeds a
terminal raster is described in [Graphics](reference/graphics.md#raster-processes-process_raster_v1).

Mod API `1.0.0`: `process.*` is frozen; raw streams (`process_streams_v1`) are experimental. Platform: Apple Silicon
macOS, in the native sandbox.

The `exec` capability grants `process.which`, `process.start`, `process.exchange`, `process.status`, and
`process.stop`. The host resolves an installed executable and its hash, verifies that identity at launch, and runs
it in a read-only repository sandbox with restricted network access and a private scratch directory.

- A process session is the named handle that `process.start` creates. Each one belongs to one mod and generation.
  The host cleans it up when the mod is disabled or reloaded, the call is cancelled or the thread stops.
- A process cannot write the repository through this API.

### Process operations

| Operation | Arguments | Result |
| --- | --- | --- |
| `process.which` | `{names, sandbox?: 'none'}` | `{found: [{name, path, sha256}]}` |
| `process.start` | see [`process.start` options](#processstart-options) | `{session, running: true}` |
| `process.exchange` | `{session, send?, wait_ms?}` | `{session, messages, running: true}` |
| `process.status` | `{session}` | `{session, running: true, idle_ms}` |
| `process.stop` | `{session}` | `{stopped}` |

- `process.which` resolves 1 to 8 names and leaves out names that don't resolve. With `sandbox: 'none'` it
  resolves as an unsandboxed `process.start` does (the `os` grant), so a version-manager shim returns its link
  path, not the manager's binary.
- `process.start` needs the `path` and `sha256` that `process.which` returned for `name`.
- `process.exchange` writes `send`, then waits up to `wait_ms` for messages; see
  [`process.exchange`](#processexchange).
- `process.status` and `process.exchange` fail with `process_stopped` once the process has exited and its output
  has been read.

#### Process limits

| Limit | Value |
| --- | --- |
| Sessions | 8 per host, 5 per mod; a session name is used once |
| Session name | 1 to 64 characters of `A-Z`, `a-z`, `0-9`, `-` and `_` |
| `arguments` | at most 16, 4,096 bytes in total |
| `environment` | at most 8 variables; names 1 to 64 characters of `A-Z`, `0-9` and `_`; values at most 1,024 bytes |
| Executable | at most 128 MiB |
| Framed message | at most 4 MiB |
| `content-length` header | 8 KiB |
| `send` per exchange | at most 32 messages |
| `wait_ms` | default 0, at most 10,000 |
| Messages returned per exchange | at most 64 and 256 KiB encoded, but at least one when any is queued |
| Queued output | 128 messages, 32 MiB |

#### Process errors

| Error | When |
| --- | --- |
| `process_candidate_limit` | `process.which` without names or with more than 8 |
| `process_program_or_arguments_invalid` | A session name, argument, variable, framing, network or `stdin` value is invalid, or `path` is not what `name` resolves to |
| `process_executable_changed` | The file at `path` does not match `sha256` or is over 128 MiB |
| `process_session_limit_or_duplicate` | The session limit is reached or the name is in use |
| `process_notify_invalid` | `notify` has entries other than `output` and `exit` |
| `process_program_declined` | The user declined the first unsandboxed start of the program |
| `process_exchange_limit` | `send` has more than 32 messages or `wait_ms` is over 10,000 |
| `process_message_invalid_or_too_large` | A sent message is not an object or is over 4 MiB |
| `process_stdin_null` | `send` to a process started with `stdin: "null"` |
| `process_stopped` | The process has exited and its output has been read |
| `process_session_unavailable` | No such session for this mod |
| `process_cancelled` | The call was cancelled |

#### Process example

```ts
const { found } = api.host.call('process.which', { names: ['pyright-langserver'] });
const server = found[0];
api.host.call('process.start', { session: 'py', name: server.name, path: server.path, sha256: server.sha256, arguments: ['--stdio'] });
const { messages } = api.host.call('process.exchange', { session: 'py', send: [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }], wait_ms: 1000 });
```

### Framed processes

Each process frames its stdio in one of three ways, chosen at `process.start`, and gets its own environment and
sandbox.

#### `process.start` options

```text
process.start {session, name, path, sha256, arguments?, environment?, framing?, network?, notify?, sandbox?,
               raster?, keys?, pixels?, stdin?}
```

`process.start` takes:

- `framing: "content-length"` (default), `"ndjson"` or `"raw"`. The host stops a process whose stdout breaks the
  framing: a line that isn't JSON under `ndjson`, or a blank line or 8 KiB without a valid header under
  `content-length`. stderr is discarded except under `raw`, which streams both unframed.
- `network: "none"` or `"loopback"`.

`network`, `stdin`, `environment` and `sandbox` are described below, `notify` under
[Process notifications](#process-notifications), and `raster`, `keys` and `pixels` under
[Raster processes](reference/graphics.md#raster-processes-process_raster_v1).

#### `process.exchange`

`process.exchange` returns messages until the next one would push the encoded `messages` past 256 KiB (at most 64,
and always at least one), so a result fits the callback's
[1 MiB host call transport budget](reference/host-model.md#host-call-transport-budget). The rest stays queued for the next call.

After the process exits, its readers get one second to deliver what it wrote. Exchanges return that queued output
first, and the exchange after that fails with `process_stopped`. `process.status` reports `running: true` until that
output has been exchanged. Once the process has exited, the host drops the `send` of any exchange.

#### `stdin: "null"`

`stdin: "null"` starts the process with standard input at end of file, for commands that would otherwise wait on an
open pipe. Its exchanges cannot `send` (`process_stdin_null`) and it cannot take `raster`.

#### Raw streams (`process_streams_v1`)

Experimental (`process_streams_v1`). Under `framing: "raw"` the host reads stdout and stderr as the process writes
them and queues each read as `{stream: "stdout" | "stderr", data}`. A read is at most 8,000 bytes, so a chunk fits one
exchange even when every byte is escaped.

- Bytes that are not UTF-8 arrive as their own `{stream, data_base64}` chunk between the text chunks around them,
  so one read can queue several chunks.
- A character split across writes arrives whole in the later chunk.
- The two streams are separate pipes, so chunks keep their order within a stream but not across streams.
- `send` takes strings, written verbatim.
- The queue keeps its bound of 128 messages: a process that writes faster than the mod exchanges blocks on its
  pipe, and nothing is dropped.
- `raw` cannot take `raster`, `keys` or `pixels`.

#### Process environment and sandbox

These rules set what a started process can see and reach.

- The host replaces `{process.home}` in process arguments with that session's private scratch directory, for tools
  that do not honor the `HOME` environment.
- `environment` supplies explicit variables to that process ([Process limits](#process-limits)). The host
  rejects its own reserved variables and loader overrides.
- Sandboxed processes also cannot read or write protected and credential paths.
- `network: "loopback"` (with the `network` capability) allows local binding while keeping external network access
  restricted.
- The host terminates the started process's whole process group. Each process gets an owner-only scratch directory,
  and a sandboxed process starts with a cleared host environment.

With the `os` grant, `sandbox: "none"` starts a listed program (`path` and `sha256` still pinned) with the same
environment rules as [unsandboxed `exec.run`](reference/running-commands.md#execrun-with-sandbox-none); `network` comes from
`os_access`. The first start of a binary asks the user, who can decline (`process_program_declined`); see
[Authority grants](reference/authority-grants.md#os_access-manifest-field). The host still manages the process: it enforces
limits, handles cancellation and tears down the process group. It stops the process when the grant expires or is
revoked, when the mod reloads or is disabled, or when the mod's source changes.

#### Process notifications

`process.start {notify: ['output','exit']}` delivers coalesced `process_event`s. `exit` fires once, when the
process group leader (the started program) exits, even while a background child keeps the output streams open and
more output may follow.

A `process_event` exit contains only the session; read the exit status with `process.status`.

### Adapters

An adapter module translates the Mod API for other packages: its default export receives a dependent package's `api`
and returns the object that package's default export is called with. A library package can declare
`adapter_module: {entry, aliases}`. A dependent package with `adapter: "<package id>"` is wrapped by that module
before activation and may import its aliases. The adapted package keeps only its own capabilities.

### Code-mode kernels

A kernel is a persistent interpreter that the `kernel` code-mode tool runs cells in. Kernels are Codex configuration,
not a Mod API: `[[features.code_mode.kernels]]` entries with `name`, `command`, absolute `driver` and
`driver_sha256` register kernels for the `kernel` code-mode tool. The driver hash is checked before each worker
starts; with no entries the tool reports that no kernel is configured.

### Expected failures and `api.host.tryCall`

`api.host.tryCall` returns `{ok:true,value}` or `{ok:false,error}` for an operation that is expected to be
unavailable, such as a language server that isn't installed. A mod can then report a fallback without the missing
server counting as a callback failure. `call` and `tryCall` go through the same declared capability and host
permission checks.

## Events and lifecycle

Use it when a mod reacts to host events: which events exist and what they contain, channels between mods, timers and
the `api.time` helpers, how background callbacks are delivered, lifecycle events and the classic hook names.

Mod API `1.0.0`: frozen, except the events and fields marked experimental. Platform: every OMD host (Apple Silicon
macOS).

### Event index

Every event in the `Events` interface of [`api.d.ts`](api.d.ts), with its input fields, what a handler may
return, how it is registered, its status in the conformance registry and where it is described. An event marked
experimental may change in any release
([Stability and migration](reference/stability-and-migration.md)).

`api.middleware` takes only `prompt`, `session`, `agent`, `tool_call`, `tool_result`, `host_operation` and
`approval`. `api.replace` takes only `context`, `routing`, `compaction`, `tool_batch`, `completion` and `history`.

| Event | Input | Handler returns | Registered with | Status | Described in |
| --- | --- | --- | --- | --- | --- |
| `context` | `{thread_id, turn_id, ledger}` | `{text}` or null | `api.on` or `api.replace` | frozen | [Thread and turn events](#context) |
| `routing` | `{routes, model, provider, reasoning}` | `{route}` or null | `api.on` or `api.replace` | frozen | [Routes](reference/routes.md#choosing-a-route) |
| `compaction` | `{token_limit, context_window}` | `CompactionDecision` | `api.on` or `api.replace` | frozen | [Thread and turn events](#compaction) |
| `history` | `{thread_id, agent_id, model, items}` | `HistoryEdit` or null | `api.on` or `api.replace` | frozen | [History and compaction](reference/history.md#model-bound-history-history_v1) |
| `completion` | `{kind: 'mention', ...}` or `{kind: 'argument', ...}` | `{items}` or null | `api.on` or `api.replace` | frozen | [Commands and composer](reference/commands-and-composer.md#composer-completion-completion_v1) |
| `tool_batch` | `{batch_id, thread_id, calls}` | `{merge}` or null | `api.on` or `api.replace` | frozen; experimental field: `success_per_call` | [Tools](reference/tools.md#replacetool_batch) |
| `tool_exposure` | `{thread_id, ledger, available}` | `{enable}` | `api.on` | experimental | [Tools](reference/tools.md#task-scoped-tools-and-tool_exposure) |
| `migrate` | `{from, to}` | nothing | `api.on` | experimental | [State and storage](reference/state-and-storage.md#state-migration-state_version) |
| `terminal` | `{event, ledger, identity?, presentation?, client?, clients?}` | `TerminalPatch` or null | `api.on` | frozen; experimental fields: `omd_version`, `welcome`, `chat`, `colors`, `sites` | [Terminal UI](reference/terminal-ui.md) |
| `start` | `Json` | nothing | `api.on` | frozen | [Thread and turn events](#start-idle-and-stop) |
| `resume` | `{thread_id, last_turn, restarted}` | nothing | `api.on` | frozen | [Thread data and recorded sessions](reference/threads-and-sessions-store.md#thread-scoped-store-and-resume) |
| `idle` | `Json` | nothing | `api.on` | frozen | [Thread and turn events](#start-idle-and-stop) |
| `stop` | `Json` | nothing | `api.on` | frozen | [Thread and turn events](#start-idle-and-stop) |
| `session` | `{phase, thread_id, cause?}` | nothing | `api.on` or `api.middleware` | experimental | [Thread and turn events](#session) |
| `prompt` | `{thread_id, turn_id, original, effective, provenance}` | nothing | `api.on` or `api.middleware` | experimental | [Peers, power holds and mod-started turns](reference/sessions-and-turns.md#how-queued-turns-start) |
| `turn_start` | `{turn_id}` | nothing | `api.on` | frozen | [Thread and turn events](#turn_start-and-compaction_start) |
| `turn_end` | `{turn_id, outcome, reason?, error?, evidence?}` | nothing | `api.on` | frozen | [Agents](reference/agents.md#agent-failure-details) |
| `tool_call` | `{call_id, agent_id, tool, arguments}` | nothing | `api.on` or `api.middleware` | frozen | [Thread and turn events](#tool_call) |
| `tool_result` | `{call_id, agent_id, thread_id, tool, outcome, answered_by, call_sha256, result_sha256, result_complete}` | nothing | `api.on` or `api.middleware` | frozen | [Tools](reference/tools.md#result-digests-on-tool_result) |
| `tool_output` | `{call_id, tool, arguments, success, text, tail, bytes}` | `{append}` or null | `api.on` | frozen | [Tools](reference/tools.md#tool_output-observers) |
| `tool_batch_end` | `{turn_id, calls}` | nothing | `api.on` | experimental | [Lifecycle events](#lifecycle-events) |
| `agent` | `{phase, agent}` | nothing | `api.on` or `api.middleware` | frozen; experimental fields: `provider`, `model`, `billing` | [Agents](reference/agents.md#agent-middleware-event) |
| `agent_end` | `{handle, role, status, error?, failure?, text?, sha256?}` | nothing | `api.on` | frozen | [Agents](reference/agents.md#agent-failure-details) |
| `contract` | `{gate, outcome, missing, candidate_sha256}` or a refusal with `outstanding_findings` | nothing | `api.on` | experimental | [Thread and turn events](#contract) |
| `compaction_start` | `{turn_id, trigger}` | nothing | `api.on` | frozen | [Thread and turn events](#turn_start-and-compaction_start) |
| `compaction_end` | `{turn_id, trigger, outcome, by, provider_call}` | nothing | `api.on` | frozen | [History and compaction](reference/history.md#compaction-summarizers-and-results) |
| `model_response` | `ModelResponse` | nothing | `api.on` | frozen | [Model requests and streams](reference/model-requests.md#onmodel_response) |
| `host_operation` | `{phase, caller, operation, arguments?, result?, error?}` | nothing | `api.on` or `api.middleware` | experimental | [Admission and interception](reference/admission-and-interception.md#host_operation-middleware-event) |
| `approval` | `{id, kind, thread_id, turn_id, agent_id, host_decision, policy, details, assessment}` | `{deny}`, `{ask}`, `{approve}` or null | `api.on` or `api.middleware` | frozen | [App bridge and approvals](reference/app-bridge-and-approvals.md#approvals-approval_v1) |
| `approval_result` | `{id, kind, decision, source, mod?}` | nothing | `api.on` | frozen | [App bridge and approvals](reference/app-bridge-and-approvals.md#how-answers-combine) |
| `app_notification` | `{method, params, thread_id, coalesced, dropped}` | nothing | `api.on` | frozen | [App bridge and approvals](reference/app-bridge-and-approvals.md#app-notifications-and-server-requests) |
| `app_server_request` | `{method, request_id, phase, params, resolution}` | nothing | `api.on` | frozen | [App bridge and approvals](reference/app-bridge-and-approvals.md#app-notifications-and-server-requests) |
| `elicitation_result` | `{server, request_id, action, content, by}` | nothing | `api.on` | experimental | [Lifecycle events](#lifecycle-events) |
| `workspace_change` | `{repository, source, call_id, watch_id?, changes, status, reason?}` | nothing | `api.on` | frozen | [Workspace files](reference/workspace-files.md#workspace_change-delivery) |
| `workspace_pre_rename` | `{repository, old, new, expected, thread_id}` | a `ready` or `fallback` proposal, or nothing | `api.on` | frozen | [Workspace files](reference/workspace-files.md#workspacerequest_rename) |
| `process_event` | `{session, kind: 'output', bytes}` or `{session, kind: 'exit'}` | nothing | `api.on` | frozen | [Managed processes](reference/managed-processes.md#process-notifications) |
| `timer` | `{key}` | nothing | `api.on` | frozen | [Timers](#timers-timers_v1) |
| `channel` | `{publisher, channel, data, correlation, sequence, dropped}` | nothing | `api.on` | frozen | [`events.publish`](#eventspublish) |
| `component_event` | `{component, thread_id, kind, ...}` | nothing | `api.on` | frozen; experimental fields: `content`, `target`, `edge`, `columns`, `rows` | [Terminal input](reference/terminal-input.md#component_event) |
| `component_post` | `{component, module, client?, data}` | nothing | `api.on` | frozen | [Terminal input](reference/terminal-input.md#component-module-handlers) |
| `view` | `{phase, view, view_id, dropped?}` | nothing | `api.on` | experimental | [Terminal input](reference/terminal-input.md#component_event) |
| `focus` | `{focused, dropped?}` | nothing | `api.on` | experimental | [Terminal input](reference/terminal-input.md#component_event) |
| `composer` | `{kind: 'change', ...}` or `{kind: 'suggestion', ...}` | nothing | `api.on` | frozen | [Commands and composer](reference/commands-and-composer.md#composer-event) |
| `prompt_expanded` | `{turn_id, items}` | nothing | `api.on` | experimental | [Commands and composer](reference/commands-and-composer.md#submitted-drafts-and-prompt_expanded) |
| `config_change` | `{key, original, effective, source, scope, caller}` | nothing | `api.on` | experimental | [Commands and composer](reference/commands-and-composer.md#configset) |
| `instructions_loaded` | `{kind, source, sha256, bytes, reason}` | nothing | `api.on` | experimental | [Lifecycle events](#lifecycle-events) |
| `thread_settings` | `{cwd, roots, model, effort, provider}` | nothing | `api.on` | frozen | [Lifecycle events](#lifecycle-events) |
| `worktree` | `{phase, path, owner}` | nothing | `api.on` | experimental | [Lifecycle events](#lifecycle-events) |
| `mods_changed` | `{active}` | nothing | `api.on` | experimental | [Lifecycle events](#lifecycle-events) |
| `peer_message` | `{id, from, to, correlation, untrusted, data, sent_at_ms}` | nothing | `api.on` | experimental | [Peers, power holds and mod-started turns](reference/sessions-and-turns.md#peer-message-authentication-and-delivery) |
| `peer_receipt` | `PeerReceipt` | nothing | `api.on` | experimental | [Peers, power holds and mod-started turns](reference/sessions-and-turns.md#peer_receipt-events) |
| `turn_queue` | `{key, status, reason?, turn_id?}` | nothing | `api.on` | experimental | [Peers, power holds and mod-started turns](reference/sessions-and-turns.md#turnsqueued-turnsdequeue-and-turn_queue-events) |

### Thread and turn events

The capability each event needs is in [Capabilities](reference/capabilities.md). Unless noted, an event fires for the lead
thread only, not for subagents or mod workers.

#### `context`

`context {thread_id, turn_id, ledger}` (capability `context`) fires while the host assembles each lead turn's
context. A handler returns `{text}` or null.

- The host adds the text as a developer fragment labeled as subordinate context from that mod.
- `text` is at most 1,024 bytes (`context_limit`); a result without a string `text` fails with
  `invalid_context_result`.
- All mods' fragments share a 6 KiB budget; past it the host adds one omission note and drops the rest.
- With `api.replace('context')` only that mod's text is used.

#### `compaction`

`compaction {token_limit, context_window}` (capability `compaction`) fires once when the host resolves the session's
configuration. `token_limit` is the configured auto-compaction limit, or 90% of the context window.

A handler returns a `CompactionDecision`: a threshold number, `{threshold?, prompt?}` or null. A non-null answer
needs `api.replace('compaction')`.

- `threshold` sets the auto-compaction token limit. It is at least 256 and at most the configured limit. With no
  configured limit the cap is the context window, and with neither it is 1,000,000.
- `prompt` (non-empty, at most 16,384 bytes, no control characters except newline and tab) replaces the compaction
  prompt. With provider-side compaction it is not applied and the host reports a `compaction_prompt` diagnostic.

| Error | When |
| --- | --- |
| `invalid_compaction_decision` | The answer is not a number, an object of those fields or null |
| `mod_compaction_conflict` | A second mod also answers |
| `mod_compaction_failed` | The handler throws |
| `exclusive_replacement_registration_required` | A non-null answer without `api.replace('compaction')` |

How compaction itself is intercepted is in [History and compaction](reference/history.md).

#### `start`, `idle` and `stop`

Observe-only (capability `lifecycle`):

- `start` fires when the lead thread is ready. Its input is null.
- `idle` fires each time the lead thread goes idle. Its input is `{cause}`, Codex's idle reason as a string
  such as `Interrupted`.
- `stop` fires when the lead thread stops, after the host has cleaned up its sessions, agents and services. Its
  input is null.

#### `session`

`session {phase, thread_id, cause?}` (capability `middleware`, experimental) reports the same moments in one event
with `phase` `start`, `resume`, `idle` or `stop`. Only the `idle` phase has `cause`. It is observe-only: a
handler that returns a value fails with `observe_only_event_returned_a_value`.

#### `turn_start` and `compaction_start`

Observe-only (capability `lifecycle`):

- `turn_start {turn_id}` fires when a lead turn starts.
- `compaction_start {turn_id, trigger}` fires when compaction of the lead thread starts; `trigger` is `manual` or
  `auto`. Its result arrives as [`compaction_end`](reference/history.md#compaction-summarizers-and-results).

#### `tool_call`

`tool_call {call_id, agent_id, tool, arguments}` (capability `middleware`) fires before tool interception for every
function and freeform call of the lead thread, its subagents and workers. `agent_id` is null for the lead. It is
observe-only; to change a call, use a
[`tool` interceptor](reference/tools.md#tool-calls-through-interceptors).

#### `contract`

`contract` (capability `contracts`, experimental) fires after a contract's `complete` or `integrate` gate is checked:

- `{gate, outcome: 'passed' | 'refused', missing, candidate_sha256}`;
- `{gate: 'complete', outcome: 'refused', reason: 'unresolved_blocking_findings', outstanding_findings,
  candidate_sha256}` when blocking findings remain.

Gates and findings are in [Contracts and receipts](reference/contracts.md).

### Channels and timers (`events_v1`)

Channels pass data between mods in one thread, and timers deliver a `timer` event to the mod that set them. Both
need the `events` capability.

#### `events.publish`

`events.publish {channel, data, correlation?}` publishes under the caller's namespace. Subscribers declare channel
patterns in the manifest's `subscriptions.channels` and receive `channel` events in the publishing thread. Each
subscriber's queue contains at most 256 events and 1 MiB; past that the host drops the oldest queued events.

- Events whose originating thread is gone are dropped.
- Sequence numbers are independent per publisher/channel.

#### Channel counters

The host retains at most 256 channel counters per publisher and 4,096 process-wide. A new channel beyond either
limit fails with `channel_sequence_limit`, while existing channels remain publishable.

- A channel counter is the sequence number the host keeps for each publisher and channel. Each publication also
  reclaims the counters of any publisher that has no queued events and no successful publication in the last 15
  minutes. That publisher's next publication starts at sequence 1.
- Successful publication with no subscribers still counts as activity; rejected publication does not.
- Unsubscribing alone does not reset counters.

#### Callback delivery

- [Watches](reference/workspace-files.md#workspacewatch) and timers end when their mod is disabled or its source changes, and each
  delivery runs in the thread that registered it.
- A `channel`, `timer`, [`process_event`](reference/managed-processes.md#process-notifications) or watched `workspace_change`
  callback that changes its mod's state republishes the terminal view, so background results appear without waiting for
  the next turn.

#### Timers (`timers_v1`)

`events.schedule {key, delay_ms}` (`timers_v1`) delivers one `timer` event `{key}` to the calling mod after
`delay_ms`, which is 16 ms to 24 h.

- Scheduling a key again replaces it within that thread.
- `events.cancel {key}` stops only that thread's timer.
- There are 16 timers per mod by default (`timers_per_mod` in [Host limits](reference/limits.md#host-limits)) across all
  threads, including ticks pending delivery.
- Require `timers_16ms_v1` for delays below 1000 ms.
- Deliveries are spaced at least 16 ms apart per mod and thread. Each one is a full callback, so draw animation from
  a component module's frame clock instead.
- Pending ticks with the same key coalesce. While one mod's timer waits for its callback budget, other mods' timers
  still fire.
- A timer never starts a turn by itself; only [`turns.queue`](reference/sessions-and-turns.md#turnsqueue) under an `autonomous`
  grant can.

#### `api.time` helpers

- `api.time.sleep(ms)` calls `time.sleep {ms}` (experimental, capability `events`, at most 60 s). The callback waits
  in place without a runtime lock, and the wait doesn't count as its own JavaScript time. Cancellation wakes it and
  ends the callback.
- `api.time.wait(check, {interval_ms, timeout_ms})` polls `check` between sleeps within the 512 host calls.
- `api.time.after(key, delay_ms, handler)` and `api.time.every(key, interval_ms, handler)` register during
  activation and return `{start(), cancel()}`. The delay or interval is 16 ms to 24 h. Both helpers call
  `events.schedule` and `events.cancel` with the key `time:<key>`.
- `every` reschedules after each handler run until `cancel()`, the handler returns `false`, or a reload with
  changed source, disable or session end drops it (the host timer limits apply).
- A mod uses these or its own `on('timer')`, not both.

Where `time.sleep` is unavailable:

| Callbacks | Result |
| --- | --- |
| Callbacks that run with the runtime lock, except in offline test steps | `time_sleep_unavailable` |
| Render, `terminal`, `command_list`, `config_list`, `tool_specs`, `agent_offers`, `admission`, `composer_edit`, `composer_key`, `component_change` and `history_persist` callbacks, which run without host operations | `host_operation_unavailable` |
| `model_request`, `model_send` and `response_stream` interceptors, which run on the request path | `time_sleep_unavailable` |

[Offline scenarios](reference/authoring.md#offline-scenarios) handle `events.schedule` and `events.cancel` themselves.
`advance_time` fires due timers in order at their virtual times (the step returns `timers`), and `time.sleep` returns
at once.

### Lifecycle events and classic hooks (`lifecycle_events_v1`)

Lifecycle events report thread, instruction and worktree changes. `api.hook` maps the classic hook names, such as
`PreToolUse`, onto these events and interceptors.

#### Lifecycle events

Observe-only events (capability `lifecycle` unless noted), all for the lead thread:

- `tool_batch_end {turn_id, calls: [{call_id, tool, outcome}]}` (experimental) after every call one model response
  dispatched has settled.
- `instructions_loaded {kind, source, sha256, bytes, reason}` (experimental) when the host loads instructions.
  `kind` is `instructions` for AGENTS.md (`reason` `session_start`, or `refresh` when they change), `skill` for a
  skill (`reason` `explicit` or `implicit`) or `attachment` for a user attachment (`reason` `explicit`).
- `thread_settings {cwd, roots: {added, removed}, model, effort, provider}` with `before`/`after` values after the
  thread's working directory, workspace roots or model settings change.
- `worktree {phase: 'created' | 'removed', path, owner: 'agent' | 'tui'}` (experimental) for isolated agent worktrees
  and worktrees the terminal creates or removes.
- `mods_changed {active}` (`mods_changed_v1`, experimental) lists the ids of the active mods. It fires once when a
  process first loads its mods, and again after a reload adds or removes one. A mod can use it to prune data it
  stored for mods that are gone. Native mods reload at the next turn or surface call, so a mod turned off in `/mods`
  is reported then.
- `elicitation_result {server, request_id, action, content, by}` (capability `approvals`, experimental) after an MCP
  elicitation is answered. Password and write-only fields are `[redacted]`, and `content` is the string `[redacted]`
  when the host no longer has the request's schema.

#### `elicitation` interceptor

`api.intercept('elicitation', …)` (capability `approvals`, experimental) sees MCP form elicitations before the user is
asked:

```text
{thread_id, turn_id, server, request_id, mode, message, schema}
```

A handler may answer:

- `{accept: content}` (only declared fields and every required one);
- `{decline}`;
- `{cancel}`.

Passing it on asks the user. URL and user-verification elicitations and forms with password or write-only fields
are never offered to mods.

#### `api.hook`

`api.hook(name, [options], handler)` adapts the 33 classic hook names onto these events and the existing events and
interceptors. Every classic hook is experimental in the conformance registry.

| Classic hook | Event or interceptor |
| --- | --- |
| `PreToolUse` | `tool` |
| `PostToolUse`, `PostToolUseFailure` | `tool_result` |
| `PostToolBatch` | `tool_batch_end` |
| `PermissionRequest` | `approval` |
| `PermissionDenied` | `approval_result` |
| `UserPromptSubmit` | `input` |
| `UserPromptExpansion` | `prompt_expanded` |
| `SessionStart`, `SessionEnd` | `session` |
| `Setup` | `start` |
| `Stop`, `StopFailure` | `turn_stop` |
| `SubagentStart`, `SubagentStop` | `agent` (model-spawned) |
| `TaskCreated`, `TaskCompleted` | `agent` (other workers) |
| `TeammateIdle` | `idle` |
| `PreCompact` | `compaction` |
| `PostCompact` | `compaction_end` |
| `PreModelSwitch` | `model_request` |
| `PostModelSwitch`, `CwdChanged`, `DirectoryAdded` | `thread_settings` |
| `ConfigChange` | `config_change` |
| `InstructionsLoaded` | `instructions_loaded` |
| `FileChanged` | `workspace_change` |
| `WorktreeCreate`, `WorktreeRemove` | `worktree` |
| `Elicitation` | `elicitation` |
| `ElicitationResult` | `elicitation_result` |
| `MessageDisplay` | `model_response` |
| `Notification` | `app_notification` |

#### Hook handler input and delivery

The handler receives:

```text
{hook, event, subject, thread_id, turn_id, origin, generation, original, effective, delivery}
```

`options.match` filters the hook's subject (for example the tool name) with exact values, arrays, regular
expressions, `api.match.glob(pattern)` and `api.match.not(matcher)`, which also work in interceptor `match`
options.

- Interceptor-backed hooks may be `required` and may return an answer such as `{deny}` or `{continue}`; returning
  nothing passes the call on.
- Event-backed hooks are delivered best-effort (`delivery: 'optional'`).
- A mod that uses a hook cannot also register the same native event itself.
- Hooks may be registered only during activation. Several hooks that map to the same native event share one
  registration of it.

## Contracts and receipts

A contract is a versioned document that gates task completion and workspace integration on receipts. Mods register
documents; users select one.

Use it when a mod registers a workflow contract, submits receipts, checks the completion or integration gate, or
narrows operations for the rest of a session. The agents that produce receipts are in [Agents](reference/agents.md).

Entries are frozen in Mod API `1.0.0` unless marked experimental (see the
[registry table](reference/stability-and-migration.md#experimental-entries-in-the-registry)). Runs on Apple Silicon macOS.

### Registering a contract

`api.contract(document)` registers a versioned schema-2 contract document:

```text
{schema: 2, id, version, description, assurance, gates: {complete?, integrate?}, restrict?}
```

Each gate, `complete` and `integrate`, lists requirements. A requirement names a receipt kind, a producer (`any`,
`lead`, `host`, `integration` or `separate_agent`), bindings (`candidate`, `acceptance`) and whether blocking findings
are allowed.

- `assurance` is a label of 1 to 64 characters of `a-z`, `0-9`, `_`, `-` and `.`. Confirmations show it when a
  selection lowers assurance.
- `restrict` lists up to 16 host operations that the contract refuses for the session
  (`contract_restricted_operation: OPERATION`).
- One contract is weaker than another when its gates don't cover every requirement of the other, or its `restrict`
  leaves out one of the other's operations.

### Selecting a contract

Users select a contract in one of three ways:

- `omd-package contract select ID@VERSION` in the repository;
- `omd-contract select STORE REPOSITORY ID@VERSION`;
- from the terminal, through a mod that calls `contract.select {contract}` from a user action (capability
  `contracts`).

```text
contract.select {contract} → {selected, applies: 'next_session'} | {status: 'declined'}
```

`contract.select` shows a native confirmation that names the `assurance` labels when the choice is weaker than the
current contract, then writes the same user selection that the commands above write. It applies from the next session.

- `omd-contract require` records a project floor in `.omd/contract-selection.json`, the weakest contract the
  repository accepts. A weaker selection doesn't apply; the floor does.
- Selections pin the document digest. A mod that changes a registered document makes the selection unavailable
  instead of silently weakening it.
- A weaker selection needs the confirmation printed by `omd-contract plan`.
- With no selection nothing is gated.
- An unavailable selection fails closed.

### `receipts.submit`

`receipts.submit` records a receipt with a host-attested producer.

```text
receipts.submit {kind, candidate_sha256, acceptance_sha256?, outcome: 'pass' | 'fail', evidence, agent?, execution?,
                 findings?, resolves?} → Receipt
```

- `agent` must be an agent handle that:
  - is completed and read-only;
  - belongs to the caller in the same session;
  - was spawned on a [snapshot](reference/workspace-files.md#snapshots-workspacesnapshot) of the receipt's candidate.
- `evidence` must be that agent's result reference.
- A claimed `acceptance_sha256` must equal the evidence the agent was given.
- An isolated-worktree agent cannot attest its own candidate.
- Only a successful `workspace.integrate` can record an `integration` producer; an execution receipt cannot
  impersonate one.

### Completion and integration gates

`task.complete {candidate_sha256, acceptance_sha256?}` checks the current workspace against the `complete` gate and
returns `completed` or `refused` with the missing requirements.

[`workspace.integrate`](reference/agents.md#workspaceintegrate) checks the `integrate` gate against the agent's candidate
(`candidate_sha256` from `agents.result`) and records an integration receipt tied to the resulting parent candidate and
the supplied acceptance digest.

- It refuses before touching the parent when the contract can't accept another receipt.
- If the receipt can't be recorded after the files are applied, the result is still `integrated` and contains
  `receipt_error`.

Pass `acceptance_sha256` to `task.complete` or `workspace.integrate` when the selected contract binds receipts to
acceptance criteria.

### Blocking findings and the finding ledger

A receipt can report `findings`, each identified by a `fingerprint` and with a severity of `advice`, `warning` or
`blocking`. For an active contract, blocking finding fingerprints remain open across later receipts and candidate
changes. `contract.status.finding_ledger` reports each finding and its resolution.

A passing `receipts.submit` from a completed, host-attested agent may include `resolves: [fingerprint, ...]` for at
most 32 distinct open findings. A resolving receipt must meet all of these:

- The candidate changed since the finding.
- The acceptance digest is the original one.
- The agent:
  - was spawned read-only from a frozen snapshot;
  - is different from the reporting agent;
  - was given `resolution_context: {acceptance_sha256, findings}` and the matching acceptance evidence.
- The agent's JSON result has a top-level `resolution_assertion` with `outcome: "pass"`, `candidate_sha256`,
  `acceptance_sha256` and the exact fingerprint set.

The host delivers the open finding details to the resolving agent, binds the context to it, and checks the
assertion before accepting `resolves`. The host attests only that an independent agent produced the result with that
review context. Whether the fix addresses the finding is the agent's judgment.

- Submitting a clean later receipt does not erase an earlier blocker.
- The ledger survives explicit resume and is replay-checked on restore.
- `task.complete` refuses while any blocker remains, returning `reason: "unresolved_blocking_findings"` and
  `outstanding_findings`.
- A session without a selected contract remains ungated.

### Scoped restrictions

`contract.restrict {operations?, scoped?, reason}` only narrows operations for the rest of the session. It can also
narrow matching arguments. Each scoped rule is
`{operation, when: {"/json/pointer": scalar}}`; all predicates must match.

For example, restricting `agents.spawn` when `"/workspace"` equals `"isolated_worktree"` leaves read-only agents
available.

- There are at most 64 rules with 1–8 scalar predicates each.
- Restrictions only narrow: a later restriction never widens an earlier one.
- Saved rules are validated again on restart.

### Contract withdrawal and persistence

The host rechecks the selected document at each turn start and after a mod fails. If no active mod still registers
the same document digest, the contract becomes unavailable (`contract_withdrawn`). Completion, integration and
receipts fail closed until the same document is registered again.

Contract receipts and restrictions survive restart in protected session state. The selected document and owner must
still match; invalid state fails closed.

## Agents

Use it when a mod spawns and manages worker agents, registers agent definitions, watches the agents of a session,
intercepts spawns or integrates a worker's changes. Receipts that agents produce for a contract are in
[Contracts and receipts](reference/contracts.md).

Mod API `1.0.0`: `agents.spawn`, `agents.wait`, `agents.result`, `agents.cancel` and `agents.inventory` are frozen;
`agents.message`, `agents.list`, the spawn `model` field and the entries marked below are experimental. Platform:
Apple Silicon macOS.

### `agents.spawn`

`agents.spawn` (capability `agents`) starts a read-only or isolated-worktree agent on a worker route under the
session's worker limits.

```text
agents.spawn {role?, route?, prompt, definition?, workspace?, tools?, evidence?, snapshot?, parent_history?,
              resolution_context?, model?}
```

#### `agents.spawn` arguments

| Argument | Meaning |
| --- | --- |
| `role` | 1 to 64 bytes |
| `route` | A worker route, or a lead route of a registered provider ([Choosing a route](reference/routes.md#choosing-a-route)); the agent runs under `worker_limits` |
| `prompt` | 1 to 8,192 bytes |
| `definition` | A registered [agent definition](#agent-definitions); it supplies the route when `route` is absent |
| `workspace` | `read_only` (default) or `isolated_worktree`; see [Worker workspaces, tool lists and integration](#worker-workspaces-tool-lists-and-integration) |
| `tools` | The child's tool list; see [Worker workspaces, tool lists and integration](#worker-workspaces-tool-lists-and-integration) |
| `evidence` | A stored evidence reference delivered to the agent |
| `snapshot` | A frozen copy from [`workspace.snapshot`](reference/workspace-files.md#snapshots-workspacesnapshot) for the agent to work on; see below |
| `parent_history` | `true` delivers the parent conversation; see [Parent history](#parent-history) |
| `resolution_context` | `{acceptance_sha256, findings}` for a worker that resolves contract findings ([Contracts and receipts](reference/contracts.md)) |
| `model` | Experimental. Another model from the provider's runtime catalog on a provider lead route; rates and billing stay the route's |

A `snapshot` agent:

- needs `fs.read`;
- is always `read_only`;
- returns a result that identifies the captured candidate and can't be integrated as an edit.

Permissions are rechecked when the agent starts.

#### `agents.spawn` result

```text
{handle, route, permissions: 'read_only' | 'isolated_worktree', parent_history?: {sha256, bytes, items, revision}}
```

#### `agents.spawn` errors

| Error | When |
| --- | --- |
| `agent_prompt_or_role_limit` | `prompt`, `role` or `route` is empty or over its limit |
| `unknown_agent_definition: <name>` | `definition` names no registered definition |
| `agent_definition_unavailable: <name>` | The definition's mod reloaded or was disabled |
| `agent_definition_route_required` | Neither `route` nor the definition names a route |
| `unsupported_agent_workspace` | `workspace` is another value |
| `snapshot_agents_are_read_only` | `snapshot` with `workspace: 'isolated_worktree'` |
| `read_only_tool_surface_invalid` | A `read_only` child lists a tool other than `exec_command`, `write_stdin` or `web_search` |
| `worker_route_requires_grant` | The worker route has no grant for the mod |
| `worker_route_authority_exceeded` | The route limits tools, and the spawn asks for an `isolated_worktree` or a tool outside that list |
| `agent_model_not_in_route_provider_catalog` | `model` is outside the provider's catalog |
| `agent_model_requires_provider_lead_route` | `model` differs from the route's on a route that is not a provider lead route |
| `agent_history_limit` | `parent_history` is over 8,192 records or 1 MiB |
| `mod_agent_limit` | The host already has 16 agents |

#### `agents.spawn` example

```ts
const agent = api.host.call('agents.spawn', {
  role: 'investigator', route: 'inspector', prompt: 'List the failing tests.', workspace: 'read_only', tools: [],
});
const result = api.host.call('agents.wait', { handle: agent.handle });
```

### Agent handles and limits

| Operation | Arguments | Result |
| --- | --- | --- |
| `agents.wait` | `{handle, consume?}` | `AgentResult`; waits at most 30 s, then returns `{status: 'running'}` |
| `agents.result` | `{handle, consume?}` | `AgentResult` without waiting |
| `agents.message` (experimental) | `{handle, message}` (1 to 8,192 bytes) | `{delivered}` |
| `agents.cancel` | `{handle}` | `{cancelled}` |
| `agents.list` (experimental) | none | `[{handle, finished, consumed}]` |

`AgentResult` is `{status: 'running'}`, `{status: 'failed', error, failure?}` or `{status: 'completed', text,
consumed, evidence, candidate_sha256?, changed_paths?}`.

- These operations address only the caller's handles; another handle fails with `unknown_or_foreign_agent`.
- `agents.message` fails with `message_limit`, `agent_finished` or `agent_not_running`.
- Calls on one handle run in order; a wait on one handle does not block calls on another.
- The host keeps at most 16 agent handles, counting spawns in progress.
- Agent handles last until cancelled, the mod is disabled or fails, or the session stops.

### Parent history

`parent_history: true` also requires `sessions` and `sessions_tools` and delivers frozen parent
conversation records including visible tool calls and outputs. It refuses more than 8,192 records or 1 MiB instead
of silently truncating them.

- The spawn result includes the history digest, byte count, item count and revision.
- The records are labeled untrusted task data.

To keep the same history as evidence without spawning, use
[`sessions.snapshot`](reference/threads-and-sessions-store.md#sessionssnapshot).

### Agent failure details

When an agent fails, `agents.result`, `agents.wait` and the `agent_end` event include an optional
`failure: {category, code, message}` taken from the host error. The same object is the `error` field of a `turn_end`
event, a `turns.activity` turn or an `agents.inventory` `last_turn` whose outcome is `error`. `reason` is set only for
an abort.

| Field | Meaning |
| --- | --- |
| `category` | `transport`, `rate_limit`, `authorization`, `sandbox`, `allowance`, `invalid_request` or `unknown` |
| `code` | Preserves the structured protocol error |
| `message` | Bounded to 1,024 characters |

A missing `failure` means the cause is unknown. It isn't evidence of an outage. Retrying is up to the mod. The host
only applies admission.

### Native subagents

These rules apply to children the model spawns with Codex's multi-agent V2 tools (`spawn_agent`, `wait_agent`,
`send_message`). Threads on multi-agent V1 keep upstream Codex behavior.

#### Completion wake

These rules set when a parent runs again after its children report.

- When a child's result reaches an idle parent (the root or another child), the parent starts one turn about 500 ms
  after the last result. That turn reads every queued result.
- A parent that was interrupted, or is in Plan mode, stays idle.
- A result over 16 KiB is cut, with a pointer to `list_agents`.
- A `wait_agent` that times out tells the model to end its turn.

#### Forwarding

These rules set where a child's questions and requests go.

- A child's approval, permission or MCP elicitation request goes to the parent's mailbox. Only the user can answer it.
- A child's `request_user_input` question is queued in the parent's mailbox and read at the parent's next turn. It
  doesn't start a turn.
- The TUI shows "Waiting on you in <thread>", and the user can answer at any time.
- The parent's next `send_message` or `followup_task` to that child also answers it, prefixed with "Your parent
  replied; its message follows."
- The question card stays until the child's turn ends.

#### Caps

Every model `spawn_agent` counts against `host.json` `limits.max_depth` (default 2) and `limits.concurrent_workers`
(default 4) and is refused with `subagent_depth_limit` or `subagent_concurrency_limit`
([Host limits](reference/limits.md#host-limits)). These apply in addition to Codex's `agents.max_threads`.

### Agent definitions, inventory and spawn interception (`agent_lifecycle_v1`)

Definitions name reusable agents, `agent_spawn` interceptors rewrite spawns, and `agents.inventory` and the `agent`
event report every agent of the session.

#### Agent definitions

```text
api.agent({name, description, instructions, route?, effort?, tools?, offer?})
```

`api.agent` registers up to 8 definitions per mod during activation, named `<mod>/<name>`. A configured or built-in
role with the same name takes precedence over a definition.

With `offer: true` the definition appears in the native `spawn_agent` role list. `agent_offers` interceptors
(experimental) run first. They may drop or re-describe offers but never add, rename or reassign one.

A model that names a definition, or a mod that calls `agents.spawn {definition, prompt}`, gets:

- the definition's instructions as subordinate developer instructions;
- its route: a lead route on the thread's own provider for native spawns, a worker route for mod spawns;
- its effort;
- when `tools` is set, only those tools: other tools are hidden from the child and refused if called
  (`agent_tool_denied`).

A definition that disappears with its mod's reload or disable can no longer be spawned
(`agent_definition_unavailable`). Running agents keep going and their inventory records keep the source digest.

#### `agent_spawn` interceptors

`agent_spawn` interceptors (experimental) see every model `spawn_agent` call and every mod `agents.spawn` as:

```text
{origin, caller, thread_id, agent_id, definition, prompt, model, effort, cwd, tools}
```

They may change:

- `definition` (retarget);
- `prompt`;
- `model`;
- `effort`;
- `cwd` (native spawns only: the session root or one of its `git worktree list` entries);
- `tools` (narrow only);

or answer `{deny}`.

- `next` runs the spawn and resolves `{agent_id, output, success}`. Outer handlers may rewrite `output` but not the
  identity or outcome.
- A `cwd` or `tools` change on a configured role is refused (`agent_spawn_override_requires_definition`): express
  it as a definition.
- After the transform the host validates the model and effort, and the child keeps the parent's permission profile.
  Nested tool and model calls of the child go through interception and admission as usual.
- A `model` that a provider registered (the spawn tool's model list names its provider) runs the child on that
  provider.
- The child needs a lead route on that provider, or the spawn fails with `agent_route_unavailable`.
- The child is admitted as a worker on that route under `worker_limits` and accounted at the route's rates. If
  admission fails, every request of the child is refused.
- Opaque reasoning and compaction items from the parent's history aren't sent to the child.
- With `agent_spawn` interceptors registered, native spawn calls reach them instead of `tool` interceptors.

#### `agents.inventory`

`agents.inventory` returns every agent of the session: model spawns, mod workers and subagents Codex starts itself
(`origin`). Each record contains:

- the parent thread and agent;
- the owner mod, definition and source digest;
- role;
- provider, model and billing basis, once known (experimental fields);
- status (`running`, `completed`, `failed`, `cancelled`);
- start and end time, and duration;
- turn count;
- the last turn's outcome and visible answer;
- the final visible answer (4,096 characters);
- usage, described below;
- the failure or cancel reason.

Usage is summed from `model_response` reports (`source: accounting`). `basis: unknown` means nothing was priced and
`partial` means some responses were unpriced. For Codex's own subagents outside OMD accounting, such as review,
usage is Codex's token totals (`source: engine`, request count and cost unknown).

A mod worker's `agent_id` is its handle. At most 64 finished records are kept.

#### `agent` middleware event

The `agent` middleware event delivers `{phase: 'start' | 'turn' | 'end', agent}` with the same record (its
`provider`, `model` and `billing` fields are experimental). Events arrive in order. Each one is delivered under the
state of the root thread, the session thread at the top of the agent's parent chain.

Observation grants nothing: `agents.message`, `agents.wait`, `agents.result` and `agents.cancel` still address only
the caller's own handles.

### Worker workspaces, tool lists and integration

`agents.spawn` accepts a host-authorized route and a `workspace` of `read_only` or `isolated_worktree`. A writable
child receives a captured, isolated worktree under the native task scratch area; its parent repository is never its
working directory. A `read_only` child may list `tools` from `exec_command`, `write_stdin`
and `web_search`; any other name fails with `read_only_tool_surface_invalid`. Only a `provider_billed` route allows
`web_search`: other routes refuse hosted tool declarations at the child's first request.

`agents.wait` and `agents.result` return a host-attested thread reference and SHA256 of the final text. A mod
should validate that text against its declared result schema and source-reference rules before calling
`agents.result` with `consume: true`. The host requires consumption before `workspace.integrate` accepts that mod's
private handle. How `workspace.integrate` checks a contract's `integrate` gate is in
[Completion and integration gates](reference/contracts.md#completion-and-integration-gates).

#### `workspace.integrate`

`workspace.integrate {handle, acceptance_sha256?}` runs these steps:

1. Captures the worker's changed paths.
2. Merges them against the current parent snapshot.
3. Runs the task's configured executable check on an isolated candidate.
4. Gets a candidate review.
5. Applies the exact checked delta.

It refuses on a conflicting parent edit, a changed candidate, a failed check or review, or a parent that changed
before apply. It returns `{status: 'integrated', candidate_sha256,
parent_candidate_sha256, changed_paths, evidence, receipt_error?}` or `{status: 'refused', candidate_sha256,
missing}`.

- The native ledger tracks allowance, permissions, lifecycle and evidence.
- A failed apply retains diagnostic evidence and may need operator inspection; external concurrent writers are not
  locked.
- Cancellation, a failed tool callback, mod disable or failure, and session stop retire the mod's handles and clean
  their worktrees; turn end does not.

## Peers, power holds and mod-started turns

Use it when a mod messages other live sessions, keeps the Mac awake, queues or continues turns on its own, or submits
prompts the user captured. Session on this page means a live session: one running `codex` process. Reading recorded
sessions, thread-scoped data and `turns.abort` are in [Thread data and recorded sessions](reference/threads-and-sessions-store.md).

Mod API `1.0.0`: every entry on this page is experimental. Platform: Apple Silicon macOS; `lid_closed` power holds
need the [authority broker](reference/protected-authority.md).

### Peer sessions (`peer_sessions_v1`)

Peer sessions are experimental: the `peers` capability, `peers.list`, `peers.send`, the `peer_send` and
`peer_receive` interceptors and the `peer_message` and `peer_receipt` events.

A mod with the `peers` authority grant declares `peer_access: {projects: "same" | "any"}` in its manifest. While at
least one loaded mod has the grant, each lead thread registers a peer session in the mod store (`peers/`). The
registration stays live as long as its process has the session lock.

#### `peers.list` and `peers.send`

`peers.list {package?}` lists other live sessions where that package (the caller by default) accepts messages.
Sessions in other repositories appear only when both packages declare `"any"`. It returns `{session, peers:
[{session, package, repository, same_project}]}`.

`peers.send {to, package?, data, correlation?, ttl_ms?}` writes the message to the recipient's mailbox and returns
`{id, status: 'queued'}`.

| Limit | Value |
| --- | --- |
| Data | at most 64 KiB |
| TTL | 1 s to 1 h, default 60 s |
| Waiting messages per recipient | 64 |

| Error | When |
| --- | --- |
| `peer_closed` | The recipient is closed |
| `peer_scope_denied` | The scope does not match |
| `peers_unavailable` | No broker is deployed; every peer operation fails closed |

#### Peer message authentication and delivery

The [authority broker](reference/protected-authority.md) countersigns every message and receipt. The signature covers the
canonical digest of the sender identity (session, repository, package and source digest), recipient, correlation,
data and expiry, so only pinned OMD binaries can mint one.

The recipient session:

- verifies the broker's countersignature tag;
- drops replays of a message id it already took;
- answers expired messages with `expired`;
- re-checks its own package's scope;
- runs `peer_receive` interceptors, which may transform `data` or refuse;
- calls the package's `peer_message` handler with `untrusted: true`.

Senders' `peer_send` interceptors may transform `data` or refuse before the message is written.

#### `peer_receipt` events

The sender's package gets `peer_receipt` events:

| Event | Meaning |
| --- | --- |
| `delivered` | The message was delivered |
| `refused` | The recipient refused it (with reason) |
| `failed` | The handler threw |
| `expired` | The message expired |
| `closed` | The recipient's time ran out without a receipt and its session is gone |

Receiving never starts a turn, changes roots or routes, or lends authority; a receiver that wants to act queues its
own work under its own grants. Revoking or expiring the grant, disabling the mod or stopping the session closes the
registration.

### Power holds (`power_hold_v1`)

Power holds are experimental: the `power` capability, `power.hold` and `power.release`.

A mod with the `power` authority grant can keep the Mac awake.

- `power.hold {reason, lid_closed?, max_duration_ms, lease?}` returns `{lease, lid_closed}`. Passing a `lease` that
  is still live with the same `lid_closed` returns it unchanged. Otherwise a new lease starts.
- `power.release {lease}` returns `{released}`. It is false when the lease already ended or belongs to another mod.
- Only event callbacks (lifecycle events, timers, channels) can call `power.hold`. Others fail with
  `host_operation_event_only`.

Every lease creates an idle-sleep assertion, so the Mac doesn't sleep from inactivity while the lid is open; the
display may still sleep. With `lid_closed: true` the lease also asks the authority broker to set `SleepDisabled`,
which keeps a closed Mac running on battery. Leases from every mod and OMD process share that setting. The first
lease records the previous value. When the last lease ends, the host restores that value and sleeps the Mac if the
lid is closed.

A lease ends at `power.release`, after `max_duration_ms`, when the session stops and when OMD exits or crashes. A
disabled, failed or changed mod loses its leases at the next host event in the session. If the broker or its helper
exits, the setting is restored and the lease ends, so holding again with that `lease` starts a new one.

| Limit | Value |
| --- | --- |
| `reason` | 1 to 128 bytes |
| `max_duration_ms` | 60 s to 24 h |
| Live leases per mod in a session | 4 |

| Error | When |
| --- | --- |
| `power_unavailable` | `lid_closed` without the deployed broker, or a broker installed before power holds (run `omd-package broker install` again); lid-open holds still work |
| `authority_power_unavailable` | The broker's power helper is not installed or could not change the setting |
| `power_lease_limit` | The mod already has 4 leases |
| `host_operation_event_only` | `power.hold` from a tool, CLI or component callback |
| `power_request_invalid` | `reason` or `max_duration_ms` is out of range |

### Autonomous turns (`autonomous_turns_v1`)

Autonomous turns are experimental: the `autonomous` capability, `turns.queue`, `turns.queued`, `turns.dequeue`, the
`turn_queue` event and `turn_stop` interceptors.

A mod with the `autonomous` authority grant declares:

```text
autonomy: {max_queued (1-16), max_turns (1-100), max_continuations? (0-4), spend_microusd?}
```

| Field | Range | Meaning |
| --- | --- | --- |
| `max_queued` | 1 to 16 | Entries the mod may have queued in a thread at once; more fail with `turn_queue_full` |
| `max_turns` | 1 to 100 | Queued turns the host starts for the mod in a thread; later entries are denied with `turn_budget_exhausted` |
| `max_continuations` | 0 to 4 | [`turn_stop`](#turn_stop-interceptors) continuations the mod may add per turn |
| `spend_microusd` | optional | Model cost of the mod's queued turns in a thread; once reached, entries are denied with `spend_budget_exhausted` |

#### `turns.queue`

`turns.queue {prompt, key, priority?, deadline_ms?}` works from any callback, including timers, channels and peer
messages, and queues the prompt for the caller's lead thread.

| Argument | Limit |
| --- | --- |
| `prompt` | 8 KiB |
| `priority` | `high`, `normal` or `low` |
| `deadline_ms` | 1 s to 24 h |

It returns `{key, status: 'queued' | 'duplicate', paused?}`. A key already queued by the same mod returns
`duplicate`.

#### How queued turns start

- The host starts the best entry (priority, then age) one second after the thread goes idle, through Codex's
  start-if-idle path. Typed input that arrives first wins, and the entry waits for the next idle.
- The turn's message begins with `[Queued by mod <id> on <event> (key <key>); not typed by the user]`, and its
  trigger is `mod:<id>`.
- The `prompt` event's `provenance` and the `input` interceptors' `origin` name the package, source digest,
  originating event and key.
- The turn keeps the thread's route, permissions and approvals.

#### `turns.queued`, `turns.dequeue` and `turn_queue` events

`turns.queued` lists the caller's entries, turns started and settled spend: `{paused, started, spent_microusd,
entries: [{key, priority, event, queued_at_ms, deadline_ms}]}`. `turns.dequeue {key}` removes one.

The owner gets `turn_queue` events:

- `started`;
- `expired`;
- `dropped`: `stale_generation` after a source change or unload, or `grant_expired`;
- `denied`: `turn_budget_exhausted` or `spend_budget_exhausted`;
- `failed`.

Interrupting a turn (Esc) pauses every mod queue of the thread until the user next sends input. Disabling the mod
or revoking its grant drops its entries.

#### `turn_stop` interceptors

`turn_stop` interceptors run when the model would end a lead turn, and after a lead turn fails without being
interrupted. They receive:

```text
{thread_id, turn_id, outcome, error, message, continued, limit, provenance}
```

`outcome` is `completed` or `error`.

Answering `{continue: prompt}` keeps the model sampling in the same turn, with the prompt added as a labeled
continuation. A mod gets at most `max_continuations` continuations per turn, and a turn gets at most 4 in total.
Continuations cannot mark verifiers passed or submit receipts.

### User prompt submissions (`user_submissions_v1`)

A mod with the `composer` capability can send text the user gave it as the user's own message, later.
`prompts.consent` records the user's consent to that exact text from a user action, and `prompts.submit` spends the
consent from any callback. `prompts.consent`, `prompts.submit`, `prompts.status` and `prompts.revoke` are
experimental.

#### `prompts.consent`

`prompts.consent {text, attachments?}` (61,440 bytes, at most 8 image resources) runs only in
[user contexts](reference/host-model.md#callback-contexts) (a command, key binding or user component action). It records a
single-use consent bound to the mod, the thread and the exact content.

- At most 64 consents are pending per mod and thread, and consents of mods that are no longer loaded are dropped.
- Consents are stored in the mod store outside mod state and are not copied into forks.

#### `prompts.submit`

`prompts.submit {consent, text, attachments?, mode, client_id?}` works from any context. It spends the consent on
exactly that content and submits it through the terminal's own path as a user message, under the thread's
permissions, route and spending.

- `mode: 'turn'` starts a turn when the thread is idle.
- `mode: 'steer'` steers the running turn.

It returns `{status: 'started' | 'steered', client_id}` or, without spending the consent, `{status:
'not_submitted', reason}`. A spent, changed or missing consent fails.

The `reason` values are:

- `busy`;
- `no_active_turn`;
- `session_starting`;
- `input_held`, while the terminal keeps its own queued input after a disconnect, an unconfirmed submission,
  rate-limit recovery or an unavailable thread.

#### `prompts.status` and `prompts.revoke`

`prompts.status {consent}` is one of:

- `pending`;
- `missing`;
- `delivered`: the message with that `client_id` was committed to the thread, also when replayed on resume;
- `unconfirmed`: spent, but no commit seen.

A caller can use it to reconcile an uncertain submission instead of sending twice. `prompts.revoke {consent}` drops
one.

A consent never grants autonomous authority: anything not captured by the user still needs `autonomous`.

## Credentials

Use it when a mod needs a token or a secret: enrolling credential profiles and secrets, the origin each one is
bound to, how sidecars reach credentials through the gateway, and the `omd-mod credentials` command. Host features:
`credentials_v1`, `secrets_v1`. How `http.request` attaches a credential is in
[Authority grants](reference/authority-grants.md#httprequest-redirects-and-credentials).

Entries are frozen in Mod API `1.0.0` unless marked experimental (see the
[registry table](reference/stability-and-migration.md#experimental-entries-in-the-registry)). Runs on Apple Silicon
macOS; the broker that keeps credentials off disk is described in [Protected authority](reference/protected-authority.md).

### Credential profiles and secrets

A credential profile is an enrolled token (ChatGPT sign-in, an API key or a provider key) bound to one origin. A
secret is a credential profile of kind `secret` that belongs to one mod.

`credentials.list` returns profiles without secret material, with `status` `ready` once enrolled. It lists a secret
only to the mod it belongs to.

`credentials.request` opens a native flow from [user contexts](reference/host-model.md#callback-contexts):

- ChatGPT sign-in;
- masked API-key entry;
- refresh;
- removal;
- `{kind: 'secret', label, origin}`, which enrolls an origin-bound secret owned by the calling mod.

- Labels are unique in the store, so enrolling an existing label fails with `credential_profile_label_exists`.
- `{action: 'refresh', profile}` on the mod's own secret asks for a new value and replaces it.
- A mod can remove only its own secrets, and the confirmation names the profile's kind and label.

### Route credentials and sidecar secrets

A [route entry](reference/routes.md#route-fields) in `host.json` may name a `credential`. The host replaces the request's
authorization with that credential's token after upstream authentication. A missing or expired credential blocks the
request. Choosing a route is in [`routes.select`](reference/routes.md#routesselect).

A mod's own secrets reach its [sidecars](reference/routes.md#sidecars) as `OMD_SECRETS`, never the mod's runner or the model.
Credential tokens reach a sidecar only through the [credential gateway](#credential-gateway).

### Credential origins

Every credential profile sends its token to one origin, fixed at enrollment:

| Profile kind | Origin |
| --- | --- |
| `chatgpt` | `https://chatgpt.com` |
| `api_key` | `https://api.openai.com` |
| `provider` | The `https` origin passed as `origin` to `credentials.request {action: 'enroll', kind: 'provider', label, provider?, origin}`, which the enrollment prompt shows |

The host injects a route `credential` only into requests whose URL has that origin. A route whose URL has another
origin fails with `credential_origin_mismatch`.

### Credential gateway

Sidecars never receive credential tokens. When a sidecar's [service grant](reference/glossary.md#trust-and-authority) lists
profile ids in `credentials`, and the grant allows network, the sidecar gets `OMD_CREDENTIAL_GATEWAY`. It is a
loopback URL with a per-sidecar secret path, and it closes when the sidecar stops.

The gateway sends a request to `$OMD_CREDENTIAL_GATEWAY/PROFILE/PATH` over HTTPS to `PATH` on that profile's origin and
streams the response back. It adds `Authorization: Bearer`, or `x-api-key` when the request sets
`x-omd-credential-header: x-api-key`. Redirects aren't followed. Stopping the sidecar cancels its in-flight gateway
requests and streams.

| Gateway limit | Value |
| --- | --- |
| Connections, globally | at most 16 |
| Forwards per registration | four |
| Connection and inactivity timeout | 30 seconds |
| Total deadline | 10 minutes |

### `omd-mod credentials`

`omd-mod credentials STORE` lists profiles without secrets.

`omd-mod credentials STORE add-secret MOD_ID LABEL ORIGIN` reads a value from stdin and stores it as a secret owned by
`MOD_ID` for `ORIGIN`, the same profile `credentials.request {kind: 'secret'}` creates. If that mod already has a secret
with the same label and origin, the command replaces its value. It prints the profile. When the
[authority broker](reference/protected-authority.md) is deployed, it asks for broker authorization. Package setup scripts use it
to enroll a key without writing it to disk.

## Thread data and recorded sessions

Use it when a mod cancels a turn, keeps data per thread, reads what happened in recent turns, reads recorded
sessions (a thread's saved history, not a live `codex` process) or keeps the current conversation as evidence.
Messaging live sessions and starting turns are in [Peers, power holds and mod-started turns](reference/sessions-and-turns.md).

Host features: `store_thread_v1`, `turn_activity_v1`. The thread-scoped `store.*` operations are in
[State and storage](reference/state-and-storage.md#store-operations).

Mod API `1.0.0`: every operation on this page is frozen. Platform: Apple Silicon macOS.

### `turns.abort`

`turns.abort {turn_id}` (capability `threads`) requests cancellation of the named active turn in the current thread
from a user or event callback. Require `turn_abort_v1`.

- `{accepted: true}` means cancellation was accepted, not that cleanup has completed.
- A stale or absent turn, queued input or competing cancellation returns `accepted: false`.
- Tool callbacks cannot call it, and it cannot target another thread.
- Successful cancellation wakes idle listeners after cleanup.

```ts
api.on('turn_start', e => {
  const { accepted } = api.host.call('turns.abort', { turn_id: e.turn_id });
});
```

### Thread-scoped store and `resume`

`store.*` accepts `scope: 'thread'`: data forks with the thread, is removed when the thread is deleted and kept
when it is archived.

The `resume` event fires when the lead thread is resumed.

- `last_turn` is the last turn in the [turn activity](#turnsactivity) log as `{turn_id, status}`, with `status`
  `completed`, `interrupted`, `failed` or `in_progress`. It is null when there is none.
- `restarted` is true when this process hadn't run the thread before, and false when the same process resumes it
  again.

### Explicit thread resume

When a saved thread is resumed, the host reopens that thread's task [ledger](reference/routes.md#ledger) instead of starting a
new one. The ledger keeps its requests, exposure, observed lead usage and uncertain in-flight requests.

- Repository, thread identity, original limits and saved journal must validate.
- Reopening a ledger without a resume, changed limits and completed tasks are refused.
- Agent handles and snapshot handles don't survive a process restart. A mod must reconcile saved pending work
  without silently spawning replacements.

### `turns.activity`

`turns.activity {thread_id?, turn_id?, last?}` reads turn outcomes, tool calls, processes and file changes for the
current thread. Event, tool and terminal slash command callbacks can call it. The host records activity only while
the source of at least one enabled mod contains a `turns.activity` call. It returns `{turns, recording}`, and each
turn has:

| Field | Meaning |
| --- | --- |
| `turn_id`, `started_at`, `ended_at` | The turn and its times |
| `outcome` | `completed`, `aborted`, `error`, `interrupted`, `running` or `unknown`, with `reason` and `error` |
| `unrecorded_end` | The turn ended while nothing was recording |
| `tool_calls` | `{call_id, tool, started_at, finished_at, outcome, output_replaced?}` |
| `processes` | `{id, kind: 'exec' \| 'managed', command, running, exit_code}` |
| `files` | `{path, before, after, source}` |
| `truncated` | The turn's lists were cut |

- File changes come from the same workspace observer as `workspace_change`, which rereads only files whose size,
  ctime or inode changed.
- Commands record their exit code when they finish, including commands that outlive their tool call.
- The log is removed when the thread is deleted.

```ts
const { turns, recording } = api.host.call('turns.activity', { last: 1 });
```

### `sessions.list`

`sessions.list {since?, until?, cursor?, limit?}` pages this repository's recorded sessions that allow memory (Codex
memory mode `enabled`). It returns `{sessions, cursor, revision, scan_truncated, unavailable, projection}`; each
session has `session_id`, `task_id`, `parent_id`, `timestamp`, `revision`, `handle`, `history_mode`,
`inherited_history` and `incomplete_tail`. Pass a session's `session_id`, `revision` and `handle` to `sessions.read`.

### `sessions.read`

`sessions.read {session_id, revision, handle, cursor?, max_bytes?}` pages one session's
`local_visible_records` and returns `{session, records, cursor, bytes, projection, projection_truncated}`:

| Record | Fields |
| --- | --- |
| `message` | `role`, `text` |
| `tool_call` | `name`, `call_id`, `arguments` |
| `tool_result` | `call_id`, `output` (text parts only) |

- The host replaces each credential line in a record with `[redacted]`, keeps line endings and sets `redacted`.
  Credential lines are lines:
  - naming a credential (`Authorization:`, `api_key`, `password=`, …);
  - assigning a secret-like name (`TOKEN=…`, `"secret": …`, `AWS_SECRET_ACCESS_KEY=…`);
  - containing a known token prefix (`sk-`, `ghp_`, `AKIA…`) or URL credentials (`scheme://user:password@`);
  - inside private-key blocks.
- A record over 2,048 characters is cut and gets `truncated`.
- Without the `sessions_tools` capability, tool records contain `bytes` and `sha256` of their arguments or output
  instead of the text.
- Reasoning and other item types are left out.
- A page contains at most 16 KiB. A session returns at most 4,096 records, keeping the oldest, and sets
  `projection_truncated` when it cuts more.
- A changed rollout fails the read against its `revision`.
- `sessions.list` and `sessions.read` serve mod CLI commands (`api.command(name, …, {cli})`) and `context`
  callbacks, not terminal slash commands.

### `sessions.snapshot`

`sessions.snapshot {call_ids?}` (capabilities `sessions` and `sessions_tools`) preserves the current thread's
committed conversation records, including visible tool calls and outputs, in a caller-bound evidence reference. It
returns `{evidence, provenance: {sha256, bytes, items, revision}}`. Reading the evidence with `evidence.read` needs
`store`.

- `call_ids` selects 1 to 32 unique call ids, and the selection must include each complete call and output pair.
- Evidence storage's 256 KiB limit still applies.
- This does not expose hidden reasoning.
- [`agents.spawn {parent_history: true}`](reference/agents.md#parent-history) delivers the same history to a worker.

| Error | When |
| --- | --- |
| `history_call_selection_invalid` | `call_ids` is empty, over 32, has duplicates or an id over 128 bytes |
| `history_call_or_output_missing` | A selected call lacks its call or its output |

```ts
const history = api.host.call('sessions.snapshot', { call_ids: ['warmup'] });
```

### Session reads and the SQLite home

This section is for operators who move Codex's state database: it says where session reads look for SQLite.

Live session reads use the runtime's configured state database, including a separate SQLite home. Standalone
commands, mod CLI commands run with `omd COMMAND --repo PATH`, resolve the selected user configuration/profile and
`CODEX_SQLITE_HOME`; `--sqlite-home` explicitly selects the state directory.

- If a repository or system configuration redirects SQLite, a standalone command requires that explicit directory
  rather than guessing.
- Relative SQLite directories are rejected.
- The reader opens `state_5.sqlite` read-only before and after a read, and doesn't modify transcripts or memory
  opt-out state.

## Routes

Use it when a mod chooses, adds or writes model routes, settles provider-billed requests, reads the ledger, or runs
a provider service. Route credentials and origins are in [Credentials](reference/credentials.md); intercepting a single
request is in [Model requests and streams](reference/model-requests.md).

Entries are frozen in Mod API `1.0.0` unless marked experimental (see the
[registry table](reference/stability-and-migration.md#experimental-entries-in-the-registry)). Runs on Apple Silicon macOS.

### Route fields

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
| `credential` | A credential profile whose token authorizes its requests; see [Credentials](reference/credentials.md#route-credentials-and-sidecar-secrets) |
| `data` | Any JSON up to 2 KiB for the route's provider mod, ignored by the host; see [Route writes](#route-writes-route_write_v1) |

`rates` also accepts optional `cache_write_microusd_per_million` and `provider_billed` (see
[Provider-billed routes](#provider-billed-routes-provider_billing_v1)). `external_subscription` marks a subscription
billed outside OMD. Its settled charge counts toward the ledger's list-equivalent total
(`subscription_list_equivalent_microusd`) instead of the task charge (`settled_task_charge_microusd`), and the route
needs a grant.

### Choosing a route

- [`routes.list`](#routeslist) returns the routes visible to the calling mod, plus `data` on the caller's own routes
  ([route writes](#route-writes-route_write_v1)).
- [`routes.select`](#routesselect) applies a lead route to the next request or the thread.
- The `routing` replacement returns `{route}` to choose a configured lead route at thread start.
- A `model_request` interceptor switches one request among the thread's lead routes (see [Model requests and
  streams](reference/model-requests.md#model-requests-and-streams-model_turn_interception_v1)).
- `agents.spawn.route` names one of:
  - a worker route. It needs a grant file whose hash, repository (or one of its `repositories`), provider, model and
    URL are rechecked on every request.
  - a lead route of a registered provider (its model is in that provider's runtime catalog) whose `mods` is empty or
    lists the caller. That agent is admitted like a cross-provider native child, with no grant.
- [`routes.add`](#routesadd) adds a worker route on the user's ChatGPT plan for one mod.

### `routes.list`

```text
routes.list null → RouteInfo[]
```

`routes.list` (capability `model`) takes no arguments and returns the routes visible to the calling mod. Each
`RouteInfo` is `{name, model, provider, reasoning, roles, billing, tools, available, credential, data?}`; `billing` is
`included_subscription`, `explicit_paid_api_grant` or `provider_billed`, and `data` is experimental.

This call from the `coordination` example picks the worker routes on the user's subscription:

```ts
const routes = api.host.call('routes.list', null).filter(route => route.available && route.roles.includes('worker') && route.billing === 'included_subscription');
```

### `routes.select`

```text
routes.select {route, scope} → {route: RouteInfo, effective_at: 'next_request'}
```

`routes.select` (capability `model`) applies a configured lead route to the calling thread.

| Argument | Type | Meaning |
| --- | --- | --- |
| `route` | string | The name of a lead route the caller may use |
| `scope` | `'next_request'` or `'thread'` | Apply the route to the next request only, or to every later request of the thread |

The route takes effect from the next request. A lead route added to `host.json` after the thread started is
admitted when it is on the thread's provider ([route reload](#route-reload-route_reload_v1)).

| Error | When |
| --- | --- |
| `route_scope_invalid` | `scope` is neither `next_request` nor `thread` |
| `route_not_configured: ROUTE` | No lead route with that name is open to the caller; after an invalid `host.json` edit the message adds why |
| `route_unavailable_for_thread: ROUTE` | The thread has no lead route account, or the route is on another provider |

```ts
api.host.call('routes.select', { route: 'fast_lead', scope: 'next_request' });
```

### `routes.add`

`routes.add {mod}` (capability `packages`, user only) gives a mod a worker route on the user's ChatGPT plan. It asks
the user, then adds the worker route `plan-MODEL-MOD` for the conversation's model and effort. The route is open only
to `mod`, and the host adds this repository to its grant.

It returns `{route}`, or `{status: 'declined'}`. It refuses with `routes_add_needs_chatgpt` without a ChatGPT sign-in
or when the conversation's provider doesn't use it.

### Route reload (`route_reload_v1`)

Route lookups recheck `host.json` (`route_reload_v1`): an edited route list applies to new threads, `routes.list`
and `routes.select` without restarting.

- At each turn, worker start and `task.status`, the host applies edited `limits` and `worker_limits` and records
  them in the thread's ledger. Spend so far still counts. It also refreshes the rates, credential and model of routes
  a running thread already uses.
- Services, secrets and protected paths stay as loaded at start.
- An invalid edit keeps the previous routes and `routes.select` reports why.
- `routes.select` also accepts a lead route added after the thread started when it is on the thread's provider.

### Route writes (`route_write_v1`)

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

### Route grant files

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

### Provider-billed routes (`provider_billing_v1`)

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

### Ledger

Every lead and native subagent request is observed and recorded in the session ledger (`task.status`, the `ledger`
field of `context` and `terminal` events). The ledger a mod receives contains the cost totals, the newest 64
attempts and `observed_requests` (a count).

- Limits are enforced only on mod-initiated agents, and on the lead when its model matches a configured lead route
  with rates.
- OMD sessions use the observed HTTP Responses transport; WebSocket transport is disabled for their threads and
  refused if any request would use it.

### Sidecars

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
only through the [credential gateway](reference/credentials.md#credential-gateway).

Compare `started_at_ms` with a store entry's `provenance.at` to tell whether a store entry was written before the
sidecar last started.

#### Service launch snapshots

Sidecars, [provider services](#provider-services) and [request helpers](#request-helper-supervision) start from a
service grant. The host launches each one from a private, read-only snapshot of the package's loaded entrypoint and
assets, with their relative paths preserved. Original package paths are denied to the child.

A grant may include `code_roots`. Each entry maps a canonical dependency directory to the SHA-256 of its sorted JSON
`[relativePath, kind, value]` rows. `kind` is `file` with a content SHA-256 or `link` with an internal relative
target. Verified bytes are copied without reopening the source. `OMD_SERVICE_ROOT` names the snapshot root, under
which absolute dependency paths are mirrored.

Changed dependencies require a new grant. Reload and disable stop stale services before their ids can be reused.

#### Request helper supervision

A request helper is the program of a service grant that `sidecars.invoke {id, input}` runs once per call. The host
runs it under its bounded request supervisor. The supervisor captures a completed helper result before returning
it, then terminates the process group. Cancellation, the deadline or loss of the host also terminates the group.

Long-running services use a separate supervisor. The helper itself, which the mod supplies, does the request parsing,
remote protocols and content selection.

### Provider services

A provider service is a mod-owned service process that a routed `host.json` service grant runs as a model provider.

#### `providers.register`

- `providers.register {id, secrets?}` delivers the caller's own secrets to a provider service, as `sidecars.start`
  does.
- It reads the store's `host.json` services at call time, so a grant written during the session needs no restart.
- A routed grant with a loopback `responses_url` defines its `route.provider` for the process unless the
  configuration already defines it. The host does this at startup when the mod is active, and at each registration.
- A grant with exactly one secret uses it as the bearer token.
- A thread resumed after its provider is gone continues on the configured provider.

#### `models.context_window` (`model_context_window_v1`)

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

#### `providers.models`

`providers.models` puts a provider service's models in the `/model` picker.

- `providers.models {provider, name?, models}` lists up to 16 models
  `{slug, display, context_window, efforts, default_effort?}` in `/model`, grouped under `name` (1–64 bytes, default
  `provider`).
- It needs a running `providers.register` registration whose grant `route.provider` equals `provider`.
- Each call replaces that provider's list. Unregistering, a stopped service or disabling the mod drops it.
- It returns `{provider, models}`, where `models` is the count.

##### Switching to a provider's model

- The models get Codex's standard tools: shell, freeform `apply_patch`, tool search and multi-agent v2.
- Picking one switches the thread to that provider from the next turn.
- The thread keeps its history, except reasoning another provider produced.
- Codex replays an item id to the next provider only when the id contains `_`. Give items ids without `_`, and mark
  plaintext function arguments with `encrypted_function_args: []`.
- A compaction checkpoint that only another provider can read is first rewritten as a plaintext summary by that
  provider, in one request on its account. If that fails, the turn shows a warning and runs without the summary.

#### `providers.unregister`

`providers.unregister {id}` is the counterpart of `providers.register`. It stops the provider service, which drops the
provider's `providers.models` list, and returns `{stopped: true}`. It fails with `unknown_or_foreign_sidecar` for an id
this mod didn't start in its current generation.

#### Streaming providers

Mod-owned model providers need no additional primitive: a `services` grant with a `route` runs a loopback server
that Codex uses as a Responses provider, which streams normally. `max_request_bytes` in `host.json` bounds request
size and has no host maximum, so a provider's context window is configuration.

## Model requests and streams (`model_turn_interception_v1`)

Use it when a mod rewrites, reroutes, answers or watches model requests and their response streams. The policy
stage that runs on the exact bytes sent is [Final-request policy](reference/final-request-policy.md). A mod that calls a
model itself uses [One-shot model calls and forks](reference/model-calls.md).

Mod API `1.0.0`: the `model_request` and `response_stream` interceptors and the `model_response` event are frozen.
Platform: Apple Silicon macOS. OMD's tests cover only the configured fixture providers, not live routes.

Every lead, native subagent and mod worker request passes the `model_request` and `response_stream` interceptors
(capability `middleware`) before and while it streams; see the
[interceptor chain rules](reference/interceptors.md#registration-chain-and-failure-rules) for ordering, `required` and failure
rules.

### `model_request` input

- `request_id`: unique across processes, also sent as `x-omd-request-id`.
- `attempt`: 2 or 3 after a mod's stop-and-retry.
- `scope {thread_id, agent_id, kind}`.
- `original`: the `RouteInfo` of the route the request was built for, before any handler changed it.
- `routes`, `route`, `model`, `provider`, `effort` and `tools` (names).
- `sections`: see [`model_request` sections](#model_request-sections).

A handler may change `route`, `effort` and `sections`.

### `model_request` `route` and `effort`

- `route`: one of `routes`. The lead sees its thread's lead routes: those on its provider, and those on another
  provider that name their own credential profile.
- Switching provider sends the request to that route's URL with its credential and rates. The request leaves out the
  thread's opaque reasoning items (the transcript keeps them), and the host strips item metadata the provider doesn't
  accept.
- A route without its own credential cannot cross providers.
- `effort`: `none`, `minimal`, `low`, `medium`, `high` or `xhigh`, only when the request contains reasoning.

### `model_request` sections

`sections` contains every classified prompt item `{id, kind, role, group, protected, text, bytes, truncated}` in
request order:

- `instructions`;
- each context fragment, by its kind, for example `agents_md.instructions`, `environments.environment_context`,
  `git_attribution.*`, `generic.turn_aborted` or `images.resize_notice`. A repeated kind appears as `kind#2`;
- expanded skills from `$`/slash mentions and spawn items as `skill:<name>`;
- `skills.read` outputs as `skill:<package>`.

Each section's `text` is a preview of at most 4 KiB, and previews total at most 48 KiB. A `truncated` section can be
replaced whole.

- A handler may rewrite or drop ordinary sections and reorder them within their `group` (message). It may also
  insert up to 8 `{id: 'mod:…', text}` sections, which the host frames as mod-provided context.
- The host puts an inserted section in the first of these that exists:
  1. the developer or user message of the section before it;
  2. the nearest developer or user message after it (or before it);
  3. a new developer message at the start of the input.
- Protected sections (permissions, approved prefixes and network rules, managed developer instructions,
  collaboration mode, guardian policy, user answers) and tool outputs cannot be changed, dropped or moved, and no
  section crosses a protected one.
- Native policy is enforced independently of this text.

### `model_request` `next` and synthetic responses

`next` resolves to `{route, effort, cache: {from}}`. `from` is the first section (or `tools`) whose content differs
from the thread's previous request, which is where a provider's prompt cache stops matching. `from` is `null` when
the prefix is unchanged.

A handler may answer without `next`:

```text
{response: {output: [{type: 'message', text} | {type: 'tool_call', tool, namespace?, arguments}]}}
```

- `output` has at most 16 items.
- `arguments` is an object for a JSON tool or a string for a freeform tool.
- The host streams it as a complete response without contacting a provider, admitting or billing anything.
- It contains no usage, and `synthetic` names the mod.
- Tool calls get `mod-<id>-<request>-<n>` call ids and pass tool interception, native permissions and approvals
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
- At a `message`, `tool_done` or `stop` chunk, add `{kind: 'message', text}` and
  `{kind: 'tool_done', tool, arguments}` chunks, which get fresh `mod-…` ids. Chunks added at a `stop` chunk come
  before the response ends.
- A returned received chunk keeps every field it arrived with.
- Text changes are both shown and recorded: a `message` whose deltas changed is recorded as streamed.
- `reasoning` and `stop` chunks are observe-only.

### Stopping a response and retrying

At a `message`, `tool_done` or `stop` chunk a handler may return `{stop: {reason}}` or
`{stop: {reason}, retry: {inject}}`.

- The host keeps the item, records a developer note that a mod stopped the response, and ends the response. With
  `retry`, it sends the request again with `inject` as developer context, at most twice per turn.
- The retried request is a new attempt with its own admission and settlement.

### `on('model_response')`

`on('model_response')` (capability `model`) fires once per provider attempt and synthetic answer. It is delivered
after the response from the delivery queue and may call host operations.

The payload contains:

- `request_id`, `attempt`, `ledger_request`, `scope`, `route`, `provider` and `credential` (profile id).
- `requested_model` and `served_model`.
- `status`: `completed`, `incomplete`, `failed` or `cancelled`.
- `stop_reason` (derived): `end_turn`, `tool_use` or the incomplete reason.
- `output {text (first 4 KiB), tool_calls}`.
- Raw `usage`, and `cache {read_tokens, write_tokens}`.
- `cost {microusd, basis}`, where `basis` is `settled`, `unsettled`, `provider_reported`, `included_subscription`,
  `unpriced` or `synthetic`. A request without configured rates is `included_subscription` when it goes to the
  ChatGPT Codex backend with the signed-in account, which is the native session on a ChatGPT plan. Otherwise it is
  `unpriced`. Credits spent past the plan's limit aren't reported.
- `context_window` when the session knows it.
- `timing {started_at_ms, first_event_ms, duration_ms}`.
- `synthetic` and `error`.

## One-shot model calls and forks (`model_complete_v2`)

Use it when a mod calls a model itself: a one-shot `model.complete` on a route, a `model.fork` of the current
conversation, and prompt cache marks. `api.classify` wraps `model.complete`; see [SDK helpers](reference/sdk-helpers.md).
To change the model requests that a lead turn or another caller sends, use
[Model requests and streams](reference/model-requests.md) instead.

Mod API `1.0.0`: `model.complete` is frozen; `model.fork` is experimental. Platform: Apple Silicon macOS.

### `model.complete`

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

### `model.fork`

Experimental.

`model.fork {prompt, route?, tools?, …}` (capabilities `agents`, `sessions` and `sessions_tools`) runs the same kind
of call on a snapshot of the current conversation, the thread's committed model-visible history. It runs on `lead`
unless `route` names a worker route. Opaque reasoning is kept for a same-provider route and left out for another
provider.

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

### Where model calls run

`model.complete` and `model.fork` run in event, tool, timer and channel callbacks and in terminal slash commands,
which reach the session in the same process. Elsewhere they fail with `no session in this process`.

`cache.read_tokens` reports prompt cache reuse, but reuse isn't guaranteed. A fork is a separate internal session
whose cache key and instructions differ from the lead's.

### Prompt cache marks (`model_cache_v1`)

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

## Final-request policy (`final_request_policy_v1`)

The final-request stage runs `model_send` interceptors on the exact body of each model request, after every other
edit. Use it when a mod must approve, redact or refuse the exact body of every model request, or when an
administrator declares a required request policy. The capability is `request_policy` in [Capabilities](reference/capabilities.md).

Entries are frozen in Mod API `1.0.0` unless marked experimental (see the
[registry table](reference/stability-and-migration.md#experimental-entries-in-the-registry)). Runs on Apple Silicon macOS.

### Where `model_send` runs

`model_send` (capability `middleware`) runs on the exact body each request sends. It runs after history,
`model_request` and the host's route, effort, section and output-ceiling edits. Only two steps follow it: removing
item metadata a provider rejects, and compression.

- It covers lead, subagent and mod worker requests (`model.complete`, `model.fork`) and the session's internal
  requests (titles, reviews, memory, guardian), whose `scope.kind` is `internal` and which have no `provider` or
  `route`.
- Every attempt runs it again: turn and stream retries, a mod's stop-and-retry, compaction and route switches
  rebuild the body, and a transport retry resends the bytes that passed.
- A synthetic answer sends nothing and skips it.

This required policy replaces API keys of the form `sk-` plus 20 or more letters and digits in every editable
segment, and keeps the edits of the policies beneath it:

```ts
api.intercept('model_send', { required: true }, async (page, next) => {
  const inner = await next(page);
  const edits = [...inner.edits];
  for (const segment of page.segments) {
    if (!segment.editable) continue;
    for (const match of segment.text.matchAll(/sk-[A-Za-z0-9]{20,}/g)) {
      const start = match.index ?? 0;
      edits.push({ segment: segment.id, start, end: start + match[0].length, text: '[key]' });
    }
  }
  return { ...inner, edits };
});
```

The package needs `middleware`. An edit that overlaps an inner policy's edit makes the request invalid, so a real
policy skips ranges already edited. `omd_privacy` is a complete policy built this way.

### What the stage covers

The stage covers the text of each request body. It proves only what its policies detect. These parts of a request
are outside it:

- images, audio, files and encrypted reasoning, which arrive only as [`opaque`](#model_send-input-pages) entries;
- web search, which sends recent conversation text and its queries as they are, even when a policy has failed;
- provider-side tools;
- mods' own HTTP and sidecars;
- terminal, log and resume originals: transcripts, rollouts and resume data keep the original text.

### `model_send` input pages

The input is one page:

- `request_id`, `attempt`, `scope`, `provider`, `route` and `model`.
- `page` and `pages` (1-based).
- `cached`.
- `segments`: the non-empty string leaves of `instructions`, `input`, `tools` and `text`. Image and memory
  summarization requests also include `prompt`, `images` and `traces`. Structural fields are left out: `type`, `id`,
  `call_id`, `status`, `role`, `name`, `namespace`, `detail` and item metadata.
- `opaque` and `opaque_total`.

Each segment is `{id, kind, role, editable, text, bytes, sha256}`:

- `id` is the JSON pointer (`/input/3/content/0/text`).
- `kind` is the content kind. Message text has a fragment kind such as `agents_md.instructions` or `user.text`, or
  `message.<role>` when it has none. Other kinds are `instructions`, `tool_call.arguments`, `tool_call.input`,
  `tool_output`, `reasoning`, `tool_spec`, `output_schema`, `image.prompt`, `memory` or the item type.
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

- An edit `{segment, start, end, text}` replaces `text.slice(start, end)` of that segment on this page. `start`,
  `end` and `offset` are JavaScript string indices and never fall inside a surrogate pair. A page takes at most 256
  edits, each with up to 4 KiB of replacement text, and edits can't overlap.
- Only `editable` segments take edits: message text of any role, including user prompts, tool-call arguments (which
  must still parse as JSON when they did) and freeform input, tool output text and instructions.
- Policy floors (`permissions.`, `network_proxy.`, `managed_config.`, `collaboration_mode.` and `guardian.` kinds),
  reasoning, tool specs and output schemas can only be denied.
- After the edits are applied every policy sees the changed segments again; a second round of edits refuses the
  request (`final_request_unsettled`), so every policy approved the exact bytes sent.

### `model_send` verdict reuse

The host reuses a verdict for a segment when all of these match, so a request pages only new text (`cached` counts
the rest):

- segment digest, kind, role and `editable`;
- the policy mods, their trusted sources and settings;
- the host generation;
- the provider, route, model and `scope` (thread, agent and kind).

- An edit that leaves the text unchanged is ignored.
- A policy whose decision depends on anything else adds `cache: false` to its result. Every handler above it must
  keep that flag, and those segments are paged again on the next request.
- At least one page runs for every request, with no segments when all are cached.

### When a request is refused (`final_request_refused`)

A request is refused, visibly as a turn or call error starting `final_request_refused`, when:

- a required `model_send` interceptor fails, times out, returns an invalid result, belongs to a faulted mod or
  waits more than 5 s for a busy runtime;
- any policy denies; or
- edits are invalid.

### Declared policies (`request_policy`)

A selection trusted with capability `request_policy` (which needs `middleware`) is a declared policy. While it is
enabled, the host refuses every request except web search (`request_policy_unavailable`) unless that mod is loaded,
healthy and has a required interceptor selecting `model_send`. The refusal also applies after a rejected selection, a
failed activation, a fault or a failed reload.

- Image generation and edits and memory summarization pass the stage too (input images arrive as `opaque`).
  Web search is never policed or refused by final-request policies.
- While a required `model_send` interceptor or a declared policy exists, realtime calls and their websockets are
  refused (`request_policy_unsupported_transport`, naming the endpoint and the mods whose policy blocks it);
  Responses websockets are always off under OMD.
- Disable the mod in `/mods` or `/omd` to send again (only the administrator can disable a managed policy).
- Status `request_policy_unavailable` names the reason every request except web search is being refused, or is
  `null`.
- Without `model_send` interceptors or declared policies the stage does not run and the body is untouched.

### Records and coverage of final-request policy

Records keep digests, never segment text: chain traces hash each page's input and result, and the request evidence
records `final_request` (pages, scanned and cached segments, each edit's segment, range and the digest of the
replaced bytes) or `final_request_refused` with its reason.

- Transcripts, rollouts and resume data keep the original text; a retried or later request applies the same cached
  edits again.
- What the stage doesn't cover is listed in [What the stage covers](#what-the-stage-covers).

## History and compaction

Use it when a mod edits what the model sees, what is stored, or how and when the thread compacts. It covers the
bounded view of each model request, store-time redaction, durable transcript rewriting and compaction interception.

| Mechanism | Capability | What it changes |
| --- | --- | --- |
| [Model-bound history](#model-bound-history-history_v1) | `history` | One model request; the transcript is unchanged |
| [Store-time history rewriting](#store-time-history-rewriting-history_persist_v1) | `history_persist` | Text written to the rollout and the prompt-recall file |
| [Durable transcript rewriting](#durable-transcript-rewriting-history_rewrite_v1) | `history_write` (experimental) | The persisted transcript |
| [Compaction interception](#compaction-interception-compaction_intercept_v1) | `compaction` | How and when the thread compacts (experimental) |

Capabilities are listed in [Capabilities](reference/capabilities.md). Entries are frozen in Mod API `1.0.0` unless marked
experimental (see the [registry table](reference/stability-and-migration.md#experimental-entries-in-the-registry)).
Runs on Apple Silicon macOS.

### Model-bound history (`history_v1`)

`replace('history')` receives a bounded view of each model request's items and may return `{drop?, replace?,
insert?}`.

Each item in the view contains `index`, `type`, `role`, `call_id`, `editable`, a 2 KiB text preview, the byte size and
the `images` count.

The view contains the newest items in order, keyed by their original `index`. It has at most 2,048 items and must fit
the callback's 4 MiB runner request.

#### History edit rules

- Messages, tool outputs and tool call arguments can be replaced; replacing a message with images keeps only the
  new text.
- A reasoning item can be dropped only together with the item it precedes, and an insert cannot separate them.
- Call and output items are dropped as pairs.
- The last item (the current input) is kept.
- Inserts are `user` or `developer` text.

An edit changes only the request being sent. The transcript and resume data stay unchanged, and the host records each
applied edit. An invalid edit or a failing mod leaves the original request.

### Store-time history rewriting (`history_persist_v1`)

`api.intercept('history_persist', …)` (authority grant `history_persist`) rewrites history text before the host
stores it, so a mod can redact it. It sees every text written to the thread's rollout and to the prompt-recall file
(`~/.codex/history.jsonl`). Each batch arrives as `{thread_id, entries}`, and an entry is
`{index, kind, role, call_id, text}`.

Redaction applies to stored text only. The model sees the original text until the thread is resumed, forked or
rolled back from the rollout.

#### `history_persist` entry kinds

`kind` is one of:

| `kind` | Group | Text it covers |
| --- | --- | --- |
| `message` | response item | its text |
| `agent_message` | response item | its text |
| `reasoning` | response item | summary and raw text |
| `function_call` | response item | its arguments |
| `custom_tool_call` | response item | its input |
| `local_shell_call` | response item | each command word and environment value |
| `tool_search_call` | response item | each string in its arguments |
| `function_call_output` | response item | its text |
| `custom_tool_call_output` | response item | its text |
| `tool_search_output` | response item | tool descriptions |
| `web_search_call` | response item | queries, URLs, patterns |
| `image_generation_call` | response item | the revised prompt |
| `delivered_message` | text kept beside an item | its text |
| `sender_user_messages` | text kept beside an item | its text |
| `event:user_message` | event copy | its text |
| `event:agent_message` | event copy | also a turn's last agent message |
| `event:reasoning` | event copy | its text |
| `event:plan` | event copy | its text |
| `event:goal` | event copy | a thread goal's objective |
| `event:command_execution` | event copy | command words, input and output |
| `event:function_call_output` | event copy | its text |
| `event:mcp_tool_call` | event copy | each argument string, result text, structured content string and error |
| `event:dynamic_tool_call` | event copy | each argument string, output text and error |
| `event:file_change` | event copy | added and deleted file contents, diffs, stdout and stderr |
| `event:web_search` | event copy | query, action and result strings |
| `event:review` | event copy | custom instructions, hint, findings and explanation |
| `event:image_generation` | event copy | the revised prompt |
| `event:hook_prompt` | event copy | the prompt |
| `event:collab_agent_tool_call` | event copy | the prompt |
| `inter_agent_communication` | other | its text |
| `compacted` | other | a compaction summary and its replacement history |
| `prompt_history` | other | a prompt-recall entry |

#### `history_persist` returns and batching

Return `{entries}` with only `text` changed, or pass a changed input to `next`. A reordered, added, dropped or
relabelled entry is rejected.

A batch is split across callbacks of at most 48 KiB of JSON-encoded entries (escaping counts). A longer text
arrives as consecutive entries with the same index, split after its last whitespace within the budget, so only a
long run without whitespace is cut inside a token.

#### `history_persist` effects and limits

- Item ids, call ids, roles, order and count never change.
- A rewritten response item contains `rewritten {revision, op: "redact", by}` and reads as not original. `by` names
  each mod whose interceptor changed the text (`mod:<id>`), and `host` when the host withheld entries.
- A rewritten user message drops its text elements.
- The interceptor gets no host operations.

Not offered:

- identifiers, names, paths and status fields
- images and other binary payloads
- encrypted content
- extension-owned items (standalone web search, image generation and sleep)
- subagent activity
- realtime transcripts

#### `history_persist` failures

- A failing optional interceptor keeps the original text.
- A failing required interceptor, or a persist runtime that fails while one is installed, stores `[withheld: a
  required history_persist interceptor failed]` instead (a withheld prompt-recall entry is not written).

### Durable transcript rewriting (`history_rewrite_v1`)

Experimental: the `history_write` capability is experimental.

A mod with the `history_write` authority grant changes the persisted transcript itself by calling
[`app.request`](reference/app-bridge-and-approvals.md) with `thread/rewrite {threadId, expectedRevision?, edits?, undo?}`, on
the current thread or a thread it started.
Revoking the mod drops `history_write`.

#### Reading rows

Without `expectedRevision` the call only reads `{revision, rows}`; `edits` or `undo` without it fail with
`history_rewrite_invalid`.

A row pairs a display item with its model items: a message, or a tool call with its output. Each row is
`{id, turnId, kind, access}`:

- `kind` is `message.<role>`, the tool call type or a display item type.
- `access` is `edit`, `delete` (reasoning, web search, image generation and display-only items) or `frozen`
  (compaction, configuration and rows before the newest compaction checkpoint).

#### Edits

1 to 256 `edits` (or `undo`, not both) apply in order as one revision:

| Edit | Meaning |
| --- | --- |
| `{op: "delete", id}` | Delete the row |
| `{op: "replace", id, items}` | Replace the row's items |
| `{op: "insert", before? \| after?, items}` | Insert items; with neither `before` nor `after` it appends after the last row |
| `{op: "move", id, before? \| after?}` | Move the row |

- `items` is one Responses `message` (`user`, `assistant` or `developer`) or one tool call followed by its output
  with the same `call_id`.
- A replacement keeps the row's role or call id; an inserted call id must be new to the thread.
- A replaced or inserted message gets a matching display item.
- A replaced or inserted tool row keeps only its model items, so it leaves replay and export views.
- Images are referenced by `image_url` (a URL or data URL) or `file_id`.
- Host metadata in the items is dropped and ids are assigned by the host.

#### Rewrite errors

| Error | When |
| --- | --- |
| `history_rewrite_invalid` | `edits` or `undo` without `expectedRevision`, or not exactly one of 1 to 256 `edits` and `undo` |
| `history_rewrite_busy` | A turn is in progress or agent mail is pending on the thread |
| `history_revision_conflict` | A stale `expectedRevision` |

The host repeats the busy check atomically when the thread unloads, so a turn that starts meanwhile is never cut off
and the thread stays loaded. Retry once the thread is idle.

Any refused edit leaves the transcript unchanged.

#### What a rewrite does

A rewrite copies the whole edited transcript to a new rollout and switches the thread to it, so resume,
`thread/turns/list`, `thread/items/list`, search and export read the result. Every client receives
`thread/rewritten {threadId, revision}` and the terminal reloads the transcript. The replaced rollout is kept
unchanged.

- Each inserted, replaced or moved model item contains `rewritten {revision, op, source?, by: "mod:<id>"}` metadata.
  It loses the host's execution, delivery and tool-call inventory metadata and so never proves that a tool ran.
- The approval reviewer's transcript labels rewritten messages and tool rows as not original.
- Receipts, usage and evidence records are not rewritten.

#### Undo and the revision log

`undo: true` restores the transcript the latest rewrite replaced and keeps rows added since; undoing an undo redoes
it.

The host keeps a per-thread revision log, anchored by the authority broker when it is deployed. Resume fails with:

- `history_anchor_mismatch` or `history_original_mismatch` when the log or an original referenced by the latest
  committed rewrite changed;
- `history_anchor_unavailable` when the deployed broker cannot be asked.

An interrupted rewrite, including a record torn by a crash, is rolled forward or discarded on the next access.

### Compaction interception (`compaction_intercept_v1`)

Experimental: the `compaction` interceptor is experimental.

`api.intercept('compaction', (input, next) => …)` (capability `compaction`) sees every compaction of the lead
thread once. That includes manual `/compact` and automatic pre-turn, mid-turn and post-turn compaction.
`implementation` is `local` for local summarization, `remote` for provider compaction or `budget` for a token-budget
reset.

#### Compaction input

| Field | Meaning |
| --- | --- |
| `trigger` | The compaction trigger |
| `reason` | The upstream reason: `user_requested`, `context_limit`, `model_downshift` or `comp_hash_changed` |
| `phase` | `standalone_turn`, `pre_turn`, `mid_turn` or `post_turn` |
| `budget` | `{tokens, auto_limit, context_window, hard}` |
| item count | The number of history items |
| `history` | A bounded view: the newest 1,024 items, 512-byte previews within 128 KiB |
| `summary_prompt` | The summary prompt; `next` may change it only for local summarization |

`next` runs the host's compaction once (each provider attempt passes route admission, accounting and request
policy) and returns `{summary, history, usage, provider_call}`, where `history` views the new history.

#### Compaction handler answers

A handler that does not call `next` may answer:

| Answer | Effect |
| --- | --- |
| `{skip: reason}` | No compaction; automatic compaction is not offered again this turn |
| `{defer: reason}` | No compaction; offered again at the next trigger |
| `{summary}` | The host builds its standard history: recent user messages plus the summary, with no provider call |
| `{history: {keep, insert?}}` | A custom replacement history |

A handler that called `next` may replace its result with `{summary}` or `{history}`, whose indices then refer to
the new history.

- `keep` lists the items kept verbatim; tool calls and their outputs, and a reasoning item and the item it
  precedes, are kept or dropped together.
- `insert` adds `user` or `developer` text `before` an index.

#### Compaction refusals and failures

- The host refuses a replacement it estimates at the context window or more (`compaction_replacement_over_limit`).
- A skip or deferral when the context is already full (`budget.hard`) fails the turn with `compaction_required`
  naming the mod instead of compacting anyway.
- A failing required interceptor fails the compaction; a failure after `next` keeps the host's result with a
  diagnostic.

#### Compaction summarizers and results

A custom summarizer calls [`model.fork`](reference/model-calls.md#modelfork) (the conversation on its own route) or
[`model.complete`](reference/model-calls.md#modelcomplete) and answers
`{summary}`.

Interrupting the turn cancels a waiting chain. The installed result persists as the normal compaction checkpoint,
so resume reads it.

`compaction_start {turn_id, trigger}` (`manual` or `auto`) fires before the `compaction` interceptors run, whatever
they then decide. `compaction_end` reports `outcome` (`compacted`, `replaced`, `skipped`, `deferred` or `failed`),
`by` and `provider_call`. Both are observe-only events of the `lifecycle` capability: a handler cannot change or
stop the compaction.

#### Evidence across compaction

With the `sessions` capability, `turn_end` delivers `evidence`, a completed-turn packet of the turn's visible records.
Completed-turn packets retain bounded original visible records across a host-observed compaction, tagging each
segment's records with its history revision. Compaction summaries do not replace those records. An unobserved
history reset or interrupted compaction still rejects evidence explicitly. The mod chooses how to select and
summarize a truncated packet.

## Terminal UI

Use it when a mod draws in the terminal. This page defines the terms the terminal pages share, lists every view
field, and describes the two screen modes and how the patches of several mods compose.

Entries are frozen in Mod API `1.0.0` unless marked experimental; the
[registry table](reference/stability-and-migration.md#experimental-entries-in-the-registry) lists the experimental ones. The
terminal runs on Apple Silicon macOS; [external clients](reference/external-clients.md) draw the same view elsewhere.

The details are on these pages:

| Page | Covers |
| --- | --- |
| [Render hooks](reference/render-hooks.md) | `render` interceptors over native components, `tool_call` props, list rows |
| [Layout and styling](reference/layout-and-styling.md) | Startup presentation, layouts, component types, region sizing, overlays, the box model, text styles, surface paint, view limits |
| [Terminal input](reference/terminal-input.md) | Focus, key and paste input, keybindings, focus regions and key contexts, pointer events, `component_event`, `component_change`, component modules |
| [Graphics](reference/graphics.md) | `image`, `terminal.image_sample`, rasters, `terminal.blit`, the underlay, process-fed rasters and pixel buffers |
| [Terminal operations](reference/terminal-operations.md) | `terminal.*` operations, selection and clipboard, terminal identity, the `client` facts |
| [External clients](reference/external-clients.md) | Renderers other than the terminal that draw the same view |

### Views, sites, layouts and components

A mod's `terminal` handler receives the `terminal` event, `{event, ledger, identity?, presentation?, client?,
clients?}`, and returns a `TerminalPatch` (the same type as `TerminalView`) or null. The host composes every mod's
patch into one view. A package that draws in the terminal lists the [host features](reference/glossary.md#mods-and-the-host)
it uses in `required_features`. The terminal's features are `terminal_surface_v1`, `terminal_media_v1`,
`terminal_prompt_v1` and `terminal_pty_v1`. `terminal_pty_v2` is experimental.

| Term | Type in `api.d.ts` | Meaning | Details |
| --- | --- | --- | --- |
| View | `TerminalView` | The fields listed in [View fields](#view-fields) | this page |
| Site | `TerminalSiteName`, `TerminalRenderSite` | A named place a view fills: `sidebar`, `header`, `above_composer`, `below_composer`, `dialog`, `welcome` or a mod site `owner/name`, each with `mode` (`replace` or `wrap`), `components` and `overlay` | [Terminal patch composition](#terminal-patch-composition-ui_composition_v1) |
| Layout | `LayoutNode` | A tree of `split` and `tabs` nodes over `transcript`, `composer` and `site:` leaves | [Layouts and component types](reference/layout-and-styling.md#layouts-and-component-types) |
| Component | `TerminalComponent` | One of 20 node types, such as `box`, `list` or `raster` | [Component types](reference/layout-and-styling.md#component-types) |
| Region | none | A focus region is the chat or one drawn `site:` leaf. A layout region is the area a layout leaf draws in. | [Focus regions](reference/terminal-input.md#focus-regions-key-contexts-and-help-terminal_focus_v1) |

The `identity`, `client` and `clients` inputs are described in
[Terminal operations](reference/terminal-operations.md#terminal-identity-terminal_identity_v1), the `presentation` input in
[Startup presentation](reference/layout-and-styling.md#startup-presentation-terminal_welcome_v1).

### View fields

Every field of `TerminalView` in [`api.d.ts`](api.d.ts), with its status in the conformance registry. "Type
only" means no page describes the field beyond its type.

| Field | Type | Status | Details |
| --- | --- | --- | --- |
| `welcome` | `{show_while_composing?, hidden?}` | frozen; `hidden` is experimental | [`welcome` site](reference/layout-and-styling.md#welcome-site) |
| `session_title_suffix` | string | frozen | [Title suffix and greeting](reference/layout-and-styling.md#title-suffix-and-greeting) |
| `greeting` | string | frozen | [Title suffix and greeting](reference/layout-and-styling.md#title-suffix-and-greeting) |
| `title` | string | frozen | [Default styling](reference/layout-and-styling.md#default-styling) |
| `foreground` | number | experimental | type only |
| `background` | number | experimental | type only |
| `sidebar_width` | number | frozen | [Default styling](reference/layout-and-styling.md#default-styling) |
| `sidebar_side` | `left` or `right` | frozen | [Default styling](reference/layout-and-styling.md#default-styling) |
| `sidebar_style` | `TerminalFrameStyle` | frozen | [Box model](reference/layout-and-styling.md#box-model-terminal_box_model_v1) |
| `panels` | `{title, lines}[]` | experimental | type only |
| `header` | `{title, lines}` | experimental | type only |
| `footer` | `{title, lines}` | experimental | type only |
| `sites` | site name to `{mode?, components?, overlay?}` | frozen | [Terminal patch composition](#terminal-patch-composition-ui_composition_v1), [Overlays](reference/layout-and-styling.md#overlays) |
| `status` | string list | frozen | [View limits](reference/layout-and-styling.md#view-limits) |
| `keybindings` | key name to `KeyAction` | frozen; experimental fields: `region`, `help` | [View keybindings](reference/terminal-input.md#view-keybindings-and-command-ownership) |
| `key_contexts` | `KeyContext[]` | experimental | [Focus regions](reference/terminal-input.md#focus-regions-key-contexts-and-help-terminal_focus_v1) |
| `theme` | `TerminalTheme` | frozen | [Theme keys](#theme-keys) |
| `placeholder` | string | experimental | [View placeholder and glyphs](reference/layout-and-styling.md#view-placeholder-and-glyphs) |
| `layout` | `LayoutNode` | frozen; experimental fields: `title`, `focus` | [Layouts](reference/layout-and-styling.md#layouts-and-component-types) |
| `surface_styles` | `{composer?, approval?}` | experimental | [Surface paint](reference/layout-and-styling.md#surface-paint) |
| `inline_sites` | `hidden` | frozen | [Screen modes](#alternate-screen-inline-mode-and-composer-sites) |
| `underlay` | `{raster}` | experimental | [Underlay](reference/graphics.md#underlay-terminal_underlay_v1) |

#### Theme keys

`TerminalTheme` takes the colors `accent`, `user_message_background`, `success`, `attention`, `failure`,
`diff_added`, `diff_removed` and `muted`; `syntax` (a string); `border` (`plain`, `rounded` or
`double`); `density` (`compact` or `comfortable`); `icons` (`unicode` or `ascii`); and `glyphs`
([View placeholder and glyphs](reference/layout-and-styling.md#view-placeholder-and-glyphs)).

### Alternate screen, inline mode and composer sites

By default Codex draws on the alternate screen, which this reference calls fullscreen mode, and terminal views draw
there, including in the fullscreen transcript. Inline mode (`--no-alt-screen`) draws the sidebar, header and dialogs
inside the current viewport. In inline mode, `render` hooks and status segments apply to scrollback.

When any mod's view sets `inline_sites: 'hidden'` (`terminal_inline_sites_v1`), the inline viewport omits the
sidebar, header and named sites. Dialogs, status segments, mod progress and diagnostics, the composer, approvals and
scrollback still draw. Fullscreen mode is unchanged.

A program that launches `codex` can narrow one session's terminal UI (TUI) with three environment variables.
`omd mini` sets all three.

| Variable | Effect |
| --- | --- |
| `OMD_TUI_MOD_UI=ID[,ID…]` | Keeps sites, panels, header, footer, layout and status segments only from the listed mods. |
| `OMD_TUI_HEADER=off` | Drops the Codex session header and first-run help. |
| `OMD_TUI_COMPOSER=plain` | Draws the composer as a bare prompt line without its background, blank rows, placeholder or idle hint row. |

- With `OMD_TUI_MOD_UI` set, unlisted mods still contribute their `dialog` site, `render` hooks, commands, keys and
  theme.
- The status row contains only the listed mods' segments. It shows no upstream `/statusline` items, and shows the
  host summary only when a mod failed.

The variables are read once at start. Agent tool processes don't inherit them or the launcher's `OH_MY_DIFF_*`
variables. A mod can still pass `OH_MY_DIFF_*` variables to its commands by listing them in its
[`exec_environment`](reference/authority-grants.md#exec_environment-names).

The `above_composer` and `below_composer` sites draw in fullscreen and inline mode, directly above and below the bottom
pane. The bottom pane is the composer, the native hints and the status row. The host sizes each site to its wrapped
components, which can use styles, links and focusable controls. `above_composer` is clipped to 8 rows and
`below_composer` to 6, each scrolling to the focused control. Both are hidden while an approval or popup replaces the
composer.

### Terminal patch composition (`ui_composition_v1`)

Every mod's `terminal` patch composes in the same order (`ui_composition_v1`):

- Sites wrap or replace. A wrap encloses the site's replacement, whichever of the two patches composes first. A
  site's `overlay` is not claimed, so the last patch that sets one wins
  ([Overlays](reference/layout-and-styling.md#overlays)). Only mod `owner` replaces or wraps its `owner/name` site; any other
  mod's patch for it is refused and reported as a conflict. Any mod can patch a native site, such as `sidebar` or
  `welcome`, under the wrap, replace and overlay rules at the start of this item.
- Presentation fields merge.
- Exclusive fields (layout, panels, header, footer, placeholder, underlay, replaced sites, keys, glyphs and the status
  budget) go to the first claimant. Each later claim is reported in `omd-mod status` under `terminal.conflicts` as
  `{field, owner, rejected, origin}`.
- A patch that breaks the composed view's limits is dropped whole.

### Reuse of `terminal` patches

The host reuses a mod's last `terminal` patch without a callback while its settings, durable state, UI state and
the `terminal` event input are unchanged.

- A patch from a callback that read the clock (`Date.now()` or `new Date()`) is reused for at most one second, so
  elapsed times and countdowns stay current on the next redraw.
- The host shows a command's `{terminal}` result for at most one second. After that, the next view update runs the
  `terminal` handler.

Session UI state is described under [`api.uiState`](reference/state-and-storage.md#session-ui-state-apiuistate), and command
`{terminal}` results under [Command views](reference/commands-and-composer.md#command-views).

## Render hooks (`render_hooks_v1`)

Use it when a mod restyles, wraps, replaces or hides a native terminal component such as a tool call, a message or
a built-in list. How interceptor chains run in general is in [Interceptors](reference/interceptors.md).

Entries are frozen in Mod API `1.0.0` unless marked experimental (see the
[registry table](reference/stability-and-migration.md#experimental-entries-in-the-registry)). Render hooks need the `terminal`
capability and draw in the OMD terminal on Apple Silicon macOS.

### Render interceptor and hook results

`api.intercept('render', {match: {component: 'tool_call'}}, async (e, next) => …)` draws one native terminal
component instance. `e` is `{component, id, surface, viewport: {columns, rows}, lifecycle, owner, props}`:

| Field | Meaning |
| --- | --- |
| `surface` | `inline` or `fullscreen`. |
| `lifecycle` | `live` while the component can still change and `final` once it cannot. |
| `owner` | `null` for host components. |

`next(e)` resolves to `{tree}`. In that tree, the node `{type: 'native', style?}` is the host's own drawing. A hook
can:

- observe: return what `next` returned;
- restyle: set `style` on the native node (`tone`, `bold`, `italic`, `underline`, `fg`, `bg`);
- wrap: place the native node in a tree;
- replace: return a tree without it;
- hide: return `{tree: []}`.

A tree contains `box` (without `style` or `flex`), `line`, `text`, `markdown`, `code`, `diff`, `list` and `native`
components. It has at most 64 components, depth 6 and 256 KiB, its ids are unique, and the native node appears at
most once. Hooks run as one continuation chain in interceptor order, so unrelated wrappers nest. Each hook sees the
props the hook before it passed on.

### Render components

Each native component a hook can match, with its `id` and props. The Rewritable column names the props a hook can
change in the `e` it passes to `next`. Rewrites to other props have no effect.

| `component` | `id` | Props (`RenderProps`) | Rewritable |
| --- | --- | --- | --- |
| `user_message` (experimental) | content digest | `text`, `images`, `spoken` | none |
| `assistant_message` | content digest | `text`, `first`, `truncated` | none |
| `tool_call` | call id (row id for agent rows; `explore:<first call id>` for an exploration group) | every agent tool row (`RenderToolCall`); see [`tool_call` props](#tool_call-props) | none |
| `tool_result` (experimental) | call id | `tool`, `success`, `text` (MCP results inside their call) | none |
| `spinner` | `main` | `header`, `elapsed_seconds`, `details`, `message`, `interrupt_hint` | `header` |
| `turn_duration` (experimental) | `turn-<completed ms>` | `seconds`, `completed_at_ms` | none |
| `notice` (experimental) | content digest | `kind` (`info`/`warning`/`error`), `text`, `hint` | `text` |
| `session_mode` (experimental) | `collaboration` | `mode`, `label`, `cycle_hint` | `label` |
| `composer_hint` (experimental) | `placeholder` or `footer` | see below | `placeholder` |
| `question` | item id or content digest | `questions` (`id`, `header`, `question`, `secret`, option labels), then the state props below | none |
| `list` | view id | `view_id`, `title`, `subtitle`, `items`, `selected` | none |

- `assistant_message` covers streamed chunks and the final message. The streaming tail is `live`. `truncated` is
  true when the host cut `text` at 48 KiB.
- `composer_hint` has id `placeholder` with props `slot`, `placeholder` and `input_enabled`, or id `footer` with
  props `mode`, `text` and `task_running`.
- A `question` adds `current` and `queued` while `live`, and `answered` and `interrupted` once `final`.

### `tool_call` props

Every agent tool row (`RenderToolCall`) contains `call_id`, `kind`, `status` (`running`/`completed`/`failed`/
`interrupted`), `duration_ms` (null without a recorded start and completion, such as a patch row drawn live) and
`expanded`, and per kind:

| `kind` | Props |
| --- | --- |
| `exec` | `command`, `parsed`, `exit_code`, `output_lines`, `output_tail`, `user_shell` |
| `explore` | `calls` (grouped reads, searches and listings) |
| `patch` | `files` (`path`, `change`, `added`, `removed`), `error` |
| `web_search` | `action`, `query` |
| `agent` | `tool`, `agents`, `prompt` |
| `mcp` | `server`, `tool`, `arguments`, `output_lines` |
| `dynamic` | `tool`, `arguments`, `output_lines` |
| `image` | `tool`, `path`, `prompt` |

Group and file limits:

- Exploration groups contain at most 32 calls; larger sequences split into additional rows without dropping calls.
- Patch `files` contains at most 32 details; `file_count`, `added` and `removed` are complete totals across all
  changed files.

### Grouped members

For grouped exploration and computer activity, the host runs `tool_call` hooks on each member of the group, as kind
`exec` or `mcp`.

- When those member hooks replace the drawing, each member has its own focus, pointer region and `expanded` flag;
  `next` draws a collapsed member as its compact row, and transcript search (Find) searches every member expanded.
- Native grouping remains when no member is replaced.
- Aggregate exploration rendering remains available on the group when member rendering does not replace it.

### Render hook behavior

Text props are at most 48 KiB. A content digest stays the same across resume and reflow, so equal content draws
identically. Tool rows are offered from live cells and committed history.

- In the fullscreen transcript a hooked tool row needs no control row. F4 focuses it, and Enter, →/← or a click
  opens and closes it. `expanded` is `true` while the row is open and for every row of the full transcript
  (Ctrl+T). A hook that shortens rows returns `next(e)` when `expanded` is `true`.
- Selection copies what is drawn; raw mode never runs hooks.
- Approvals are [native confirmations](reference/glossary.md#trust-and-authority) and have no render hook. Their identity,
  decision text, options, focus and grants stay native, and `surface_styles.approval` only paints the frame.
- A question hook changes the presentation only; answers, focus and keys stay native.
- The existing panes, `above_composer` band and named sites stay declarative views.

### Render callback runtime

Render callbacks get no host operations and can't write state. A write fails with `render_side_effect_refused`, and
a write during activation stays local to that render. Read `api.state` or atoms instead.

- Renders run in a runner that stays activated while the package revision, settings and persisted state stay
  unchanged. Changing state requires a new activation.
- Stateless renders can reuse the runner across rows, including renders that call `next`. Activation-local state is
  restored before each reused render. Module variables may survive between renders, so never draw from them.
- The host keeps a tree until its input changes or a state key its hooks read changes. Live components and
  fullscreen transcript cells redraw asynchronously and show their last tree until the new one arrives. Inline
  scrollback is written once, so it waits for each cell's hooks as the cell is inserted. A narrower or wider
  terminal is a new input.
- A hook that throws, times out or returns an invalid tree is skipped with the input it received, so the native
  drawing survives. A disabled or failed mod's hooks are gone at once, and every failed render joins the status
  `chains` log.
- With no `render` interceptor the host never calls a mod while drawing.

### List rows (`terminal_lists_v1`)

Use a `list` hook to redraw the rows of Codex's built-in lists, such as its pickers. `terminal_lists_v1` lets a
`render` hook on component `list` replace built-in list rows. The host keeps selection actions, session state,
keyboard handling and native fallback when the mod is absent or fails.

The same feature lets a component's `action` be `{insert: TEXT}`, which inserts the text in the composer.

## Layout and styling

Use it when a mod places and styles what it draws: the startup presentation, layout trees, the component types,
region sizing, overlays, the box model, text styles, surface paint and the view limits. Keys, focus and pointer
input are in [Terminal input](reference/terminal-input.md); images and rasters are in [Graphics](reference/graphics.md).

Entries are frozen in Mod API `1.0.0` unless marked experimental (see the
[registry table](reference/stability-and-migration.md#experimental-entries-in-the-registry)). They draw in the OMD terminal on
Apple Silicon macOS and in [external clients](reference/external-clients.md).

### Startup presentation (`terminal_welcome_v1`)

A mod can change what the terminal shows when a session starts.

#### Presentation value

The terminal event's read-only `presentation` is `{thread_id, phase, surface?}`.

- `surface` is `fullscreen` when the terminal client draws on the alternate screen and `inline` otherwise (inline
  sessions never draw the `welcome` site); it is absent until the client has chosen its screen mode.
- `phase` is `fresh` for a new thread, `started` once the host accepts the thread's first turn, and `resumed` for a
  resumed or forked thread. The host sets it from its own records before it first publishes the view.
- Before the composer first accepts input, the host can run the `terminal` handler with `event: 'startup'`, more
  than once. That event has `ledger: null` and a null `thread_id`, and its phase depends on whether the session is
  new, resumed or forked. During these `startup` callbacks, native task, app and paid host operations are
  unavailable.
- Before local presentation is available, the whole presentation value may be absent or null.

`presentation` describes the host session, so a mod doesn't need to persist its own first-turn flag. The host sends
it with every presentation refresh. Composer input, a rejected submission, ordinary view refreshes and a mod reload
don't reset it. A locally queued draft isn't an accepted turn. An empty view the host publishes while mods start
keeps the initial view on screen. A view from a disabled, broken or reloaded mod replaces it.

#### `welcome` site

The reserved `welcome` site renders bounded generic components centered in the unused area of the fullscreen transcript.
`welcome: {show_while_composing: true}` keeps the site visible with a draft, including while the slash command, file
or mention popup is open; the default shows it only with an empty composer.

`welcome: {hidden: true}` (`terminal_welcome_hidden_v1`, experimental) keeps the welcome area under the same rules, with
Codex's own welcome and animation off, but draws no `welcome` site there. Use it when a mod fills the fresh screen
another way, such as an underlay. `hidden` takes effect only when it comes from the mod whose underlay is in the
composed view. A later mod that sets `welcome` can't show the site again, even with `show_while_composing` off. If
the host refuses the underlay, the usual welcome comes back.

- Accepted/running and resumed sessions, transcript selection/search, raw output and overlays suppress the
  `welcome` site.
- Any history beyond the startup header and notices (a command's output, a rejected submission) hides it until a new
  thread, like Codex's own welcome.
- Approvals and input retain their space; if no blank space fits the components, the site does not draw.
- Inline output retains the native transcript without the centered decoration.
- Without a `welcome` site, Codex keeps its normal empty-screen animation (its blossom policy).

#### Title suffix and greeting

- `session_title_suffix` appends up to 80 bytes to the upstream version heading, including inline/raw output; the
  host keeps its source-backed version and attribution.
- `greeting` overrides the startup phrase with up to 256 bytes, and an empty string hides it.

For each field, the last mod to set it wins. Mods are ordered by dependency, then by mod id, so a later opt-in theme can
override an earlier presentation default. Escape/control injection is refused. Disable, a broken mod, or direct mode
restores the upstream fields.

### Layouts and component types

Views may declare a `layout` tree of splits and tabs with transcript, composer and mod sites (`owner/name`).

| Limit | Value |
| --- | --- |
| Depth | Splits and tabs nest at most 6 levels deep |
| Split children | 2–4 |
| Tabs per `tabs` node | 1–6 |
| Leaves | At most 12 |

A `site:` or `transcript` leaf may set `title` (`terminal_layout_title_v1`, experimental), at most 64 bytes without
control characters. A `composer` leaf takes no title.

- A site's frame shows the title instead of the site name, and `''` draws no title.
- A titled transcript gives its top row to a rule with the title, accented while the chat has focus in a view
  with `key_contexts`.

Layout sites contain the component types below, including `document` (see [Documents](#documents)), `diff`, `image`,
`raster` and `terminal` (a PTY session).

### Component types

Every `TerminalComponent` type in [`api.d.ts`](api.d.ts) with its fields (`?` marks an optional field).

| `type` | Fields | Details |
| --- | --- | --- |
| `box` | `id, label, title?, children?, style?, flex?, min_width?, max_width?, pointer?` | [Box model](#box-model-terminal_box_model_v1) |
| `line` | `id, label, spans` | [Rich lines](#rich-lines-terminal_rich_line_v1) |
| `text` | `id, label, text, tone?` | [View limits](#view-limits) |
| `button` | `id, label, text, action, hotkey?, autofocus?` | [Input and focus](reference/terminal-input.md#input-and-focus) |
| `input` | `id, label, value?, placeholder?, action, hotkey?, autofocus?` | [Input and focus](reference/terminal-input.md#input-and-focus) |
| `select` | `id, label, value, options, action, hotkey?, autofocus?` | [Input and focus](reference/terminal-input.md#input-and-focus) |
| `multiselect` | `id, label, value?, options, action, hotkey?, autofocus?` | [Input and focus](reference/terminal-input.md#input-and-focus) |
| `list` | `id, label, rows, selected?, height?, action, hotkey?, autofocus?` | [Region sizing](#region-sizing-and-layout-events) |
| `markdown` | `id, label, text` | [View limits](#view-limits) |
| `code` | `id, label, text, language?, start?` | [Code highlighting](#code-highlighting-terminal_code_highlight_v1) |
| `pane` | `id, label, title?, collapsed?, scroll?, keys?, children?, style?, flex?, min_width?, max_width?, pointer?` | [Box model](#box-model-terminal_box_model_v1), [`terminal.pane`](reference/terminal-operations.md#terminalpane-and-terminalpanes) |
| `dialog` | `id, label, title, children?, style?` | [Input and focus](reference/terminal-input.md#input-and-focus) |
| `document` | `id, label, lines?, source?, anchors?, selected?, find?, height?, action?, keys?` | [Documents](#documents) |
| `diff` | `id, label, unified, selected?, height?, action?` | [Region sizing](#region-sizing-and-layout-events) |
| `image` | `id, label, image, alt, height?, pointer?` | [Graphics](reference/graphics.md#image-component) |
| `raster` (experimental) | `id, label, alt, width?, height?, pointer?` | [Graphics](reference/graphics.md#raster-component) |
| `terminal` | `id, label, session, height?, autofocus?` | [`terminal.pty`](reference/terminal-operations.md#terminalpty) |
| `module` | `id, label, module, props?, height?, keys?, pointer?` | [Component modules](reference/terminal-input.md#component-modules-component_modules_v1) |
| `slot` | none | [View limits](#view-limits) |
| `native` | `style?` | [Render hooks](reference/render-hooks.md#render-interceptor-and-hook-results) |

### Documents

A `document` shows up to 100,000 lines with a cursor, selection, find and per-line anchors.

| Field | Meaning |
| --- | --- |
| `lines` | Lines of styled spans; `document` keeps span styles but refuses span `link` |
| `source` | Instead of `lines`, an [evidence](reference/state-and-storage.md#evidencewrite-and-evidenceread) `ResourceRef` the mod owns, drawn as plain text lines; an unreadable one draws one `unavailable: ERROR` line |
| `anchors` | One string per line, by line index; `activate`, `select` and the action report the line's anchor |
| `selected` | `{start, end}` line indexes from 0; a new value moves the cursor and selection there |
| `find` | `{query, regex?, case?}`: a literal search unless `regex`, case-insensitive unless `case`; matching lines are underlined |
| `height` | Rows. Defaults to 12, or the line count when the document is shorter. In a layout region, see [Region sizing](#region-sizing-and-layout-events). |
| `action` | A command action run on `activate`, with the line's anchor or, without one, its line number from 1 as the argument |
| `keys` | `true` or `'all'` forwards keys to the mod instead, under [Component key and paste input](reference/terminal-input.md#component-key-and-paste-input-terminal_input_v1) |

While a document without `keys` has focus:

- Up and Down move the cursor, Shift+Up and Shift+Down extend the selection, and PageUp, PageDown, Home and End
  jump.
- Enter on one line sends `component_event {kind: 'activate', range, anchor}` and runs `action`. Enter on a
  multi-line selection sends `{kind: 'select', range, anchor}` and runs nothing; extending the selection sends
  `select` too.
- `n` and `N` move to the next and previous match, and Esc clears the find.

A new `find` moves the cursor to the first match at or after it and sends `component_event {kind: 'find', matches}`.
An invalid regex sends `matches: 0` and `error: 'find_pattern_invalid: ...'`. Find stops at 10,000 matches, and a
regex find scans the first 256 KiB of text.

Updating only a document's anchors updates activation targets without resetting its cursor, selection or scroll,
including when source-backed text is unchanged.

### Region sizing and layout events

In a layout region, `terminal`, `document`, `diff`, `list` and `raster` components without a `height` share the
rows left after the region's other components and gaps. In a row layout each gets the region's full inner height.

- Releasing a mouse drag on a split border sends `component_event {kind: 'resize', component, ratio}`, where
  `component` is the split's path (`r` for the root, then `.N` per child index) and `ratio` its new percentages, so
  a mod can keep the ratio in its layout.
- Clicking a tab title switches the tab and sends `component_event {kind: 'select', component, index}` with the
  `tabs` node's path (`terminal_tabs_v1`), so the owner can keep `active` in its layout.
- Releasing a drag that started on a `site:` leaf's top frame row (not a tab bar or split border) over another site
  leaf or the chat sends one `component_event {kind: 'dock', component, content, target, edge, columns, rows}`
  (`terminal_layout_dock_v1`), described below.

These go only to the mod whose view supplied the layout.

#### Dock events

A dock event reports a drag of a `site:` leaf onto another leaf or the chat. `content`, `target`, `edge`, `columns`
and `rows` are experimental fields.

| Field | Value |
| --- | --- |
| `component` | The dragged leaf's path |
| `content` | The dragged leaf's `site:<name>` |
| `target` | The leaf path it was dropped on; for the chat, the path of the split containing the transcript and composer, or the transcript leaf without a composer |
| `edge` | `left`, `right`, `top` or `bottom` over the outer quarter of the target, `center` over its middle; never set over the chat |
| `columns`, `rows` | The size of the area the layout was drawn in |

- While dragging, the host tints where the pane would drop and draws its edge in the accent. Cells it can't blend
  (including ANSI 0-15 backgrounds) keep their color and get the edge reversed.
- The host changes nothing itself, so the owner republishes its layout.
- Nothing is sent when Esc cancels the drag or it ends on the dragged leaf or outside every zone.

### Overlays

A mod site (`owner/name`) with `overlay: {anchor, offset?, width, height, z?, clip?, style?}` draws above the
layout instead of in the sidebar.

| Field | Meaning |
| --- | --- |
| `anchor` | A screen corner (`top_left`, `top_right`, `bottom_left`, `bottom_right`) or `center`, or `{component}` (the component's top-left cell; the overlay is skipped while that component is not drawn). |
| `offset` | Moves the overlay by cells. |
| `z` | 0–9; orders overlays. |
| `clip` | `clip: 'anchor'` clips it to the anchor component's cells, otherwise to the screen. |

- An overlay hides what lies beneath it from pointer events, and a dialog stays above every overlay.
- A view with an overlay outside these bounds is invalid: `width` 1–200, `height` 1–60, `offset.x` within ±500,
  `offset.y` within ±200, and a screen anchor cannot use `clip: 'anchor'`.
- When several patches set an overlay for the same site, the patch that composes last wins. A `wrap` patch
  overrides another mod's overlay without a claim or a `terminal.conflicts` entry.

### Box model (`terminal_box_model_v1`)

One `style: TerminalBoxStyle` object styles a `box`, `pane` or `dialog`, an overlay, a layout `site:` leaf and, as
`sidebar_style`, the sidebar.

- `border`: `none`, `plain`, `rounded`, `double` or `thick`; a title sits in the top edge. Under the theme's
  `icons: 'ascii'`, `OMD_TUI_ASCII=1`, or a non-Unicode locale, every border draws as `+`, `-` and `|`, and
  markers, cursors and separators draw in ASCII too.
- `padding` and `margin`: cells on every side, or `[vertical, horizontal]`, each 0–4.
- `gap` (0–4) separates children: rows in a column, cells in a row.
- `background` and `foreground`: a tone (`accent`, `muted`, ...) or a color (0–255 or `#rrggbb`). A filled or
  bordered box pads its rows to its width, so the fill reaches the edge; other boxes leave rows unpadded.
- `direction: 'row'` lays children side by side (see [Row layout](#row-layout)).
- `hover` and `focus` take `{border?, background?, foreground?}` on a `box` or `pane`, and `focus` on a layout
  `site:` leaf while its region has focus; other surfaces refuse them
  (see [Hover and focus accents](#hover-and-focus-accents)).

#### Row layout

With `direction: 'row'`:

- A `button`, `text` or `line` takes its natural width; every other child gets a share of the rest by its `flex`
  weight (1–12, default 1).
- When natural widths exceed the available space, shorter children keep their width and longer children share the
  remaining columns.
- `max_width` caps a child's width and a child with fewer columns than its `min_width` drops out.
- In a column layout, a box is hidden when the available width is outside its `min_width` to `max_width` range.

#### Hover and focus accents

`hover` and `focus` restyle a `box` or `pane` while it is in that state.

- `hover` applies while the pointer is over the box (no `pointer: true` needed; events still need it).
- `focus` applies while the box or a descendant has focus.
- Accents never add or remove a border, so geometry stays put.

#### Default styling

Unstyled panes, dialogs and layout sites are cards: the theme `border`, `padding: [0, 1]` and the title in the top
edge. A pane with `border: 'none'` is a flat panel whose title row leads its content. Unstyled boxes and overlays
draw no frame.

- The sidebar has no padding, one row between its components under the comfortable density, and no border unless
  `sidebar_style` sets one, and then shows the view `title`.
- `sidebar_width` is the sidebar's width in columns, an integer from 0 to 60; a larger value refuses the patch
  (`invalid_terminal_patch: sidebar_width`). The fullscreen sidebar is never narrower than 20 columns (the width
  when unset) or wider than a third of the terminal, and it does not draw below 80 columns.
- `sidebar_side` is `left` or `right` (default `right`). When several mods set either, the last one applied wins;
  it is not a conflict.
- A split's `gap` (0–4) leaves cells between its children.
- Render hook trees refuse `style` and `flex`.
- The sidebar opens only for a mod's `sidebar` components, `panels` or unplaced mod sites. The host's progress and
  mod diagnostics draw as cards above the composer instead, four entries each, wrapped to six lines, then
  `+N more`.

### Span styles

Spans accept `fg` and `bg` theme colors, `italic` and `underline` (`terminal_style_v1`).

### Code highlighting (`terminal_code_highlight_v1`)

A `code` component with a `language` (a name or file extension such as `rust`, `ts` or `py`) draws its `text` in the
user's syntax theme. An unknown or missing `language`, or a line over 4 KiB, draws it plain. `start` (a line index,
default 0; an experimental field) draws from that line while highlighting from the top of `text`, so a scrolled view
keeps comments and strings that open above it.

### Rich lines (`terminal_rich_line_v1`)

`terminal_rich_line_v1` adds the one-row `line` component. A `line` has up to 12 styled `spans` (`text`, `tone`,
`bold`, `italic`, `underline`, `fg`, `bg`, `link`), 256 characters in total, and its `label` is the accessible text.
The feature also adds optional `min_width` and `max_width` (1–500 columns) on `box` and `pane`.

The host draws a box with width bounds only when the site's inner width fits it, and header height counts only drawn
boxes. Header
rows are never spaced by the comfortable density.

### Surface paint

`surface_styles.composer` and `.approval` (`terminal_surface_paint_v1`, an experimental view field) accept a
`TerminalSurfacePaint` with `top`, `bottom`, `foreground`, `border` RGB/indexed colors and `opacity` from 0 to 1.

- Background colors interpolate vertically and blend with existing colors.
- The foreground is independent of background opacity; reset foregrounds get a readable color against the surviving
  background. Explicit native foregrounds and special backgrounds remain.
- Borders use blank edge cells and disappear at zero opacity.
- `NO_COLOR` omits styling.
- Inline rendering uses the current bounded viewport; it does not repaint earlier terminal scrollback.
- `approval` paints the frame of [native confirmations](reference/glossary.md#trust-and-authority), such as approvals and mod
  confirmations. The host still draws their text, options, default selection, focus and grants.

Surface paints compose by surface name with the later contributor replacing that surface's paint.

### View placeholder and glyphs

A terminal view may set `placeholder` (experimental) and `theme.glyphs`.

- `placeholder` replaces the composer's placeholder text.
- `theme.glyphs` maps a sequence of 2–4 printable ASCII characters to a replacement with the same number of
  characters. The host ignores a mapping that changes the drawn width.

### View limits

The host checks every view and patch against these limits.

Keybindings:

- Each mod's view or patch has at most 24 keybindings.
- The view composed from every mod has at most 128, and a key bound by two mods rejects the later mod's patch.

Components:

- A view contains at most 64 components nested at most 6 deep.
- Component ids use `a-z`, `0-9` and `_`, up to 48 bytes, and are unique across the composed view.
- A `select` or `multiselect` has at most 16 options and a `list` at most 200 rows.
- A `wrap` site contains exactly one `slot`.

Links and hotkeys:

- A span `link` is an http(s) URL of at most 2,048 bytes on `line` and `list` spans (documents refuse it), drawn as
  an OSC 8 hyperlink, and `markdown` links become hyperlinks too.
- A control `hotkey` uses the keybinding names.

Text sizes:

- Row values, labels and spans are at most 256 bytes.
- `text`, `code`, `markdown`, `diff` and `document` are at most 49,152 bytes. The terminal caches recent
  markdown renders, so a large `markdown` is parsed again, at about 1 ms per KiB, only when its text or width
  changes. Stream text into `code` or `text` instead.
- A view or patch is at most 256 KiB of JSON and the composed view 1 MiB. Those JSON limits still apply to
  text-heavy views, and escaping can double a text (`\n`, `"` and `\` take two bytes), so clip long text on its
  `JSON.stringify` size rather than its 48 KiB length.
- Text fields refuse control characters except newlines where a field is multi-line.
- The status row contains at most 4 segments of 40 characters across all mods.

An invalid view is dropped with the failing field named and the mod's last valid view stays; `omd-mod status`
reports the composed view's diagnostics under `terminal`.

## Terminal input

Use it when a mod takes keys, pastes or pointer events, binds keys, moves focus between regions and controls,
reacts to `component_event`, guards focus changes with `component_change`, or draws with component modules.

Entries are frozen in Mod API `1.0.0` unless marked experimental (see the
[registry table](reference/stability-and-migration.md#experimental-entries-in-the-registry)). They run in the OMD terminal on
Apple Silicon macOS and in [external clients](reference/external-clients.md).

### Input and focus

- A dialog focuses its first item when it opens, or the control it `autofocus`es.
- Tab and Shift+Tab cycle focus while a dialog shows or a control has focus. Otherwise the composer receives them.
- To start cycling, focus a control first with a click, a `hotkey`, `autofocus` or a `{focus}` keybinding.
- Up and Down move within a list, multiselect, document or scrolled pane. At its first or last row, and on any other
  control, they focus the previous or next control.
- Entering a list from above starts at its first row, and from below at its last.
- [Keys components](#component-key-and-paste-input-terminal_input_v1) and `terminal` components are reached with
  Tab once a control has focus, or with a click or a `{focus}` keybinding.
- Left and Right change a `select`.
- While a dialog shows or a control has focus, held arrow, page, Home, End, Backspace, Delete and character keys
  repeat; Enter, Space, Tab and Esc act once per press, and a held key never fires a hotkey or view binding.
- In a dialog, typing that no binding takes goes to its `autofocus` input.
- Esc, Ctrl+] or a click outside releases focus and hides the dialog until a mod command runs, and Esc reaches the
  focused component's owner as `component_event {kind: 'input', events: [{key: 'Esc'}]}`.
- A shown dialog is modal: keys it does not bind never reach the composer behind it (Ctrl+C still interrupts).
- Space on a focused `list` row or `button` activates it like Enter; on a `select` it steps to the next option.
- On a focused `multiselect`, Space toggles the current option and Enter runs its action with the checked values as
  a JSON array argument.
- A `hotkey` on a button, input, select, multiselect or list focuses it (a button runs its action) unless a text
  input has focus. It obeys the keybinding collision rules, is checked before view `keybindings`, and when two
  controls share one the first wins.
- `autofocus` focuses the control when it first appears and nothing has focus, reported as a `focus` event with
  origin `mod`.
- An `input`, `select` or `multiselect` is controlled: the user's edits stay while the view repeats a value, an
  echo of one of the user's own recent values is ignored, and a new `value` from the mod resets the field.

### Component key and paste input (`terminal_input_v1`)

A `pane` or `document` with `keys: true` (`terminal_input_v1`) forwards keys and pastes while focused as
`component_event {kind: 'input', events}`, each event `{key, text}` or `{paste, truncated?}` (a paste is at most
64 KiB). These pages call a `pane`, `document` or `module` with `keys` set a keys component.

| Limit | Value |
| --- | --- |
| Events per batch | at most 64 events and 64 KiB; input waiting for one component arrives in order as one batch, so a slow callback adds at most one batch of lag |
| Queued events | beyond 256 queued events input is dropped and the next batch reports `dropped` |

Leaving the component:

- Ctrl+] leaves the component (terminals without the kitty keyboard protocol send it as Ctrl+5, which also leaves).
- Ctrl+C leaves it and keeps its native meaning (interrupt or quit).
- Esc goes to the mod and leaves the component or closes the dialog.
- `keys: 'all'` (`terminal_focus_v1`, also on `module`) also forwards Esc, Ctrl+C and the other Ctrl and Alt keys
  (Ctrl+Z still suspends), so only Ctrl+] (or Ctrl+5) leaves.
- [Key contexts](#focus-regions-key-contexts-and-help-terminal_focus_v1) of the component's site owner that name
  its site get each key before the component does.

Input callbacks run in the terminal process with read-only workspace access. The view redraws as soon as one
changes the mod's state. To write, the input callback publishes an event with
[`events.publish`](reference/events-and-lifecycle.md#eventspublish) to the mod's `channel` handler, which runs with the
session's access. Terminal-side callbacks, such as slash commands and input, run beside the session. That event can
reach the `channel` handler before the input callback's own `api.state` write is saved.
[Handle keys in a terminal view](../docs/mod-authors/handle-keys.md) shows the save pattern.

The mod stores the buffer, cursor and selection and draws them as spans. A `document` with `keys` set keeps its scroll
across content changes and scrolls to `selected`. A paste into a focused `terminal` component goes to the PTY, bracketed
when the program asked for it.

### View keybindings and command ownership

View `keybindings` accept `Ctrl+`, `Alt+` and `Shift+` combinations of letters, digits, F2–F12 and named keys
(`Up`, `PageDown`, `Enter`, ...), except terminal control keys and Shift+Tab; a binding that collides with a native
key is ignored with a warning.

On macOS, Kitty and Ghostty send Option+letter as a composed character (`π` for Option+p) unless Option-as-Alt is
enabled (`macos_option_as_alt` in Kitty, `macos-option-as-alt` in Ghostty), and the `Alt+` binding doesn't fire.

Key bindings and component actions run only the contributing mod's commands: a bare name is its own `id:name`, and
a binding or control naming another mod's command is dropped.

### Focus regions, key contexts and help (`terminal_focus_v1`)

With a view `layout`, the host computes focus regions every frame. The chat (transcript and composer) is region 0
and each drawn `site:` leaf is a region named by its site, numbered from 1 in layout order; only a `tabs` node's
active tab counts. When a `tabs` node's active tab changes (a tab click or a new `active`), focus inside it moves to
the node's newly drawn region.

- A `{region}` key action moves focus without a mod callback (table below). A region gets back the control last
  focused there, else its first control that is not a keys component or terminal, else no control.
- The focused region's frame draws in the accent color, or with its leaf's `style.focus` accent.
- While a region has focus, keys it does not bind never reach the composer. Ctrl, Alt and F-keys still reach
  `keybindings` and native shortcuts, and native confirmations such as approvals keep their keys.
- Esc in a region returns to the chat. Ctrl+] in a region returns to the chat. From a focused keys component or
  terminal, Ctrl+] returns to its region. In the chat, when the view has key contexts, Ctrl+] focuses the last region,
  or the first if none was focused. Clicking a region or a control in it focuses the region, and pastes into a focused
  region never reach the composer.

| `{region}` value | Focuses |
| --- | --- |
| `left`, `right`, `up`, `down` | The nearest region on that side |
| `next`, `previous` | The next or previous region in layout order |
| `chat` or `0` | The chat |
| 1–12 | That site region |
| A site name | That site's region |

View `key_contexts` (experimental) bind keys that apply only while `when` holds, at most 8 contexts and 32 keys per mod
(16 and 128 composed):

| `when` field | Holds when |
| --- | --- |
| `focus` | One name or a list of up to 8 different names: `chat`, `site` (any site region or a control in any site) or a site name. Omitted, anywhere. |
| `composer` | `empty` or `draft`, by the composer's text. |

- A context whose `when.focus` excludes the chat can also bind unmodified keys: named keys other than Esc and
  Shift+Tab, and single printable characters (`h`, `1`, `[`, `?`, `G`; letters match case exactly). A context that
  can apply in the chat takes only `keybindings` key names, and the host ignores a key there that collides with a
  native binding, as in `keybindings`.
- A binding is a key action or `{action, label}`; `label` (at most 64 bytes) names it in the help overlay.
- Contexts of the focused site's owner (the `owner` of `owner/name`) match first, then the others in composition
  order. A focused control keeps Enter, Space, Up, Down and a select's Left and Right.
- `{region}` and `{help: true}` also work in `keybindings` (experimental fields there); commands follow the ownership
  rule below.

`{help: true}` opens a host overlay listing the bindings that apply to the focused region with their labels and
owning mod, then `keybindings` and the host keys. `/` searches, Up and Down (or `j` and `k`) move, Enter runs the
selected binding and Esc clears the search or closes the overlay.

### Pointer events

`box`, `pane`, `image`, `raster` and `module` accept `pointer: true`. The owner then receives `component_event
{kind: 'pointer', pointer}`, where `pointer` has:

- `action`: `enter`, `leave`, `move`, `down`, `up`, `drag`, or `scroll_up` and `scroll_down` for the mouse wheel;
- `button`: `left`, `right`, `middle`, or null for motion and the wheel;
- `column`/`row` relative to the component's first cell (a nested box counts its title and children);
- `half` (0 or 1, the half-cell row) on terminals that report pixel positions (Kitty, Ghostty and WezTerm), else
  null.

A press captures the pointer until release, so `drag` and `up` reach the component outside its cells with
out-of-range or negative coordinates. Motion is latest-wins per component: a slow callback sees the newest
position, never a backlog. Views with no pointer components add no pointer work.

### `component_event`

`component_event` reports interaction with a mod's components and goes only to the component's owner. Two experimental
events report native state: `view` (`{phase, view, view_id, dropped?}`) when a native bottom-pane view or overlay opens
or closes, and `focus` (`{focused, dropped?}`) when the terminal window gains or loses focus. Each event names its
`component` and `kind`:

| Kind | Reports | Fields |
| --- | --- | --- |
| `focus` and `blur` | Focus changes | `origin` |
| `change` | An input's or select's new value, or a multiselect's checked values, on every edit | `value` or `values`, `origin` |
| `scroll` | A pane's new offset | `offset`, `origin` |
| `pointer` | A pointer event, under [Pointer events](#pointer-events) | `pointer` |
| `input` | Keys and pastes, under [Component key and paste input](#component-key-and-paste-input-terminal_input_v1) | `events`, `dropped` |
| `key` | One key from an [external client](reference/omd-client-protocol.md#omdclientevent) | `key`, `text` |
| `activate` | Enter on a `document` line with no multi-line selection | `range`, `anchor` |
| `select` | A `document` multi-line selection (Shift+Up or Shift+Down, or Enter on it), or a tab click | `range`, `anchor` on a document; `index` on a `tabs` node |
| `find` | A `document`'s `find` changed and was run | `matches`, `error` |
| `resize` | A split border drag ended | `ratio` |
| `dock` | A site leaf was dragged onto another leaf or the chat | `content`, `target`, `edge`, `columns`, `rows` |
| `open` / `close` | Panes and dialogs (`ui_composition_v1`) | none |
| `exit`, `title`, `bell` and `notify` | A `terminal` component's program, under [the terminal pane extension](reference/terminal-operations.md#terminal-pane-extension-terminal_pty_v2) (experimental) | `session`, `exit_code`, `files`, `title`, `text` |

The fields:

| Field | Meaning |
| --- | --- |
| `component` | The component id; for `resize`, `select` on tabs and `dock`, the layout path (`r`, then `.N` per child index) |
| `thread_id` | The session thread the event came from, or null before the session has one |
| `origin` | `user` or `mod` |
| `client` | The external client id, when a client sent the event |
| `value`, `values` | The new value, or the checked values in option order |
| `offset` | The pane's scroll offset |
| `pointer` | `{column, row, half?, action, button}` |
| `events` | Input events, each `{key, text}` or `{paste, truncated?}` |
| `key`, `text` | A key name, or null with the typed or pasted text |
| `range` | `{start, end}` line indexes from 0, inclusive |
| `anchor` | The `anchors` entry for the range's first line, or null |
| `matches` | The number of find matches, at most 10,000 |
| `error` | Why `find` failed, such as `find_pattern_invalid: ...`; `matches` is then 0 |
| `dropped` | Events dropped before this one |
| `ratio` | The split's new percentages |
| `index` | The tab clicked |
| `content`, `target`, `edge`, `columns`, `rows` | The `dock` fields, under [Dock events](reference/layout-and-styling.md#dock-events) (experimental) |
| `session`, `exit_code`, `files`, `title` | The `terminal` component fields; `notify` puts its message in `text` |

`resize`, tab `select` and `dock` are described under
[Region sizing and layout events](reference/layout-and-styling.md#region-sizing-and-layout-events), and `activate`, document
`select` and `find` under [Documents](reference/layout-and-styling.md#documents).

When the owner sets [`state_scope: "thread"`](reference/state-and-storage.md#state_scope-state_scopes_v1), its
`component_event` callback reads and writes the state of the event's `thread_id` thread.

These events wait in order behind a slow callback; beyond 256 waiting events new ones are dropped and the next
delivered event reports the count as `dropped`.

### `component_change` interceptor

A `component_change` interceptor, `api.intercept('component_change', …)`, can block or redirect a user's focus or
scroll change before the owner hears about it. It needs the `terminal` capability and `ui_controls_v1`, and it is
experimental. It runs only for the mod that owns the component being left or entered, with
`{kind: 'focus', id, from, to, origin: 'user'}` or `{kind: 'scroll', id, from, to, origin}`.

Handlers answer:

- `{deny}` to keep the previous focus or offset;
- `{focus: id}` to move focus to another of their own components (or `null` to release it);
- `{scroll: n}` to clamp the offset.

They run while the terminal handles the gesture, so they get no host operations and run under the
[terminal chain budget](reference/interceptors.md#terminal-chain-budget). When it runs out the change applies unchanged.

### Component modules (`component_modules_v1`)

A component module is a view region drawn by synchronous handlers the mod registers with `api.component`. Use one
for a widget that reacts to keys, pointer events or timer ticks every frame without a `terminal` callback.

Component modules need the feature `component_modules_v1`, which `mod_host_check.py --static` requires of any
package that calls `api.component`.

`api.component(module, {init?, view, key?, pointer?, every?})` is registered during activation under the `terminal`
capability (at most 16 per mod) and draws `{type: 'module', id, label, module, props?, height?, keys?, pointer?}`
nodes.

#### Component module lifecycle

Each mounted node runs in its own runner that stays alive while the node is in the view. `init(props, ui)` runs once
per mount. The state a handler returns is passed to the next handler call, and returning `undefined` keeps the
previous state.

- At most four nodes are mounted at once for the terminal and four for each external client; a fifth node draws a
  `component_limit` error line and no mounted runner is evicted for it.
- Handlers are synchronous; a returned promise fails with `component_handlers_must_be_synchronous`.
- In the terminal, removing a node or changing its owner or module starts a new mount. Results, retries and
  undelivered posts from the previous mount are discarded.

#### Component module steps

A step runs at most once per 16 ms frame and only when something is pending: a mount, new props or size, queued
input, or a due `every: {ms, tick}` tick.

- `every` ticks run from 16 ms to 24 h, with at most 8 missed ticks caught up.
- `ms` may be a function of the state, and `null` pauses ticks, so a paused module costs nothing until input or new
  props arrive.

#### Component module handlers

- `key(state, {kind: 'key', key, text})` receives keys while the node, given `keys: true`, has focus from a click
  or Tab (Esc and Ctrl+] return focus; pasted text arrives as one event with `key: null`).
- `pointer(state, {kind: 'pointer', column, row, action, button})` receives pointer events over the region with
  `pointer: true`, consecutive moves coalesced.
- `view(state, ui)` returns a render tree (`box` without style, `line`, `text`, `markdown`, `code`, `diff`, `list`;
  at most 64 components, depth 6, 256 KiB).

`ui` is `{columns, rows, props, post(data)}`, where `rows` is the node's `height` and 0 when it has none (auto
height). `post` hands the mod's `component_post` hooks `{component, module, data}` at most once per frame (a later
post in the same frame replaces it; 64 KiB).

#### Component module authority and failure

- Handlers can't call host operations, including `time.sleep`. A call fails with `host_operation_unavailable`, and
  no `host_operation` hook or interceptor sees it. Handlers can't write state, but `api.state.get()` and
  `api.uiState.get()` return the current values at every step.
- A throw, three consecutive steps over 8 ms after the mounting one (`component_overrun`) or an invalid tree
  unmounts the node, which then draws one dim error line (the error's first line) until the next view revision
  mounts it again. A failed step never counts toward the mod's [fault limit](reference/host-model.md#fault-limit).
- Without `height` the region is as tall as its latest tree.

#### Component modules for external clients

External clients read a node's tree with [`omd/render`](reference/omd-client-protocol.md#omdrender)
`{slot: 'module', props: {component, columns?, rows?}}`. Each client gets its own instance of the node. It is sized
by `columns` and `rows`, or as last rendered. The default is 80 columns and 0 rows. `effective.next_ms` in the result
says when the next tick is due. The client sends key and pointer events through `omd/client/event`.

Their posts reach `component_post` as `{component, module, client, data}`. `component_post` hooks can call the same
host operations as `component_event` hooks, for terminal and client posts alike. Detaching unmounts the client's
instances.

## Graphics

Use it when a mod shows pictures or draws pixels and cells: the `image` component and its renderers, image sampling,
rasters and `terminal.blit`, the underlay, and processes that feed a raster frames or raw pixel buffers. Which renderer
a terminal or client offers is in the [`terminal` event `client`](reference/terminal-operations.md#terminal-event-client).

Entries are frozen in Mod API `1.0.0` unless marked experimental (see the
[registry table](reference/stability-and-migration.md#experimental-entries-in-the-registry)); rasters and `terminal.blit` are
experimental. They draw in the OMD terminal on Apple Silicon macOS and in
[external clients](reference/external-clients.md).

### `image` component

An `image` draws a picture in its cells, aspect-fit to the measured cell size. The renderer depends on the terminal:

| Renderer | Where |
| --- | --- |
| Kitty graphics image (Unicode placeholders, so it scrolls, clips and hides under dialogs and overlays like text) | local Kitty and Ghostty |
| iTerm2 inline image (`iip`) | local Orca, iTerm2 and WezTerm |
| Truecolor half-block cells | elsewhere |
| Alt text | under `NO_COLOR` or below 4 columns |

Each image component has its own image id; replacing or removing the component deletes it, and exit and suspend
delete every image.

### Image formats and pixel mapping

An image is PNG or JPEG, at most 8 MiB and 4,096 pixels a side (`terminal_raster_v1`). An SVG `image`
([`svg_assets_v1`](reference/state-and-storage.md#svg-assets-svg_assets_v1)) draws `[image unavailable: alt]` in the terminal,
which has no SVG rasterizer; external renderers receive the same resource and draw it natively.

The image is aspect-fit into the component's cells from its top-left cell. Kitty uses `client.cell_px` as the cell
size, or 8×16 pixels when that is unknown. Half-block cells count as 1×2 pixels. With these sizes a mod can map
`pointer` cells and `half` rows on an `image` back to image pixels.

### `terminal.image_sample`

Use it to read a picture's colors at cell resolution, for example to draw it into a raster.
`terminal.image_sample {resource, columns, rows}` (experimental) returns `{width,height,rgba}` (row-major RGBA bytes)
for a caller-owned PNG/JPEG.

| Limit | Value |
| --- | --- |
| Columns | integers 1..120 |
| Rows | 1..60 |
| Source size | at most 8 MiB |
| Source dimensions | 4,096 pixels per dimension |
| Decoder allocation | 64 MiB |

### Rasters (`terminal_raster_v1`)

A raster is a keyed canvas of cells that a mod fills with `terminal.blit`.

#### `raster` component

`{type: 'raster', id, label, alt, width?, height?, pointer?}` (experimental) is a keyed canvas of 1–512 × 1–256 cells
that shows `alt` until its first frame and clips to the component's width.

- An omitted `width` fills the region's width.
- An omitted `height` shares the rows left in a layout region like `terminal`, `document`, `diff` and `list` (12
  elsewhere).
- A raster with an omitted `width` or `height` has the size it last rendered at, and a cells `terminal.blit` before
  its first render is `terminal_blit_unknown`.
- A mod can have at most 16 rasters: a blit to a 17th key is `terminal_blit_limit`; a raster's frames are dropped with
  its component.

#### `terminal.blit` cells

`terminal.blit {key, rect: {x, y, width, height}, cells}` (experimental) updates part of the caller's own raster (`key`
is its id). `cells` lists the rect's cells row by row, each a one-cell glyph or `[glyph, fg, bg]` with theme colors or
null.

`terminal.blit {key, rect, packed}` (`terminal_raster_packed_v1`) passes the same cells as base64 of `rect.width ×
rect.height` little-endian u32 triplets `[codePoint, fg, bg]`, row by row:

- A code point is one printable column (no controls, combining marks or wide characters).
- A color is `0x00RRGGBB`, `0x01000000` for the theme default or `0x02000000 | index` for a 0–255 palette color;
  under `NO_COLOR` every cell draws in the default colors.
- A cell takes 16 bytes of base64, about half a colored JSON cell, and the host decodes it without a JSON tree. The
  runner has no `btoa`; the [`raster_wave`](examples/raster_wave/index.ts) example has a base64 encoder.
- A callback's host calls, arguments included, share its 1 MiB
  [host call transport budget](reference/host-model.md#host-call-transport-budget): a packed cell takes 16 bytes of it and
  a colored JSON cell about 29. Timer ticks are 16 ms apart, so a larger raster should redraw only the cells that
  change.
- External clients receive `packed` updates as `cells`.

| Error | When |
| --- | --- |
| `terminal_blit_not_owned` | The raster is another mod's. |
| `terminal_blit_unknown` | The terminal has not received the raster in a view yet, such as one returned by the same callback. |
| `terminal_blit_too_large` | One call is over 256 KiB. |
| `terminal_blit_limit` | A blit to a 17th key. |
| `terminal_blit_packed_invalid` | `packed` is not base64, is not 12 bytes a cell once decoded, or has a code point or color outside the rules above; the message names the cell. |

Cells and packed updates that reach a raster before its next 16 ms frame merge into that frame, and later cells
overwrite earlier ones. So one timer tick can draw a frame in several calls. The host drops cells identical to what
the raster already shows. A call that changes nothing returns `queued: 0` and draws no frame.

The call returns `{frame, queued, frame_ms}`. `frame` is the frame the update shows in, and `queued` counts the
pending frames, such as a picture and the cells merged after it. Merged cells never need more room than the raster,
so cell updates get `{status: 'backpressure', retry_after_ms: 250}` only while a pending frame stays undrawn for four
ticks, for example in an inactive tab or an unplaced layout. Image and pixel frames follow the pacing in
[Frame pacing](#frame-pacing-and-profiling).

#### `terminal.blit` images

`terminal.blit {key, image: {media_type: 'image/png' | 'image/jpeg', base64}}` (instead of `rect` and `cells`)
draws one transient picture in a raster you own, aspect-fit from the top-left cell into the raster's width × height
cells by the same rule and renderers as `image` (Kitty placeholders, iTerm2 inline images, truecolor half-blocks,
`alt` under `NO_COLOR`).

- The newest frame replaces the previous one, a cells blit replaces the frame and a frame replaces the cells.
- It is never stored as a resource. Prefer it to a new `image` resource per frame, which uses up the record quota,
  and to cells, which give two effective pixels a cell.
- External clients whose renderer `formats` include the media type receive the frame as sent, other clients with
  `cells` receive half-block cells.

| Error | When |
| --- | --- |
| `terminal_blit_image_invalid` | A wrong media type, bad base64 or an image that does not decode within 4,096 px per side. |
| `terminal_blit_invalid` | Not exactly one of `cells`, `packed`, `image` and `pixels` is passed. |

The host returns both errors before it queues the frame.

#### Underlay (`terminal_underlay_v1`)

`underlay: {raster: KEY}` draws one of the mod's own cell rasters under the whole fullscreen screen, behind the
conversation, the composer and the footer. It is experimental and exclusive: the first mod in composition order
gets it, and later claims become `terminal.conflicts` entries. A raster key another mod already draws is refused the
same way: the underlay is dropped and the conflict names that mod.

- The raster has the screen's size (at most 512 × 256) and needs no component; blit it with `terminal.blit` like any
  raster. Before the first draw a blit is `terminal_blit_unknown`. After a resize the old frame draws clipped until a
  blit at the new size starts a fresh raster; a reply with `frame: 1` and `queued: 1` means the raster restarted, so
  send it whole.
- It is painted after the transcript and the bottom pane and before selection, layout regions, the sidebar,
  overlays, the `welcome` site and dialogs, so all of those draw over it.
- Its background colors every cell whose background is the terminal default, and Codex's raised surface (menus,
  list views, the composer, submitted prompts) gets the same color lifted the way Codex lifts the terminal
  background. Text with the default color on a colored cell gets a readable foreground; explicit colors stay,
  except on a light terminal, where any that would be hard to read get a readable one.
- The underlay's glyphs draw only in blank cells after each row's last character plus a 2-cell gutter. They draw at
  full color in the transcript and at 35 % on the raised surface. Transcript images and the footer never show them,
  and OMD's own copies never include them. The terminal's own selection (for example Shift-drag) copies what the
  screen shows.
- Image and pixel frames draw nothing. Nothing draws under `NO_COLOR`, with fewer than 256 colors (`colors: '16'`),
  below 60 columns, inline (`--no-alt-screen`) or in an external client.

### Raster processes (`process_raster_v1`)

With `process_raster_v1` and the `terminal` capability, `process.start` for an `ndjson`
[managed process](reference/managed-processes.md) accepts:

- `raster: KEY` (one of the caller's raster ids);
- optionally `keys: ID` (a `keys: true` component).

The host draws each stdout message `{"blit": {media_type, base64}}` into that raster, as if the mod had called
[`terminal.blit {key, image}`](#terminalblit-images). It applies the same validation but needs no callback per
frame. The newest frame wins, and a frame the terminal cannot take yet is retried for up to 5 s.

#### Pixel buffers (`raster_pixels_v1`)

With `raster_pixels_v1` and `pixels: true` the host also creates a private raw buffer and sends `{"pixels":
{"source": HANDLE, "path": PATH}}` on stdin before any raster input. Without `pixels: true` the process gets no
buffer, and the host stops the process with `terminal_blit_source_not_owned` when it publishes raw pixels.

The process opens that file, writes exactly `width * height * channels` packed bytes at offset zero, and publishes:

```text
{"blit": {"pixels": {"source": HANDLE, "format": "rgb" | "rgba", "width": W, "height": H, "sequence": N}}}
```

The equivalent mod call is `terminal.blit {key, pixels: {...}}`. Sequence numbers start at 1 and increase for each
publication.

#### Pixel publication acknowledgement

The process must not modify the buffer until stdin acknowledges `{"pixels": {"source": HANDLE, "sequence": N,
"ready": true, "error": null}}`.

- The host sends a successful acknowledgement when the next frame should start, which can be later than the copy.
  It times the acknowledgement so the next publication arrives just before the following 16 ms tick, based on how
  long the process took to publish after its previous acknowledgement.
- A process that renders on each acknowledgement shows fresh frames with one copy per shown frame.
- An owned invalid descriptor or failed copy returns `ready: false` with an error at once.
- A failed copy does not consume the sequence, so direct callers may retry the same publication.
- Retrying an accepted publication reuses its copy without a second acknowledgement.

#### Pixel publication retries and backpressure

A process's pending raw publication is retried while the process is active only for surface, layout and
callback admission errors (`terminal_blit_unknown`, `terminal_blit_not_owned`, `terminal_blit_limit`, `callback_*`,
`client_surface_*`). Any other error, and confirmed owner revocation, stops the process.

- While a raw frame waits for its 16 ms tick, a newer raw publication gets backpressure.
- A raster whose last frame stayed undrawn for four ticks (an inactive tab or unplaced layout) answers
  `retry_after_ms: 250` until it is drawn again.
- Backpressure neither copies nor acknowledges the buffer, so the same publication can be retried safely.

#### Pixel buffer safety and limits

- The host retains the original descriptor, copies a bounded immutable frame, and never reopens a process-supplied
  path. Replacing the pathname cannot redirect the read.
- Handles are bound to the thread, mod generation, raster and process lifetime; stopping/reloading the process
  revokes them.
- Frames are limited to 4,096 pixels per side (64 MiB for RGBA), with one newest pending image per raster.
- General POSIX shared memory is not granted by the sandbox; the private file works under the existing process
  sandbox.

Raw frames reach Kitty without PNG encoding. Inline-image terminals and external PNG/JPEG clients receive encoded
snapshots scaled down to the raster's pixel size (a client's `cell_px`, else 8×16) and at most 8 MiB, and
cells-only clients receive half-blocks. Host paths and handles never reach external renderers.

#### Frame pacing and profiling

Frames are paced at 16 ms while experimental, and the pacing may change; `terminal.blit` returns the current `frame_ms`,
and backpressure returns `retry_after_ms`. Processes that publish encoded frames keep their stdin and stdout shapes.

For local profiling, `OMD_FRAME_TRACE=/absolute/new/file.jsonl` enables per-stage wall and thread-CPU timings; the
file must not already exist.

#### Raster pointer, key and box input

Stdout messages other than `blit` reach `process_event` and `process.exchange` as usual. Input on a bound raster is
written to the process's stdin instead of [`component_event`](reference/terminal-input.md#component_event) callbacks:

| Input | Stdin message |
| --- | --- |
| Pointer events on the raster | `{"pointer": {action, button, x, y, inside}}`, with `x`/`y` in the drawn frame's pixels (null before a frame; sub-cell on terminals that report pixel positions) |
| Key and paste input on the keys component | `{"input": [events]}` |
| After the first render, and whenever the raster's drawable box or the client cell changes | `{"box": {columns, rows, cell_px: {width, height}}}` |

- A left press on the raster focuses the keys component.
- Bindings are scoped to the owning conversation thread.
- Input queues contain at most 128 messages and 256 KiB; consecutive motion and resize messages coalesce.
- Overflow or a write blocked for two seconds stops the process and discards queued input.
- The binding ends with the process.
- An invalid key or another framing is `process_raster_invalid`; without `terminal`, `capability_denied: terminal`.

## Terminal operations

Use it when a mod calls an operation the terminal serves (notifications, threads and imports, selection and
clipboard, opening files, prompts, panes, panels, notices and PTY sessions) or reads what the `terminal` event
reports about the terminal itself. Raster updates (`terminal.blit`) are in [Graphics](reference/graphics.md).

Entries are frozen in Mod API `1.0.0` unless marked experimental (see the
[registry table](reference/stability-and-migration.md#experimental-entries-in-the-registry)). They run in the OMD terminal on
Apple Silicon macOS. Every `terminal.*` operation except `terminal.pty` needs
the `terminal` capability; `terminal.pty` needs `pty`.

Operations the terminal UI serves, such as `terminal.panel`, need a running `codex` terminal. `omd-mod command` has no
terminal, so there they fail with `host_operation_unavailable: requires a native task`. Call them with
`api.host.tryCall` and fall back to returning text.

### Notifications and ports

```text
terminal.notify {title, body?} → {delivered, method, reason?}
sessions.ports → {ports: [{port, pid, address}]}
```

- `terminal.notify` uses the configured notification method with a focus condition and a 2 s rate limit. `method`
  is `osc9`, `osc99`, `osc777`, `bel` or `none`, and `reason` says why nothing was delivered.
- `sessions.ports` (`session_ports_v1`, `sessions` capability) returns the TCP listeners owned by the current
  thread's background terminals and their child processes, read by the host outside the mod sandbox (at most 32
  ports, 3 s per probe).

`commands.list`, `commands.describe` and `commands.invoke` are in
[Commands and configuration](reference/commands-and-composer.md#commands-and-configuration-command_config_middleware_v1), and
the `composer.*` operations in
[Composer drafts and suggestions](reference/commands-and-composer.md#composer-drafts-and-suggestions-composer_v2).

### Threads and imports

```text
terminal.show_thread {thread_id} → {shown}
terminal.import_file {path, max_bytes?, lifetime?} → ResourceRef | {status: 'declined'}
```

`terminal.show_thread` switches the terminal to `thread_id`. `terminal.import_file` imports a file the user confirms,
at most 8 MiB, and returns its resource; the confirmation shows the resolved path. SVG text is labeled
`image/svg+xml` and checked as an [SVG asset](reference/state-and-storage.md#svg-assets-svg_assets_v1).

#### Import lifetime

`lifetime` (`terminal_import_lifetime_v1`) is `thread` (the default) or `package`.

- A `package` import stays available across settings changes, reloads and new threads. It keeps its repository,
  owner, exact source and content identity, and the content can't change.
- A source change requires a new confirmed import. The original path is never reread.
- Existing blob and resource quotas apply; removing the mod store removes retained assets.

### Selection and clipboard

```text
terminal.selection {} → {text, truncated}
terminal.copy {text} → {status}
```

`terminal.selection` returns the current selection in the Codex terminal UI (a mouse selection or a
select-mode mark), or `text: null` when there is none. It
prefers the visible transcript overlay and never reads obscured transcript text, another client's selection or the OS
clipboard.

- UTF-8 text is capped at 64 KiB and further bounded by its JSON-encoded size so a selection followed by a copy fits one
  callback's [host call transport budget](reference/host-model.md#host-call-transport-budget). Any shortening sets
  `truncated: true`.
- `terminal.copy {text}` uses the native plain-text clipboard backend with the same 64 KiB limit. Its status is
  `confirmed`, `unconfirmed`, `pending` or `busy`; the native host waits for the matching clipboard worker's
  delivery result. `unconfirmed` means the backend cannot confirm delivery.

List `terminal_selection_v1` and `terminal_copy_v1` in `required_features`. Both operations work only from a
callback the local user started, such as a command or a clicked control. They reject calls from event and tool
handlers and from attached clients. Call `terminal.selection` from a clicked component action, as the terminal
example does, because typing a slash command clears the transcript selection before its callback runs.

#### Copy-on-select and right-click paste

Copy-on-select and right-click paste are Codex settings (`tui.copy_on_select`, `tui.right_click_paste`); mods
change them through `config.write`.

### `terminal.open`

```text
terminal.open {url} | {path} | {path, line?, editor: true} → {opened: true} | {status: 'declined'}
```

It opens an http(s) URL or an existing HTML, Markdown, text, PDF or image file after a
native confirmation.

`{path, line?, editor: true}` (`terminal_editor_v1`) opens a workspace file in the argv the user sets as `editor`
in `host.json`, with `{path}` and `{line}` substituted.

### `terminal.prompt`

```text
terminal.prompt {kind: 'confirm', title, message} → {status: 'accepted'} | {status: 'declined'}
terminal.prompt {kind: 'text', title, message, masked?} → {status: 'accepted', value} | {status: 'declined'}
terminal.prompt {kind: 'choice', title, message, options, multiple?, other?} → {status: 'accepted', values, other?} | {status: 'declined'}
```

It asks the user; mods never answer prompts. `masked` hides typed text.

`choice` (`ui_composition_v1`) shows a native picker of up to 32 `options` `{value, label}`: one value, several with
`multiple`, or a typed answer through an `Other…` row with `other`. Cancelling returns `declined`.

```ts
const answer = api.host.tryCall('terminal.prompt', { kind: 'confirm', title, message });
```

That call is from [`omd_git`](first-party/omd_git/index.ts).

### `terminal.pane` and `terminal.panes`

```text
terminal.pane {action: 'open' | 'close' | 'focus' | 'reveal', id} → {applied: true}
terminal.pane {action: 'scroll', id, offset} → {applied: true}
terminal.panes {} → {panes: [{id, visible, collapsed, focused, scroll}]}
```

`terminal.pane` (`ui_composition_v1`) opens, closes, focuses, scrolls or reveals one of the caller's own panes,
dialogs or controls; another mod's component is `terminal_pane_not_owned`. Scrolling uses
`offset`; a pane shows 8 rows and stops scrolling once its last row is in view.

`terminal.panes` (`ui_controls_v1`, experimental) returns the caller's own panes; a pane is `visible` while its
header row was on screen in the last frame.

### `terminal.panel`

```text
terminal.panel {title, subtitle?, tabs?, items, search?, query?, selected?, close_args?, action} → {shown: true}
```

`terminal.panel` (`terminal_panel_v1`) opens Codex's own list panel in the bottom pane, where `/config` is. Only
the user's own commands and panel actions open panels (`host_operation_user_only` elsewhere).

| Argument | Meaning |
| --- | --- |
| `title` | At most 128 bytes |
| `subtitle` | At most 2,000 bytes of plain text that keeps its line breaks |
| `tabs` | Up to 8 `{id, title}`, titles up to 32 bytes; with tabs, every item names its `tab` |
| `items` | 1–200 `{id, tab?, label, description?, group?, keywords?, detail?, kind, value?, options?}`: unique ids without spaces up to 128 bytes, labels up to 128 bytes, descriptions up to 256 bytes |
| `search` | `true` lets `/` search every tab |
| `action` | The caller's command that each change runs |
| `query`, `selected`, `close_args` | Experimental, under [Panel navigation](#panel-navigation-terminal_panel_navigation_v1) |

Item kinds:

| `kind` | `value` | Space or Enter |
| --- | --- | --- |
| `toggle` | boolean | Flips it. |
| `choice` | one of `options`, 1–32 `{value, label}` with unique values without spaces | Moves to the next option. |
| `text` | string up to 2,000 bytes | Opens Codex's single-line prompt; an empty answer is ignored. |
| `action` | none | Runs the action. |

Each change runs the caller's command `action.command` with `args`, the item id and the new value joined by spaces
(`set bars true`), and the panel shows the new value at once.

Keys in the panel:

- Up and Down move and repeat while held, and Left and Right switch tabs.
- `/` searches every tab when `search` is true: labels match fuzzily, best first, then items whose description,
  keywords or tab title contain the query. Esc clears the search or closes the panel.
- Outside a search, a letter moves to the next item whose label starts with it, `g` and `G` go to the first and last
  row, and Home, End, PgUp and PgDn work as in every Codex list.

A call with the same title as the caller's open panel replaces that panel in place. The new panel keeps the open panel's
tab, selected item and search, even across a panel without tabs, such as a confirmation. Another title opens a new panel
over it, and Esc returns to the one below.

#### Panel navigation (`terminal_panel_navigation_v1`)

These fields are experimental:

| Field | Meaning |
| --- | --- |
| Item `group` | Up to 32 bytes. Gathers items under a header row with their count, in order of first appearance after any ungrouped items; Space or Enter on the header collapses or expands it. |
| Item `keywords` | Up to 256 bytes, searched but not shown. |
| Item `detail` | Up to 512 bytes, shown below the list while the item is selected. |
| `query` | Up to 128 bytes; opens the panel with that search. |
| `selected` | The item to select first. |
| `close_args` | Arguments for the command that runs when the panel closes |

When the user closes the panel, the host runs `action.command` with `close_args`, the selected item id (`-` on a
header) and the user's last search, joined by spaces. The last search is the one the user last chose an item with,
and it is cleared when the user ends a search without choosing. A mod can use these to reopen the panel where the
user left it.

#### Panels after a reload

A package or settings change (`packages.apply`, `settings.write`) reloads mods, and the rest of that callback's
panel calls fail with `callback_cancelled`. When a command that changed packages or settings finishes, every open
panel's `action.command` runs again with its `args` alone, bottom panel first, so each mod redraws its panels from
current state; keep anything the redraw needs, such as a result notice, in `api.uiState` or in `args`.

### `terminal.notice`

```text
terminal.notice {text, kind?, placement?: 'toast' | 'status', ttl_ms?, id?} → {shown: true}
terminal.notice {id, placement?, clear: true} → {cleared}
terminal.notice {text, kind?, placement: 'transcript', audience?, tool_call_id?} → {shown: true, model?}
```

`terminal.notice` (`ui_controls_v1`) shows a notice of at most 512 bytes attributed to the mod. `kind` is `info`
(default), `warning` or `error`.

| `placement` | Where |
| --- | --- |
| `placement: 'toast'` (default) | Below the composer notes. |
| `placement: 'status'` | In the status row (first 40 characters). |
| `placement: 'transcript'` | Appends a log notice to the transcript. Only a notice with `audience: 'model'` reaches the model. |

Toast and status notices:

- Each lasts `ttl_ms` (1,000 to 60,000, default 5,000).
- At most 4 per mod; a new notice with the same `id` replaces the old one.
- `{id, placement, clear: true}` removes it early and returns `{cleared}`.

Transcript notices:

- `audience: 'model'` also adds the text as mod-provided context to the thread's next model request and every retry
  of it until a response completes. At most 8 such notices are queued per thread. Another one fails with
  `model_context_queue_full`. A request contains at most 8 of these notices and `model_request` interceptor sections
  together, and the rest wait for the next request.
- `tool_call_id` draws a transcript notice beneath that tool call's cell in the fullscreen transcript, or as a notice
  naming the call in inline mode or when no drawn cell contains the call.

### `terminal.pty`

```text
terminal.pty {action: 'start', session, cwd?, program?, argv?, sha256?, write?, network?, sandbox?, files?} → {session, running: true} | {status: 'declined'}
terminal.pty {action: 'write', session, text} → {written}
terminal.pty {action: 'read', session} → {text, running, exit_code, files?}
terminal.pty {action: 'stop', session} → {stopped: true}
```

`start` starts an interactive shell after the user confirms. Call it from a user command. The shell runs in the
session sandbox, without network, with a scratch `HOME`.

`start` accepts:

| Field | Meaning |
| --- | --- |
| `program`, `argv`, `sha256` | May name a program (`pty_programs_v1`). |
| `write: true` | Lets the pane write the workspace; needs `fs.write`. |
| `network: 'loopback'` | Lets it reach services on this computer only; needs `network`. |

The confirmation names the program, write and network access and that the mod can type into the pane.

With the `os` grant, `sandbox: 'none'` starts a listed program unsandboxed with the real `HOME` (no `write` or
`network` fields) and stops when the grant ends.

- The host hashes the resolved program and asks once per mod and binary ("Allow and remember"). It starts without
  asking while the hash matches and asks again when the binary changes, for example after a package manager upgrade.
  Pins are in `program-pins.json` in the mod store and are shared with the other unsandboxed starts, as described in
  [Authority grants](reference/authority-grants.md#os_access-manifest-field).
- A declined prompt returns `{status: 'declined'}`. A start that reaches the spawn without that approval or a matching
  pin fails `pty_program_unpinned`.
- The pane gets the environment of an
  [unsandboxed `exec.run`](reference/running-commands.md#execrun-with-sandbox-none), the mod's declared `exec_environment` names
  included, plus `SSH_AUTH_SOCK`, `TERM=xterm-256color` and, on a 24-bit color terminal, `COLORTERM=truecolor`. 24-bit
  colors are drawn at the terminal's color depth.

Each mod can have up to `pty_panes_per_mod` sessions, set in `host.json` `mod_limits` (default four, maximum
sixteen). The host allows sixteen sessions in all.

Sessions:

- Are bound to the calling mod, thread and admitted generation.
- Render only in terminal components owned by that mod.
- Stop when the thread, repository, permission context or admitted generation changes, or the mod unloads. A stop
  hangs up the program (SIGHUP) and kills it 2 s later if it still runs.
- Queued requests and terminal input retain their original binding and cannot address a replacement session.
- A focused `terminal` component receives keys; Ctrl+] (or Ctrl+5) leaves it.

#### Terminal pane extension (`terminal_pty_v2`)

`terminal_pty_v2` (experimental) adds:

| Addition | Behavior |
| --- | --- |
| Keys | xterm encodings: F1-F12, PgUp/PgDn, Insert, Home/End, Shift+Tab, modified arrows (`CSI 1;m X`), Alt as an Esc prefix, Ctrl+Space and Ctrl+symbol control bytes, application-cursor mode. |
| Drawing | A focused pane draws its cursor; wide characters take two cells; italic, underline and dim are kept. |
| Links | OSC 8 `http`/`https` links become terminal hyperlinks. |
| Replies | The pane answers device attributes (`CSI c`), status (`CSI 5n`) and cursor position (`CSI 6n`) queries, as a terminal does. |

It also adds the mouse, signal, clipboard, session directory and focus behavior below.

##### Pane mouse input

When the program enables mouse reporting, clicks, releases, drags, motion and the wheel go to it in its encoding
(SGR, UTF-8 or X10) with modifiers. Otherwise the wheel scrolls the pane's scrollback, or sends Up/Down on the
alternate screen.

##### Pane signals

- Title changes (OSC 0/2), the bell and OSC 9 / OSC 777 notifications reach the owner as `component_event`
  `title {title}`, `bell` and `notify {text}` (1 KiB, ten a second).
- The exit arrives once as `exit {session, exit_code, files}`.
- A drawn `terminal` component whose session isn't running (never started, stopped, or ended by the host on a thread
  switch, reload or restart) reports `exit {session, exit_code: null}` once, so the owner can drop its layout.

##### Pane clipboard

An OSC 52 copy asks the user once per pane ("Allow for this pane"), then goes through the terminal's clipboard. A
decline lasts for the pane.

##### Session directory

`start {files: {NAME: text}}` (four files, 16 KiB each, names `[A-Za-z0-9._-]`) writes a private directory. Every
`{dir}` in `argv` is its path. Errors are `pty_files_invalid`.

- The exit event and a `read` after the exit return its top-level regular files (64 KiB in all; symlinks and hard
  links are skipped), including files the program wrote.
- It is removed when the session stops or is replaced. One left behind when OMD quits is removed by the next start.
- Unsandboxed panes keep it in `pty-sessions` in the mod store, out of every sandbox's reach. Sandboxed panes keep it
  in the scratch `HOME` they share, so other sandboxed panes can read it.

##### Pane focus

- `autofocus: true` on the `terminal` component focuses it when it appears while nothing else has focus, and when
  its focus region is entered.
- A focused terminal shows a Ctrl+] hint until the first key. Inside a focus region the first Ctrl+] leaves for the
  region and a second for the chat.
- A key for a terminal whose program has ended leaves it.
- When a focused terminal unmounts, focus returns to where it was before.

### Terminal identity (`terminal_identity_v1`)

The `terminal` input has a read-only `identity` (`terminal_identity_v1`):

- `codex_version` from the installed build;
- `omd_version`, the installed OMD release, such as `1.2.0` or `1.3.0-rc.2` (experimental);
- `install_profile` (`full`, `platform_only`, `private`, `unknown` or `unreported`);
- effective `mode` (`omd`);
- installed, enabled, active and failed mod counts.

In [`direct` mode](reference/glossary.md#stores-and-data), which runs plain Codex with no mods, no `terminal` handler runs.

### `terminal` event `client`

The `terminal` event has `client: {kind: 'terminal', graphics, pointer, reduced_motion, cell_px, columns,
rows, sites?}` and, with external clients attached, `clients` (see
[Renderer capabilities and fallback](reference/omd-client-protocol.md#renderer-capabilities-and-fallback)):

| Field | Meaning |
| --- | --- |
| `graphics` | `kitty` (pixel images), `iip` (iTerm2 inline images: Orca, iTerm2, WezTerm), `cells` (half-block) or `text` (`NO_COLOR`). |
| `pointer` | `half_cell`, `cell` or `none` (no mouse capture: tmux, `OMD_TUI_MOUSE=off`, inline viewport). |
| `reduced_motion` | Follows `tui.animations` and the system setting, and mods that animate stop when it is true. |
| `cell_px` | The measured cell size or null. |
| `columns` and `rows` | The terminal grid. |
| `sites` | `terminal_site_area_v1` (an experimental field): `{[site]: {columns, rows}}` for the mod's own drawn sites |
| `welcome` | `terminal_welcome_area_v1`: `{columns, rows}` of the blank area a `welcome` site gets this frame, or null when the welcome cannot show |
| `chat` | `terminal_chat_area_v1`: `{x, y, columns, rows}` of the chat column this frame, or null before the first fullscreen draw |
| `colors` | `terminal_colors_v1`: the colors the terminal shows, `truecolor`, `256` or `16`. |

- `sites` lists each of the receiving mod's own `owner/name` sites that the last frame drew as a layout leaf or an
  overlay. Each entry is the cells its components got inside the frame's border, padding and title. `sites` is
  absent when the last frame drew none, and sites stacked in the sidebar are not listed.
- The `welcome` area is the chat width beside any sidebar or dock, by the unused transcript height. Size welcome
  content from it.
- The `chat` column is the conversation and composer, beside any sidebar, dock or layout region. Place art relative
  to the conversation with it.
- A change in `welcome` or `chat` renders the view again.

`client` is null without a terminal client. When any of these change (the window or font is resized, animations are
turned off) the view renders again with the new `client`. If several changes arrive while a render is in progress,
the host renders once more after it. A change in a drawn site's area also renders the view again. The exception is
when the area returns within a second to the size it had before the last change. A view that sizes its own layout
from `sites` can cause that loop, so the host skips the render.

## Protected authority (macOS)

Use it when you deploy or reason about the macOS authority broker: what it protects, how changes are
authenticated, where its trust boundary ends, and how it is pinned, reset and removed. For what a user sees, see
[Trust and permissions](https://github.com/dzkchen/oh-my-diff/blob/main/docs/trust-and-permissions.md).

Host behavior outside the mod API. macOS only: the broker is a LaunchDaemon.

### The broker

`omd-package broker install` (sudo) deploys an OS-separated broker as two LaunchDaemons:

| Daemon | Runs as | Socket | Answers |
| --- | --- | --- | --- |
| The broker | The hidden `_omdbroker` account, which owns `/Library/Application Support/OhMyDiff/broker` (mode 0700) | `/var/run/dev.ohmydiff.broker.sock` | Pinned hardened-runtime binaries (see below) |
| `omd-broker power` | root | `/var/run/dev.ohmydiff.broker.power.sock` | Only the broker's account |

The broker answers a peer only when the peer's kernel audit token resolves to a hardened-runtime binary whose code
directory hash root has pinned. The broker asks the kernel for the running peer's signing status and code directory hash
and never reads the executable, so binaries installed under a private home folder verify too.

`omd-broker power` does one thing: it sets `SleepDisabled` for
[power holds](reference/sessions-and-turns.md#power-holds-power_hold_v1). It restores the previous value when the last hold
ends, when the broker exits, or when `omd-broker power` restarts after a crash. It then sleeps the Mac if the lid is
closed.

### Without the broker

Without the broker, credential profiles, the trusted grant set, the task ledger and contract state are files in the
mod store. Any process running as the user can read or change them, including an explicitly unsandboxed child, and
`status.authority` reports `unprotected (same-user)`.

Agent commands that Codex runs in its sandbox can't reach the mod store, workspace leases, `host.json` protected
paths or secret files. Commands Codex runs without its sandbox (approved escalations, allow rules, full access, an
external sandbox) can reach them.

### What the broker protects

While the root-owned daemon plist exists, `status.authority` reports `protected (OS-separated broker)` and the host
protects credentials, the runner, grants and the ledger as below. When the broker can't be reached, the host fails
closed with `authority_broker_unavailable`: mods stay inactive and the session continues without them.

#### Credentials and secrets

The broker stores credential profiles, secrets and sign-in tokens; enrollment never writes them to the user's disk.
A mod's own secrets do leave the broker: `sidecars.start` places them in the sidecar's environment
(`OMD_SECRETS`), so a same-user process can read them as described in
[Trust boundary and limits of the broker](#trust-boundary-and-limits-of-the-broker).

#### Runner grants

Mod callbacks run only under the `omd-runner` beside the host executable whose path and digest the broker stores as
a runner grant.

- Only `omd-mod init`, `omd-mod authorize-runner STORE` (the installer runs it after each update) and broker grant
  import grant a runner; trusting or installing packages never does.
- A runner that doesn't match fails with `runner_unverified`, and `runner_changed` when the binary changes after
  verification. A missing runner fails with `runner_unavailable`, with no fallback to another program.
- The compiled-module cache in `<store>/cache/code` contains only V8 bytecode. While the broker or an administrator
  policy pins trust, the runner ignores the cache and compiles the trusted package source. Otherwise the runner uses
  the cache. That adds no authority, because a process that can write the store can already change trust through
  `mods.json`.

#### Selection grants

The host accepts a mod selection only when the broker has the same grant (path, digest, capabilities, scope and
secret environment), otherwise `grant_not_brokered`. Enabling, disabling and settings changes don't touch the grant.

- `trust`, `trust-all`, exact broker grant import and package installs or updates add grants, and only for the
  selections they change, so an entry another process adds to `mods.json` is never granted by an unrelated change.
- Removing a selection revokes its grant without authorization.
- A running mod whose grant disappears is unloaded at the next reload, and all mods unload while the broker can't be
  reached.
- The host re-reads grants when `mods.json` changes and at most every 2 s otherwise.

#### Ledger and contract anchors

The broker anchors every task-ledger record and contract-state write. The host refuses a ledger or contract state
that differs from its anchor, including a deleted one (`evidence_anchor_mismatch`,
`contract_state_anchor_mismatch`).

- State that was never anchored (created before `broker install` or after `broker reset`) is anchored as found when
  it is next opened.
- A record is written before it is anchored, and a record whose anchor fails is removed.

### Authenticating changes

Changing grants or enrolled credentials makes the broker ask the logged-in user to authenticate in a system dialog
(right `dev.ohmydiff.broker.grant`). Without a GUI login session, for example over SSH, OMD asks for the macOS
login password in the TUI or terminal instead, and the broker checks it against the connecting user's own account.

- Mods can't produce that prompt: their prompts always name the asking mod.
- Each change includes a single-use broker challenge bound to its digest and a generation check, so a stale writer
  is refused.
- Broker policy values need an administrator (`dev.ohmydiff.broker.policy`).

### Trust boundary and limits of the broker

The trust boundary is the OS plus the pinned binaries. Broker install and pin accept only the helper and binaries
listed in a release manifest signed by the Oh My Diff release key. Later privileged steps run from a root-owned copy
of the broker tooling. As a result, a locally built or replaced binary can't be pinned.

The broker doesn't protect against an administrator or root. With the broker deployed, a process running as the same
user can and can't do the following:

| Asset | A same-user process can | It can't |
| --- | --- | --- |
| Grants | Edit `mods.json`, and remove a selection, which revokes its grant | Add or widen a grant without the broker's authentication dialog (the host rejects it with `grant_not_brokered`) |
| Credential tokens | Use enrolled credentials against their enrolled origins, through OMD or a sidecar's gateway path | Read a token, or send it to another origin |
| Mod secrets (`OMD_SECRETS`) | Read a mod's secrets by editing its service grant in the user-writable `host.json`, because the secrets are placed in the sidecar's environment | Read them through an OMD API; OMD offers no secrets-read API |
| Ledger and contract state | Edit or delete the files | Make the host accept them: a record that differs from its anchor is refused |
| The runner | Replace the `omd-runner` binary | Run mod callbacks under it (`runner_changed`) |
| Files and the TUI | Read every user-readable file (for example `~/.codex/auth.json` or other secret files) and drive OMD interactively | Skip the authentication dialog, which still appears for each change |

### Broker pinning, reset and uninstall

- Installs, upgrades and rollbacks of signed releases pin their binaries (one sudo prompt), and `omd-package broker
  pin` re-pins by hand.
- `omd-package broker reset` clears grants and anchors but keeps credentials.
- `omd-package broker uninstall` removes the daemon, account, rights and all broker state, returning to same-user
  mode.

## Administrator policy and managed deployment

Use it when an organization restricts which mods run, pins and deploys packages with `package-sync`, or recovers
from a managed failure. Storing the policy in the broker needs [protected authority](reference/protected-authority.md).

Policy `schema` 1, read by the host on Apple Silicon macOS; it isn't part of the mod API.

An organization restricts and deploys mods through one administrator policy. OMD reads it from the broker (key
`mods`) when the broker is deployed and has one, otherwise from the root-owned file `/Library/Application
Support/OhMyDiff/policy.json`.

### Installing and replacing the policy

- With the broker, `omd-mod policy set FILE` stores the policy in the broker and needs an administrator
  (`dev.ohmydiff.broker.policy`); `policy rollback` swaps it with the value it replaced and `policy clear` removes
  it.
- Without the broker, `omd-package policy install FILE` (sudo) checks the policy and writes the file (mode 0644,
  keeping the replaced one), `policy rollback` swaps them back and `policy remove` deletes it.
- A policy file or folder that isn't owned by root or is writable by anyone else fails with
  `managed_policy_untrusted` and no mod loads until it is fixed.

OMD never contacts a vendor for policy and there is no remote disable: restrictions are an organization's own
decision, made on the machine.

### Policy fields

The policy is one JSON object of at most 64 KiB. Unknown fields fail with `managed_policy_invalid`.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `schema` | `1` | required | Policy format version. |
| `managed_only` | boolean | `false` | Load only the packages the policy lists. |
| `sideload` | boolean | `true` | Allow user packages without [broker-protected install provenance](#package-source-provenance). |
| `sources` | string array | none (any source) | Source prefixes installs and loads must match. |
| `updates` | `"user"` or `"managed"` | `"user"` | Who updates and rolls back installed packages. |
| `deny` | mod id array | `[]` | Mod ids that never load. |
| `capabilities` | capability array | none (every capability) | The most any unmanaged mod is granted. |
| `index` | `{sha256, locations}` | none | A package index, read from the first absolute path in `locations` whose bytes match `sha256`. |
| `registry` | URL | none | The npm registry for `npm:` sources that name none. |
| `packages` | entry array | `[]` | Managed packages, described in [Managed `packages` entries](#managed-packages-entries). |

`omd-mod policy check FILE` checks these rules before you install a file.

### Policy file example

Replace each `SHA256` with the 64-character hex digest of the package or index, and `COMMIT` with a commit hash.

```json
{
  "schema": 1,
  "managed_only": false,
  "sideload": true,
  "updates": "user",
  "sources": ["/Library/OhMyDiff/packages/", "npm:https://npm.example.com/@corp/"],
  "deny": ["old_tool"],
  "capabilities": ["commands", "interception", "store"],
  "index": {"sha256": "SHA256", "locations": ["/Volumes/mirror/index.json", "/Library/OhMyDiff/index.json"]},
  "registry": "https://npm.example.com",
  "packages": [
    {
      "id": "corp_guard",
      "source": "corp_guard@2.0.0",
      "sha256": "SHA256",
      "capabilities": ["interception"],
      "tier": "append",
      "settings": {"mode": "strict"},
      "percent": 20
    },
    {
      "id": "corp_guard",
      "source": "/Library/OhMyDiff/packages/corp_guard",
      "sha256": "SHA256",
      "capabilities": ["interception"],
      "tier": "append",
      "mirrors": ["git+https://git.example.com/guard.git#COMMIT"]
    }
  ]
}
```

The two `corp_guard` entries are a rollout: 20% of accounts get `2.0.0` and the rest keep the folder package.

### Policy controls and refusals

The controls apply to user and project selections; packages the policy lists are never refused by them:

| Field | Refusal |
| --- | --- |
| `deny` | `managed_denied`: the mod ids are revoked. |
| `managed_only` | `managed_only`: only managed packages load. |
| `capabilities` | `managed_capability_denied`: a capability outside the list, for example `approve.override`, is withheld from every unmanaged mod. |
| `sideload: false` | `managed_sideload_denied`: user packages need broker-protected install provenance, and `trust` refuses. |
| `sources` | `managed_source_denied` (rules below) |
| `updates: "managed"` | `managed_updates_denied`: users can't update or roll back installed packages. |

`sources` rules:

- Installs and loads need an allowed source namespace: a folder path, `git+URL`, `index:PATH#ID` or
  `npm:REGISTRY/NAME`.
- A match needs an exact reference or a `/` or `#` boundary. Traversal segments are refused.
- Loads without protected provenance report `managed_source_unverified`.

These refusals apply at every reload, so revoking takes effect immediately, and `/omd` lists them.

Codex's managed requirements set the approval floor, and `approve.override` never overrides them. To withhold
approval authority itself, leave `approve` and `approve.override` out of the `capabilities` list.

An administrator's required `model_send` policy does not cover web search, which
[final-request policies](reference/final-request-policy.md) never see.

### Package-source provenance

Package-source provenance is the broker's record of where a user package came from. It binds the package id, path
and content hash in the broker's protected grants, and the `sources` and `sideload` restrictions check it.

- Only a verified online package install records it; editable locks, offline cache claims and broker grant import
  cannot establish origin.
- Under source or sideload restrictions, user packages without this evidence stay unloaded, including file-policy
  deployments without a broker.
- Git verification reads fresh fetched objects with isolated configuration; cached URL rewrites, replacement refs
  and editable cached objects cannot certify origin.
- Reinstall from a verified source with the broker deployed to establish evidence.
- Managed packages use the administrator's pins directly.

### Managed `packages` entries

Each `packages` entry pins a package's exact content (`sha256`) and its grant (`capabilities`, `dependencies`,
`secret_environment`); the policy is the grant, so a managed package needs no broker grant or user prompt. A policy
can't grant install scripts.

| Entry field | Type | Meaning |
| --- | --- | --- |
| `id` | mod id | Required. The package's mod id. |
| `source` | string | Required. A folder path, `ID@VERSION` from `index`, `git+URL` or `npm:` reference. |
| `version` | string | Optional version applied to an `ID` or `npm:` source. |
| `sha256` | hex digest | Required. The exact package content. |
| `capabilities` | capability array | Required. The capabilities granted. |
| `dependencies` | boolean | Default `false`. Grants the package's declared dependencies. |
| `secret_environment` | string array | Secret environment variables granted. |
| `settings` | object | Setting values; `policy explain` reports their origin as `managed`. |
| `mirrors` | string array | Sources tried in order after `source`. |
| `users` | string array | Account names the entry targets. |
| `percent` | 1–100 | Targets a stable share of accounts per package id. |
| `projects` | absolute path array | Lists folders the session's repository must be inside, compared after resolving symlinks. |
| `tier` | `"prepend"` or `"append"` | Places the package's interceptors: `prepend` outside every other mod, `append` inside. |

- For each id the first entry that applies is the target and later entries are fallbacks, so a rollout lists the
  new content first and the current content after it.
- Managed selections take precedence over project and user ones (`shadowed_by_managed_scope`), and `/omd` and
  `omd-mod disable` refuse them (`managed_by_policy`).
- Only the policy grants the managed scope and tiers: a `mods.json` selection that claims either is refused
  (`unsupported_scope`).
- When a managed package's required interceptor is beneath a handler, that handler may answer without `next` only
  with a deny. Any other such answer is invalid. Other mods can skip optional transforms but never a managed
  required interceptor.

### Deploying with `omd-mod package-sync`

`omd-mod package-sync STORE` deploys the policy unattended for the account that owns the store, typically from the
organization's own launch agent or configuration tool after it installs the policy; it takes no confirmation.

Every applicable entry, across projects, comes from the content-addressed package cache, otherwise from its
`source` and then each mirror in order, through the normal package resolver:

- `ID@VERSION` uses the first `index` location whose bytes match its sha256.
- `npm:` sources without a registry use `registry` and the user's own `.npmrc` tokens (the policy contains no
  secrets).

These are refused:

- content that differs from the pin (`managed_integrity_mismatch`);
- dependencies the policy doesn't list;
- packages with lifecycle scripts (`managed_lifecycle_requires_approval`, installed interactively instead).

Only when every entry verifies does sync record a new generation in `STORE/managed.json`; otherwise it fails with
`managed_sync_incomplete` and the previous generation stays active. `--offline` uses the cache and local sources
only, and `--rollback` makes the previous generation active again.

### Managed load behavior

- At load, a target that is deployed runs; otherwise a deployed fallback keeps running and `managed_pending_sync`
  is reported.
- Dependencies and their versions are read from hash-verified package manifests, never from editable deployment
  metadata. The dependencies of a running entry load with it under their own policy entry, even when that entry
  doesn't target the account or project.
- Content the policy no longer lists never runs, so removing an entry or changing its pin revokes it at once and an
  administrator's `policy rollback` with an unchanged cache restores the previous generation offline.
- A target can have nothing running: not deployed yet, a reset or unreadable `managed.json`, stale content, or a
  package that never inspected. Then every interception surface its policy `capabilities` reach fails closed with
  `intercept_required_failed: ID: REASON` until `package-sync` deploys it. Tool calls stay blocked between installing
  a policy and its first sync.
- In that state, a broken `mods.json` drops only user and project mods.
- Managed reloads reject broken selections individually so a user mod cannot prevent policy updates.
- If authority cannot be read or authenticated, interception fails closed until authority recovers.
- Generated type-file errors appear in `reload_error` and do not prevent host startup or policy enforcement.

### Inspecting managed state

- `omd-mod policy show` prints the effective policy and its origin.
- `policy check FILE` validates one.
- `policy explain STORE [PROJECT_DIR]` lists the account, each target and whether it is deployed, the deployment
  generation, and every selection with its scope, tier, effective state, refusal and the origin of each setting
  (`managed`, `user` or `default`).
- `status.managed` and `selection-status` report the same; `status.managed.unserved` lists the targets failing
  closed and why, and an unreadable deployment record appears as `managed_error` instead of failing the view.

### Recovery

Recovery stays local and offline. `/omd`, `omd mods disable ID` and `omd-mod reset STORE mods.json` recover
user and project mods; managed packages keep running while the policy lists them. Running the upstream `codex`
recovers from every customization.

When a managed package fails, its required interceptors fail closed (`intercept_required_failed`) until an
administrator changes or rolls back the policy. `omd-mod reset STORE managed.json` then `package-sync` repairs an
unreadable deployment record, and until that sync the policy's targets fail closed as above.

## Plugin components and shell commands

Use it when a plugin contains a mod component or when you run a mod's exported shell command with `omd COMMAND`.
To bundle a mod in a plugin step by step, see
[Bundle a mod in a plugin](https://github.com/dzkchen/oh-my-diff/blob/main/docs/mod-authors/bundle-in-a-plugin.md).

The descriptor and `omd COMMAND` run on Apple Silicon macOS.

### Plugin component descriptor

A plugin names its [mod component](reference/glossary.md#mods-and-the-host) in `.codex-plugin/omd.json`:

```json
{"schema":1,"component":"mod","sha256":"<inspected package digest>"}
```

`component` names the component's folder in the plugin, and `sha256` is the package digest that
`omd-mod plugin-component` reports for it. The folder is an ordinary public-API package with `mod.json` and
`index.ts`.

- Inspect it with `omd-mod plugin-component PLUGIN_ROOT`; the inspector rejects traversal, symlinks and digest
  changes.
- Trust and enable the inspected component the same way as any other package ([Packaging](reference/packaging.md)). The
  descriptor does not activate it.

### `omd COMMAND` shell dispatch

`omd COMMAND --repo PATH [--store STORE] [--home CODEX_HOME] [--sqlite-home DIR]` runs the command a mod exports with
the `cli` option of [`api.command`](reference/sdk-helpers.md#other-api-members). That command can call only `evidence.*` and
`sessions.*`. Model and process operations aren't available. Protect the mod store from writes by agent processes.
When more than one mod exports `COMMAND`, `omd` refuses to run it (`plugin_command_collision`).

## External clients

Use it when you build or review a renderer other than the terminal, such as a desktop window, an editor webview or a
text console. A client attaches to a running session over JSON-RPC to Codex's app server (see
[Transports and auth](#transports-and-auth)) and draws the same composed mod view. Oh My Diff ships no desktop or editor
client of its own; a mod ships its adapter (see [Client adapters](#client-adapters)). The exact messages are in the
[`omd-client/1` protocol](reference/omd-client-protocol.md), and the steps to build one are in
[Build an external client](../docs/mod-authors/build-a-client.md).

In Mod API `1.0.0` the `omd/*` methods are experimental and need the `experimentalApi` opt-in
([Initialize and errors](reference/omd-client-protocol.md#initialize-and-errors)). The host runs on Apple Silicon macOS, and
the client SDK runs in browsers and Node.

### Transports and auth

- `unix://PATH`, or `unix://` for the default socket under `$CODEX_HOME`: a WebSocket over a 0600, owner-checked
  Unix socket, no token. The default choice for local clients.
- `ws://IP:PORT` with `--ws-auth capability-token` (`--ws-token-file` or `--ws-token-sha256`) or `--ws-auth
  signed-bearer-token` (`--ws-shared-secret-file`, optional `--ws-issuer`/`--ws-audience`). A non-loopback listener
  refuses to start without auth.
- `stdio`: the spawning process speaks newline-delimited JSON-RPC to `codex app-server`.
- `codex app-server --listen URL` runs a headless host, with no terminal.
- `codex --listen URL` serves the running terminal session's app server, so a client attaches beside the terminal.
  It takes the same `--ws-*` flags, including `--ws-allowed-origin`, and accepts only `unix://PATH` or
  `ws://IP:PORT` with an explicit port. It refuses a bare `unix://` and port 0.

### WebSocket bearer tokens and origins

- Native clients send `Authorization: Bearer <token>`.
- Browsers offer the subprotocols `codex-app-server` and `codex.bearer.<token>` instead, and the server selects
  `codex-app-server`.
- The server compares the raw token, so a capability token used from a browser must be base64url or hex
  (subprotocol values cannot contain `+`, `/` or `=`, and browsers may log them).
- `--ws-allowed-origin ORIGIN` (repeatable, `scheme://host[:port]`, requires `--ws-auth`) allows a browser or
  webview origin. Origins are compared exactly after normalization, which drops a default port (`:80`, `:443`); any
  other `Origin` is refused.
- The `codex exec-server` listener (upstream Codex's remote execution environment) honors the same allowed origins
  and subprotocol bearer.

### Client adapters

A client adapter is the part of a mod that starts the client's UI process. The mod ships the adapter. It starts the
UI process with `process.start` from a native callback, such as a `channel` handler that a command publishes to. The
adapter starts it in one of two ways:

- Unsandboxed, with `{sandbox: 'none'}`, which needs the `os` capability with the program in `os_access.programs`
  (for example `node`).
- Sandboxed, with `network: 'loopback'`, which needs the `network` capability and works with a loopback `ws://`
  listener.

In both cases:

- It passes the listen URL and the token, or a token file path, through `environment` or on ndjson stdin.
  Environment names must be listed in `exec_environment`, and a name containing `TOKEN`, `KEY` or `SECRET` needs
  `--allow-secret-env`.
- The host stops the process with the mod.
- Its stdout is the framed message channel, so a UI process logs to stderr or a file: output that breaks the
  framing stops the process (an `exit` `process_event` follows).

### Client SDK (`@oh-my-diff/mod-api/client`)

The UI process connects with the SDK in `@oh-my-diff/mod-api/client`:

```text
connect({url, token?, command?, name, renderer, operations?, reconnect?, onView, onRoster, onMirrored, onSurfaceCall?, onServerRequest?, onNotification?, onReconnect?, onClose?})
```

It is dependency-free ESM for browsers and Node over `ws://`/`wss://` (bearer subprotocol), `unix://PATH` and
`stdio` (Node; spawns `codex app-server`).

- The object `connect` returns has `attach`, `update`, `detach`, `read`, `event`, `action` (serialized), `render`,
  `resource`, `recovery` and `request(method, params)`. Together they cover every `omd/*` and app-server method.
- After a disconnect it reconnects with backoff (`reconnect: false` turns that off), re-initializes, re-attaches,
  replays the last update, resumes the threads it resumed through `request('thread/resume', …)` and reports
  `onReconnect({epoch, previousEpoch})`.
- `unsupported(component, renderer, drawable)` returns null when the renderer can draw the component. Otherwise it
  returns an error with `fallback` set to the component's alt text, text or label. A renderer can't draw a type
  outside `drawable`, a `raster` without `cells` or an `image` without an image format. The error message has the
  form `unsupported_element: <type> '<id>': <reason>; drawing its fallback "<text>"`.

`mods/examples/external_client` (a text renderer) and `mods/examples/approval_desk` (a GUI-shaped renderer that
answers approvals) are complete adapters for unrelated mods.

### Security

Clients cannot mint grants or evidence. No `omd/*` method writes a grant, consent or evidence record. The host
resolves actions against its own view. Events reach only the component's owner, and a client can read only resources
in the view.

Mod callbacks still run in the mod's [runner](reference/glossary.md#mods-and-the-host), without ambient Node, DOM or secrets.
Only the confined renderer process uses its own UI runtime.

## `omd-client/1` protocol

Use it when you implement or debug a client's messages: initialization and errors, every `omd/*` request, the
host's notifications and server requests, action tokens, epochs and reconnecting, renderer fallbacks and
delegation. Transports, adapters and the SDK are in [External clients](reference/external-clients.md); the steps to build a
client are in [Build an external client](../docs/mod-authors/build-a-client.md).

In Mod API `1.0.0` every `omd/*` method is experimental. The host runs on Apple Silicon macOS.

### Initialize and errors

A client sends `initialize {clientInfo, capabilities: {experimentalApi: true}}` and the `initialized` notification.
`omd/*` methods are experimental and need that opt-in.

Wait for `omd/client/attach` to return before any other `omd/*` call. Until then every method fails with
`client_not_attached`, and the host doesn't queue requests.

Errors are JSON-RPC errors whose message starts with the code. Besides the codes listed with each request, these
exist:

- `mod_host_inactive`: no mods run in this host
- `session_unavailable`: no thread runs in this host
- `host_operation_unavailable`: this host has no session runtime
- `view_unavailable`: this host hasn't published a view
- `command_unavailable` and `command_unavailable_during_turn` for the action's command
- `render_slot_invalid` and `render_props_invalid`
- `resource_not_in_view` and `resource_unavailable`
- `recovery_action_invalid` and `mod_store_unavailable` from recovery

### Requests

Each request below is a method a client sends to the host.

#### `omd/client/attach`

```text
omd/client/attach {name, renderer: {kind: 'terminal'|'gui'|'text', formats: ('svg'|'png'|'jpeg'|'cells'|'text')[], pointer: 'pixel'|'cell'|'half_cell'|'none', reducedMotion, cellPx?}, operations}
// → {clientId, protocol: 'omd-client/1', epoch, roster, features, delegable}, then omd/view/updated
```

- The result's `roster` already lists the new client, and `omd/roster/updated` reports later changes.
- Attaching again on the connection replaces its entry.
- Attach also succeeds while mods are inactive or failed to start (empty `epoch`, null `snapshot`), so the recovery
  calls stay reachable.

#### `omd/client/update`

```text
omd/client/update {renderer?, viewport?: {width, height, unit}, focus?}
// → {}
```

`focus` sets the entry's `focused`. Every client gets `omd/roster/updated` and mods render again.

#### `omd/client/detach`

```text
omd/client/detach {}
// → {}
```

#### `omd/view/read`

```text
omd/view/read {}
// → {epoch, revision, snapshot, actionToken}
```

#### `omd/client/event`

```text
omd/client/event {epoch, component, event}
// → {delivered}
```

`event` is one of:

- `{kind: 'change', value}`
- `{kind: 'change', values}` (strings)
- `{kind: 'pointer', pointer: {column, row, half?: 0|1|null, action:
  'down'|'up'|'scroll_up'|'scroll_down'|'move'|'drag'|'enter'|'leave', button: 'left'|'right'|'middle'|null}}`
- `{kind: 'scroll', offset}`
- `{kind: 'key', key, text?}`
- `{kind: 'focus'}`

Behavior:

- `{delivered}` is answered in the order the connection sent its events and actions.
- The component's owner, as listed in the snapshot's `component_owners` (see
  [Host notifications](#host-notifications-and-server-requests)), gets
  [`component_event`](reference/terminal-input.md#component_event) with `client: clientId` and only the kind's fields above.
  `origin`, `events`, `anchor`, `range`, `index` and any other field a client sends are dropped.

| Error | When |
| --- | --- |
| `view_stale` | Another epoch |
| `view_stale: <component>` | The component is gone |
| `component_event_invalid` | Another kind, a missing or malformed field the kind requires, or an event over 64 KiB |

#### `omd/action`

```text
omd/action {actionToken, component, row?, value?}
// → {status: 'completed', outcome, actionToken}
```

`outcome` is the command's result (`insert`, `submit`, `display`, `preview`) or null, which the client applies in
its own UI (a `submit` through `turn/start`).

Errors:

- `action_stale` (also when the view changed before the action ran)
- `action_replayed`
- `action_unknown`
- `action_unavailable: <component>`
- `action_value_invalid: <component>` (including document anchors and lines and diff lines)

#### `omd/render`

```text
omd/render {slot, props}
// → {original, effective, tree, answeredBy}
```

`omd/render` runs the mods' `render` interceptors over a component the client draws natively. `slot` names that
component, one of the [render components](reference/render-hooks.md#render-components) such as `tool_call`, and `props` are its
native props. This `slot` is unrelated to the `slot` component type.

- The result gives the client's native props before and after `render` interceptors, drawn with the envelope `{id:
  'client:<slot>', surface: 'inline', lifecycle: 'final', viewport: {columns: 80, rows: 24}, owner: null}`.
- Slot `module` with `props: {component, columns?, rows?}` (1–65535 cells) steps the client's own instance of that
  view's component module and answers its `tree` with `effective: {next_ms}`.

#### `omd/resource/read`

```text
omd/resource/read {reference}
// → {mediaType, data, sha256}
```

`data` is base64. Only references in the current view can be read.

#### `omd/recovery/read` and `omd/recovery/apply`

```text
omd/recovery/read {}
omd/recovery/apply {action: 'enable'|'disable'|'reload'|'reset', target}
```

`omd/recovery/read` returns the host-owned `/omd` recovery state, and `omd/recovery/apply` returns the result:

```text
{mods: [{id, path, scope, enabled, packaged, failing, error}], resettable, store_error, activation_error, reload_error}
```

- `reload` reloads the mods at once, refreshes the session's limits and contract and pushes the new view, or fails
  with `recovery_unavailable_during_turn` while the lead thread's turn runs. It needs no attached client: `/omd`'s
  Reload mods sends it from the terminal.
- `enable`, `disable` and `reset` change what runs or reset `host.json`/`mods.json`, so like `packages.apply` and
  `config.set` they need the terminal (`/omd`) or `omd-mod` and fail for a client with
  `client_surface_operation_unavailable`.
- `resettable` names the files `/omd` and `omd-mod` can reset; a client reads it but cannot reset them.
- When a mod's source changes after trust, its last trusted code keeps running. The mod reports
  `source_changed: ...`, and `reload_error` is `untrusted_source: ...`. The new source loads after `omd-mod trust`
  and a reload. Administered content that no longer matches its pin reports `managed_content_stale: ...` instead and
  loads after `omd-mod package-sync`.

### Host notifications and server requests

A surface operation is a host operation the terminal normally serves, such as `terminal.notice` or
`terminal.prompt`. The host mirrors some of them to clients (`omd/surface/mirrored`) and, with no terminal attached,
delegates others (`omd/surface/call`, see [Delegation](#delegation)).

The host sends these notifications:

- `omd/view/updated {epoch, revision, snapshot, actionToken}`: the full, coalesced `ModViewSnapshot`
- `omd/roster/updated {roster}`
- `omd/surface/mirrored {caller, operation, arguments}`

The `ModViewSnapshot` fields are `view`, `component_owners`, `layout_owner` (the mod whose view supplied
`view.layout`), `progress`, `activity` and `diagnostics`.

The host also sends the server request `omd/surface/call {caller, operation, arguments, confirm?}`. A client
answers it with the operation's result or an error whose message the mod receives. When the mod's call is cancelled
or outlives its callback budget first, the host drops the request and a late answer is ignored.

Other server requests (approvals, `requestUserInput`, permissions, elicitation) reach every subscribed client, and
the first answer wins, an error included. An SDK client answers only what its `onServerRequest` returns a value for
(`undefined` leaves the request unanswered). So a client that ignores a request leaves it for the user at the
terminal to answer.

### Actions and tokens

A client names a component and row, never a command. The host resolves the action from its own current view and
runs it like Space/Enter in the terminal: `command` interceptors, then the command as a user action.

- Tokens are random, per connection and bound to the view's epoch and revision.
- A pushed revision or a use replaces the token, while progress and activity pushes keep it.
- A use spends the token even when the action then fails, so re-read the view after an error.
- The last 8 retired tokens keep `action_stale` and `action_replayed` accurate.
- Send one action at a time per connection and keep the newest token from the last view or action result.
- Roster-driven re-renders coalesce, and a view that did not change keeps its revision, so one client's viewport or
  focus update does not rotate the others' tokens.

### Ordering, epochs and reconnecting

State is per connection. A disconnect removes the roster entry and at once fails that client's pending surface
calls with `client_surface_closed` (an attach on a closing connection gets `client_surface_closed: the connection
is closing`).

- `epoch` is an opaque decimal string (empty, with revision 0 and a null snapshot, until the host publishes its
  first view).
- `revision` grows within an `epoch`.
- A new `epoch` means the host restarted and invalidates everything the client stored.

Reconnecting is `initialize`, attach (a full snapshot, never deltas), then `thread/resume` per thread, which
replays pending approvals. `thread/resume` also joins a loaded thread before its first turn.

- Approvals stay upstream server requests broadcast to subscribed connections (first answer wins,
  `serverRequest/resolved` tells the rest).
- `turn/interrupt` cancels a turn.
- `thread/rewritten` invalidates a thread's cached history.

### Renderer capabilities and fallback

The wire roster lists `{id, name, renderer, viewport, focused, attachedMs}` (camelCase renderer). Mods see it as
`clients: ClientEntry[]` beside [`client`](reference/terminal-operations.md#terminal-event-client) in the `terminal` input, in
snake_case (`renderer.reduced_motion`, `renderer.cell_px`, `focused`, `attached_ms`); neither lists declared operations.
`client` stays the local terminal's facts, or null headless.

A view serves every attached renderer, so draw for the least capable or branch on `clients`.

- An SVG `image` shows its alt text in terminals (SVG rules in
  [SVG assets](reference/state-and-storage.md#svg-assets-svg_assets_v1)); a client listing `svg`, `png` or `jpeg` reads the
  resource with `omd/resource/read` and draws it.
- `terminal.notify`, `terminal.notice` and `terminal.blit` are mirrored to attached clients whether the host is
  headless or a terminal is attached. Blits go only to clients listing `cells`; others draw a raster's `alt`.

Headless, the host answers those three itself with the terminal's validation:

- A blit is checked against `component_owners` (`terminal_blit_not_owned`, `terminal_blit_unknown`) and the
  raster's size, and paced at one frame per 16 ms. Once 32 updates are waiting for a raster, a blit gets
  `{status: 'backpressure', retry_after_ms}`.
- A notice fails with `terminal_notice_invalid` like in the terminal, and a `model`-audience notice is still queued
  for the model.

### Delegation

With no terminal attached, `features` includes `surface_call` and `delegable` lists the declared operations the
host delegates. A mod's surface operation goes to the clients that declared it, and the first answer wins.

User-only operations are never delegated:

- `credentials.request`
- `terminal.import_file`
- `builtins.invoke`
- `commands.invoke`
- `config.set`
- `packages.apply`
- `routes.add`
- `routes.write`
- `contract.select`

`prompts.consent` is never delegated either. When a client's action or event caused the call, these operations and
a `terminal.pty` start fail, whether the host is headless or a terminal is attached. The error is
`client_surface_operation_unavailable: <operation> needs the terminal (/omd) or omd-mod`, so clients never reach
grant-writing or user-only operations. To change what runs, use `/omd` in the terminal or
`omd-mod enable|disable|reload|reset`.

- Headless, a `terminal.pty` start from a non-user context is `host_operation_user_only`.
- An operation no attached client declared fails with `client_surface_operation_unavailable: no attached client
  serves <operation>`.
- `app.request` runs on the headless host itself. For a method that needs confirmation, the host first sends
  `omd/surface/call terminal.prompt {kind: 'confirm', title, message}` to the clients that declared
  `terminal.prompt`. The method runs only on `{status: 'accepted'}`. Otherwise, or when no client declared
  `terminal.prompt`, it returns `{status: 'declined'}`.
- A call with `confirm` needs the user's consent in the client before it acts.
