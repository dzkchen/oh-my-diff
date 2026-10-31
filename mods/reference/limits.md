# Limits

Use it when you check whether a design fits the host. Each row gives one limit and links its owner page, which
states the exact rule and the error a call gets. The `host.json` limits an operator can change are under
[Host limits](#host-limits).

Values are those of Mod API `1.0.0` on Codex `0.165.0`; limits of experimental entries may change in any release.

## Limits by area

Each table covers one area, and the Owner column links the page with the exact rule.

### Host and runner

| Limit | Value | Owner |
| --- | --- | --- |
| Host operations per callback | 512 | [Host model](host-model.md#callback-budgets-and-the-clock) |
| Callback JavaScript time plus waits on user-action operations | 5 s (`callback_execution_budget`) | [Host model](host-model.md#callback-budgets-and-the-clock) |
| Host operation arguments and results per callback | 1 MiB transport budget (`host_result_limit`) | [Host model](host-model.md#host-call-transport-budget) |
| Request and stream hook wait for a busy runtime | 2 s | [Host model](host-model.md#runtime-waits-and-hook-skips) |
| Middleware log | 8 MiB | [Host model](host-model.md#runtime-waits-and-hook-skips) |
| Service provider chain | 8 callback frames | [Host model](host-model.md#service-dispatch-service_dispatch_v1) |
| Consecutive failed callbacks before a mod turns off | 5 | [Host model](host-model.md#fault-limit) |
| Tools and commands per mod | 32 each | [Host model](host-model.md#registration-limits) |
| Mod id | 24 bytes of `a-z`, `0-9` and `_` | [Host model](host-model.md#registration-limits) |
| Command and tool names | 32 bytes of `a-z`, `0-9` and `_` | [Host model](host-model.md#registration-limits) |
| Runner V8 old space | 64 MiB (`mod_out_of_memory`) | [Host model](host-model.md#runner-memory-limits) |
| Runner physical memory | 512 MiB (`mod_out_of_memory`) | [Host model](host-model.md#runner-memory-limits) |
| Generated HMAC keys and derived bits | 8,388,608 bits (1 MiB) | [Host model](host-model.md#text-encoding-and-crypto) |
| PBKDF2 `iterations` | 1 to 4,294,967,295 (`OperationError`) | [Host model](host-model.md#text-encoding-and-crypto) |
| RSA key size | 2,048 to 8,192 bits, exponent 65537 | [Host model](host-model.md#text-encoding-and-crypto) |
| AES-GCM `iv` and tag | 96 bits and 128 bits | [Host model](host-model.md#text-encoding-and-crypto) |
| Subagent depth and concurrent workers | 2 and 4 by default (`host.json` `limits`) | [Host limits](#host-limits) |
| Watches, paths per watch, timers, PTY panes, completion items | `host.json` `mod_limits` | [Host limits](#host-limits) |

### Packages and settings

| Limit | Value | Owner |
| --- | --- | --- |
| npm tarball | 4 MiB, 16 MiB unpacked, 1,024 entries | [Packaging](packaging.md#version-and-tarball-checks) |
| Rollback history per local package | 8 entries | [Packaging](packaging.md#rollback-and-cleanup) |
| Security log | 64 KiB | [Packaging](packaging.md#protection-recovery-and-the-security-log) |
| `packages.index` page | 1-200 entries, default 200 | [Packaging](packaging.md#packagesindex) |
| Package `description` | 1–160 printable characters | [Packaging](packaging.md#package-description) |
| Settings file | 64 KiB | [Settings](settings.md#settings-file-settings_file_v1) |
| Setting `title` and `description` | 64 and 300 bytes | [Settings](settings.md#settings-defaults) |
| Package files | 16 assets, 8 KiB `mod.json`, 512 KiB per file | [Packaging](packaging.md#package-assets) |

### Authority, admission and credentials

| Limit | Value | Owner |
| --- | --- | --- |
| `os_access` programs | 32 | [Authority grants](authority-grants.md#os_access-manifest-field) |
| `http_access` origins and credential profiles | 32 | [Authority grants](authority-grants.md#http_access-manifest-field) |
| `http.request` timeout | 30 s default, 120 s maximum | [Authority grants](authority-grants.md#httprequest) |
| `http.request` response | 64 KiB default, 128 KiB maximum | [Authority grants](authority-grants.md#httprequest) |
| `http.request` body and headers | 1 MiB; 32 headers in 8 KiB | [Authority grants](authority-grants.md#httprequest) |
| `http.request` redirects | 5 | [Authority grants](authority-grants.md#httprequest-redirects-and-credentials) |
| HTTP streams per mod | 4, closed after 60 s idle; 64 KiB per read | [Authority grants](authority-grants.md#httpopen-httpread-and-httpclose) |
| `fs_access` roots | 16 | [Authority grants](authority-grants.md#fs_access-manifest-field) |
| `mcp_servers` servers | 8 | [Authority grants](authority-grants.md#mcp_servers-manifest-field) |
| Access receipts in status | the last 32 | [Authority grants](authority-grants.md#access-receipts) |
| `environment.read` | 16 names; values over 4,096 bytes read as unset | [Authority grants](authority-grants.md#environmentread) |
| `environment.set` | 4,096-byte values; 16 names and 16 KiB per scope | [Authority grants](authority-grants.md#environmentset) |
| `exec_environment` names | 16 | [Authority grants](authority-grants.md#exec_environment-names) |
| `policy.namespaces` patterns | 16 | [Admission and interception](admission-and-interception.md#admission-and-api-policy-admission_api_policy_v1) |
| Credential gateway | 16 connections, 4 forwards per registration, 30 s timeout, 10 min deadline | [Credentials](credentials.md#credential-gateway) |

### Routes, models and history

| Limit | Value | Owner |
| --- | --- | --- |
| `providers.models` | 16 models; `name` 1–64 bytes | [Routes](routes.md#providersmodels) |
| Route `data` | 2 KiB | [Routes](routes.md#route-writes-route_write_v1) |
| Ledger attempts given to a mod | the newest 64 | [Routes](routes.md#ledger) |
| `model_request` section previews | 48 KiB in all, 4 KiB each; 8 inserted sections | [Model requests](model-requests.md#model_request-sections) |
| Synthetic `model_request` response | at most 16 items | [Model requests](model-requests.md#model_request-next-and-synthetic-responses) |
| Stop-and-retry | twice per turn | [Model requests](model-requests.md#stopping-a-response-and-retrying) |
| `model.complete` prompt, `system`, `context` | 8 KiB, 8 KiB, 8 blocks and 32 KiB in total | [Model calls](model-calls.md#modelcomplete) |
| `model.complete` output and timeout | 128,000 tokens; 300 s | [Model calls](model-calls.md#modelcomplete) |
| `model_send` page | 96 KiB; pieces of 80 KiB with 1 KiB of context | [Final-request policy](final-request-policy.md#model_send-input-pages) |
| `model_send` pages per request | 128 (`final_request_too_large`) | [Final-request policy](final-request-policy.md#model_send-input-pages) |
| `model_send` edits | 256, 4 KiB of replacement text each | [Final-request policy](final-request-policy.md#model_send-edits-and-denials) |
| Model-bound history view | 2,048 items within a 4 MiB runner request; 2 KiB previews | [History](history.md#model-bound-history-history_v1) |
| `history_persist` batch | 48 KiB of JSON per callback | [History](history.md#history_persist-returns-and-batching) |
| `thread/rewrite` edits | 1 to 256 | [History](history.md#edits) |
| Compaction history view | 1,024 items, 512-byte previews within 128 KiB | [History](history.md#compaction-input) |

### Interceptors, tools, commands and the app bridge

| Limit | Value | Owner |
| --- | --- | --- |
| Dynamic tools per mod | 64 | [Tools](tools.md#dynamic-tools-dynamic_tools_v1) |
| Interceptors per mod | 16, registered during activation | [Interceptors](interceptors.md#apiintercept) |
| `next` calls per interceptor | 3 | [Interceptors](interceptors.md#the-next-object-and-retries) |
| Interceptor chains kept in status | the last 16; values over 2 KiB become a digest | [Interceptors](interceptors.md#chain-status-and-offline-scenarios) |
| Interceptor wait for a busy runtime | 5 s for a required one, 2 s for an optional one | [Interceptors](interceptors.md#handler-failures-and-skipped-interceptors) |
| Tool output a handler sees | 256 KiB; the model sees at most 64 KiB of a replacement | [Interceptors](interceptors.md#surfaces-and-what-a-handler-may-change) |
| `tools.original` | 16 MiB; read in 64 KiB pages | [Tools](tools.md#toolsoriginal-tool_original_v1) |
| `tool_output` append | 4 KiB, 16 KiB per call | [Tools](tools.md#tool_output-observers) |
| `tools.list` | 512 tools, 4,096-character descriptions, 16 KiB `parameters` | [Tools](tools.md#toolslist) |
| Confirmed `app.request` parameters | 2,000 bytes | [App bridge and approvals](app-bridge-and-approvals.md#contexts-and-native-confirmations) |
| `app_notification` queue | 256 events / 1 MiB per mod | [App bridge and approvals](app-bridge-and-approvals.md#app-notifications-and-server-requests) |
| `app.respond` question answers | 16 questions of 16 answers, 16,384 bytes | [App bridge and approvals](app-bridge-and-approvals.md#apprespond-app_respond_v1) |
| `commands.invoke` nesting | 4 deep | [Commands and composer](commands-and-composer.md#commandsinvoke) |
| Completion triggers | 4 per mod | [Commands and composer](commands-and-composer.md#token-completion) |
| `composer.suggest` | 4 KiB | [Commands and composer](commands-and-composer.md#composersuggest) |
| `@` file mentions | 16 per turn, 256 KiB of returned text | [Commands and composer](commands-and-composer.md#read-checks-and-limits) |

### Workspace, commands and processes

| Limit | Value | Owner |
| --- | --- | --- |
| `exec.run` | 10 s default, 120 s timeout; 1 MiB captured output; 4 concurrent runs | [Running commands](running-commands.md#execrun-limits) |
| `process.exchange` | 256 KiB of messages, at most 64 | [Managed processes](managed-processes.md#processexchange) |
| `exec.run` output artifact | 16 MiB; 16 KiB pages; 64 MiB per binding | [Running commands](running-commands.md#output_artifact-and-execoutput_page) |
| `exec.run` `guards` | 4 guards of 10 s and 1 MiB | [Running commands](running-commands.md#guards-for-live-workspace-writes) |
| `exec.run` `required_access` | 128 paths | [Running commands](running-commands.md#required_access) |
| `exec.run` `unix_sockets` | 4 variables | [Running commands](running-commands.md#unix_sockets) |
| Execution records | 64 per mod generation and thread, 256 per host | [Running commands](running-commands.md#execrun-against-a-snapshot) |
| `workspace.read` | 128 paths, 4 MiB | [Workspace files](workspace-files.md#workspace-reads-and-transactions) |
| `workspace.list` | 20,000 entries | [Workspace files](workspace-files.md#other-workspace-operations) |
| `workspace.check_access` | 128 paths | [Workspace files](workspace-files.md#other-workspace-operations) |
| `workspace.backup`, `workspace.restore` | 256 files, 64 MiB | [Workspace files](workspace-files.md#other-workspace-operations) |
| `workspace_change` batch | 128 paths, 16,000 bytes of path names; a rescan after 64 unannounced changes | [Workspace files](workspace-files.md#workspace_change-delivery) |
| Workspace snapshots | 128 MiB per capture; 8 snapshots and 128 MiB per mod generation and thread; 32 snapshots and 256 MiB per host | [Workspace files](workspace-files.md#snapshots-workspacesnapshot) |
| Raw process streams | 8,000-byte chunks, 128 queued messages | [Managed processes](managed-processes.md#raw-streams-process_streams_v1) |
| `process.start` `environment` | 8 variables | [Managed processes](managed-processes.md#process-environment-and-sandbox) |

### State and events

| Limit | Value | Owner |
| --- | --- | --- |
| `store.*` | 256-byte keys, 64 KiB values, 16 MiB and 4,096 keys per scope | [State and storage](state-and-storage.md#store-operations) |
| `api.state` in the mod store | 512 KiB | [State and storage](state-and-storage.md#state_scope-state_scopes_v1) |
| `evidence.write` | PNG and JPEG 8 MiB, SVG 1 MiB, `application/octet-stream` and text 16 MiB | [State and storage](state-and-storage.md#evidencewrite-and-evidenceread) |
| `time.sleep` | 60 s | [Events and lifecycle](events-and-lifecycle.md#apitime-helpers) |
| `api.time` timers | 16 ms to 24 h | [Events and lifecycle](events-and-lifecycle.md#apitime-helpers) |
| `api.uiState` | 65,536 bytes of JSON | [State and storage](state-and-storage.md#session-ui-state-apiuistate) |
| Reactive subscriptions | 64 per mod; cascades stop after 8 rounds | [State and storage](state-and-storage.md#reactive-state-reactive_state_v1) |
| Channel events | 256 events / 1 MiB per subscriber; 256 counters per publisher, 4,096 per process | [Events and lifecycle](events-and-lifecycle.md#eventspublish) |
| Timer delay | 16 ms to 24 h (`timers_16ms_v1` below 1,000 ms) | [Events and lifecycle](events-and-lifecycle.md#timers-timers_v1) |

### Sessions, agents and contracts

| Limit | Value | Owner |
| --- | --- | --- |
| `sessions.read` | 2,048 characters per record, 16 KiB pages, 4,096 records | [Thread data and recorded sessions](threads-and-sessions-store.md#sessionsread) |
| Peer messages | 64 KiB data, TTL 1 s to 1 h, 64 waiting per recipient | [Peers, power holds and mod-started turns](sessions-and-turns.md#peerslist-and-peerssend) |
| Power holds | 4 live leases per mod; 60 s to 24 h | [Peers, power holds and mod-started turns](sessions-and-turns.md#power-holds-power_hold_v1) |
| Agent definitions per mod | 8 | [Agents](agents.md#agent-definitions) |
| Agents | 16 held handles; `agents.wait` 30 s; 64 finished records | [Agents](agents.md#agent-handles-and-limits) |
| Parent history | 8,192 records or 1 MiB | [Agents](agents.md#parent-history) |
| `sessions.snapshot` `call_ids` | 1–32 call ids | [Thread data and recorded sessions](threads-and-sessions-store.md#sessionssnapshot) |
| Contract restrictions and resolutions | 64 scoped rules of 1–8 predicates; 32 findings per `resolves` | [Contracts and receipts](contracts.md#scoped-restrictions) |
| `turns.queue` | 8 KiB prompt; deadline 1 s to 24 h | [Peers, power holds and mod-started turns](sessions-and-turns.md#turnsqueue) |
| `prompts.consent` | 61,440 bytes, 8 images, 64 pending per mod and thread | [Peers, power holds and mod-started turns](sessions-and-turns.md#promptsconsent) |

### Terminal

| Limit | Value | Owner |
| --- | --- | --- |
| View keybindings | 24 per mod, 128 composed | [Layout and styling](layout-and-styling.md#view-limits) |
| View components | 64, nested 6 deep; ids up to 48 bytes | [Layout and styling](layout-and-styling.md#view-limits) |
| View text | 256 bytes per row value, label and span; 49,152 bytes per text block | [Layout and styling](layout-and-styling.md#view-limits) |
| View JSON | 256 KiB per view or patch, 1 MiB composed | [Layout and styling](layout-and-styling.md#view-limits) |
| Status row | 4 segments of 40 characters across all mods | [Layout and styling](layout-and-styling.md#view-limits) |
| Component modules per mod | 16; 4 mounted in the terminal and 4 per external client | [Terminal input](terminal-input.md#component-modules-component_modules_v1) |
| Layout tree | 6 levels, 2–4 children per split, 1–6 tabs per node, 12 leaves | [Layout and styling](layout-and-styling.md#layouts-and-component-types) |
| Overlays | width 1–200, height 1–60 | [Layout and styling](layout-and-styling.md#overlays) |
| `key_contexts` | 8 contexts and 32 keys per mod; 16 and 128 composed | [Terminal input](terminal-input.md#focus-regions-key-contexts-and-help-terminal_focus_v1) |
| Component key input | 64 events and 64 KiB per batch; 256 queued events | [Terminal input](terminal-input.md#component-key-and-paste-input-terminal_input_v1) |
| Images | 8 MiB PNG or JPEG, 4,096 pixels a side | [Graphics](graphics.md#image-formats-and-pixel-mapping) |
| `terminal.image_sample` | 120 columns, 60 rows, 8 MiB source | [Graphics](graphics.md#terminalimage_sample) |
| Rasters | 1–512 × 1–256 cells; 16 per mod; 256 KiB per `terminal.blit` | [Graphics](graphics.md#raster-component) |
| Pixel frames | 4,096 pixels per side (64 MiB for RGBA) | [Graphics](graphics.md#pixel-buffer-safety-and-limits) |
| `terminal.panel` | 1–200 items, 8 tabs, 32 options; 128-byte title | [Terminal operations](terminal-operations.md#terminalpanel) |
| `terminal.notice` | 512 bytes; 4 toast or status notices per mod; 8 model notices queued per thread | [Terminal operations](terminal-operations.md#terminalnotice) |
| `terminal.selection`, `terminal.copy` | 64 KiB | [Terminal operations](terminal-operations.md#selection-and-clipboard) |
| `above_composer`, `below_composer` sites | 8 and 6 rows | [Terminal UI](terminal-ui.md#alternate-screen-inline-mode-and-composer-sites) |
| `omd/client/event` | 64 KiB per event | [`omd-client/1` protocol](omd-client-protocol.md#omdclientevent) |
| `session_title_suffix`, `greeting` | 80 and 256 bytes | [Layout and styling](layout-and-styling.md#title-suffix-and-greeting) |
| Layout leaf `title` | 64 bytes | [Layout and styling](layout-and-styling.md#layouts-and-component-types) |
| `terminal.pane` | 8 rows shown | [Terminal operations](terminal-operations.md#terminalpane-and-terminalpanes) |
| `terminal.prompt` choices | 32 options | [Terminal operations](terminal-operations.md#terminalprompt) |
| `terminal.notify` | 1 per 2 s | [Terminal operations](terminal-operations.md#notifications-and-ports) |
| `terminal.import_file` | 8 MiB | [Terminal operations](terminal-operations.md#threads-and-imports) |
| `sessions.ports` | 32 ports, 3 s per probe | [Terminal operations](terminal-operations.md#notifications-and-ports) |
| `document` component | 100,000 lines; 10,000 find matches | [Layout and styling](layout-and-styling.md#documents) |

## Host limits

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
