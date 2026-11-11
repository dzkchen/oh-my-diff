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
| `/mods ACTION MOD` | Run an action without the panel. Actions are `enable`, `disable`, `toggle`, `update`, `rollback`, `remove` and `trust`. |
| `/mods install SOURCE` | Review installing `npm:NAME[@VERSION]`, `git+URL#TAG`, an absolute folder or a directory id. |
| `/mods plugin MARKETPLACE/PLUGIN` | Review turning on the mod component of a Codex plugin you added, such as `oh-my-diff/omd-anchored-edit`. One approval installs and turns it on. |
| `/mods scope user` or `/mods scope project` | Choose where `/mods install` and Directory installs go: your user store or this project. |
| `/mods reload` | Reload every mod. |
| `/mods apply` or `/mods cancel` | Confirm or drop a pending action. |

The panel's tabs:

- All lists your mods as switches, grouped into Needs attention, On, Off and Available, with counts. A mod that's off
  still shows the commands and keys it adds, and experimental mods are marked. Available holds directory mods you
  haven't installed and the mod components of Codex plugins you added.
- Settings opens one mod's panel, with its On switch followed by its settings. Edit a list of words as
  comma-separated text (or as a JSON list when an entry contains a comma). Edit objects and lists of objects as JSON.
  **Changes apply to**, below the settings, chooses every terminal or only this one. Only the active copy's settings
  can change. A disabled copy, or a user or project copy overridden by another scope, shows the reason instead.
- Directory installs from a source or updates.

For example, `/mods enable omd_frecency` turns on `omd_frecency` without opening the panel, after you approve
its permissions.

When the same id is installed both for you and for this project, a typed command asks which one you mean: write
`user:ID` or `project:ID`.

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
- A mod whose permissions were revoked, or that asks for new ones, shows as needs approval. Review it from a shell
  with `omd mods update ID`.
- Choose a model reads the ChatGPT model list (`routes.models`, under `packages`) and the conversation's model
  (`session.info`, under `inventory`).
- Every install is reviewed and starts off.
- A mod's commands work at once. Its other behavior starts with your next message.

Trust previews warn when an ID is already installed in another scope: same-ID copies share storage and owned credential
authority.

## More

- [Manage mods](../../../docs/manage-mods.md)
- [Included mods](../../../docs/collection.md)
- [Packaging](../../reference/packaging.md) in the mod API reference

## Terminal choices and saved settings

By default, switches and setting edits save for every terminal. In a mod's panel, set **Changes apply to** to
**Only this terminal** to keep changes in that terminal until you close it. If the terminal already has choices for
the mod, its panel opens on **Only this terminal** until you pick **Every terminal**. The list marks it "only this
terminal".

The panel also offers **Use saved settings** and **Keep these for every terminal**. Each previews its changes and
asks before applying them. A mod the installer keeps on can't be turned off from the panel, but you can change its
settings. An administrator's mod shows its settings read-only.

When user and project copies have the same mod ID, settings edits apply to the selected copy and its schema.
