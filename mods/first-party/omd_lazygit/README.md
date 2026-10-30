# omd_lazygit

Runs [lazygit](https://github.com/jesseduffield/lazygit) inside the session. `/lazygit [path]` starts it in the session directory (or `path`, relative to it), with keys, mouse and colors passed through. The files you edit in it open in your editor or become `@path` mentions in the prompt.

## Turn it on

It comes with OMD+ but starts off. Turn it on in `/mods`, or run:

```sh
omd-package mod enable omd_lazygit
```

It runs `lazygit` outside the sandbox with your real `HOME`, so trusting the mod grants that (`os_access` lists only `lazygit`). The first start asks once per `lazygit` binary, and again when the binary changes. Install lazygit first: `brew install lazygit`, or see the [installation guide](https://github.com/jesseduffield/lazygit#installation); without it `/lazygit` says so.

## Use it

| Command | What it does |
| --- | --- |
| `/lazygit [path]` | Start lazygit; while it runs, focus it again |

Ctrl+] leaves lazygit for the prompt, and quitting lazygit (`q`) closes it. Entering its region with Ctrl+] or a click focuses it again.

Pressing `e` (edit) on a file in lazygit hands the file back to OMD, which does what the `edit` setting says. Lazygit's own `os.edit` commands are replaced for this run only by a small config file that sends the path and line to OMD.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `placement` | `full` | `full`: lazygit takes the screen above a compact chat. `panel`: a Lazygit tab of the `omd_workspace` dock, which must be on, else `full` |
| `edit` | `editor` | `editor`: open the file at its line in the `editor` argv of `host.json`, after a confirmation. `composer`: insert `@path` at the prompt's cursor |

## Needs and limits

- Your own lazygit config still loads: the mod finds its folder with `lazygit -cd` and passes `config.yml` there first, then its injected file, through `--use-config-file`. Your files are never changed. If `lazygit -cd` fails, only the injected file is used and your config is not loaded. `LG_CONFIG_FILE` is replaced the same way.
- Only files inside the session root are opened or mentioned; others show a notice.
- Needs the `terminal_pty_v2` host feature. Both placements use the mod's own layout or panel site, so with `omd_workspace` on, use `panel`.
- One lazygit per thread. It stops with the thread or when OMD reloads.
