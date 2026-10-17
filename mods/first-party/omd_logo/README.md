# omd_logo

Shows the OMD mark and your install profile when a session starts.

## Turn it off

It is on by default in OMD+ and OMD Core. Turn it off in `/mods`, or run:

```sh
omd-package mod disable omd_logo
```

## Use it

Nothing to run. The mark appears on a fresh session and goes away when your first message is accepted. Resumed sessions don't show it.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `icons` | `unicode` | Use `ascii` for a plain-text mark. |

## Needs and limits

- The mark gets smaller on narrow terminals and shows `OMD` below 15 columns.
- It is skipped when there is no room, and in inline or raw output.
- Turning the mod off brings back the standard Codex heading.
