# omd_inspector

Shows a summary of your session: whether OMD is running it, the install profile, mod counts, the workflow contract
(the task checks [`omd_workflow`](../omd_workflow/README.md) enforces), task and worker limits, and paid API cost. It's
on by default in OMD+. OMD Core doesn't include it.

## Turn it off

Turn it off in `/mods`, or run:

```sh
omd mods disable omd_inspector
```

[Manage mods](../../../docs/manage-mods.md) covers the other ways to turn a mod on or off.

## Use it

| Command or key | What it does |
| --- | --- |
| `/inspect` | Open the inspector. Run it again to refresh. |
| `/inspect close` or `Alt+i` | Close it. |

For example, run `/inspect` after turning on a mod in `/mods` to check the new mod count.

## Settings

It has no settings.

## Needs and limits

- When live task and contract status are unavailable, the inspector says so instead.
- Resuming a session closes the inspector.

## More

- [Included mods](../../../docs/collection.md)
- [Terminal UI](../../reference/terminal-ui.md) in the mod API reference
