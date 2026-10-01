# Herdr integration

`omd_herdr` tells [Herdr](https://herdr.dev) what the OMD session in a pane is doing, following Herdr's [agent integration contract](https://herdr.dev/docs/add-herdr-support/). It is installed inactive in OMD+ and can be installed explicitly in OMD Core.

```text
/mods enable omd_herdr
/herdr        # shows the pane it reports to, or that it is inert
```

How it works:

- The mod declares `HERDR_ENV`, `HERDR_PANE_ID`, `HERDR_BIN_PATH` and `HERDR_SOCKET_PATH` and reads them with `exec.run {program: 'env'}`. Unless `HERDR_ENV=1` and all four are well formed, it does nothing else.
- Native `thread/status/changed` notifications drive the reports, so the host's precedence applies: a pending approval or question is `blocked` (with the message `waiting for approval` or `waiting for input`), a running turn is `working`, anything else is `idle`. Sub-agent and ephemeral side threads are ignored.
- Each report runs `"$HERDR_BIN_PATH" pane report-agent "$HERDR_PANE_ID" --source omd --agent codex --state … --agent-session-id <thread> --seq <ms> -- codex resume <thread>` through `exec.run` in the session sandbox, with the socket granted through `unix_sockets: ['HERDR_SOCKET_PATH']`. The host canonicalizes and hashes the binary and admits only a user-owned socket outside the repository. Herdr 0.9.3 takes the pane and the resume command from that one report.
- The agent label is `codex` because OMD runs as the `codex` launcher: Herdr keeps a reported resume command only when the label matches the agent it detects in the pane (with `--agent omd` the command was accepted but never saved).
- The sequence number is the report time in milliseconds, so a delayed or older report never overrides a newer one, also across an OMD restart in the same pane.
- `codex resume <thread>` restores the thread's model and reasoning settings itself, so the resume command does not change when settings change; it is sent with every report.
- When the session's thread stops (quit, or a switch to another thread), the mod runs `pane release-agent`, which also drops the saved resume command. The next status report takes the pane again. A Herdr restart saves the session before it hangs up the panes, so the resume command survives it, and the restarted server runs `codex resume <thread>` in the pane, which restores the thread with its model settings.

The mod never reads the screen, answers prompts, installs Herdr, focuses panes or replaces the multiplexer. Argv holds only the pane id, state and session id.

Limitations:

- After an abrupt exit (crash, `kill -9`) no release is sent; Herdr clears the agent when the shell prompt returns.
- Disabling the mod mid-session sends no release; the last report stays until OMD exits.
- Launch-time permission flags (`--sandbox`, `--ask-for-approval`, `--profile`) are not carried into the resume command, so a restored session uses the configured defaults.
- Reports run on the notification thread with a 2 s limit each (measured: `env` 13–15 ms plus 20–23 ms per report); a failed report is dropped, and the next status change reports again. Outside Herdr each status change costs one `env` run; a disabled mod costs nothing.
- Running it together with Herdr's own Codex hook (`herdr integration install codex`) was not tested.
