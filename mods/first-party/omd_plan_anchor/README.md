# omd_plan_anchor

Keeps the agent's current plan near the end of its context in long runs, without breaking the provider's prompt
cache. It's experimental, and neither OMD+ nor OMD Core installs it.

## Turn it on

```sh
omd install omd_plan_anchor
omd mods enable omd_plan_anchor
```

It needs no authority grant. Turn it on in the shell or `/mods` before a `codex exec` run: a headless run can't show the trust dialog, so a mod that
isn't trusted yet stays off.

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
result is tried instead. A rejected `update_plan` call keeps the previous plan.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `every` | `8` | Tool calls after the plan was last shown before it is repeated (2 to 50) |

## Needs and limits

- Capabilities `interception` and `store`. It turns on Codex's `update_plan` tool.
- Models that don't get `update_plan` by default (gpt-6.1-sol in Codex 0.166) get it added to their tool list, so a
  new thread's first request no longer matches Codex's shared cached prefix and pays for about 12K more uncached
  input tokens.
- The reminder is part of the tool result, so it is recorded in the conversation and later requests reuse the cached
  prefix. A request section can't do this: inserted sections join an early context message and would change the
  cached prefix every time the plan changes.
- Only the model's own calls get the reminder; code-mode cells don't. Each thread keeps its own plan.
