# omd_mini

Runs the same OMD session in a minimal interface. The conversation prints into your terminal's own scrollback, with a
bare prompt and one status line. It's off by default in OMD+. OMD Core doesn't include it.

## Turn it on

Turn it on in `/mods`, or run:

```sh
omd mods enable omd_mini
```

[Manage mods](../../../docs/manage-mods.md) covers the other ways to turn a mod on or off.

## Use it

Start a session from a shell:

```sh
omd mini
```

Any `codex` arguments pass through, so `omd mini resume THREAD` resumes a thread in the mini interface.

| Command | What it does |
| --- | --- |
| `omd mini [codex arguments]` | Start a mini session |
| `/omd_mini:switch` | Inside a session: reopen it in the other interface when you quit |

A mini session shows the transcript, the bare prompt and one status line. The status line shows the model, context use
and the settled paid cost. When nothing was paid, it shows the primary Codex usage-limit window instead. Mod diagnostics
stay visible, and the host summary comes back to the status line only when a mod failed. One-line tool rows come from
`omd_tool_lines`, which OMD+ turns on by default.

It is the same Codex session and agent engine: approvals, attachments, slash commands, `Esc` interruption, resume and
fork stay native. Other mods keep running, and their commands, dialogs, tool-row hooks and toasts still work, but
their rows, cards, sidebar and status segments are hidden.

### Switch interfaces

`/omd_mini:switch` asks to reopen this session in the other interface when you quit. It's refused while a turn runs,
and running it again cancels the request. After you quit, the `omd mini` launcher reopens the thread with
`codex resume THREAD` in the other interface. It keeps the session options you launched with: model, profile, sandbox,
approvals, `-C`, `--add-dir`, `-c` overrides, feature toggles, remote and search options. Quitting without a request
ends the session. A session started with plain `codex` gets the `omd mini resume THREAD` command to run instead. The
switch waits until you quit because mods can't quit Codex, and by then the thread, its history and its settings are
on disk.

### What `omd mini` sets

`omd mini` runs the installed `codex` launcher with `--no-alt-screen` and `-c tui.show_tooltips=false`, so the
conversation stays in the terminal's own scrollback without tips. It also sets these environment variables:

| Variable | What it does |
| --- | --- |
| `OH_MY_DIFF_PRESENTATION=mini` | Marks the session as mini |
| `OH_MY_DIFF_LAUNCH` | A per-launch id, used by `/omd_mini:switch` |
| `OMD_TUI_HEADER=off` | Drops the Codex header card |
| `OMD_TUI_COMPOSER=plain` | Draws the prompt as a bare `›` line without a box, placeholder or hint row |
| `OMD_TUI_MOD_UI=omd_mini` | Hides every other mod's rows, cards, sidebar and status segments |

Sessions not started by `omd mini` read `OH_MY_DIFF_PRESENTATION` and `OH_MY_DIFF_LAUNCH` once at start and resume,
then do nothing.

## Settings

It has no settings.

## Needs and limits

- A terminal. The launcher refuses when stdin or stdout isn't a terminal (use `codex exec` for piped or scripted runs),
  when the mod is off, and in `direct` mode (plain Codex with no mods, see
  [Troubleshooting](../../../docs/troubleshooting.md#a-mod-breaks-codex)).
- A switched run drops the first run's prompt, images, `--worktree`, `--no-alt-screen` and resume selectors, and any
  option Codex `0.166.0` doesn't have.
- The status line updates when a notification arrives, not every second. Codex's own working indicator counts time
  during a turn.
- Earlier scrollback is never repainted, so a theme or template change applies to new output only.

## More

- [Included mods](../../../docs/collection.md)
- [Terminal UI](../../reference/terminal-ui.md) in the mod API reference
- Credit: inspired by [OpenCode's mini mode](https://opencode.ai/v2/docs/cli/) (MIT); reimplemented, no code copied.
