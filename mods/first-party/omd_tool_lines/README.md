# Tool lines

`omd_tool_lines` draws every agent tool call as one transcript line: a bullet, the tool name, its short arguments and a result marker.

```text
• Shell cargo test -p codex-omd · ok · 214 lines · 41.3s
• Read mod_render.rs, layout.rs · ok · 512 lines · 12ms
• Edit tui/src/transcript_view/layout.rs · +9 −3
✗ Shell pnpm lint · exit 1 · 18 lines · 2.4s
• docs.search query: render hooks · ok · 3 lines · 220ms
```

Shell commands, grouped reads, searches and listings (one line per call), patches, web searches, agent spawns and waits, MCP and mod tools, and image calls are covered. Failures stay on one line, marked `✗` with the exit code. User shell commands (`!cmd`), approvals, `/diff` and the assistant's messages keep their native drawing.

It is default-active in OMD+ and can be installed in OMD Core. It needs only the `terminal` capability and registers one `render` hook on `tool_call`, which draws from the row's props: it makes no host calls and keeps no state.

## Opening a row

In the fullscreen transcript, a click on a tool line, or F4 to focus tool rows, ↑/↓ to move and Enter (or →/←), toggles that row between the one-line form and the full native row. Ctrl+T opens the full transcript, where every row is native. Inline sessions (`--no-alt-screen`) write one-line rows to scrollback; Ctrl+T shows them in full there too.

The call that is still running keeps its native progress drawing until it finishes. Disabling the mod, or a broken copy, restores native rows at once.
