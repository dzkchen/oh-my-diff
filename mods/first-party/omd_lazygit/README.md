# omd_lazygit

Runs [lazygit](https://github.com/jesseduffield/lazygit) inside the session. `/lazygit [path]` starts it in the
session directory (or `path`, relative to it), with keys, mouse and colors passed through. The files you edit in it
open in your editor or become `@path` mentions in the prompt. It's off by default in OMD+, and it's experimental. OMD
Core doesn't include it.

## Turn it on

Install lazygit first, following the [installation guide](https://github.com/jesseduffield/lazygit#installation)
(Homebrew: `brew install lazygit`). Without it `/lazygit` says so. Then turn on `omd_lazygit` in `/mods`, or run:

```sh
omd-package mod enable omd_lazygit
```

[Manage mods](../../../docs/manage-mods.md) covers the other ways to turn a mod on or off.

It runs `lazygit` outside the sandbox with your real `HOME`, the network, your SSH agent and your `EDITOR`, `VISUAL`,
`GIT_EDITOR`, `XDG_CONFIG_HOME` and `CONFIG_DIR`, so trusting the mod grants that. Its `os_access` lists only
`lazygit`. The first start asks once per `lazygit` binary, and again when the binary changes.

## Use it

| Command | What it does |
| --- | --- |
| `/lazygit [path]` | Start lazygit; while it runs, focus it again |
| `/lazygit --stop` (or `stop`) | Close it; open a directory named `stop` with `/lazygit ./stop` |

Ctrl+] leaves lazygit for the prompt. After you enter its workspace panel from the dock, the first Ctrl+] goes back to
the panel and a second goes to the prompt. Quitting lazygit (`q`) closes it, and a failed exit shows lazygit's last
output line in a notice. Entering its region with Ctrl+] or a click focuses it again. A path that doesn't exist shows
`No such directory`.

Pressing `e` (edit) on a file or folder in lazygit hands it back to OMD, which does what the `edit` setting says. For
this run only, a small config file replaces lazygit's `os.edit`, `os.editAtLine` and `os.openDirInEditor` and sends
the path and line to OMD. If no editor is set in `host.json` or it fails to start, a notice says why and the `@path`
mention is inserted instead. Declining the confirmation does neither. Edits lazygit waits for, such as a commit
message, open your `EDITOR` inside the pane.

## Settings

Every setting is its own row in `/mods`.

| Setting | Default | What it does |
| --- | --- | --- |
| `placement` | `panel` | `full`: lazygit takes the screen above a compact chat, through the workspace's full screen mode while `omd_workspace` is on. `panel`: a Lazygit tab of the `omd_workspace` dock, which must be on, else `full`; in a thread where lazygit isn't running the tab says how to start it |
| `edit` | `editor` | `editor`: open the file at its line in the `editor` argv of `host.json`, after a confirmation. `composer`: insert `@path` at the prompt's cursor |

## Needs and limits

- It asks to add commands, draw in a terminal pane, keep its state, run `lazygit` outside the sandbox with network
  access, insert text at the prompt and use the workspace's panel. The capabilities are `commands`, `terminal`,
  `store`, `exec`, `os`, `pty`, `composer`, `inventory` and `services`.
- Your own lazygit config still loads. The mod finds its folder with `lazygit -cd` at every start and passes
  `config.yml` there first, then its injected file, through `--use-config-file`. Your files are never changed. If
  `lazygit -cd` fails, only the injected file is used and your config is not loaded. `LG_CONFIG_FILE` is ignored.
- Only files inside the session root are opened or mentioned. Others show a notice.
- It needs an OMD host with `terminal_pty_v2`. Without `omd_workspace`, `panel` falls back to `full`.
- One lazygit runs per thread. It stops when you switch threads or OMD reloads, and its layout goes with it. If the
  workspace is turned off or the panel is removed while it runs, lazygit moves to the full screen layout.

## More

- [Included mods](../../../docs/collection.md)
- [`omd_workspace`](../omd_workspace/README.md), whose dock can hold the lazygit panel
- [`omd_git`](../omd_git/README.md), a Git panel drawn by OMD itself
