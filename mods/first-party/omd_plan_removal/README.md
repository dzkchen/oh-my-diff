# omd_plan_removal

Removes Codex's plan mode, so there's no `/plan` command and `Shift+Tab` can't switch into plan mode.
It's experimental, and no install profile includes it.

## Turn it on

Install it from the Available group in `/mods`, or run:

```sh
omd install omd_plan_removal
omd mods enable omd_plan_removal
```

[Manage mods](../../../docs/manage-mods.md) covers the other ways to install and turn on a mod.

## Use it

Nothing to run. `/plan` is gone, and `Shift+Tab` no longer cycles into plan mode.

## Settings

It has no settings.

## Needs and limits

- Clients that connect to Codex no longer see plan mode. A request for plan mode, or an old session that was in plan
  mode, runs in the default mode and shows a warning.
- The agent's question tool (`request_user_input`) stays in the tool list, so the shared prompt cache still hits, but
  a call is refused unless the default mode is allowed to ask.
- Permissions, approvals and your session data are unchanged.
- Changes apply at the next turn. Turning the mod off brings plan mode back then.

## More

- [Included mods](../../../docs/collection.md)
