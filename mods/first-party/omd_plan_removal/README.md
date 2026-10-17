# omd_plan_removal

Removes Codex plan mode, so there is no `/plan` and no Plan mode to switch into.

## Turn it off

It is on by default in OMD+. To get plan mode back, turn it off in `/mods`, or run:

```sh
omd-package mod disable omd_plan_removal
```

## Use it

Nothing to run. `/plan` is gone, and Shift+Tab no longer cycles into Plan mode.

## Needs and limits

- A thread that asks for plan mode, such as an old plan-mode session, runs in the default mode with a warning.
- Permissions, approvals and your session data are unchanged.
- Changes apply at the next turn. Turning the mod off brings plan mode back then.
- OMD Core doesn't include it, but you can install it yourself.
