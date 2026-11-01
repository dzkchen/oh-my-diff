# omd_plan_anchor

Keeps the agent's current plan near the end of its context in long runs, without breaking the provider's prompt
cache.

## Use it

After the agent writes a plan with Codex's `update_plan` tool, every 8th tool result (counted since the plan was last
written or shown) ends with its open steps:

```text
[omd_plan_anchor: current plan, 1/3 done; call update_plan when it changes]
- [>] Fix the parser
- [ ] Run the suite
```

Completed steps are counted, not listed, and at most 8 open steps are shown. Nothing is added when there is no plan
or every step is completed.

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
- Only the model's own calls get the reminder; code-mode cells don't. Plans are kept per thread for the 32 most
  recent threads.
