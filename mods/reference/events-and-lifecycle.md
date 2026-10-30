# Events and lifecycle

Use it when a mod reacts to host events: which events exist and what they carry, channels between mods, timers and
the `api.time` helpers, how background callbacks are delivered, lifecycle events and the classic hook names.

## Event index

Every event in the `Events` interface of [`api.d.ts`](../api.d.ts), with its input fields, what a handler may
return, how it is registered, its status in the conformance registry and where it is described. "Type only" means
no page describes the event beyond its type. An event marked experimental may change in any release
([Stability and migration](stability-and-migration.md)).

`api.middleware` takes only `prompt`, `session`, `agent`, `tool_call`, `tool_result`, `host_operation` and
`approval`. `api.replace` takes only `context`, `routing`, `compaction`, `tool_batch`, `completion` and `history`.

| Event | Input | Handler returns | Registered with | Status | Described in |
| --- | --- | --- | --- | --- | --- |
| `context` | `{thread_id, turn_id, ledger}` | `{text}` or null | `api.on` or `api.replace` | frozen | type only |
| `routing` | `{routes, model, provider, reasoning}` | `{route}` or null | `api.on` or `api.replace` | frozen | [Routes](routes.md#choosing-a-route) |
| `compaction` | `{token_limit, context_window}` | `CompactionDecision` | `api.on` or `api.replace` | frozen | type only |
| `history` | `{thread_id, agent_id, model, items}` | `HistoryEdit` or null | `api.on` or `api.replace` | frozen | [History and compaction](history.md#model-bound-history-history_v1) |
| `completion` | `{kind: 'mention', ...}` or `{kind: 'argument', ...}` | `{items}` or null | `api.on` or `api.replace` | frozen | [Commands and composer](commands-and-composer.md#composer-completion-completion_v1) |
| `tool_batch` | `{batch_id, thread_id, calls}` | `{merge}` or null | `api.on` or `api.replace` | frozen; experimental field: `success_per_call` | [Tools](tools.md#replacetool_batch) |
| `tool_exposure` | `{thread_id, ledger, available}` | `{enable}` | `api.on` | experimental | [Tools](tools.md#task-scoped-tools-and-tool_exposure) |
| `migrate` | `{from, to}` | nothing | `api.on` | experimental | [State and storage](state-and-storage.md#state_version-migration-of-thread-and-checkout-state) |
| `terminal` | `{event, ledger, identity?, presentation?, client?, clients?}` | `TerminalPatch` or null | `api.on` | frozen; experimental fields: `omd_version`, `sites` | [Terminal UI](terminal-ui.md) |
| `start` | `Json` | nothing | `api.on` | frozen | type only |
| `resume` | `{thread_id, last_turn, restarted}` | nothing | `api.on` | frozen | [Threads, turns and sessions](threads-and-sessions-store.md#thread-scoped-store-and-resume) |
| `idle` | `Json` | nothing | `api.on` | frozen | type only |
| `stop` | `Json` | nothing | `api.on` | frozen | type only |
| `session` | `{phase, thread_id, cause?}` | nothing | `api.on` or `api.middleware` | experimental | type only |
| `prompt` | `{thread_id, turn_id, original, effective, provenance}` | nothing | `api.on` or `api.middleware` | experimental | [Sessions and turns](sessions-and-turns.md#how-queued-turns-start) |
| `turn_start` | `{turn_id}` | nothing | `api.on` | frozen | type only |
| `turn_end` | `{turn_id, outcome, reason?, error?, evidence?}` | nothing | `api.on` | frozen | [Agents](agents.md#agent-failure-details) |
| `tool_call` | `{call_id, agent_id, tool, arguments}` | nothing | `api.on` or `api.middleware` | frozen | type only |
| `tool_result` | `{call_id, agent_id, thread_id, tool, outcome, answered_by, call_sha256, result_sha256, result_complete}` | nothing | `api.on` or `api.middleware` | frozen | [Tools](tools.md#tool_result_fingerprints_v1) |
| `tool_output` | `{call_id, tool, arguments, success, text, tail, bytes}` | `{append}` or null | `api.on` | frozen | [Tools](tools.md#tool_output-observers) |
| `tool_batch_end` | `{turn_id, calls}` | nothing | `api.on` | experimental | [Lifecycle events](#lifecycle-events) |
| `agent` | `{phase, agent}` | nothing | `api.on` or `api.middleware` | frozen; experimental fields: `provider`, `model`, `billing` | [Agents](agents.md#agent-middleware-event) |
| `agent_end` | `{handle, role, status, error?, failure?, text?, sha256?}` | nothing | `api.on` | frozen | [Agents](agents.md#agent-failure-details) |
| `contract` | `{gate, outcome, missing, candidate_sha256}` or a refusal with `outstanding_findings` | nothing | `api.on` | experimental | type only |
| `compaction_start` | `{turn_id, trigger}` | nothing | `api.on` | frozen | type only |
| `compaction_end` | `{turn_id, trigger, outcome, by, provider_call}` | nothing | `api.on` | frozen | [History and compaction](history.md#compaction-summarizers-and-results) |
| `model_response` | `ModelResponse` | nothing | `api.on` | frozen | [Model requests and streams](model-requests.md#onmodel_response) |
| `host_operation` | `{phase, caller, operation, arguments?, result?, error?}` | nothing | `api.on` or `api.middleware` | experimental | [Admission and interception](admission-and-interception.md#host_operation-middleware-event) |
| `approval` | `{id, kind, thread_id, turn_id, agent_id, host_decision, policy, details, assessment}` | `{deny}`, `{ask}`, `{approve}` or null | `api.on` or `api.middleware` | frozen | [App bridge and approvals](app-bridge-and-approvals.md#approvals-approval_v1) |
| `approval_result` | `{id, kind, decision, source, mod?}` | nothing | `api.on` | frozen | [App bridge and approvals](app-bridge-and-approvals.md#how-answers-combine) |
| `app_notification` | `{method, params, thread_id, coalesced, dropped}` | nothing | `api.on` | frozen | [App bridge and approvals](app-bridge-and-approvals.md#excluded-methods-and-subscriptions) |
| `app_server_request` | `{method, request_id, phase, params, resolution}` | nothing | `api.on` | frozen | [App bridge and approvals](app-bridge-and-approvals.md#excluded-methods-and-subscriptions) |
| `elicitation_result` | `{server, request_id, action, content, by}` | nothing | `api.on` | experimental | [Lifecycle events](#lifecycle-events) |
| `workspace_change` | `{repository, source, call_id, watch_id?, changes, status, reason?}` | nothing | `api.on` | frozen | [Workspace files](workspace-files.md#workspace_change-delivery) |
| `workspace_pre_rename` | `{repository, old, new, expected, thread_id}` | a `ready` or `fallback` proposal, or nothing | `api.on` | frozen | [Workspace files](workspace-files.md#workspacerequest_rename) |
| `process_event` | `{session, kind: 'output', bytes}` or `{session, kind: 'exit'}` | nothing | `api.on` | frozen | [Managed processes](managed-processes.md#process-notifications) |
| `timer` | `{key}` | nothing | `api.on` | frozen | [Timers](#timers-timers_v1) |
| `channel` | `{publisher, channel, data, correlation, sequence, dropped}` | nothing | `api.on` | frozen | [`events.publish`](#eventspublish) |
| `component_event` | `{component, thread_id, kind, ...}` | nothing | `api.on` | frozen; experimental fields: `content`, `target`, `edge` | [Terminal input](terminal-input.md#component_event) |
| `component_post` | `{component, module, client?, data}` | nothing | `api.on` | frozen | [Terminal input](terminal-input.md#component-module-handlers) |
| `view` | `{phase, view, view_id, dropped?}` | nothing | `api.on` | experimental | [Terminal input](terminal-input.md#component_event) |
| `focus` | `{focused, dropped?}` | nothing | `api.on` | experimental | [Terminal input](terminal-input.md#component_event) |
| `composer` | `{kind: 'change', ...}` or `{kind: 'suggestion', ...}` | nothing | `api.on` | frozen | [Commands and composer](commands-and-composer.md#composer-event) |
| `prompt_expanded` | `{turn_id, items}` | nothing | `api.on` | experimental | [Commands and composer](commands-and-composer.md#submitted-drafts-and-prompt_expanded) |
| `config_change` | `{key, original, effective, source, scope, caller}` | nothing | `api.on` | experimental | [Commands and composer](commands-and-composer.md#configset) |
| `instructions_loaded` | `{kind, source, sha256, bytes, reason}` | nothing | `api.on` | experimental | [Lifecycle events](#lifecycle-events) |
| `thread_settings` | `{cwd, roots, model, effort, provider}` | nothing | `api.on` | frozen | [Lifecycle events](#lifecycle-events) |
| `worktree` | `{phase, path, owner}` | nothing | `api.on` | experimental | [Lifecycle events](#lifecycle-events) |
| `mods_changed` | `{active}` | nothing | `api.on` | experimental | [Lifecycle events](#lifecycle-events) |
| `peer_message` | `{id, from, to, correlation, untrusted, data, sent_at_ms}` | nothing | `api.on` | experimental | [Sessions and turns](sessions-and-turns.md#peer-message-authentication-and-delivery) |
| `peer_receipt` | `PeerReceipt` | nothing | `api.on` | experimental | [Sessions and turns](sessions-and-turns.md#peer_receipt-events) |
| `turn_queue` | `{key, status, reason?, turn_id?}` | nothing | `api.on` | experimental | [Sessions and turns](sessions-and-turns.md#turnsqueued-turnsdequeue-and-turn_queue-events) |

## Channels and timers (`events_v1`)

This section covers `events.publish`, channel counters, callback delivery, timers and the `api.time` helpers.

### `events.publish`

`events.publish {channel, data, correlation?}` publishes under the caller's namespace. Subscribers declare channel
patterns and receive `channel` events (256 events / 1 MiB per subscriber) in the publishing thread.

- Events whose originating thread is gone are dropped.
- Sequence numbers are independent per publisher/channel.

### Channel counters

The host retains at most 256 channel counters per publisher and 4,096 process-wide. A new channel beyond either
limit fails with `channel_sequence_limit`, while existing channels remain publishable.

- On publication, counters for a publisher with no successful publication for at least 15 minutes and no queued
  events are reclaimed. Its next publication starts at sequence 1.
- Successful publication with no subscribers still counts as activity; rejected publication does not.
- Unsubscribing alone does not reset counters.

### Callback delivery

- [Watches](workspace-files.md#workspacewatch) and timers end when their mod is disabled or its source changes, and each
  delivery runs in the thread that registered it.
- A `channel`, `timer`, [`process_event`](managed-processes.md#process-notifications) or watched `workspace_change`
  callback that changes its mod's state republishes the terminal view, so background results appear without waiting for
  the next turn.

### Timers (`timers_v1`)

`events.schedule {key, delay_ms}` (`timers_v1`) delivers one `timer` event `{key}` to the calling mod after 16 ms
to 24 h.

- Scheduling a key again replaces it within that thread.
- `events.cancel {key}` stops only that thread's timer.
- There are 16 timers per mod by default (`timers_per_mod` in [Host limits](limits.md#host-limits)) across all
  threads, including ticks pending delivery.
- Require `timers_16ms_v1` for delays below 1000 ms.
- Deliveries are spaced at least 16 ms apart per mod/thread, and each is a full callback: draw animation from a
  component module's frame clock instead.
- Pending ticks with the same key coalesce, and other owners continue while one owner waits for its budget.
- A timer never starts a turn by itself; only [`turns.queue`](sessions-and-turns.md#turnsqueue) under an `autonomous`
  grant can.

### `api.time` helpers

- `api.time.sleep(ms)` calls `time.sleep {ms}` (`events`, at most 60 s, experimental): the callback waits in place,
  holding no runtime lock, and the wait does not count as own time; cancellation wakes it and ends the callback.
- `api.time.wait(check, {interval_ms, timeout_ms})` polls `check` between sleeps within the 512 host calls.
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

## Lifecycle events and classic hooks (`lifecycle_events_v1`)

This section covers lifecycle events, the `elicitation` interceptor, `api.hook` and the input a hook handler receives.

### Lifecycle events

Observe-only events (capability `lifecycle` unless noted), all for the lead thread:

- `tool_batch_end {turn_id, calls: [{call_id, tool, outcome}]}` (experimental) after every call one model response
  dispatched has settled.
- `instructions_loaded {kind, source, sha256, bytes, reason}` (experimental) when the host loads AGENTS.md instructions
  (`instructions`, at `session_start` or on `refresh` when they change), a skill (`skill`, `explicit` or
  `implicit`) or a user attachment (`attachment`).
- `thread_settings {cwd, roots: {added, removed}, model, effort, provider}` with `before`/`after` values after the
  thread's working directory, workspace roots or model settings change.
- `worktree {phase: 'created' | 'removed', path, owner: 'agent' | 'tui'}` (experimental) for isolated agent worktrees
  and worktrees the terminal creates or removes.
- `mods_changed {active}` (`mods_changed_v1`, experimental) with the ids of the active mods, once when a process first
  loads its mods and again after a reload adds or removes one, so a mod can prune data kept for mods that are gone;
  native mods reload at the next turn or surface call, so a mod turned off in `/mods` is reported then.
- `elicitation_result {server, request_id, action, content, by}` (capability `approvals`, experimental) after an MCP
  elicitation is answered; password and write-only fields are `[redacted]`, and `content` is the string `[redacted]`
  when the host no longer holds the request's schema.

### `elicitation` interceptor

`api.intercept('elicitation', …)` (capability `approvals`, experimental) sees MCP form elicitations before the user is
asked:

```ts
{thread_id, turn_id, server, request_id, mode, message, schema}
```

A handler may answer:

- `{accept: content}` (only declared fields and every required one);
- `{decline}`;
- `{cancel}`.

Passing it on asks the user. URL and user-verification elicitations and forms with password or write-only fields
are never offered to mods.

### `api.hook`

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

### Hook handler input and delivery

The handler receives:

```ts
{hook, event, subject, thread_id, turn_id, origin, generation, original, effective, delivery}
```

`options.match` filters the hook's subject (for example the tool name) with exact values, arrays, regular
expressions, `api.match.glob(pattern)` and `api.match.not(matcher)`, which also work in interceptor `match`
options.

- Interceptor-backed hooks may be `required` and may return an answer such as `{deny}` or `{continue}`; returning
  nothing passes the call on.
- Event-backed hooks are delivered best-effort (`delivery: 'optional'`).
- A mod that uses a hook cannot also register the same native event itself.
- Hooks may be registered only during activation, including when their native event is already registered.
