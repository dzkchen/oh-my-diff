# omd_subagent_router

Runs subagents on the model you name, including another provider's, such as Claude subagents under a GPT lead, and adds a `delegate_task` tool for background workers.

## Turn it on

It comes with OMD+ but starts off. Turn it on in `/mods`, or run:

```sh
omd-package mod enable omd_subagent_router
```

A model from another provider also needs that provider set up, for example `omd_claude_cli` with `/claude login`.

## Use it

Say which model subagents should use, in any prompt:

| You write | Subagents it affects |
| --- | --- |
| `use sonnet 5.5 as subagents to research` | research subagents |
| `use opus with high effort as subagents for review` | review subagents, at high effort |
| `@opus for review` | review subagents |
| `use gpt-6.1-sol as subagents` | every subagent |
| `use the lead model as subagents for review` | review subagents go back to the lead's model |

A directive lasts for the rest of the conversation, and a later one for the same role replaces it. Words match
model names loosely: `sonnet 5.5` finds `claude-sonnet-5-5`.

A subagent counts as research when the lead spawns an `explorer` or its task mentions researching, investigating or
exploring; as review when it mentions reviewing, auditing or verifying; as a worker when it mentions implementing,
fixing or editing. A subagent whose task can't be read this way, as with GPT-6.1 models whose spawn tool seals the
task, follows your only role directive when you gave exactly one. When the lead picks an available model itself,
that choice stands.

The agent's tool row shows the model it runs on, and `/status` lists each subagent with its model, tokens and cost.

## Delegate tasks

The model also gets a `delegate_task` tool (found through `tool_search`). Native `spawn_agent` stays the choice for
same-provider work that finishes within the turn; `delegate_task` is for another provider's model, an isolated
worktree, or work that outlives the turn.

| `action` | What it does |
| --- | --- |
| `start` | Runs `task` as a background worker. `role` is `research`, `review`, `worker` or `general`; `model` defaults to the role's setting; `isolation` is `shared` (read-only workspace and tools) or `worktree`; `mode` is `async` (default) or `wait` (up to `timeout_ms`, 30 to 120 s in 30 s steps); a repeated `request_id` (up to 128 characters) returns the existing task whatever the other fields say |
| `status` | Reports a task by `handle`, or lists them all |
| `cancel` | Stops a task, or discards a finished worktree result |
| `integrate` | Applies a finished `worktree` task's changes to the workspace; `status` lists its `changed_paths` and `candidate_sha256` |
| `targets` | Lists routes with their model, provider, health, and why one is skipped |

A task runs on a worker route from `host.json` (a role `worker` route with a grant, or a lead route of a provider
such as `omd_claude_cli`; either open to this mod) and has only the permissions the host gives it. On a provider's lead
route it can run any model of that provider's catalog (`model: claude-sonnet-5-5` on the `claude` route); `targets`
lists those models. When it finishes, the result is saved and, about 1.5 s later, one queued prompt
wakes the lead with the results of everything that finished in that window (up to 5 KiB inlined; larger results are
named for `status`), each result as a JSON string followed by a warning that it is untrusted. A result you read with
`status` or `wait` first removes its pending wake. If the wake can't be queued, a notice says why and it is retried a
few times; after that, or when the `autonomous` grant is gone, the running text tells the model to poll with `status`.
A worker keeps going after the turn ends but not after the session. A finished `worktree` task holds one of the host's
16 agent slots until you `integrate` or `cancel` it; the mod keeps its 12 newest tasks, dropping read ones first.

## Routing health

For `delegate_task` and for subagents the mod routes by directive or setting, a target is skipped when its route isn't available, when its
provider's latest usage window (from `account/rateLimits/updated`, which Claude sends after a Claude request) is at
90% or more, or when a task on that provider failed for authorization, rate limit or allowance in the last 15
minutes. Windows and failures are kept in the mod's user store, so every thread sees them; a window with no reset
time stops counting after an hour. The task or subagent then runs on `fallback_model`, else the lead's model, with a
notice naming every skipped route and why. With no usable route left, `delegate_task` refuses and lists them.
A subagent model the lead picked itself, and models on the built-in OpenAI provider, skip these checks.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `research_model`, `review_model`, `worker_model` | empty | The model for that role when no directive names one. Empty keeps the lead's model. |
| `research_effort`, `review_effort`, `worker_effort` | empty | The reasoning effort for that role. Empty keeps the lead's effort when the model supports it, else the model's default; an effort the model lacks is ignored. `delegate_task` ignores it: the host sets a worker's effort from its route. |
| `fallback_model` | empty | The model to use when the chosen one is skipped. Empty keeps the lead's model. |

## Needs and limits

- If no model matches, or the model's provider has no usable route, the subagent runs on the lead's model and a
  warning shows above the prompt and in the transcript.
- A subagent on another provider is admitted like any helper agent on that provider's route: it counts against
  `worker_limits` in `host.json` (by default 60 requests and 30 minutes per subagent; `omd_claude_cli` setup raises
  them to 300 requests and a day), and if it can't be admitted its requests are refused.
- `delegate_task` reaches another provider through its lead route (for example `omd_claude_cli`'s Claude routes) or a
  granted worker route; an OpenAI lead route is not a delegate target.
- Turning it on asks for the `autonomous` grant, to queue the wake prompt (at most 4 queued, 20 turns).
- A directive whose model isn't available is not kept: a warning names it when you submit the prompt.
- It changes only which model subagents use. The subagent's tools, permissions and approvals stay those of the lead.
- Earlier reasoning and compaction summaries from the lead aren't sent to a subagent on another provider.
- GPT-6.1 leads seal the task they give a subagent; another provider can't read it, so that subagent works from the
  conversation it inherits and its agent name (such as `/root/readme_research`).
- A Claude lead's subagent on a GPT model runs on the provider the session started on, with its own sign-in. A Claude
  subagent's own GPT subagent needs an OpenAI lead route in `host.json`; without one it is refused.
