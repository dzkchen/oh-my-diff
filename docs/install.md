# Install Oh My Diff

## Before you begin

- Apple Silicon Mac (no Linux or Intel).
- Codex `0.163.x` (`codex --version`). Install: `npm install -g @openai/codex@0.163`. Don't update Codex until OMD
  supports the new version.
- Node 24.18+ (24.x) from [mise](https://mise.jdx.dev) (`mise use -g node@24`) or on `PATH`.
- Python 3.12+ (macOS ships 3.9): `brew install python@3.12`.

## Install

```sh
curl --proto '=https' --tlsv1.2 -fsSL https://github.com/dzkchen/oh-my-diff/releases/download/v1.0.0-rc.2/install.sh | sh -s -- --channel prerelease --profile full
```

- `--channel prerelease` installs the `1.0.0` release candidate.
- `--profile full` is **OMD+**: OMD plus the [mod collection](collection.md). Some mods start on; turn on the rest
  with `/mods`.
- `--profile platform` is **OMD Core**: OMD, the mod manager and update notices.

OMD `1.0` is labeled beta: not every planned capability is included yet. The label does not mean unstable.

Installs and updates check the release signature and checksum. Commands go in `~/.local/bin`; your Codex settings,
sign-in and sessions aren't touched.

Check it: `omd update status`, then run `codex` and type `/mods`.

## Update

```sh
omd update            # install the newest release
omd update rollback   # undo the last update
omd update enable     # install updates automatically
```

With other OMD sessions open, the update waits for your next `codex` start. Mods, settings and sign-in are kept.

## Switch profile

Rerun the install command with the other `--profile`. Each profile keeps its own mod choices.

## Uninstall

```sh
sh ~/.local/share/oh-my-diff/current/prefix/management/install.sh uninstall
```

Removes OMD and its Codex plugins and restores commands it moved aside. Codex data stays. If you deployed the
authority broker, run `omd-package broker uninstall` first. Mod settings stay in `~/.local/share/oh-my-diff/stores`;
delete it to remove them.

## Troubleshooting

| Message | Fix |
| --- | --- |
| `Python 3.12 or newer is required` | Install a newer Python and rerun. |
| `upstream Codex 0.163.x is required` | Install Codex `0.163.x`, or pass `--upstream /path/to/codex`. |
| `move the upstream codex out of ~/.local/bin` | Move your Codex elsewhere and pass `--upstream`. |
| `codex on PATH is ..., not the OMD launcher` | Add the printed `export PATH=...` line to your shell profile; open a new shell. |
| `Node 24.18 or a later 24.x is required` | Install Node 24 with mise or on `PATH`, or pass `--node /path/to/node`. |
| `No terminal is available` | Add `--profile full` or `--profile platform`. |
| A mod breaks `codex` | `omd mods disable ID` ([more](manage-mods.md#when-a-mod-misbehaves)). |

## More

- **Release candidates or nightly builds:** `--channel prerelease|nightly` on install, or
  `omd update channel prerelease|nightly|stable`.
- **Update settings:** `omd update checks on|off`, `cadence daily|weekly`, `pin VERSION|none`, `enable|disable`, or
  `/update`.
- **Locations:** `--root DIR` (default `~/.local/share/oh-my-diff`), `--bin-dir DIR` (default `~/.local/bin`). An
  existing command there becomes `NAME.before-omd` and comes back on uninstall.
- **Without `omd`:** the uninstall command also takes `status` and `rollback`.
- **From source:** [CONTRIBUTING.md](../CONTRIBUTING.md).
