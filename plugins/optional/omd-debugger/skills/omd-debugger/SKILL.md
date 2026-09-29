---
name: omd-debugger
description: Inspect a reproducible Python failure with the opt-in sandboxed OMD debugger mod and separately installed debugpy.
---

# OMD Python debugger

Use this skill only when the `omd_debugger` mod has been reviewed, explicitly
trusted, and enabled with its `tools`, `exec`, `store`, `lifecycle`, and `network`
capabilities. Installing the plugin skill does not activate debugging. The
tools are named `mod_omd_debugger_open`, `start`, `breakpoints`, `configure`,
`inspect`, `control`, `detach`, and `status` under the same prefix. Each call
uses native permission and task admission. Set `OMD_MODE=omd` for the current host.

The separate Python dependency must provide `python3 -m debugpy.adapter` on
the effective Codex `PATH`. Historical pre-migration acceptance used pinned Codex 0.156.1,
OMD 0.1.0, mod API 0.1.0-experimental.8, Apple Silicon macOS Darwin 25.5.0,
Python 3.14.6, and debugpy 1.8.22. Only Python launch is exposed. C, Go,
attach, other platforms, and other adapter versions have no acceptance claim.
Those historical tests do not qualify the current API 0.2 port.
Do not install dependencies or change system Developer mode from this skill.

First reproduce the Python failure with ordinary tests. Open `debugpy`, then
call `start` with `mode: launch` and the absolute target path. Poll `status`
until ready, set exact source breakpoints, and call `configure`. At a stop,
inspect threads, stack frames, scopes, and variables using returned IDs.
`evaluate` can execute target code and expose local values, so request it only
when the user explicitly wants that expression. Use `control` to continue,
step, or pause, then call `detach` to terminate the launched target and close
the adapter. Reopen after failure; prior frame and breakpoint IDs are stale.

The native host owns executable identity, the read-only repository sandbox,
restricted external network, cancellation, timeouts, process-group cleanup,
and cleanup on disable, reload, or task stop. The mod returns bounded fields
and generic errors rather than raw adapter logs.
