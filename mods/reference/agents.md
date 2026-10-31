# Agents

Use it when a mod spawns and manages worker agents, registers agent definitions, watches the agents of a session,
intercepts spawns or integrates a worker's changes. Receipts that agents produce for a contract are in
[Contracts and receipts](contracts.md).

Mod API `1.0.0`: `agents.spawn`, `agents.wait`, `agents.result`, `agents.cancel` and `agents.inventory` are frozen;
`agents.message`, `agents.list`, the spawn `model` field and the entries marked below are experimental. Platform:
Apple Silicon macOS.

## `agents.spawn`

`agents.spawn` (capability `agents`) starts a read-only or isolated-worktree agent on a worker route under the
session's worker limits.

```text
agents.spawn {role?, route?, prompt, definition?, workspace?, tools?, evidence?, snapshot?, parent_history?,
              resolution_context?, model?}
```

### `agents.spawn` arguments

| Argument | Meaning |
| --- | --- |
| `role` | 1 to 64 bytes |
| `route` | A worker route, or a lead route of a registered provider ([Choosing a route](routes.md#choosing-a-route)); the agent runs under `worker_limits` |
| `prompt` | 1 to 8,192 bytes |
| `definition` | A registered [agent definition](#agent-definitions); it supplies the route when `route` is absent |
| `workspace` | `read_only` (default) or `isolated_worktree`; see [Worker workspaces, tool lists and integration](#worker-workspaces-tool-lists-and-integration) |
| `tools` | The child's tool list; see [Worker workspaces, tool lists and integration](#worker-workspaces-tool-lists-and-integration) |
| `evidence` | A stored evidence reference delivered to the agent |
| `snapshot` | A frozen copy from [`workspace.snapshot`](workspace-files.md#snapshots-workspacesnapshot) for the agent to work on; see below |
| `parent_history` | `true` delivers the parent conversation; see [Parent history](#parent-history) |
| `resolution_context` | `{acceptance_sha256, findings}` for a worker that resolves contract findings ([Contracts and receipts](contracts.md)) |
| `model` | Experimental. Another model from the provider's runtime catalog on a provider lead route; rates and billing stay the route's |

A `snapshot` agent:

- needs `fs.read`;
- is always `read_only`;
- returns a result that identifies the captured candidate and can't be integrated as an edit.

Permissions are rechecked when the agent starts.

### `agents.spawn` result

```text
{handle, route, permissions: 'read_only' | 'isolated_worktree', parent_history?: {sha256, bytes, items, revision}}
```

### `agents.spawn` errors

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

### `agents.spawn` example

```ts
const agent = api.host.call('agents.spawn', {
  role: 'investigator', route: 'inspector', prompt: 'List the failing tests.', workspace: 'read_only', tools: [],
});
const result = api.host.call('agents.wait', { handle: agent.handle });
```

## Agent handles and limits

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

## Parent history

`parent_history: true` also requires `sessions` and `sessions_tools` and delivers frozen parent
conversation records including visible tool calls and outputs. It refuses more than 8,192 records or 1 MiB instead
of silently truncating them.

- The spawn result includes the history digest, byte count, item count and revision.
- The records are labeled untrusted task data.

To keep the same history as evidence without spawning, use
[`sessions.snapshot`](threads-and-sessions-store.md#sessionssnapshot).

## Agent failure details

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

## Native subagents

These rules apply to children the model spawns with Codex's multi-agent V2 tools (`spawn_agent`, `wait_agent`,
`send_message`). Threads on multi-agent V1 keep upstream Codex behavior.

### Completion wake

These rules set when a parent runs again after its children report.

- When a child's result reaches an idle parent (the root or another child), the parent starts one turn about 500 ms
  after the last result. That turn reads every queued result.
- A parent that was interrupted, or is in Plan mode, stays idle.
- A result over 16 KiB is cut, with a pointer to `list_agents`.
- A `wait_agent` that times out tells the model to end its turn.

### Forwarding

These rules set where a child's questions and requests go.

- A child's approval, permission or MCP elicitation request goes to the parent's mailbox. Only the user can answer it.
- A child's `request_user_input` question is queued in the parent's mailbox and read at the parent's next turn. It
  doesn't start a turn.
- The TUI shows "Waiting on you in <thread>", and the user can answer at any time.
- The parent's next `send_message` or `followup_task` to that child also answers it, prefixed with "Your parent
  replied; its message follows."
- The question card stays until the child's turn ends.

### Caps

Every model `spawn_agent` counts against `host.json` `limits.max_depth` (default 2) and `limits.concurrent_workers`
(default 4) and is refused with `subagent_depth_limit` or `subagent_concurrency_limit`
([Host limits](limits.md#host-limits)). These apply in addition to Codex's `agents.max_threads`.

## Agent definitions, inventory and spawn interception (`agent_lifecycle_v1`)

Definitions name reusable agents, `agent_spawn` interceptors rewrite spawns, and `agents.inventory` and the `agent`
event report every agent of the session.

### Agent definitions

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

### `agent_spawn` interceptors

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

### `agents.inventory`

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

### `agent` middleware event

The `agent` middleware event delivers `{phase: 'start' | 'turn' | 'end', agent}` with the same record (its
`provider`, `model` and `billing` fields are experimental). Events arrive in order. Each one is delivered under the
state of the root thread, the session thread at the top of the agent's parent chain.

Observation grants nothing: `agents.message`, `agents.wait`, `agents.result` and `agents.cancel` still address only
the caller's own handles.

## Worker workspaces, tool lists and integration

`agents.spawn` accepts a host-authorized route and a `workspace` of `read_only` or `isolated_worktree`. A writable
child receives a captured, isolated worktree under the native task scratch area; its parent repository is never its
working directory. A `read_only` child may list `tools` from `exec_command`, `write_stdin`
and `web_search`; any other name fails with `read_only_tool_surface_invalid`. Only a `provider_billed` route allows
`web_search`: other routes refuse hosted tool declarations at the child's first request.

`agents.wait` and `agents.result` return a host-attested thread reference and SHA256 of the final text. A mod
should validate that text against its declared result schema and source-reference rules before calling
`agents.result` with `consume: true`. The host requires consumption before `workspace.integrate` accepts that mod's
private handle. How `workspace.integrate` checks a contract's `integrate` gate is in
[Completion and integration gates](contracts.md#completion-and-integration-gates).

### `workspace.integrate`

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
