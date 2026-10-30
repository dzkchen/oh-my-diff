# Agents

Use it when a mod spawns and manages worker agents, registers agent definitions, watches the agents of a session,
intercepts spawns or integrates a worker's changes. Receipts that agents produce for a contract are in
[Contracts and receipts](contracts.md).

## `agents.spawn`

```ts
agents.spawn {role?, route?, prompt, definition?, workspace?, tools?, evidence?, snapshot?, parent_history?,
              resolution_context?, model?}
```

It starts a read-only or isolated-worktree agent on a worker route under the session's worker limits.

- `route` may also be a lead route of a registered provider ([Choosing a route](routes.md#choosing-a-route)); the
  agent runs under `worker_limits`.
- `model` (an experimental field) picks another model from that provider's runtime catalog on such a lead route (rates
  and billing stay the route's); outside the catalog it fails with `agent_model_not_in_route_provider_catalog`, and on
  any other route a `model` other than the route's fails with `agent_model_requires_provider_lead_route`.
- `evidence` delivers a stored evidence reference to the agent.
- `snapshot` selects a frozen copy ([`workspace.snapshot`](workspace-files.md#snapshots-workspacesnapshot)) and requires
  `fs.read`. Its permission is always `read_only`, its result
  identifies the captured candidate, and it cannot be integrated as an edit.
- Permissions are rechecked when the agent starts.

## Agent handles and limits

`agents.message`, `agents.wait` (at most 30 s), `agents.result`, `agents.cancel` and `agents.list` address only the
caller's handles. `agents.message` and `agents.list` are experimental.

- Calls on one handle run in order; a wait on one handle does not block calls on another.
- The host holds at most 16 agents, counting spawns in progress.
- Agents live until cancelled, the mod is disabled or fails, or the session stops.

## Parent history and `sessions.snapshot`

`parent_history: true` also requires `sessions` and `sessions_tools` and delivers frozen parent
conversation records including visible tool calls and outputs. It refuses more than 8,192 records or 1 MiB instead
of silently truncating them.

- The spawn result includes the history digest, byte count, item count and revision.
- The records are labeled untrusted task data.

`sessions.snapshot {call_ids?}` preserves the same history in a caller-bound evidence reference and requires
`sessions` and `sessions_tools`. Reading the returned evidence with `evidence.read` needs `store`.

- A selection contains 1–32 unique IDs and must include each complete call/output pair.
- Evidence storage's 256 KiB limit still applies.
- This does not expose hidden reasoning.

## Agent failure details

Failed `agents.result`/`agents.wait` and `agent_end` retain an optional `failure: {category, code, message}` from
the host error. The same object is `error` on an `error` outcome of `turn_end`, `turns.activity` turns and
`agents.inventory` `last_turn`; `reason` names only an abort.

| Field | Meaning |
| --- | --- |
| `category` | `transport`, `rate_limit`, `authorization`, `sandbox`, `allowance`, `invalid_request` or `unknown` |
| `code` | Preserves the structured protocol error |
| `message` | Bounded to 1,024 characters |

Missing details are unknown, never evidence of an outage. Mods own retry policy; the host owns admission.

## Explicit thread resume

Explicit thread resume reopens the same task ledger, preserving requests, exposure, observed lead usage and
uncertain in-flight requests.

- Repository, thread identity, original limits and saved journal must validate.
- Implicit reopening, changed limits and completed tasks are refused.
- Agent handles and snapshot handles do not survive process restart; mods must reconcile saved pending work without
  silently spawning replacements.

## Native subagents

Multi-agent V2 children behave like this in OMD (V1 sessions keep upstream behavior):

### Completion wake

When a child's result reaches an idle parent (the root or another child), the parent starts one
turn about 500 ms after the last result, and that turn reads every queued result. An interrupted parent and Plan
mode stay idle. A result over 16 KiB is cut with a pointer to `list_agents`. A `wait_agent` that times out tells
the model to end its turn.

### Forwarding

A child's approval, permission or MCP elicitation request is reported to the parent's mailbox; only
the user can answer it. A child may call `request_user_input`: its question is queued in the parent's mailbox and
read at the parent's next turn (it does not start one), and the TUI shows "Waiting on you in <thread>" so the user
can answer meanwhile. The parent's next `send_message` or `followup_task` to that child answers the question ("Your
parent replied; its message follows." then the message); the user can answer too. The question card stays until the
child's turn ends.

### Caps

Every model `spawn_agent` counts against `host.json` `limits.max_depth` (default 2) and
  `limits.concurrent_workers` (default 4) and is refused with `subagent_depth_limit` or
`subagent_concurrency_limit` ([Host limits](limits.md#host-limits)). These apply in addition to
Codex's `agents.max_threads`.

## Agent definitions, inventory and spawn interception (`agent_lifecycle_v1`)

This section covers agent definitions, `agent_spawn` interceptors, `agents.inventory` and the `agent` middleware
event.

### Agent definitions

```ts
api.agent({name, description, instructions, route?, effort?, tools?, offer?})
```

It registers up to 8 definitions per mod during activation, named `<mod>/<name>`. Configured and built-in role
names always win.

With `offer: true` the definition appears in the native `spawn_agent` role list, after `agent_offers` interceptors
(experimental),
which may drop or re-describe offers but never add, rename or reassign one.

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

```ts
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
  provider. It needs a lead route there (`agent_route_unavailable` otherwise); the child is then admitted as a
  worker on that route under `worker_limits` and accounted at the route's rates; if admission fails, every request of
  the child is refused. Opaque reasoning and compaction items from the parent's history are not sent to it.
- With `agent_spawn` interceptors registered, native spawn calls reach them instead of `tool` interceptors.

### `agents.inventory`

`agents.inventory` returns every agent of the session: model spawns, mod workers and engine-started subagents
(`origin`). Each record carries:

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
`partial` means some responses were unpriced. For engine subagents outside OMD accounting, such as review, usage
is the engine's token totals (`source: engine`, request count and cost unknown).

A mod worker's `agent_id` is its handle. At most 64 finished records are kept.

### `agent` middleware event

The `agent` middleware event delivers `{phase: 'start' | 'turn' | 'end', agent}` with the same record (its
`provider`, `model` and `billing` fields are experimental), in order and
under the state of the session thread at the root of the agent's parents.

Observation grants nothing: `agents.message`, `agents.wait`, `agents.result` and `agents.cancel` still address only
the caller's own handles.

## Typed worker and workspace operations

`agents.spawn` accepts a host-authorized route and a `workspace` of `read_only` or `isolated_worktree`. A writable
child receives a captured, isolated worktree under the native task scratch area; its parent repository is never its
working directory. A `read_only` child may list `tools` from `exec_command`, `write_stdin`
and `web_search`; any other name fails with `read_only_tool_surface_invalid`. Only a `provider_billed` route admits
`web_search`: other routes refuse hosted tool declarations at the child's first request.

`agents.wait` and `agents.result` return a host-attested thread reference and SHA256 of the final text. A mod
should validate that text against its declared result schema and source-reference rules before calling
`agents.result` with `consume: true`. The host requires consumption before `workspace.integrate` accepts that mod's
private handle. How `workspace.integrate` checks a contract's `integrate` gate is in
[Completion, integration and restriction](contracts.md#completion-integration-and-restriction).

The typed-task mod reads the native checkpoint before spawning, passes its bounded objective and revision into each
worker prompt, and reports the revision with the validated batch. It never marks acceptance criteria complete on
behalf of the parent.

### `workspace.integrate`

`workspace.integrate` captures the worker's changed paths, merges against the current parent snapshot, runs the
task's configured executable check on an isolated candidate, and obtains a candidate review before applying the
exact checked delta. It refuses conflicting parent edits, a changed candidate, a failed check or review, or a
changed parent before apply.

- The native ledger owns allowance, permissions, lifecycle, and evidence.
- A failed apply retains diagnostic evidence and may need operator inspection; external concurrent writers are not
  locked.
- Cancellation, a failed tool callback, mod disable or failure, and session stop retire owned handles and clean
  their worktrees; turn end does not.
- Direct mode never loads this mod.
