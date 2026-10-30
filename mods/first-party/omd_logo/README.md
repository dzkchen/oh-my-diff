# omd_logo

Shows the OMD mark, the OMD version, your install profile (OMD+ or OMD Core), the Codex version and the mod count when
a session starts, and adds the profile to the session title. It's on by default in OMD+ and OMD Core.

## Turn it off

`/mods` keeps it on, because OMD requires it. To turn it off, run:

```sh
omd-package mod disable omd_logo
```

[Manage mods](../../../docs/manage-mods.md) covers the other ways to turn a mod on or off.

## Use it

Nothing to run. The mark appears on a fresh session and goes away when your first message is accepted. Resumed
sessions don't show it.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `icons` | `unicode` | `unicode` draws the full mark. `ascii` uses plain characters. |

## Needs and limits

- The mark gets smaller on narrow terminals, with the OMD version and profile under it (one per line when they don't
  fit on one), and shows `OMD` below 15 columns.
- It is skipped when there is no room, and in inline or raw output.
- Turning the mod off brings back the standard Codex heading.

## More

- [Included mods](../../../docs/collection.md)
- [Startup presentation](../../reference/layout-and-styling.md#startup-presentation-terminal_welcome_v1) in the mod API
  reference
