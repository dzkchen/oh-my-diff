# Manage mods

How to find, install, turn on and off, update and remove mods. For what ships with OMD+, see the
[included mods](collection.md). For what a mod is allowed to do, see [trust and permissions](trust-and-permissions.md).

## Find a mod

In `codex`, type `/mods`. The All tab lists installed mods and, under Available, mods from the curated directory
that you can install. The Directory tab has Add from source, for npm, Git and folder sources.

From a shell:

```sh
omd mods catalog QUERY       # search the curated directory
omd mods inspect REFERENCE   # preview a mod without installing it
```

The curated directory has the OMD+ mods and three ports of Claude Code mods (`burn_meter`, `token_weather` and
`blast_radius`). The [included mods](collection.md) page describes each one.

## Install a mod

In `/mods`, pick a mod under Available, or use Add from source. From a shell, `omd install` takes a reference:

```sh
omd install some_mod                                        # curated directory
omd install npm:@author/some-mod@1.2.3                      # npm
omd install 'git+https://github.com/author/repo#v1.2.3:mod' # Git tag and folder
omd install ./my-mod                                        # local folder
```

Each install shows the source, license and permissions and asks first. Installing doesn't turn the mod on.

Curated mods are pinned to a commit and hash. OMD refuses a download that changed (`package_integrity_failure`) or a
mod built for another API version (`incompatible_api`).

To install for the current project instead of for you, add `--scope project` (the default is `--scope user`).

## Turn a mod on or off

In `codex`, use `/mods`. If `/mods` is broken, `/omd` has an on/off switch for each mod.

From a shell there are two commands:

| Command | What it does |
| --- | --- |
| `omd mods enable ID`, `omd mods disable ID` | Finds the installed mod by id, shows its permissions and asks first |
| `omd-package mod enable ID`, `omd-package mod disable ID` | Changes the trusted selection of a mod your profile installed, without asking. It reloads the mods and puts the previous state back if the mod fails to load |

The mod READMEs use `omd-package mod` for first-party mods, for example:

```sh
omd-package mod enable omd_usage
```

For a mod you installed with `omd install`, use `omd mods enable ID`. A change applies at your next message.
`omd mods list` shows which mods are installed and on.

Turning a mod off keeps its data.

## Change a mod's settings

Open `/mods` in `codex` and pick the mod. Each mod's README in [`mods/first-party`](../mods/first-party) lists its
settings.

## Update, roll back or remove a mod

```sh
omd mods update some_mod     # newest version, after showing what changes
omd mods rollback some_mod   # the previous version
omd mods remove some_mod     # uninstall; cache, state and local sources are kept
```

A mod installed from a folder runs from that folder. After any edit to the folder, the mod stops until you review it
again with `omd mods update ID`. To freeze a version, install a Git tag or a package instead.

## Next steps

- If a mod breaks `codex`, see [troubleshooting](troubleshooting.md).
- For every subcommand, see [commands](commands.md).
- For organizations, the [administrator policy](../mods/reference/administrator-policy.md)
  controls which mods may run.
