# Install and manage mods

For the mods that ship with OMD+, see [Included mods](collection.md).

## Install a mod

In `codex`: `/mods`, then Browse or Add from source. From a shell:

```sh
omd install some_mod                                        # curated directory
omd install npm:@author/some-mod@1.2.3                      # npm
omd install 'git+https://github.com/author/repo#v1.2.3:mod' # Git tag and folder
omd install ./my-mod                                        # local folder
omd mods enable some_mod                                    # installing doesn't turn it on
```

Each step shows the source, license and permissions and asks first. The mod runs from your next message.

Curated mods are pinned to a commit and hash; OMD refuses a changed download (`package_integrity_failure`) or an
unsupported API (`incompatible_api`). The curated directory also lists three Claude Code ports from
[`mods/ports`](../mods/ports): `burn_meter`, `token_weather` and `blast_radius`.

## See and change mods

```sh
omd mods list                  # installed, and whether on
omd mods catalog QUERY         # search the directory
omd mods inspect REFERENCE     # preview without installing
omd mods update some_mod       # also: disable, remove, rollback
```

Settings live in `/mods`. `--scope project` installs for the current project instead of for you (`--scope user`, the default).

## When a mod misbehaves

Works from any shell, even if `codex` won't start:

```sh
omd mods disable some_mod               # off, data kept
omd-package mod disable omd_usage       # an OMD+ mod
omd mods quarantine some_mod "reason"   # off, and block this version
omd-package activate direct             # no mods at all; back with: omd-package activate full (or platform)
```

In `codex`, `/omd` has an on/off switch per mod, even when `/mods` is broken.

Lower-level repair on the store (`~/.local/share/oh-my-diff/stores/full`, or `.../platform` for OMD Core):

```sh
omd-mod selection-status STORE         # what's selected, without running mods
omd-mod package-disable STORE ID       # an installed mod off
omd-mod disable STORE PATH             # a folder-trusted mod (by source folder) off
omd-mod package-enable STORE ID        # back on, data kept
```

A mod whose source changed must be trusted again.

## Safety

You approve a mod's permissions when you turn it on. A mod allowed to run programs outside the sandbox, use the
network or approve actions really can. Only turn on mods you trust.

## More

- **Preview a plugin update:** `omd-mod plugin-preview CODEX_BIN CODEX_HOME NAME@MARKETPLACE CANDIDATE_DIR` compares
  files without changing anything; apply with `/plugins` or `codex plugin add`.
- **Organizations:** policy files and an OS-separated credential broker (both need `sudo`):
  [policy](../mods/reference/safety.md#administrator-policy-and-managed-deployment),
  [protected authority](../mods/reference/safety.md#protected-authority-macos). Run `omd-package broker uninstall` before
  uninstalling OMD.
