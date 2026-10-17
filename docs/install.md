# Install Oh My Diff

This page covers installing, updating and removing OMD.

## Before you begin

You need:

- An Apple Silicon Mac. Linux and Intel Macs aren't supported.
- Codex `0.163.x`. Check with `codex --version`.
- Node 24.18 or later 24.x, installed with [mise](https://mise.jdx.dev).
- Python 3.12 or later. macOS ships 3.9; install a newer one with `brew install python@3.12`.

## Install

Run:

```sh
curl --proto '=https' --tlsv1.2 -fsSL https://github.com/dzkchen/oh-my-diff/releases/latest/download/install.sh | sh -s -- --profile full
```

`--profile full` installs **OMD+**: OMD plus its [mod collection](collection.md). A few useful mods are on; the
rest are installed but off until you turn them on.

For the minimal install, use `--profile platform` instead. That installs **OMD Core**: OMD, the mod manager and
update notices, ready for mods you choose yourself.

The installer checks the release's signature and the download's checksum before installing, and updates do the
same. It adds `codex`, `omd`, `omd-package`, `omd-mod`,
`omd-mod-author` and `omd-contract` to `~/.local/bin`. Your Codex settings, sign-in and sessions aren't changed.

## Check that it works

```sh
omd update status
```

It prints the installed version and profile. Then run `codex` and type `/mods` to see your mods.

## Update

```sh
omd update
```

This installs the newest release. If other OMD sessions are open, the update waits and installs the next time you
start `codex`. Your mods, settings and sign-in are kept.

OMD checks for updates in the background and tells you when one is ready. To update automatically instead, run
`omd update enable`.

To undo the last update:

```sh
omd update rollback
```

## Switch between OMD+ and OMD Core

Run the install command again with the other `--profile`. Each profile remembers its own mod choices.

## Uninstall

```sh
sh ~/.local/share/oh-my-diff/current/prefix/management/install.sh uninstall
```

This removes OMD and puts back any commands it moved aside. Your Codex data is kept, and so are your mod
settings in `~/.local/share/oh-my-diff/stores`. Delete that folder too if you want them gone.

## Troubleshooting

| Message | Fix |
| --- | --- |
| `Python 3.12 or newer is required` | Install a newer Python, then rerun the install command. |
| `upstream Codex 0.163.x is required` | Install Codex `0.163.x`, or pass its path with `--upstream /path/to/codex`. |
| `move the upstream codex out of ~/.local/bin` | OMD's `codex` goes in `~/.local/bin`. Move your Codex elsewhere and pass `--upstream`. |
| `codex on PATH is ..., not the OMD launcher` | Add the `export PATH=...` line it prints to your shell profile and open a new shell. |
| `Node 24.18 or a later 24.x is required` | Install Node with mise, or pass `--node /path/to/node`. |
| `No terminal is available` | Add `--profile full` or `--profile platform` to the command. |
| A mod breaks `codex` | Run `omd mods disable ID`. See [Install and manage mods](manage-mods.md#when-a-mod-misbehaves). |

## More options

- **Release candidates and nightly builds:** add `--channel beta` or `--channel nightly` to the install command, or
  run `omd update channel beta`. Switch back with `omd update channel stable`.
- **Update settings:** `omd update status` shows them. Change them with `omd update checks on|off`,
  `omd update cadence daily|weekly`, `omd update pin VERSION|none` or `omd update disable`, or in `/update`.
- **Install locations:** `--root DIR` (default `~/.local/share/oh-my-diff`) and `--bin-dir DIR` (default
  `~/.local/bin`). If a command OMD installs already exists there, OMD renames it to `NAME.before-omd` and restores it
  when you uninstall.
- **Status and rollback without `omd`:** the uninstall command above also takes `status` and `rollback`.
- **Build from source:** see [CONTRIBUTING.md](../CONTRIBUTING.md).
