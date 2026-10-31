# omd_mods

Adds `/mods`, a screen to turn mods on or off, change their settings and install new ones.

## Turn it off

It is on by default in OMD+ and OMD Core. `/mods` cannot turn itself off or remove itself; use `/omd` or `omd mods disable omd_mods`. `/omd` stays available if `/mods` breaks.

## Use it

| Command or key | What it does |
| --- | --- |
| `/mods` | Open the panel where `/config` lives. All lists your mods as switches grouped into Needs attention, On, Off and Available, with counts; Settings opens one mod's own panel and Directory installs from a source or updates. It reopens on the mod and search you last used. |
| Up and Down | Move through the list; held keys repeat. |
| A letter, `g`, `G`, PgUp, PgDn | Jump to the next mod with that initial, the top, the bottom or a page. |
| Left and Right | Switch tabs. |
| Space or Enter | Turn the highlighted mod on or off, change a setting or run an action; on a group header, collapse or expand it. |
| `/` | Fuzzy-search names, ids, descriptions and command names across every tab; Esc clears the search. The line below the list shows the highlighted mod's state and commands. |
| Esc | Close the panel, or go back from a mod's own panel. |
| `/mods MOD` | Open one mod's panel: its settings, Update, Roll back and Remove. |
| `/mods ACTION MOD` | Run an action without the panel. Actions are `enable`, `disable`, `update`, `rollback`, `remove` and `trust`. |
| `/mods reload` | Reload every mod. |
| `/mods apply` or `/mods cancel` | Confirm or drop a pending action. |

Add from source, in Directory, takes `npm:NAME[@VERSION]`, `git+URL[#REF]`, an absolute folder or a directory id; a
directory entry installs its newest available version. A mod that is already installed is updated from its own panel instead. Install for picks your user store or this project.

## Needs and limits

- Turning a mod on asks for approval and lists any new permissions.
- Every install is reviewed and starts off.
- A mod's commands work at once. Its other behavior starts with your next message.
- On a fresh session it also shows a short getting-started card.
