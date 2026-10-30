# Troubleshooting

Symptoms, their causes and fixes for installing OMD and running mods. Find the message or symptom you see, then
follow its fix.

## Installer messages

| Message | Cause | Fix |
| --- | --- | --- |
| `Python 3.12 or newer is required` | macOS ships Python 3.9 | Install Python 3.12 or later (`brew install python@3.12`) and rerun. |
| `Oh My Diff supports Apple Silicon macOS only.` | Another platform | OMD doesn't run there. See [support](support.md). |
| `upstream Codex 0.165.x is required` | Your Codex is another version | Install Codex `0.165.x`, or pass `--upstream /path/to/codex`. |
| `An upstream Codex 0.165.x executable is required` | The installer found no `codex` on your `PATH` | Install Codex `0.165.x`, or pass `--upstream /path/to/codex`. |
| `move the upstream codex out of ~/.local/bin` | Your Codex is where the OMD launcher goes | Move your Codex elsewhere and pass its new path with `--upstream`. |
| `No terminal is available` | The installer can't ask which profile you want | Add `--profile full` or `--profile platform`. |

## `codex` still starts plain Codex

If the installer printed `codex on your PATH is ..., not OMD's`, another `codex` comes first on your `PATH`. Add the
`export PATH=...` line the installer printed to the end of `~/.zshrc` (bash: `~/.bash_profile`), then open a new
shell. The line doesn't work in `~/.zshenv`, because macOS and Homebrew reorder `PATH` after that file runs.

If the line is already there, your shell cached the old `codex`. Run `hash -r` or open a new terminal.

## A mod breaks `codex`

Try these in order. The first three work from any shell, even when `codex` won't start.

1. Turn the mod off. Its data is kept.

   ```sh
   omd mods disable ID            # a mod you installed
   omd-package mod disable ID     # a mod that came with your profile
   ```

2. Turn it off and block this version. Turning it on or reinstalling it is refused until you run
   `omd mods unblock ID`.

   ```sh
   omd mods quarantine ID "reason"
   ```

3. Run with no mods at all:

   ```sh
   omd-package activate direct
   ```

   `omd-package activate full` (OMD+) or `omd-package activate platform` (OMD Core) brings the mods back.

In `codex`, `/omd` has an on/off switch for each mod, even when `/mods` is broken.

OMD turns a mod off by itself after five failed callbacks in a row
([fault limit](../mods/reference/host-model.md#fault-limit)).

### Repair the mod store directly

`omd-mod` works on the mod store without running any mod. The store is `~/.local/share/oh-my-diff/stores/full` for
OMD+ and `~/.local/share/oh-my-diff/stores/platform` for OMD Core; replace `STORE` with that path.

```sh
omd-mod selection-status STORE         # what's selected, without running mods
omd-mod package-disable STORE ID       # turn off an installed mod
omd-mod disable STORE PATH             # turn off a mod trusted by its source folder
omd-mod package-enable STORE ID        # turn it back on, data kept
```

## Mod messages

| Message or symptom | Cause | Fix |
| --- | --- | --- |
| A mod installed from a folder stopped, and `omd-mod status STORE` lists it under `rejected` as `untrusted_source` | The folder changed after you trusted it | Review it again with `omd mods update ID`. |
| `package_integrity_failure` | A curated mod's download doesn't match its pinned hash | Don't install it. Report it in an [issue](https://github.com/dzkchen/oh-my-diff/issues/new/choose). |
| `incompatible_api` | The mod was built for another mod API version | Ask its author for an update. Only API `1.0.0` loads. |
| `capability_denied: NAME` | The mod called something it wasn't granted | Ask its author; `omd-mod-author explain DENIAL` shows what the code means. |
| `omd update` says enabled mods don't support the new mod API | Those mods will stop loading after the update | Update or remove them first, or pass `--yes` to update anyway. |
| An update didn't apply | Other OMD sessions are open | It applies at your next `codex` start with no other session open. |
| Alt shortcuts (Alt+a, Alt+s) do nothing in Kitty or Ghostty | The terminal sends Option as a character | Turn on Option-as-Alt: `macos_option_as_alt` in Kitty, `macos-option-as-alt` in Ghostty. |

## Report a problem

Include the output of these commands in a [bug report](https://github.com/dzkchen/oh-my-diff/issues/new/choose):

```sh
omd update status
omd-package status
```

Report security problems [privately](../SECURITY.md), not in a public issue.

## See also

- [Manage mods](manage-mods.md)
- [Commands](commands.md)
- [Trust and permissions](trust-and-permissions.md)
