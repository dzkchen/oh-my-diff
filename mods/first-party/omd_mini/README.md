# Mini interface

`omd_mini` (`0.1.0-preview.1`) is a scrollback-first presentation of the same OMD session, inspired by [OpenCode's mini mode](https://opencode.ai/v2/docs/cli/). It is installed inactive in OMD+ and can be installed explicitly in OMD Core.

```text
omd-package mod enable omd_mini   # once
omd mini                          # new session
omd mini resume <thread>          # any codex arguments pass through
/omd_mini:switch                  # inside a session: reopen it in the other interface
```

`omd mini` runs the installed `codex` launcher with `--no-alt-screen`, so the conversation stays in the terminal's own scrollback, and sets `OH_MY_DIFF_PRESENTATION=mini` plus a per-launch `OH_MY_DIFF_LAUNCH` id. It is the same Codex session and agent engine: approvals, attachments, slash commands, Esc interruption, resume and fork stay native. The launcher refuses when the mod is not enabled, in upstream-style direct mode, and when stdin or stdout is not a terminal (use `codex exec` for piped or scripted runs).

In a mini session the mod sets:

- `completed_tools: 'compact'`: a successful agent command collapses to one `completed · N output lines` summary; failed tools, user shell commands and input sent to a running unified-exec session stay in full.
- a short prompt placeholder;
- one status segment on Codex's own status line, which already shows the model and reasoning: the last turn's time (or `working`), context use and the settled paid cost, or the primary usage-limit window when nothing was paid (at most 40 characters).

It also sets `inline_sites: 'hidden'` (`terminal_inline_sites_v1`), so other mods' sidebar, header and named sites stay out of the inline viewport; their dialogs, message templates, status segments and commands still apply, and mod diagnostics stay visible. Sessions not started by `omd mini` read the two variables once at start and resume, then do nothing.

**Switching.** `/omd_mini:switch` records a request for the current launch run in the mod's user store (refused while a turn runs; running it again cancels). After you quit, the `omd mini` launcher, which stays the parent process, reads the request with `omd store export` and reopens the thread with `codex resume <thread>` in the other interface; quitting without a request ends it. A session started by plain `codex` gets the `omd mini resume <thread>` command to run instead. Mods cannot quit Codex, so the switch happens at your quit, which is the safe boundary: the thread, its history and its settings are on disk.

Limitations: codex arguments other than the thread are not carried into a switched run; the status segment updates when a turn starts or ends or a notification arrives, not every second (Codex's own working indicator counts time during a turn); and earlier scrollback is never repainted, so a theme or template change applies to new output only.
