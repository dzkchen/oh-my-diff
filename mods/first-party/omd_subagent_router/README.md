# omd_subagent_router

Runs subagents, the helper agents the main agent (the lead) starts for part of a task, on the model you name. That can
be another provider's model, such as Claude subagents under a GPT lead. It also adds a `delegate_task` tool that runs
background workers. It's experimental, and no install profile includes it.

## Turn it on

Install it from the Available group in `/mods`, or run:

```sh
omd install omd_subagent_router
omd mods enable omd_subagent_router
```

[Manage mods](../../../docs/manage-mods.md) covers the other ways to install and turn on a mod.

While it's on, an idle lead wakes about 0.5 s after a subagent's or a delegated task's result arrives (Codex's
`agents.completion_wake`).

## Use it

Say which model subagents should use, in any prompt you type (queued prompts from mods are ignored):

| You write | Subagents it affects |
| --- | --- |
| `use sonnet 5.5 as subagents to research` | research subagents |
| `use opus with high effort as subagents for review` | review subagents, at high effort |
| `@opus for review` | review subagents |
| `use gpt-6.1-sol as subagents` | every subagent |
| `use the lead model as subagents for review` | review subagents go back to the lead's model |

A directive lasts for the rest of the conversation, and a later one for the same role replaces it. Words match model
names loosely: `sonnet 5.5` finds `claude-sonnet-5-5`. A directive right after a negation (`don't use opus as subagents`,
`never`, `do not`, `no`, `without`, `avoid`, `not`) is ignored.

A subagent's role comes from its definition (`explorer` is research, `worker` is worker) or from words in its task,
matched as whole words (with their common endings, so `workspace` is not `work`) and checked in this order:

1. review: review, audit, critique, verif
2. research: research, investigat, explor, look up, look into, find out, survey
3. worker: implement, write, edit, fix, build, code, work

Some tasks have no role words, for example when Codex's multi-agent v2 tools seal the task so the router can't read it.
Such a task follows your role directive if you gave exactly one. When the lead picks an available model itself, that
choice stands.

The agent's tool row shows the model it runs on, and `/status` lists each subagent with its model, tokens and cost.

### Delegate tasks

The model, not you, calls the `delegate_task` tool (found through `tool_search`). Native `spawn_agent` already runs
other providers' models and work that outlives the turn, so its description tells the model to use `delegate_task`
only for what it alone gives: worker-only routes, a read-only sandbox, an isolated worktree whose result the lead
applies with `integrate` (`workspace.integrate`), and `retry_after_limit`.

| `action` | What it does |
| --- | --- |
| `start` | Runs `task` as a background worker (fields below) |
| `status` | Reports a task by `handle`, or lists them all |
| `cancel` | Stops a task, or discards a finished worktree result |
| `integrate` | Applies a finished `worktree` task's changes to the workspace. `status` lists its `changed_paths` and `candidate_sha256` |
| `targets` | Lists routes with their model, provider, health, the isolation each allows, and why one is skipped. With `model`, lists only routes and models matching it. A route lists at most 12 other models and counts the rest in `more_models` |

Fields of `start`:

- `role`: `research`, `review`, `worker` or `general`.
- `model`: defaults to the role's directive or setting.
- `isolation`: `shared` (read-only workspace and tools) or `worktree`.
- `mode`: `async` (default) or `wait` (one wait of up to 30 s, then it returns running).
- `request_id` (up to 128 bytes): a repeated one returns the existing task whatever the other fields say.

A task runs on a worker route from `host.json` and has only the permissions the host gives it. A route is a model setup
in `host.json`: provider, model, URL and rates. The task's route is either a route with role `worker` and a grant, or a
lead route of a provider such as `omd_claude_cli`, and it must be open to this mod. On a provider's lead route, a task
can run any model in that provider's catalog, for example `model: claude-sonnet-5-5` on the `claude` route. `targets`
lists those models.

- A finished or failed task's result reaches the lead as a subagent message from `<lead path>/<handle>` (the handle
  lowercased, with `-` made `_`), the way a native subagent's result does, and wakes an idle lead. A result that
  `mode: 'wait'` already returned isn't sent again. The message carries up to 16 KiB of the result; `status` returns the
  stored copy, which is at most 8 KiB.
- A stored result longer than 8 KiB ends with a truncation marker.
- A worker keeps going after the turn ends but not after the session. A finished `worktree` task uses one of the
  host's agent slots until you `integrate` or `cancel` it. Running tasks share `limits.concurrent_workers` in
  `host.json` with other subagents.
- The mod keeps its 12 newest tasks, dropping read ones first.

### Routing health

