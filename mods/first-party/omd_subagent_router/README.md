# omd_subagent_router

Runs subagents on the model you name, including another provider's, such as Claude subagents under a GPT lead, and adds a `delegate_task` tool for background workers.

## Turn it on

It comes with OMD+ but starts off. Turn it on in `/mods`, or run:

```sh
omd mods enable omd_subagent_router
```

A model from another provider also needs that provider set up, for example `omd_claude_cli` with `/claude login`.

## Use it

Say which model subagents should use, in any prompt you type (queued prompts from mods are ignored):

| You write | Subagents it affects |
| --- | --- |
| `use sonnet 5.5 as subagents to research` | research subagents |
| `use opus with high effort as subagents for review` | review subagents, at high effort |
| `@opus for review` | review subagents |
| `use gpt-6.1-sol as subagents` | every subagent |
| `use the lead model as subagents for review` | review subagents go back to the lead's model |

A directive lasts for the rest of the conversation, and a later one for the same role replaces it. Words match
model names loosely: `sonnet 5.5` finds `claude-sonnet-5-5`.

A subagent's role comes from its definition (`explorer` is research, `worker` is worker) or from words in its task,
matched by prefix and checked in the order review (review, audit, critique, verif), research (research, investigat,
explor, look up, look into, find out, survey) then worker (implement, write, edit, fix, build, code, work). GPT-6.1 models seal the task they give
a subagent, so the router can't read it and another provider's model can't either: that subagent follows your only
role directive when you gave exactly one, and works from the conversation it inherits and its agent name (such as
`/root/readme_research`). When the lead picks an available model itself, that choice stands.

The agent's tool row shows the model it runs on, and `/status` lists each subagent with its model, tokens and cost.

## Delegate tasks

The model also gets a `delegate_task` tool (found through `tool_search`). Use native `spawn_agent` for same-provider
work. Use `delegate_task` for another provider's model through a worker route, for a worktree, or for a task the lead
polls or integrates itself.

| `action` | What it does |
| --- | --- |
| `start` | Runs `task` as a background worker. `role` is `research`, `review`, `worker` or `general`; `model` defaults to the role's directive or setting; `isolation` is `shared` (read-only workspace and tools) or `worktree`; `mode` is `async` (default) or `wait` (one wait of up to 30 s, then it returns running); a repeated `request_id` (up to 128 characters) returns the existing task whatever the other fields say |
| `status` | Reports a task by `handle`, or lists them all |
| `cancel` | Stops a task, or discards a finished worktree result |
| `integrate` | Applies a finished `worktree` task's changes to the workspace; `status` lists its `changed_paths` and `candidate_sha256` |
| `targets` | Lists routes with their model, provider, health, and why one is skipped |

A task runs on a worker route from `host.json` (a role `worker` route with a grant, or a lead route of a provider
such as `omd_claude_cli`; either open to this mod) and has only the permissions the host gives it. On a provider's lead
route it can run any model of that provider's catalog (`model: claude-sonnet-5-5` on the `claude` route); `targets`
lists those models.

- A finished task wakes the lead (about 1.5 s later, batched). Results over 5 KiB are named for `status` rather than
  inlined; each result is untrusted subagent output.
- A stored result is at most 8 KiB; a longer one ends with a truncation marker.
- A worker keeps going after the turn ends but not after the session. A finished `worktree` task holds one of the
  host's agent slots until you `integrate` or `cancel` it. Running tasks share `limits.concurrent_workers` in
  `host.json` with other subagents.
- The mod keeps its 12 newest tasks, dropping read ones first.

## Routing health

For `delegate_task` and for subagents the router routes (a model the lead named itself is kept unchecked), a target
is skipped when its route isn't available, when its provider's latest usage window (from `account/rateLimits/updated`, which Claude sends after a Claude request) is at
90% or more, or when a task on that provider failed for authorization, rate limit or allowance in the last 15
minutes. Windows and failures are kept in the mod's user store, so every thread sees them; a window with no reset
time stops counting after an hour. The task or subagent then runs on `fallback_model`, else the lead's model, with a
notice naming every skipped route and why. With no usable route left, `delegate_task` refuses and lists them.
A subagent model the lead picked itself, and models on the built-in OpenAI provider, skip these checks.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `research_model`, `review_model`, `worker_model` | empty | The model for that role when no directive names one. Empty keeps the lead's model. |
| `research_effort`, `review_effort`, `worker_effort` | empty | The reasoning effort for that role; it applies only together with that role's `*_model` setting (a directive for the role replaces both). Empty uses the effort the lead put in the spawn call if the model supports it, else the model's default; an effort the model lacks is ignored. `delegate_task` ignores it: the host sets a worker's effort from its route. |
| `fallback_model` | empty | The model to try first when the chosen one is skipped, before the lead's model. Empty goes straight to the lead's model. |

## Needs and limits

- A skipped model (see Routing health) tries `fallback_model` first, then the lead's model; a model that matches
  nothing runs on the lead's model. Either way a warning shows above the prompt and in the transcript.
- A subagent on another provider is admitted like any helper agent on that provider's route: it counts against
  `worker_limits` in `host.json` (by default 60 requests and 30 minutes per subagent; `omd_claude_cli` setup raises
  them to 300 requests and a day), and if it can't be admitted its requests are refused.
- `delegate_task` reaches another provider through its lead route (for example `omd_claude_cli`'s Claude routes) or a
  granted worker route; an OpenAI lead route is not a delegate target.
- Turning it on asks for the `autonomous` grant, to queue the wake prompt (at most 4 queued, 20 turns).
- A `use ... as subagents` directive whose model isn't available is not kept and a warning names it; an unmatched
  `@name for role` is ignored silently.
- Routed `spawn_agent` subagents keep the lead's tools, permissions and approvals. `delegate_task` workers are
  read-only or worktree-only, and children on another provider lose web search.
- Earlier reasoning and compaction summaries from the lead aren't sent to a subagent on another provider.
- A Claude lead's subagent on a GPT model runs on the provider the session started on, with its own sign-in. A Claude
  subagent's own GPT subagent needs an OpenAI lead route in `host.json`; without one it is refused.
