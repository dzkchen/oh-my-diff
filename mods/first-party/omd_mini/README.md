# Mini interface

`omd_mini` is a scrollback-first presentation of the same OMD session, inspired by [OpenCode's mini mode](https://opencode.ai/v2/docs/cli/). It comes with OMD+ but starts off; turn it on in `/mods` or with the command below.

```text
omd-package mod enable omd_mini   # once
omd mini                          # new session
omd mini resume <thread>          # any codex arguments pass through
/omd_mini:switch                  # inside a session: reopen it in the other interface
```

`omd mini` runs the installed `codex` launcher with `--no-alt-screen` and `-c tui.show_tooltips=false`, so the conversation stays in the terminal's own scrollback without tips, and sets `OH_MY_DIFF_PRESENTATION=mini` plus a per-launch `OH_MY_DIFF_LAUNCH` id. It also sets `OMD_TUI_HEADER=off`, which drops the Codex header card, `OMD_TUI_COMPOSER=plain`, which draws the prompt as a bare `›` line without a box, placeholder or hint row, and `OMD_TUI_MOD_UI=omd_mini`, which keeps every other mod's rows, cards, sidebar and status segments out of the session while those mods keep running: their commands, dialogs, tool-row hooks and toasts still work. It is the same Codex session and agent engine: approvals, attachments, slash commands, Esc interruption, resume and fork stay native. The launcher refuses when the mod is not enabled, in upstream-style direct mode, and when stdin or stdout is not a terminal (use `codex exec` for piped or scripted runs).

A mini session shows the transcript, the bare prompt and one status line: the model, context use and the settled paid cost, or the primary usage-limit window when nothing was paid. Mod diagnostics stay visible, and the host summary returns to the status line only when a mod failed. Sessions not started by `omd mini` read the two variables once at start and resume, then do nothing. One-line tool rows come from `omd_tool_lines`, which OMD+ turns on by default.

**Switching.** `/omd_mini:switch` records a request for the current launch run in the mod's user store (refused while a turn runs; running it again cancels). After you quit, the `omd mini` launcher, which stays the parent process, reads the request with `omd store export` and reopens the thread with `codex resume <thread>` in the other interface, keeping the session options you launched with (model, profile, sandbox, approvals, `-C`, `--add-dir`, `-c` overrides, feature toggles, remote and search options); quitting without a request ends it. A session started by plain `codex` gets the `omd mini resume <thread>` command to run instead. Mods cannot quit Codex, so the switch happens at your quit, which is the safe boundary: the thread, its history and its settings are on disk.

Limitations: a switched run drops the first run's prompt, images, `--worktree`, `--no-alt-screen` and resume selectors, and any option Codex 0.163 does not have; the status line updates when a notification arrives, not every second (Codex's own working indicator counts time during a turn); and earlier scrollback is never repainted, so a theme or template change applies to new output only.
