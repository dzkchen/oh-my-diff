# omd_mods

Adds `/mods`, a screen to turn mods on or off, change their settings and install new ones. It's on by default in OMD+
and OMD Core.

## Turn it off

`/mods`, and `/omd` (the backup on/off screen for when `/mods` breaks), can't turn off or remove the three mods OMD
requires: `omd_mods`, `omd_logo` and `omd_update`. Only a shell command can:

```sh
omd mods disable omd_mods
```

[Manage mods](../../../docs/manage-mods.md) covers the other ways to turn a mod on or off.

## Use it

| Command or key | What it does |
| --- | --- |
| `/mods` | Open the mods panel, in the same place as `/config`. It reopens on the mod and search you last used. |
| `Up` and `Down` | Move through the list; held keys repeat. |
| A letter, `g`, `G`, `PgUp`, `PgDn` | Jump to the next mod with that initial, the top, the bottom or a page. |
| `Left` and `Right` | Switch tabs. |
| `Space` or `Enter` | Turn the highlighted mod on or off, change a setting or run an action; on a group header, collapse or expand it. |
| `/` | Fuzzy-search names, ids, descriptions and command names across every tab; `Esc` clears the search. The line below the list shows the highlighted mod's state and commands. |
| `Esc` | Close the panel, or go back from a mod's own panel. |
| `/mods MOD` | Open one mod's panel: its settings, Update, Roll back and Remove. |
| `/mods ACTION MOD` | Run an action without the panel. Actions are `enable`, `disable`, `update`, `rollback`, `remove` and `trust`. |
| `/mods reload` | Reload every mod. |
| `/mods apply` or `/mods cancel` | Confirm or drop a pending action. |

The panel's tabs:

- All lists your mods as switches, grouped into Needs attention, On, Off and Available, with counts.
- Settings opens one mod's own panel.
- Directory installs from a source or updates.

For example, `/mods enable omd_frecency` turns on `omd_frecency` without opening the panel, after you approve
its permissions.

In Directory, Add from source takes `npm:NAME[@VERSION]`, `git+URL#TAG`, an absolute folder or a directory id. A
directory entry installs its newest available version. To update a mod that's already installed, use its own panel
instead. The Install for option picks your user store or this project.

A mod setting that picks a model route lists the worker routes open to that mod and the routes of connected
providers whose model is available now. Below it, Choose a model lists the ChatGPT models on your plan with their
reasoning efforts, and Add a helper model uses the model you're chatting with. Either asks before adding a helper route
on your ChatGPT plan for that mod. When the mod skips runs on the lead's model (`skip_same_model`, on by default in
Advisor), the chooser says so and marks the lead's model.

On a fresh session it also shows a short welcome card.

## Settings

It has no settings.

## Needs and limits

- Turning a mod on asks for approval and lists any new permissions.
- Choose a model reads the ChatGPT model list (`routes.models`, under `packages`) and the conversation's model
  (`session.info`, under `inventory`).
- Every install is reviewed and starts off.
- A mod's commands work at once. Its other behavior starts with your next message.

## More

- [Manage mods](../../../docs/manage-mods.md)
- [Included mods](../../../docs/collection.md)
- [Packaging](../../reference/packaging.md) in the mod API reference

Trust previews warn when an ID is already installed in another scope: same-ID copies share storage and owned credential authority.

## Terminal choices and saved defaults

Ordinary on/off switches and setting edits in `/mods` and native `/omd` affect this terminal only.
They survive conversation changes and mod reloads, and disappear when the terminal host exits.
Another terminal, including one on the same conversation, starts from shared defaults. Reconnecting the
same attached terminal retains its choices while its host is alive; children start from defaults.

Use **Reset to defaults** to clear local enablement and settings choices and inherit the latest shared values.
Use **Save as defaults** explicitly to persist your choices for future launches and terminals inheriting defaults.
Shared changes do not replace valid local overrides. Shell `omd mods` commands change shared configuration.
Install, update, remove, rollback and trust are always shared. Policy and trust still apply: local choices cannot
grant permissions, undo revocation or revive removed packages. Source, schema and authority changes invalidate
or revalidate overrides. Mod data and credentials are separate from terminal configuration.

When user and project copies have the same mod ID, settings edits apply to the selected copy and its schema.
