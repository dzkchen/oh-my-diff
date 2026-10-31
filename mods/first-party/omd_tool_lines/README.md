# omd_tool_lines

Shows each agent tool call as one transcript line: the tool, its short arguments and the result.

```text
• Shell cargo test -p codex-omd · ok · 214 lines · 41.3s
• Edit tui/src/transcript_view/layout.rs · +9 −3
✗ Shell pnpm lint · exit 1 · 18 lines · 2.4s
```

## Turn it off

It is on by default in OMD+. Turn it off in `/mods`, or run:

```sh
omd mods disable omd_tool_lines
```

## Use it

| Action | What it does |
| --- | --- |
| Click a tool line, or `F4`, Up and Down, then Enter | Open or close the full output for that row. |
| `Ctrl+T` | Open the full transcript, where every row is shown in full. |

## Needs and limits

- Failures stay on one line, marked `✗` with the exit code.
- Your own `!cmd` commands, approvals, `/diff` and the assistant's messages look the same as before.
- Inline sessions (`--no-alt-screen`) print one-line rows to scrollback. `Ctrl+T` shows them in full.
- Narrow terminals shorten names and arguments.
- Turning the mod off brings back the standard rows at once.
