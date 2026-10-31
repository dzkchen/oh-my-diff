# omd_lazygit

Runs [lazygit](https://github.com/jesseduffield/lazygit), a terminal Git interface, inside the session. It's off by
default in OMD+. OMD Core doesn't include it.

## Turn it on

Install lazygit first, following the [installation guide](https://github.com/jesseduffield/lazygit#installation)
(Homebrew: `brew install lazygit`). Without it `/lazygit` says so. Then turn on `omd_lazygit` in `/mods`, or run:

```sh
omd-package mod enable omd_lazygit
```

[Manage mods](../../../docs/manage-mods.md) covers the other ways to turn a mod on or off.

It runs `lazygit` outside the sandbox with your real `HOME`, the network, your SSH agent and your `EDITOR`, `VISUAL`,
`GIT_EDITOR`, `XDG_CONFIG_HOME` and `CONFIG_DIR`. Trusting the mod allows that for the `lazygit` program only. The
first start asks once per `lazygit` binary, and again when the binary changes.

## Use it

`/lazygit [path]` starts lazygit in the session directory (or `path`, relative to it), with keys, mouse and colors
passed through. The files you edit in it open in your editor or become `@path` mentions in the prompt.

| Command | What it does |
| --- | --- |
| `/lazygit [path]` | Start lazygit; while it runs, focus it again |
| `/lazygit --stop` (or `stop`) | Close it. Open a directory named `stop` with `/lazygit ./stop` |

`Ctrl+]` leaves lazygit for the prompt. If you entered lazygit's workspace panel from the dock, the first `Ctrl+]`
returns to the panel and the second to the prompt. To focus lazygit again, press `Ctrl+]` or click its area. Quitting
lazygit (`q`) closes it, and a failed exit shows lazygit's last output line in a notice. A path that doesn't exist shows
`No such directory`.

Press `e` (edit) on a file or folder in lazygit to hand it to OMD, which follows the `edit` setting. If no editor is set
in `host.json`, or it fails to start, a notice says why and OMD inserts the `@path` mention instead. If you decline the
confirmation, neither happens. Edits lazygit waits for, such as a commit message, open your `EDITOR` inside the pane.

## Settings

Change settings in `/mods`.

| Setting | Default | What it does |
| --- | --- | --- |
| `placement` | `panel` | `panel`: a Lazygit tab in the `omd_workspace` dock. `full`: lazygit takes the screen above a compact chat. |
| `edit` | `editor` | `editor`: open the file at its line in the `editor` argv of `host.json`, after a confirmation. `composer`: insert `@path` at the prompt's cursor |

`panel` needs `omd_workspace` on and falls back to `full` without it. `full` uses the workspace's full screen mode when
`omd_workspace` is on. In a thread where lazygit isn't running, the Lazygit tab says how to start it.

## Needs and limits

- It asks to add commands, draw in a terminal pane, keep its state, run `lazygit` outside the sandbox with network
  access, insert text at the prompt and use the workspace's panel. The capabilities are `commands`, `terminal`, `store`,
  `exec`, `os`, `pty`, `composer`, `inventory` and `services` (see
  [Trust and permissions](../../../docs/trust-and-permissions.md#what-a-mod-can-do)).
- For this run only, a small config file replaces lazygit's `os.edit`, `os.editAtLine` and `os.openDirInEditor` and
  sends the path and line to OMD.
- Your own lazygit config still loads. The mod finds its folder with `lazygit -cd` at every start and passes
  `config.yml` there first, then its injected file, through `--use-config-file`. Your files are never changed. If
  `lazygit -cd` fails, only the injected file is used and your config is not loaded. `LG_CONFIG_FILE` is ignored.
- Only files inside the session's root folder are opened or mentioned. Others show a notice.
- It needs an OMD host with the experimental terminal pane API (host feature `terminal_pty_v2`).
- One lazygit runs per thread. It stops when you switch threads or OMD reloads, and its layout goes with it. If the
  workspace is turned off or the panel is removed while it runs, lazygit moves to the full screen layout.

## More

- [Included mods](../../../docs/collection.md)
- [`omd_workspace`](../omd_workspace/README.md), whose dock can show the lazygit panel
- [`omd_git`](../omd_git/README.md), a Git panel drawn by OMD itself
