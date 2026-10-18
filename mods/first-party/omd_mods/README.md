# omd_mods

Adds `/mods`, a screen to turn mods on or off, change their settings and install new ones.

## Turn it off

It is on by default in OMD+ and OMD Core. Turn it off with `omd-package mod disable omd_mods`. `/omd` stays available if `/mods` breaks.

## Use it

| Command or key | What it does |
| --- | --- |
| `/mods` | Open the panel where `/config` lives. Installed lists your mods as switches, Settings opens one mod's own panel and Directory installs new ones. |
| Up and Down | Move through the list; held keys repeat. |
| Left and Right | Switch tabs. |
| Space or Enter | Turn the highlighted mod on or off, change a setting or run an action. |
| `/` | Search every tab as you type; Esc clears the search. |
| Esc | Close the panel, or go back from a mod's own panel. |
| `/mods MOD` | Open one mod's panel: its settings, Update, Roll back and Remove. |
| `/mods ACTION MOD` | Run an action without the panel. Actions are `enable`, `disable`, `update`, `rollback`, `remove` and `trust`. |
| `/mods reload` | Reload every mod. |
| `/mods apply` or `/mods cancel` | Confirm or drop a pending action. |

Add from source, in Directory, takes `npm:NAME[@VERSION]`, `git+URL[#REF]`, an absolute folder or a directory id; a
directory entry installs its newest available version. Install for picks your user store or this project.

## Needs and limits

- Turning a mod on asks for approval and lists any new permissions.
- Every install is reviewed and starts off.
- A mod's commands work at once. Its other behavior starts with your next message.
- On a fresh session it also shows a short getting-started card.
