# Install Oh My Diff

## Before you begin

- Apple Silicon Mac (no Linux or Intel).
- Codex `0.164.x` (`codex --version`). Install: `npm install -g @openai/codex@0.164`. Don't update Codex until OMD
  supports the new version.
- Python 3.12+ (macOS ships 3.9): `brew install python@3.12`.
- Only to write mods: Node 24.18+ (24.x) on `PATH` for `omd-mod-author`.
- Only for the account mods (`omd_profiles`, `omd_claude_cli`, `omd_cursor`): Node 22.18+ on `PATH`.

## Install

```sh
curl --proto '=https' --tlsv1.2 -fsSL https://github.com/dzkchen/oh-my-diff/releases/latest/download/install.sh | sh -s -- --profile full
```

- `--profile full` is **OMD+**, the one most people want: OMD plus the [mod collection](collection.md). Some mods
  start on; turn on the rest with `/mods`.
- `--profile platform` is **OMD Core**: only OMD, the mod manager and update notices, for adding just the mods you
  pick or writing your own.

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
omd uninstall
```

Removes OMD and its Codex plugins and restores commands it moved aside. Codex data stays. If you deployed the
authority broker, run `omd-package broker uninstall` first. Mod settings stay in `~/.local/share/oh-my-diff/stores`;
delete it to remove them.

## Troubleshooting

| Message | Fix |
| --- | --- |
| `Python 3.12 or newer is required` | Install a newer Python and rerun. |
| `upstream Codex 0.164.x is required` | Install Codex `0.164.x`, or pass `--upstream /path/to/codex`. |
| `move the upstream codex out of ~/.local/bin` | Move your Codex elsewhere and pass `--upstream`. |
| `codex on your PATH is ..., not OMD's` | Add the printed `export PATH=...` line to the end of `~/.zshrc` (bash: `~/.bash_profile`); open a new shell. In `~/.zshenv` it doesn't work: macOS and Homebrew reorder `PATH` after it. |
| `codex` still starts plain Codex right after installing | Your shell cached the old `codex`: run `hash -r` or open a new terminal. |
| `No terminal is available` | Add `--profile full` or `--profile platform`. |
| A mod breaks `codex` | `omd mods disable ID` ([more](manage-mods.md#when-a-mod-misbehaves)). |

## More

- **Prereleases or nightly builds:** `--channel prerelease|nightly` on install, or
  `omd update channel prerelease|nightly|stable`.
- **Update settings:** `omd update checks on|off`, `cadence daily|weekly`, `pin VERSION|none`, `enable|disable`, or
  `/update`.
- **Locations:** `--root DIR` (default `~/.local/share/oh-my-diff`), `--bin-dir DIR` (default `~/.local/bin`). An
  existing command there becomes `NAME.before-omd` and comes back on uninstall.
- **Layout:** under the root, `releases/` holds the current and previous generation, `stores/` your mod choices and
  `objects/` one copy of each package source and management file, hard-linked into `catalog/` and every release
  (an update upgrades an older install in place). `sessions/` holds one marker per open `codex`, cleared at the next launch
  after it exits.
- **Without `omd`:** `sh ~/.local/share/oh-my-diff/current/prefix/management/install.sh uninstall` (the script also
  takes `status` and `rollback`).
- **From source:** [CONTRIBUTING.md](../CONTRIBUTING.md).
