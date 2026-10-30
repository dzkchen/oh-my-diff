# Install Oh My Diff

How to install, update, switch profile and uninstall Oh My Diff (OMD). If something fails, see
[troubleshooting](troubleshooting.md).

## Before you begin

- An Apple Silicon Mac. Other platforms are unsupported and the installer refuses them.
- Codex `0.165.x` (`codex --version`). To install it: `npm install -g @openai/codex@0.165`. Don't update Codex until
  OMD supports the new version.
- Python 3.12 or later (macOS ships 3.9): `brew install python@3.12`.

Some mods and the mod author tools also need Node. [Support](support.md) lists which versions.

## Choose an install profile

| Install profile | Install flag | What you get |
| --- | --- | --- |
| OMD+ | `--profile full` | OMD plus the [included mods](collection.md). Some start on; turn on the rest with `/mods`. |
| OMD Core | `--profile platform` | Only the mod host: the `/mods` screen, update notices and the OMD mark. For adding only the mods you pick, or writing your own. |

A third mode, `direct`, runs plain Codex behavior with no mods. You switch to it with `omd-package activate direct`
when you need to recover, not at install time.

## Install

For OMD+:

```sh
curl --proto '=https' --tlsv1.2 -fsSL https://github.com/dzkchen/oh-my-diff/releases/latest/download/install.sh | sh -s -- --profile full
```

For OMD Core, use `--profile platform` instead.

Installs and updates check the release signature and checksum. Commands go in `~/.local/bin`; your Codex settings,
sign-in and sessions aren't touched.

To check it worked, run:

```sh
omd update status
```

Then run `codex` and type `/mods`.

## Update

```sh
omd update            # install the newest release
omd update rollback   # undo the last update
omd update enable     # install updates automatically
```

While other OMD sessions are open, the update waits for your next `codex` start. Mods, settings and sign-in are
kept. If an enabled mod doesn't support the new mod API, `omd update` asks first; `--yes` updates anyway.

To change how updates work, use `/update` in `codex` or these commands:

| Command | Effect |
| --- | --- |
| `omd update checks on\|off` | Turn update checks on or off |
| `omd update cadence daily\|weekly` | How often to check |
| `omd update channel stable\|prerelease\|nightly` | Which releases to follow |
| `omd update pin VERSION\|none` | Stay on one version, or stop pinning |
| `omd update enable\|disable` | Install updates automatically, or only when you run `omd update` |

To install a prerelease or nightly build in the first place, add `--channel prerelease` or `--channel nightly` to
the install command.

## Switch install profile

Rerun the install command with the other `--profile`. Each install profile keeps its own mod choices.

## Uninstall

If you deployed the authority broker (an optional macOS service that protects credentials, described in
[trust and permissions](trust-and-permissions.md)), remove it first:

```sh
omd-package broker uninstall
```

Then remove OMD:

```sh
omd uninstall
```

This removes OMD and its Codex plugins and restores the commands it moved aside. Codex data stays. Mod settings stay
in `~/.local/share/oh-my-diff/stores`; delete that folder to remove them.

If the `omd` command is gone, run the management script directly. It also takes `status` and `rollback`:

```sh
sh ~/.local/share/oh-my-diff/current/prefix/management/install.sh uninstall
```

## Install options

| Option | Default | Effect |
| --- | --- | --- |
| `--profile full\|platform` | asked in a terminal | OMD+ or OMD Core |
| `--channel stable\|prerelease\|nightly` | `stable` | Which release to install |
| `--root DIR` | `~/.local/share/oh-my-diff` | Where OMD keeps releases and mod stores |
| `--bin-dir DIR` | `~/.local/bin` | Where the `codex`, `omd` and other commands go |
| `--upstream PATH` | `codex` on your `PATH` | The Codex `0.165.x` executable OMD builds on |

An existing command in the bin folder is renamed to `NAME.before-omd` and comes back on uninstall.

## Where OMD keeps files

Under the root folder:

- `releases/` contains the current and the previous release.
- `stores/` contains your mod choices and mod data, one store per profile (`stores/full`, `stores/platform`).
- `objects/` contains one copy of each package source and management file, hard-linked into `catalog/` and every
  release.
- `sessions/` contains one marker per open `codex`, cleared at the next launch after that session exits.

To build OMD from source, see [CONTRIBUTING.md](../CONTRIBUTING.md).

## Next steps

- See what's in OMD+: [included mods](collection.md).
- Install and turn on more mods: [Manage mods](manage-mods.md).
- Use Claude, Cursor or an API key: [use other providers](use-other-providers.md).
