# omd_yazi

Runs the [yazi](https://yazi-rs.github.io) file manager inside the session. `/yazi [path]` starts it, with keys,
mouse and colors passed through (image previews don't show). The files you pick become `@path` mentions in the prompt
when you leave it. It's off by default in OMD+, and it's experimental. OMD Core doesn't include it.

## Turn it on

Install yazi first, following the [installation guide](https://yazi-rs.github.io/docs/installation) (Homebrew:
`brew install yazi`). Without it `/yazi` says so. Then turn on `omd_yazi` in `/mods`, or run:

```sh
omd-package mod enable omd_yazi
```

[Manage mods](../../../docs/manage-mods.md) covers the other ways to turn a mod on or off.

It runs `yazi` outside the sandbox with your real `HOME`, without network, and with your `EDITOR`, `VISUAL`,
`XDG_CONFIG_HOME` and `YAZI_CONFIG_HOME`, so trusting the mod grants that. Its `os_access` lists only `yazi`. The
first start asks once per `yazi` binary, and again when the binary changes.

## Use it

| Command | What it does |
| --- | --- |
| `/yazi [path]` | Start yazi in `path` (relative to the session directory); while it runs, focus it again |
| `/yazi --stop` (or `stop`) | Close it without inserting mentions; open a directory named `stop` with `/yazi ./stop` |

Pick files with yazi's open action (Enter) or its chooser keys. When yazi quits (`q`), the picked paths are inserted at
the prompt's cursor as `@relative/path`, or `@"quoted path"` when the path has spaces. Ctrl+] leaves yazi for the
prompt without closing it. After you enter its workspace panel from the dock, the first Ctrl+] goes back to the panel
and a second goes to the prompt. A failed exit shows yazi's last output line in a notice.

Without a `path`, yazi starts where it last ended in this thread if that is inside the session root, and in the
session directory otherwise.

## Settings

Every setting is its own row in `/mods`.

| Setting | Default | What it does |
| --- | --- | --- |
| `placement` | `panel` | `full`: yazi takes the screen above a compact chat, through the workspace's full screen mode while `omd_workspace` is on. `panel`: a Yazi tab of the `omd_workspace` dock, which must be on, else `full`; in a thread where yazi isn't running the tab says how to start it |

## Needs and limits

- It asks to add commands, draw in a terminal pane, keep its state, run `yazi` outside the sandbox without network
  access, insert text at the prompt and use the workspace's panel. The capabilities are `commands`, `terminal`,
  `store`, `exec`, `os`, `pty`, `composer`, `inventory` and `services`.
- At most 16 mentions are inserted. Paths outside the session root are skipped, and a notice says how many were
  skipped and why.
- It needs an OMD host with `terminal_pty_v2`. Without `omd_workspace`, `panel` falls back to `full`.
- One yazi runs per thread. It stops when you switch threads or OMD reloads, and its layout goes with it. If the
  workspace is turned off or the panel is removed while it runs, yazi moves to the full screen layout.

## More

- [Included mods](../../../docs/collection.md)
- [`omd_workspace`](../omd_workspace/README.md), whose dock can hold the yazi panel
- [`omd_files`](../omd_files/README.md), a file manager drawn by OMD itself
