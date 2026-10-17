# omd_mods

Adds `/mods`, a screen to turn mods on or off, change their settings and install new ones.

## Turn it off

It is on by default in OMD+ and OMD Core. Turn it off with `omd-package mod disable omd_mods`. `/omd` stays available if `/mods` breaks.

## Use it

| Command or key | What it does |
| --- | --- |
| `/mods` | Open the screen. Mods are listed as Failed, On and Off. |
| Up and Down | Move through the list. |
| Space or Enter | Turn the highlighted mod on or off. |
| Tab | Reach the filter, settings, Browse and Add from source. |
| Esc | Close the screen. |
| `/mods ACTION MOD` | Run an action without the screen. Actions are `enable`, `disable`, `update`, `rollback`, `remove` and `trust`. |
| `/mods reload` | Reload the list. |
| `/mods apply` or `/mods cancel` | Confirm or drop a pending action. |

Browse searches the mod directory. Add from source takes `npm:NAME[@VERSION]`, `git+URL[#REF]`, an absolute folder or a directory id.

## Needs and limits

- Turning a mod on asks for approval and lists any new permissions.
- Every install is reviewed and starts off.
- A mod's commands work at once. Its other behavior starts with your next message.
- On a fresh session it also shows a short getting-started card.
