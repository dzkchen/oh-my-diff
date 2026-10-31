# omd_tool_lines

Shows each tool call the agent makes, such as a command it runs or a file it edits, as one transcript line: the tool,
its short arguments and the result. It's on by default in OMD+. OMD Core doesn't include it.

```text
• Shell cargo test -p codex-omd · ok · 214 lines · 41.3s
• Edit tui/src/transcript_view/layout.rs · +9 −3
✗ Shell pnpm lint · exit 1 · 18 lines · 2.4s
```

## Turn it off

Turn it off in `/mods`, or run:

```sh
omd mods disable omd_tool_lines
```

[Manage mods](../../../docs/manage-mods.md) covers the other ways to turn a mod on or off.

## Use it

| Command or key | What it does |
| --- | --- |
| Click a tool line | Open or close the full output for that row. |
| `F4`, then `Up` or `Down`, then `Enter` | The same, from the keyboard. |
| `Ctrl+T` | Open the full transcript, where every row is shown in full. |

## Settings

It has no settings.

## Needs and limits

- Failures stay on one line, marked `✗` with the exit code.
- Your own `!cmd` commands, approvals, `/diff` and the assistant's messages look the same as before.
- Inline sessions (`--no-alt-screen`) print one-line rows to scrollback. `Ctrl+T` shows them in full.
- Narrow terminals shorten names and arguments.
- Turning the mod off brings back the standard rows at once.

## More

- [Included mods](../../../docs/collection.md)
- [Terminal UI reference](../../reference/terminal-ui.md)
