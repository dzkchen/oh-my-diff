# omd_subagent_router

Runs subagents on the model you name, including another provider's, such as Claude subagents under a GPT lead.

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

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `research_model`, `review_model`, `worker_model` | empty | The model for that role when no directive names one. Empty keeps the lead's model. |
| `research_effort`, `review_effort`, `worker_effort` | empty | The reasoning effort for that role. Empty keeps the lead's effort when the model supports it, else the model's default; an effort the model lacks is ignored. |

## Needs and limits

- If no model matches, or the model's provider has no usable route, the subagent runs on the lead's model and a
  warning shows above the prompt and in the transcript.
- A subagent on another provider is admitted like any helper agent on that provider's route: it counts against
  `worker_limits` in `host.json` (by default 60 requests and 30 minutes per subagent; `omd_claude_cli` setup raises
  them to 300 requests and a day), and if it can't be admitted its requests are refused.
- A directive whose model isn't available is not kept: a warning names it when you submit the prompt.
- It changes only which model subagents use. The subagent's tools, permissions and approvals stay those of the lead.
- Earlier reasoning and compaction summaries from the lead aren't sent to a subagent on another provider.
- GPT-6.1 leads seal the task they give a subagent; another provider can't read it, so that subagent works from the
  conversation it inherits and its agent name (such as `/root/readme_research`).
- A Claude lead's subagent on a GPT model runs on the provider the session started on, with its own sign-in. A Claude
  subagent's own GPT subagent needs an OpenAI lead route in `host.json`; without one it is refused.
