# Glossary

Use it when a reference page uses a term you don't know, or uses a word such as "grant", "store" or "managed" that
means more than one thing. Each entry gives the meaning used in this reference and links to the page that owns it.

## Mods and the host

| Term | Meaning |
| --- | --- |
| Mod | A TypeScript package with `mod.json` and an entrypoint that the host loads to change how `codex` behaves or looks. See [How OMD works](https://github.com/dzkchen/oh-my-diff/blob/main/docs/how-omd-works.md). |
| Mod component | A mod that a Codex plugin carries in its own folder (`mod/` in the OMD+ plugins), named by the plugin's `.codex-plugin/omd.json` descriptor. Adding the plugin doesn't run it: you trust and enable it like any other mod. See [Plugin components](plugin-components.md). |
| Package | A mod as installed: its source, version and integrity in the package lock. One package is one mod. See [Packaging](packaging.md). |
| Host | The native mod host inside the `codex` process. One host owns the process at a time. See [Host model](host-model.md#one-host-per-process). |
| Runner | An `omd-runner` process that runs one package's callbacks. Runners are never shared between packages. See [Host model](host-model.md#callback-lifetime). |
| Host operation | A named operation a mod calls through `api.host.call`, such as `exec.run` or `store.get`. Each one needs a capability. See [Capability by operation](capabilities.md#capability-by-operation). |
| Host call | One invocation of a host operation from a callback. A callback makes at most 512. See [Host model](host-model.md#callback-budgets-and-the-clock). |
| Handler | A function a mod registers, for example with `api.on`, `api.intercept` or `api.command`. |
| Callback | One run of a handler by the host. Budgets, contexts and the fault limit apply per callback. See [Host model](host-model.md). |
| Interceptor | A handler registered with `api.intercept` that runs in a chain and may call `next`, change its input or answer without it. See [Interceptors](interceptors.md). |
| Middleware event | An event a mod receives with `api.middleware`: `prompt`, `session`, `agent`, `tool_call`, `tool_result`, `host_operation` or `approval`. |
| Replacement | A handler registered with `api.replace` for one exclusive point: `context`, `routing`, `compaction`, `tool_batch`, `completion` or `history`. |
| Observer | A handler that receives an event and changes nothing, for example a `tool_output` observer. |
| Interceptor surface | A name `api.intercept` selects, such as `tool`, `command` or `render`. See [Every interceptor surface](interceptors.md#every-interceptor-surface). |
| `next` | The function an interceptor calls to run the rest of the chain and then the native executor. See [Interceptors](interceptors.md#the-next-object-and-retries). |
| Required interceptor | An interceptor registered with `required: true`; when it fails, the operation fails closed. See [Interceptors](interceptors.md#handler-failures-and-skipped-interceptors). |
| Managed process | A helper process a mod starts with `process.start` and talks to with framed messages. See [Managed processes](managed-processes.md). |
| Host feature | A name such as `routes_v1` that the host advertises and a package lists in `required_features`. "Require X" on a reference page means listing feature X. |
| Generation | A number the host raises each time a reload changes which mods are loaded. It rejects a callback from an older generation with `stale_mod_generation` (retry on the next turn), and raster handles from an older generation stop working. Each runtime counts its own, and the `generation` in `store.*` and `packages.*` results is a different number. See [Host model](host-model.md#callback-admission-and-completion). |

## Trust and authority

| Term | Meaning |
| --- | --- |
| Capability | A name in `mod.json` `capabilities` that admits a class of host operations, events and registrations. See [Capabilities](capabilities.md). |
| Authority grant | A capability whose manifest scope the trust digest binds, such as `os`, `http` or `approve`. It can expire and be revoked. See [Authority grants](authority-grants.md). |
| Grant | Used alone, the set of capabilities and secret environment a user trusted for one selection. Other uses always carry a qualifier: authority grant, service grant, route grant file, runner grant. |
| Service grant | An entry in `host.json` `services` that lets a mod run a sidecar or provider service, with its program, network, credentials and route. See [Routes](routes.md#provider-services). |
| Route grant file | A JSON file an operator writes and a route's `grant` names by path and SHA-256, binding the route to a repository, provider, model and URL. See [Routes](routes.md#route-grant-files). |
| Runner grant | The `omd-runner` path and digest the authority broker holds for a store. See [Protected authority](protected-authority.md#what-the-broker-protects). |
| Trust | A user's approval of one package's exact content, capabilities and scope. Changed content or a wider scope needs a new trust. |
| Trust digest | The digest of a package's content and declared authority that trust binds. |
| Native confirmation | A confirmation Codex draws itself, outside every mod's view, such as an approval or the check before a mod writes Codex config. Its decision text, options and keys stay native. Pages use this term, not "native prompt" or "native dialog". See [Render hooks](render-hooks.md). |
| Selection | One package a store runs, at managed, project or user scope. User and project selections are in `mods.json`; managed ones come from the administrator policy. |
| Scope | The selection level, `managed`, `project` or `user`; managed shadows project, which shadows user. Also used for the store scope of data (`thread`) and for the scopes of an authority grant. |
| Managed | Deployed by an administrator policy. A managed package's grant is the policy itself. See [Administrator policy](administrator-policy.md). |
| Tier | Where a managed package's interceptors sit: `prepend` outside every other mod, `append` inside. |
| Authority broker | The macOS LaunchDaemon that holds credentials and grants outside the user's reach. See [Protected authority](protected-authority.md). |
| Provenance | Two meanings. Package-source provenance is the broker's record of a verified install's origin ([Administrator policy](administrator-policy.md#package-source-provenance)). Manifest `provenance.source` is the repository a package says it comes from ([Packaging](packaging.md#provenancesource-for-git-installs)). A store record's `provenance` is the host-attested writer of that record. |
| Receipt | Two meanings. A contract receipt is evidence a mod submits with `receipts.submit` ([Contracts and receipts](contracts.md#receiptssubmit)). An access receipt is the host's record of an HTTP, MCP, external file or environment call ([Authority grants](authority-grants.md#access-receipts)). |
| Producer | Who made a contract receipt: `any`, `lead`, `host`, `integration` or `separate_agent`. See [Contracts and receipts](contracts.md#registering-a-contract). For rasters, a producer is the process that publishes frames ([Graphics](graphics.md#raster-processes-process_raster_v1)). |
| Contract | A versioned document that gates task completion and workspace integration on receipts. See [Contracts and receipts](contracts.md). |
| Snapshot | A frozen copy of the workspace or of an agent's workspace, made with `workspace.snapshot`. See [Workspace files](workspace-files.md#snapshots-workspacesnapshot). |
| Candidate | The workspace change a receipt or `workspace.integrate` is about, identified by `candidate_sha256`. See [Workspace files](workspace-files.md#snapshots-workspacesnapshot). |

## Stores and data

| Term | Meaning |
| --- | --- |
| Mod store | The directory that holds `mods.json`, `host.json`, package caches, settings and mod data. `STORE` in a command is its path. |
| Install profile | Which mods the installer adds: OMD+ (`--profile full`) or OMD Core (`--profile platform`). Each keeps its own mod choices. Written "install profile" to tell it from an account profile. See [Install Oh My Diff](https://github.com/dzkchen/oh-my-diff/blob/main/docs/install.md). |
| Account profile | A ChatGPT account, API key or provider that `omd_profiles` switches between with `/profile`. See [Use other providers](https://github.com/dzkchen/oh-my-diff/blob/main/docs/use-other-providers.md). |
| Scratch store | An empty mod store made with `omd-mod init` for testing. |
| `store.*` | The key-value data operations a mod calls. See [State and storage](state-and-storage.md#store-operations). |
| `api.state` | A mod's saved state, read during renders. See [State and storage](state-and-storage.md#apistate-compare-and-swap). |
| Evidence | Records written with `evidence.write` and read with `evidence.read`, plus the host's records of a turn. |
| Settings | A mod's user-set values, checked against `settings_schema`. See [Settings](settings.md). |

## Sessions and models

| Term | Meaning |
| --- | --- |
| Thread | One Codex conversation. Thread-scoped data follows it through forks. |
| Turn | One user input and the model's work on it. |
| Session | One thread's recorded history, as `sessions.list` and `sessions.read` return it: read-only messages and tool records from this repository's rollouts that allow memory. `session_id` is the thread's id, so a session can be a past thread or a subagent thread (`parent_id`). See [Threads, turns and sessions](threads-and-sessions-store.md). |
| Rollout | The file a thread's history is recorded in. Resume, search and export read it. |
| Transcript | The persisted conversation a user sees, rewritten only through `thread/rewrite`. See [History](history.md). |
| Compaction checkpoint | The installed result of a compaction, which resume reads. |
| Route | A model configuration in `host.json` `routes`: provider, model, URL, rates and roles. See [Routes](routes.md). |
| Lead, worker | Route roles. A lead route serves a thread; a worker route serves mod-started agents and `model.complete`. |
| Provider service | A mod-owned service process that a routed service grant runs as a model provider. See [Routes](routes.md#provider-services). |
| Sidecar | A process a mod starts from a service grant with `sidecars.start`. See [Credentials](credentials.md#routes-and-sidecars). |
| Ledger | The session's record of model requests, costs and limits. See [Routes](routes.md#ledger). |
| Reservation, exposure | `reservation_microusd` is the most one request on a route can cost, set aside when the host admits it. Exposure is a thread's running total of what its requests have cost plus what unsettled ones could still cost. `limits.exposure_microusd` caps it for the whole thread and `worker_limits.exposure_microusd` for each worker, and the host denies a request that would pass either cap. Both caps default to `0`. See [Route grant files](routes.md#route-grant-files). |
| Agent handle | The `agent_id` a mod gets from `agents.spawn`; agent operations address only the caller's own handles. See [Agents](agents.md#agent-handles-and-limits). |
| Peer session | Another live session whose package accepts messages from `peers.send`. See [Sessions and turns](sessions-and-turns.md#peer-sessions-peer_sessions_v1). |
| Microusd | One millionth of a US dollar, the unit of route rates and costs. |

## Terminal

| Term | Meaning |
| --- | --- |
| View | What a mod's `terminal` handler returns: components, panes, layout and other fields the host composes with other mods' views. See [Terminal UI](terminal-ui.md#views-sites-layouts-and-components). |
| Terminal patch | A view a mod contributes, composed with every other mod's patch in one order. |
| Site | A named place in the terminal a patch can fill, wrap or replace: native sites such as `welcome`, and mod sites named `owner/name`. |
| Region | A focus region: the chat is region 0 and each drawn `site:` layout leaf is a region. A layout region is the area a layout leaf draws in. See [Terminal input](terminal-input.md#focus-regions-key-contexts-and-help-terminal_focus_v1). |
| Layout | A tree of splits and tabs over the transcript, the composer and `site:` leaves. See [Layout and styling](layout-and-styling.md#layouts-and-component-types). |
| Component | One node of a view, of 20 types such as `box`, `list` and `raster`. See [Component types](layout-and-styling.md#component-types). |
| Overlay | A mod site drawn above the layout at an anchor. See [Layout and styling](layout-and-styling.md#overlays). |
| Raster | A keyed canvas of cells that `terminal.blit` draws into. See [Graphics](graphics.md#raster-component). |
| Underlay | One cell raster drawn under the whole fullscreen screen. See [Graphics](graphics.md#underlay-terminal_underlay_v1). |
| Component module | A view region drawn by the handlers a mod registers with `api.component`. See [Terminal input](terminal-input.md#component-modules-component_modules_v1). |
| Key context | View key bindings that apply only while their `when` condition holds. See [Terminal input](terminal-input.md#focus-regions-key-contexts-and-help-terminal_focus_v1). |
| External client | A renderer other than the terminal that attaches over `omd-client/1` and draws the same view. See [External clients](external-clients.md). |
| Epoch, revision | An epoch identifies one run of the host's view; a new epoch means the host restarted. A revision grows within an epoch. See [`omd-client/1` protocol](omd-client-protocol.md#ordering-epochs-and-reconnecting). |
| Action token | A per-connection token bound to the view's epoch and revision that `omd/action` spends. See [`omd-client/1` protocol](omd-client-protocol.md#actions-and-tokens). |
| Roster | The list of attached external clients. See [`omd-client/1` protocol](omd-client-protocol.md#capabilities-and-fallback). |
