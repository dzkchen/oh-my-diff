# Manage mods

How to find, install, turn on and off, update and remove mods. For what ships with OMD+, see the
[included mods](collection.md). For what a mod is allowed to do, see [trust and permissions](trust-and-permissions.md).

## Before you begin

- OMD installed with either install profile ([Install Oh My Diff](install.md)).

## Find a mod

In `codex`, type `/mods`. The All tab lists installed mods and, under Available, mods you can install from the curated
directory, the list of mods OMD reviews. The Directory tab has Add from source, for npm, Git and folder sources.

From a shell:

```sh
omd mods catalog QUERY       # search the curated directory
omd mods inspect REFERENCE   # preview a mod without installing it
```

The curated directory has the OMD+ mods and three ports, mods adapted from Claude Code mods (`burn_meter`,
`token_weather` and `blast_radius`). The [included mods](collection.md) page describes each one.

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

In `codex`, use `/mods`. If `/mods` is broken, `/omd` has an on/off switch for each mod.

From a shell, use `omd mods enable ID` or `omd mods disable ID`. It finds the mod by id, shows its permissions and
asks before turning it on. For example, to turn on `omd_usage`, which comes with OMD+:

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

## Next steps

- If a mod breaks `codex`, see [troubleshooting](troubleshooting.md).
- For every subcommand, see [commands](commands.md).
- For organizations, the [administrator policy](../mods/reference/administrator-policy.md)
  controls which mods may run.
