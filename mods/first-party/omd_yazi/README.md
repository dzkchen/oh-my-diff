# omd_yazi

Runs the [yazi](https://yazi-rs.github.io) file manager inside the session. `/yazi [path]` starts it, with keys, mouse and colors passed through (image previews don't show). The files you pick become `@path` mentions in the prompt when you leave it.

## Turn it on

It comes with OMD+ but starts off. Turn it on in `/mods`, or run:

```sh
omd-package mod enable omd_yazi
```

It runs `yazi` outside the sandbox with your real `HOME`, without network, and with your `EDITOR`, `VISUAL`, `XDG_CONFIG_HOME` and `YAZI_CONFIG_HOME`, so trusting the mod grants that (`os_access` lists only `yazi`). The first start asks once per `yazi` binary, and again when the binary changes. Install yazi first: `brew install yazi`, or see the [installation guide](https://yazi-rs.github.io/docs/installation); without it `/yazi` says so.

## Use it

| Command | What it does |
| --- | --- |
| `/yazi [path]` | Start yazi in `path` (relative to the session directory); while it runs, focus it again |
| `/yazi --stop` | Close it without inserting mentions |

Pick files with yazi's open action (Enter) or its chooser keys. When yazi quits (`q`), the picked paths are inserted at the prompt's cursor as `@relative/path`, `@"quoted path"` when the path has spaces. Ctrl+] leaves yazi without closing it.

Without a `path`, yazi starts where it last ended in this thread, if that is inside the session root, else in the session directory.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `placement` | `panel` | `full`: yazi takes the screen above a compact chat, through the workspace's full screen mode while `omd_workspace` is on. `panel`: a Yazi tab of the `omd_workspace` dock, which must be on, else `full`; in a thread where yazi isn't running the tab says how to start it |

## Needs and limits

- At most 16 mentions; paths outside the session root are skipped.
- Needs the `terminal_pty_v2` host feature. Without `omd_workspace`, `panel` falls back to `full`.
- One yazi per thread. It stops when you switch threads or OMD reloads, and its layout goes with it.
