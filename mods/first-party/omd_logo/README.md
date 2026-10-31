# omd_logo

Shows the OMD logo when a session starts, with the OMD version, your install profile (OMD+ or OMD Core), the Codex
version and the mod count. It also adds the install profile to the session title. It's on by default in OMD+ and OMD
Core.

## Turn it off

`/mods` can't turn it off, because OMD requires it. Turn it off from a shell:

```sh
omd mods disable omd_logo
```

[Manage mods](../../../docs/manage-mods.md) covers the other ways to turn a mod on or off.

## Use it

Nothing to run. The logo appears on a fresh session and goes away when your first message is accepted. Resumed
sessions don't show it.

## Settings

Change settings in `/mods`.

| Setting | Default | What it does |
| --- | --- | --- |
| `icons` | `unicode` | `unicode` draws the full logo. `ascii` uses plain characters. |

## Needs and limits

- On narrow terminals the logo gets smaller, with the OMD version and install profile under it, one per line when
  they don't fit on one. Below 15 columns it shows only `OMD`.
- It is skipped when there is no room, and in inline or raw output.
- Turning the mod off brings back the standard Codex heading.

## More

- [Included mods](../../../docs/collection.md)
- [Startup presentation](../../reference/layout-and-styling.md#startup-presentation-terminal_welcome_v1) in the mod API
  reference
