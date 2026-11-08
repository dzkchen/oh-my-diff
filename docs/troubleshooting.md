# Troubleshooting

Symptoms, their causes and fixes for installing OMD and running mods. Find the message or symptom you see, then
follow its fix.

## Installer messages

| Message | Cause | Fix |
| --- | --- | --- |
| `Python 3.12 or newer is required` | macOS ships Python 3.9 | Install Python 3.12 or later (`brew install python@3.12`) and rerun. |
| `Oh My Diff supports Apple Silicon macOS only.` | Another platform | OMD doesn't run there. See [support](support.md). |
| `upstream Codex X.Y.x is required` | Your Codex is another version | Run the `npm install -g @openai/codex@X.Y` command the message ends with, or pass `--upstream /path/to/codex`. |
| `An upstream Codex X.Y.x executable is required` | The installer found no `codex` on your `PATH` | Run the `npm install` command the message names, or pass `--upstream /path/to/codex`. |
| `is or becomes the OMD launcher` | The Codex you named is in `~/.local/bin`, where the OMD launcher goes, or is OMD itself | Move your Codex elsewhere and pass its new path with `--upstream`. |
| `Python could not verify GitHub's certificate` | Python from python.org has no CA certificates until you install them | Run `Install Certificates.command` in its `/Applications/Python 3.x` folder, or use Homebrew's Python, then rerun. |
| `No terminal is available` | The installer can't ask which profile you want | Add `--profile full` or `--profile platform`. |

## Check the install

`omd doctor` runs `codex doctor`, then checks OMD itself and names one fix for each problem it finds. Add `--json`
for scripts.

## `codex` still starts plain Codex

If the installer printed `codex on your PATH is ..., not OMD's` or `OMD isn't on your PATH`, you answered `n` to its
`PATH` question or installed without a terminal. Add the line it printed to the end of `~/.zshrc` (bash:
`~/.bash_profile`, fish: `~/.config/fish/config.fish`), or rerun the installer and answer `y`, then open a new
terminal. The line doesn't work in `~/.zshenv`, because macOS and Homebrew reorder `PATH` after that file runs.

If the line is already there, your shell cached the old `codex`. Run `hash -r` or open a new terminal.

## A mod breaks `codex`

Try these in order. All three work from any shell, even when `codex` won't start. If `codex` starts but `/mods` is
broken, `/omd` has an on/off switch for each mod.

1. Turn the mod off. Its data is kept.

   ```sh
   omd mods disable ID
   ```

2. Turn it off and block this version. Turning it on or reinstalling it is refused until you run
   `omd mods unblock ID`.

   ```sh
   omd mods quarantine ID "reason"
   ```

3. Switch to `direct`, the recovery state with no mods at all:

   ```sh
   omd-package activate direct
   ```

   `omd-package activate full` (OMD+) or `omd-package activate platform` (OMD Core) brings the mods back.

OMD also turns a mod off by itself when five calls into its code (callbacks) fail in a row
([fault limit](../mods/reference/host-model.md#fault-limit)).

### Repair the mod store directly

`omd-mod` is the low-level tool that works on the mod store directly, without running any mod. Replace `STORE` with
your install profile's store path, listed under [`omd-mod` in Commands](commands.md#omd-mod). Use `package-disable`
with the id of a mod you installed with `omd install`. Use `disable` with the folder of a mod that came with your
install profile, `STORE/sources/ID`.

```sh
omd-mod selection-status STORE         # list what's selected, without running mods
omd-mod package-disable STORE ID       # turn off a mod you installed with omd install
omd-mod disable STORE PACKAGE          # turn off a mod by its folder; PACKAGE is the folder
omd-mod package-enable STORE ID        # turn a mod you installed back on; its data is kept
```

## Mod, update and terminal problems

| Message or symptom | Cause | Fix |
| --- | --- | --- |
| A mod installed from a folder stopped, and `omd-mod status STORE` lists it under `rejected` as `source_changed` | The folder changed after you trusted it, and trust covers the exact files (see [how trust is bound](trust-and-permissions.md#installing-doesnt-turn-a-mod-on)) | Review it again with `omd mods update ID`. |
| `package_integrity_failure` | A curated mod's download doesn't match its pinned hash | Don't install it. Report it in an [issue](https://github.com/dzkchen/oh-my-diff/issues/new/choose). |
| `incompatible_api` | The mod was built for another mod API version | Ask its author for an update. Only API `1.0.0` loads. |
| `capability_denied: NAME` | The mod called something it wasn't granted | Ask its author; `omd-mod-author explain 'capability_denied: NAME'` shows what the message means. |
| `omd update` says enabled mods don't support the new mod API | Those mods will stop loading after the update | Update or remove them first, or pass `--yes` to update anyway. |
| An update didn't apply | Other OMD sessions are open | It applies at your next `codex` start with no other session open. |
| No mod loads, and `/omd` says the host is off | `codex` started in your home folder or in `/` | `cd` into a project folder and run `codex` again. |
| Alt shortcuts (Alt+a, Alt+s) do nothing in Kitty or Ghostty | The terminal sends Option as a character | Turn on Option-as-Alt: `macos_option_as_alt` in Kitty, `macos-option-as-alt` in Ghostty. |

## Report a problem

Include the output of these commands in a [bug report](https://github.com/dzkchen/oh-my-diff/issues/new/choose):

```sh
omd doctor
omd update status
```

Report security problems [privately](../SECURITY.md), not in a public issue.

## See also

- [Manage mods](manage-mods.md)
- [Commands](commands.md)
- [Trust and permissions](trust-and-permissions.md)
