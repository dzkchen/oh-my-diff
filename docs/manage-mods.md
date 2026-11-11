# Manage mods

Open `/mods` in `codex` to find, install and manage mods, or use the shell commands below.
See [included mods](collection.md) for the OMD+ selection and [trust and permissions](trust-and-permissions.md)
for the access you grant when turning one on.

## Find a mod

In `codex`, type `/mods`. The All tab lists installed mods and, under Available, mods from the curated directory.
Experimental entries have not been fully tested; check their support status before trusting them.
Use Add from source in the Directory tab for npm, Git and folder sources.

From a shell:

```sh
omd mods catalog QUERY       # search the curated directory
omd mods inspect REFERENCE   # preview a mod without installing it
```

The curated directory lists OMD+ mods, experimental mods and three mods adapted from Claude Code:
`burn_meter`, `token_weather` and `blast_radius`. [Included mods](collection.md) describes each one.

## Install a mod

In `/mods`, pick a mod under Available, or use Add from source. From a shell, `omd install` takes a reference:

```sh
omd install burn_meter                                      # curated directory
omd install npm:@author/some-mod@1.2.3                      # npm
omd install 'git+https://github.com/author/repo#v1.2.3:mod' # Git tag and folder
omd install ./my-mod                                        # local folder
```

Each install shows the source, license and permissions and asks first. Installing doesn't turn the mod on.

OMD refuses a mod built for another API version (`incompatible_api`), and checks a curated download against its
pinned hash (see [how trust is bound](trust-and-permissions.md#installing-doesnt-turn-a-mod-on)).

To install for the current project instead of for you, add `--scope project` (the default is `--scope user`).

## Turn a mod on or off

In `codex`, use `/mods`. If `/mods` is broken, use the controls in `/omd`.

From a shell, use `omd mods enable ID` or `omd mods disable ID`. Enabling a mod shows its permissions and asks for
approval. For example, to turn on `omd_usage`, which comes with OMD+:

```sh
omd mods enable omd_usage
```

A change applies at your next message. `omd mods list` shows which mods are installed and on. Turning a mod off
keeps its data.

## Change a mod's settings

Open `/mods` in `codex` and pick the mod. Each mod's README in [`mods/first-party`](../mods/first-party) lists its
settings.

## Update, roll back or remove a mod

```sh
omd mods update burn_meter     # newest version, after showing what changes
omd mods rollback burn_meter   # the previous version
omd mods remove burn_meter     # uninstall; cache, state and local sources are kept
```

A mod installed from a folder runs from that folder, and an edit to the folder stops it until you review it again
(see [how trust is bound](trust-and-permissions.md#installing-doesnt-turn-a-mod-on)). To freeze a version, install a
Git tag or a package instead.

## Terminal choices and saved settings

By default, `/mods` and `/omd` save changes for every terminal, including future launches.
To change a mod in the current terminal only, set **Changes apply to** to **Only this terminal** in `/mods`,
or use the same row under **All mods…** in `/omd`. Forks and subagents started from that terminal inherit its
choices. The choices last until you close it.

If a mod already has settings for this terminal, its settings screen opens on **Only this terminal**.
Pick **Every terminal** to save the next change for all terminals.

When a terminal has its own choices, the mod shows **This terminal has its own choices** and offers two actions.
Each previews the changes and asks for approval:

- **Use saved settings** drops this terminal's choices.
- **Keep these for every terminal** saves them for every terminal.

`/omd` offers the same two actions. If you change a setting defined in a mod's settings file, OMD updates that line
and preserves the file's comments. In `/mods` and `/omd`, you can change the settings of a mod the installer keeps
on, but you can't turn it off. You can't change administrator-managed mods.

## Next steps

- If a mod breaks `codex`, see [troubleshooting](troubleshooting.md).
- For every subcommand, see [commands](commands.md).
- For organizations, the [administrator policy](../mods/reference/administrator-policy.md)
  controls which mods may run.
