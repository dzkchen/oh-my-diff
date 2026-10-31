# Mod API reference

Use this reference when you need the exact shape of an operation, event, capability or limit while writing or reviewing
a mod.
Start with the contents below; the [glossary](glossary.md) defines the terms the pages share.

## Version

This reference matches `@oh-my-diff/mod-api` and host API `1.0.0` and Codex `0.165.0`.
`omd-mod status` reports the OMD release as `host.omd`. A package's `compatibility.releases` is matched against that
version. The host loads only mods for this API version. [`api.d.ts`](../api.d.ts) is the complete typed surface.

[`REFERENCE.md`](../REFERENCE.md) has every page in the contents tables in one file, for agents and search.

## Stability

API `1.0.0` is stable. Which entries are frozen or experimental, and the migration notes, are in
[Stability and migration](stability-and-migration.md).

## Contents

The pages are grouped by area. A heading that ends with a name in parentheses, such as (`routes_v1`), names the
[host feature](glossary.md#mods-and-the-host) for that section. Mods that use the section list it in
`required_features`.

### Host and stability

| Page | Covers |
| --- | --- |
| [Glossary](glossary.md) | Terms the pages share, and the words with more than one meaning |
| [Host model](host-model.md) | What mods can't replace, host lifetime, callback budgets, contexts and composition order, registration limits, the fault limit, the runner environment |
| [Limits](limits.md) | Every limit, grouped by area, and the `host.json` limits |
| [Stability and migration](stability-and-migration.md) | Frozen and experimental entries, what isn't provided, migration notes |

### Authoring and packages

| Page | Covers |
| --- | --- |
| [Authoring](authoring.md) | Author commands, generated declarations, TypeScript tests, `mod.test.json`, watch, JSX, diagnostics, the cost report |
| [Packaging](packaging.md) | Package commands, requests, sources, npm, indexes, manifests and `codex_config`, `packages.*` controls, package assets (`api.assets.read`), enablement, rollback, the security log |
| [Settings](settings.md) | `settings.write`, settings schema defaults, the settings file, manifest `environment` |
| [SDK helpers](sdk-helpers.md) | `api.package`, `api.session()`, `api.fs`, `api.classify`, `api.usage`, other `api` members |

### Authority and interception

| Page | Covers |
| --- | --- |
| [Capabilities](capabilities.md) | Every capability, and the capability each operation needs |
| [Authority grants](authority-grants.md) | `os_access`, `approves`, ending grants, `http_access`, `fs_access`, `mcp_servers`, access receipts, environment variables |
| [Admission and interception](admission-and-interception.md) | Admission policy, `host_operation` interceptors and the `host_operation` event |
| [Interceptors](interceptors.md) | `api.intercept`, `match`, what a handler may change, `next` and retries, order, failures, every interceptor surface |

### Operations and data

| Page | Covers |
| --- | --- |
| [Tools](tools.md) | Tool interceptor inputs, `tools.invoke`, `tools.check`, `tools.original`, tool output, batches, tool specs, `tools.list`, task-scoped and dynamic tools |
| [App bridge and approvals](app-bridge-and-approvals.md) | `app.request` routes and rules, config writes and redaction, `app.respond`, `approval` middleware |
| [Commands, configuration and composer](commands-and-composer.md) | Commands, configuration, built-in controls, completion, composer drafts, `@` mentions |
| [Running commands](running-commands.md) | `exec.run` arguments, sandbox, limits, results, output artifacts, guards, runs against a snapshot |
| [Workspace files](workspace-files.md) | Workspace reads, lists and transactions, renames, `workspace_change`, `workspace.watch`, snapshots |
| [State and storage](state-and-storage.md) | `store.*`, evidence and binary evidence, SVG assets, `api.state`, `api.uiState`, `state_scope`, migration, reactive state |
| [Managed processes](managed-processes.md) | `process.*`, framing, raw streams, process environment, notifications, adapters, kernels, `api.host.tryCall` |
| [Events and lifecycle](events-and-lifecycle.md) | Every event, channels, timers, `api.time`, lifecycle events, `api.hook` and classic hooks |
| [Contracts and receipts](contracts.md) | Contract documents and selection, `receipts.submit`, gates, the finding ledger, restrictions |
| [Agents](agents.md) | `agents.spawn`, handles, parent history, failures, native subagents, definitions, `agent_spawn`, inventory, `workspace.integrate` |
| [Peers, power holds and mod-started turns](sessions-and-turns.md) | Peer sessions, power holds, autonomous turns, `turn_stop`, user prompt submissions |
| [Credentials](credentials.md) | Credential profiles and secrets, route credentials, sidecar secrets, credential origins, the credential gateway, `omd-mod credentials` |
| [Thread data and recorded sessions](threads-and-sessions-store.md) | `turns.abort`, thread-scoped store, the `resume` event, explicit thread resume, `turns.activity`, `sessions.list`, `sessions.read`, `sessions.snapshot`, the SQLite home |

### Models and history

| Page | Covers |
| --- | --- |
| [Routes](routes.md) | Route fields, `routes.list`, `routes.select`, `routes.add`, reloading and writing routes, grant files, provider billing, the ledger, sidecars, service launch snapshots, request helpers, provider services |
| [Model requests and streams](model-requests.md) | `model_request`, `response_stream`, synthetic responses, `model_response` |
| [One-shot model calls and forks](model-calls.md) | `model.complete`, `model.fork`, prompt cache marks |
| [Final-request policy](final-request-policy.md) | `model_send`, declared request policies, coverage |
| [History and compaction](history.md) | Model-bound history, history rewriting, transcript rewriting, compaction interception |

### Terminal

| Page | Covers |
| --- | --- |
| [Terminal UI](terminal-ui.md) | Views, sites, layouts and components, view fields, screen modes, patch composition |
| [Render hooks](render-hooks.md) | `render` interceptors, render components, `tool_call` props, list rows |
| [Layout and styling](layout-and-styling.md) | Startup presentation, layouts, component types, documents, region sizing and dock events, overlays, the box model, text styles, surface paint, view limits |
| [Terminal input](terminal-input.md) | Focus, keys and paste, keybindings, focus regions, pointer events, `component_event`, `component_change`, component modules |
| [Graphics](graphics.md) | `image`, `terminal.image_sample`, rasters, `terminal.blit`, the underlay, raster processes, pixel buffers |
| [Terminal operations](terminal-operations.md) | `terminal.*` operations, selection and clipboard, terminal identity, the `terminal` event `client` |

### Protected authority and managed deployment

| Page | Covers |
| --- | --- |
| [Protected authority (macOS)](protected-authority.md) | The authority broker, what it protects, its trust boundary, pinning and reset |
| [Administrator policy and managed deployment](administrator-policy.md) | The policy file, controls and refusals, managed packages, `package-sync`, recovery |

### Plugins and external clients

| Page | Covers |
| --- | --- |
| [Plugin components and shell commands](plugin-components.md) | Plugin component descriptors, `omd COMMAND` |
| [External clients](external-clients.md) | Building a client: transports, adapters, the client SDK, desktop apps and webviews, security |
| [`omd-client/1` protocol](omd-client-protocol.md) | Initialize, every `omd/*` request, notifications, action tokens, epochs, fallback, delegation |
