# omd_plan_removal

Removes Codex plan mode, so there is no `/plan` and no Plan mode to switch into. It's on by default in OMD+. OMD Core
doesn't include it.

## Turn it off

To get plan mode back, turn it off in `/mods`, or run:

```sh
omd-package mod disable omd_plan_removal
```

[Manage mods](../../../docs/manage-mods.md) covers the other ways to turn mods on and off.

## Use it

Nothing to run. `/plan` is gone, and `Shift+Tab` no longer cycles into Plan mode.

## Settings

It has no settings.

## Needs and limits

- Clients no longer see Plan. A request for it, or a thread that already holds it such as an old plan-mode session,
  runs in the default mode with a warning.
- `request_user_input` isn't offered unless the default mode is allowed to use it.
- Permissions, approvals and your session data are unchanged.
- Changes apply at the next turn. Turning the mod off brings plan mode back then.

## More

- [Included mods](../../../docs/collection.md)
