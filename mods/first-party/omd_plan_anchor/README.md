# omd_plan_anchor

Keeps the agent's current plan near the end of its context in long runs. It's experimental, and no install profile
includes it.

## Turn it on

```sh
omd install omd_plan_anchor
omd mods enable omd_plan_anchor
```

It needs no authority grant. Turn it on in the shell or `/mods` before a `codex exec` run: a headless run can't show
the trust dialog, so a mod that isn't trusted yet stays off.

## Use it

After the agent writes a plan with Codex's `update_plan` tool, every 8th tool result (counted since the plan was last
written or shown) ends with its open steps:

```text
[omd_plan_anchor: current plan, 1/3 done; call update_plan when it changes]
- [>] Fix the parser
- [ ] Run the suite
```

Completed steps are counted, not listed, and at most 8 open steps are shown. Nothing is added when there is no plan
or every step is completed. A result that was truncated or is over 200,000 characters gets no reminder and the next
result is tried instead. A rejected `update_plan` call keeps the previous plan, and each new turn starts with no
plan, so an old task's steps are never repeated.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `every` | `8` | Tool calls after the plan was last shown before it is repeated (2 to 50) |

## Needs and limits

- It acts only when the session offers Codex's `update_plan` tool, which Codex 0.167 leaves off: turn on
  [`omd_plan_panel`](../omd_plan_panel/README.md) (or `[tools.update_plan] enabled = true` in `config.toml`). Either
  changes the tool list, so each new thread's first request misses the prompt cache stock Codex requests share (about
  12K uncached input tokens). The mod doesn't add the tool itself for that reason.
- Capabilities `interception`, `lifecycle` and `store`.
- The reminder is part of the tool result, so it is recorded in the conversation and later requests reuse the cached
  prefix. A request section would instead join an early context message and change the cached prefix every time the
  plan changes.
- Only the model's own calls get the reminder; code-mode cells don't. Each thread keeps its own plan.