This applies to `delegate_task` and to subagents the router routes. A model the lead named itself is kept unchecked.
A target is skipped when:

- its route isn't available,
- its provider's latest usage window (from `account/rateLimits/updated`, which Claude sends after a Claude request) is
  at 90% or more, or
- a task on that provider failed for authorization, rate limit or allowance in the last 15 minutes.

Windows and failures are kept in the mod's user store, so every thread sees them. A window with no reset time stops
counting after an hour. The task or subagent then runs on the first usable model in `fallback_models`, else the lead's
model, with a notice naming every skipped route and why. `start` also returns them in `skipped`. With no usable route
left, `delegate_task` refuses and lists them. A subagent model the
lead picked itself, and models on the built-in OpenAI provider, skip these checks.

### Restart after a usage limit

With `retry_after_limit` on, a task that fails for a rate limit, on a provider whose usage window has a reset time
within 6 hours and at least 90% used (Claude, ChatGPT), is held for a restart. Its failure doesn't reach the lead,
and `status` reports it `waiting` with the restart time. About 30 s after the reset it starts again as a new task with
the same brief, route and model, and that task's result reaches the lead like any other, from the new task's handle, and `status <original>` links the two. A restart that fails isn't
restarted again. If the route is gone or skipped by then, or its name now points at another provider, account or billing, the original failure reaches the lead, and `status` says why. `cancel` stops a pending restart, and so does turning the setting off. The mod keeps the brief
(up to 8,000 bytes) only while this setting is on. It never moves the task to another route or provider.

## Settings

Change settings in `/mods`. Effort values are empty, `none`, `minimal`, `low`, `medium`, `high` or `xhigh`.

| Setting | Default | What it does |
| --- | --- | --- |
| `research_model`, `review_model`, `worker_model` | empty | The model for that role when no directive names one. Empty keeps the lead's model. |
| `research_effort`, `review_effort`, `worker_effort` | empty | Reasoning effort for that role, used only with that role's `*_model` setting |
| `fallback_models` | empty | Comma-separated models to try in order when the chosen one is skipped, such as `opus, gpt-6.1-sol`. The lead's model comes last. Empty goes straight to the lead's model. |
| `retry_after_limit` | `false` | Restarts a `delegate_task` task once, on the same route, when its provider's usage limit stopped it and the limit resets within 6 hours (see below) |

A directive for a role replaces both its model and effort settings. An empty effort uses the effort the lead put in the
spawn call if the model supports it, else the model's default. An effort the model lacks is ignored. `delegate_task`
ignores the effort settings, because the host sets a worker's effort from its route.

## Needs and limits

- It asks to read the prompts you type for directives, change the model of subagents the lead starts, start background
  workers on other routes, add `delegate_task`, read providers' rate-limit updates, show warnings, run timers and
  keep its state. The capabilities are `input`, `agents`, `model`, `tools`, `threads`, `terminal`, `events`,
  `lifecycle`, `inventory` and `store` (see
  [Trust and permissions](../../../docs/trust-and-permissions.md#what-a-mod-can-do)).
- A model from another provider needs that provider set up, for example `omd_claude_cli` with `/claude login`. See
  [Use other providers](../../../docs/use-other-providers.md).
- A skipped model (see [Routing health](#routing-health)) tries `fallback_models` in order, then the lead's model. A model
  that matches nothing runs on the lead's model. Either way a warning shows above the prompt and in the transcript.
- A subagent on another provider is allowed to run like any helper agent on that provider's route. It counts against
  `worker_limits` in `host.json`, by default 60 requests and 30 minutes per subagent (`omd_claude_cli` setup raises
  them to 300 requests and a day). If it isn't allowed to run, its requests are refused.
- `delegate_task` reaches another provider through its lead route (for example `omd_claude_cli`'s Claude routes) or a
  granted worker route. An OpenAI lead route isn't a delegate target.
- A `use ... as subagents` directive whose model isn't available isn't kept, and a warning names it. An unmatched
  `@name for role` is ignored silently.
- Routed `spawn_agent` subagents keep the lead's tools, permissions and approvals. `delegate_task` workers are
  read-only or worktree-only, and children on another provider lose web search.
- Earlier reasoning and compaction summaries from the lead aren't sent to a subagent on another provider.
- A Claude lead's subagent on a GPT model runs on the provider the session started on, with its own sign-in. A Claude
  subagent's own GPT subagent needs an OpenAI lead route in `host.json`. Without one it's refused.

## More

- [`omd_claude_cli`](../omd_claude_cli/README.md)
- [Included mods](../../../docs/collection.md)
- [Agents reference](../../reference/agents.md)
