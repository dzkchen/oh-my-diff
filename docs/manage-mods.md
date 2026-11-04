# Manage mods

How to find, install, turn on and off, update and remove mods. For what ships with OMD+, see the
[included mods](collection.md). For what a mod is allowed to do, see [trust and permissions](trust-and-permissions.md).

## Before you begin

- OMD installed with either install profile ([Install Oh My Diff](install.md)).

## Find a mod

In `codex`, type `/mods`. The All tab lists installed mods and, under Available, mods you can install from the curated
directory. Experimental entries have not been fully tested; check their support status before trusting them. The Directory tab has Add from source, for npm, Git and folder sources.

From a shell:

```sh
omd mods catalog QUERY       # search the curated directory
omd mods inspect REFERENCE   # preview a mod without installing it
```

The curated directory has the OMD+ mods, the experimental mods and three ports, mods adapted from Claude Code mods (`burn_meter`,
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

## Terminal choices and saved defaults

Ordinary on/off switches and setting edits in `/mods` and native `/omd` affect this terminal only.
In `/omd`, open **All mods** to edit string, number, boolean and enum settings, including while `/mods` is disabled.
Each setting shows its effective value, inherited value and terminal override; **Reset setting** clears only that key.
They survive conversation changes and mod reloads, and disappear when the terminal host exits.
Another terminal, including one on the same conversation, starts from shared defaults. Reconnecting the
same attached terminal retains its choices while its host is alive; children start from defaults.

Use **Reset to defaults** to clear local enablement and settings choices and inherit the latest shared values. If a shell command disabled an installer-required mod, native `/omd` offers **Restore saved default**; this explicit shared action turns it back on for every terminal. Administrator policy remains authoritative.
Use **Save as defaults** explicitly to persist your choices for future launches and terminals inheriting defaults. If the mod has a settings file, this action also saves the effective values there; JSON syntax is used for JSON and YAML files, replacing existing formatting and comments.
Shared changes do not replace valid local overrides. Shell `omd mods` commands change shared configuration.
Install, update, remove, rollback and trust are always shared. Policy and trust still apply: local choices cannot
grant permissions, undo revocation or revive removed packages. Source, schema and authority changes invalidate
or revalidate overrides. Mod data and credentials are separate from terminal configuration.
