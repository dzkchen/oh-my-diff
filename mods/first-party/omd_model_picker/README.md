# omd_model_picker

Shows the `/model` and reasoning-effort pickers as compact lists with your current choice marked. It's on by default
in OMD+. OMD Core doesn't include it.

## Turn it off

Turn it off in `/mods`, or run:

```sh
omd-package mod disable omd_model_picker
```

[Manage mods](../../../docs/manage-mods.md) covers the other ways to turn a mod on or off.

## Use it

Open `/model` as usual. Selection and keys work as before. With `omd_profiles` on, the model list also shows up to 4
of your account profiles (ChatGPT accounts, API keys and providers). `/profile` lists all of them, and
`/profile use NAME` switches to one.

## Settings

Change settings in `/mods`.

| Setting | Default | What it does |
| --- | --- | --- |
| `layout` | `compact` | `compact` redraws the model and effort pickers. `native` leaves them as Codex draws them. |
| `brand` | `oh my diff` | Text before the picker title. Empty hides it. |

## Needs and limits

- With `layout` set to `native`, no account profiles are shown in `/model`.

## More

- [Included mods](../../../docs/collection.md)
- [`omd_profiles`](../omd_profiles/README.md) for accounts and providers
- [Terminal identity](../../reference/terminal-operations.md#terminal-identity-terminal_identity_v1) and
  [rich lines](../../reference/layout-and-styling.md#rich-lines-terminal_rich_line_v1) in the mod API reference
