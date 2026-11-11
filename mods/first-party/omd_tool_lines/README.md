# omd_tool_lines

Groups adjacent agent shell commands into one transcript line. The row shows the latest active, failed or
interrupted command and totals for running, failed and interrupted commands. Other tools each get one line with
short arguments and their result. It's on by default in OMD+. OMD Core doesn't include it.

```text
• 8 commands cargo test -p codex-omd · ok · 41.3s
✗ 2 searches needle · 1 interrupted · 0.2s
• Edit tui/src/transcript_view/layout.rs · +9 −3
✗ Shell pnpm lint · exit 1 · 18 lines · 2.4s
  └ error: lint failed
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
| Click a tool line | Open or close the full output for that row or command group. |
| `F4`, then `Up` or `Down`, then `Enter` | The same, from the keyboard. |
| `Ctrl+T` | Open the full transcript, where every row is shown in full. |

## Settings

It has no settings.

## Needs and limits

- It uses the `terminal` and `builtins` capabilities to draw tool rows and group shell commands. Its host needs
  `render_hooks_v1`, `builtins_v1` and `transcript_exec_groups_v1`.
- Groups show failed and interrupted command counts separately, marked `✗`, with the latest failure's exit code
  (`2 failed · exit 127`); expand the group for each command.
- Shell commands join their group when they start, so its running count includes commands such as `cargo test`.
- A failed row is marked `✗` with the exit code, and a second, muted line shows why: the last output line of a shell
  command (the latest failed one in a group), or the first error line of an MCP or app tool.
- Your own `!cmd` commands, approvals, `/diff` and the assistant's messages look the same as before.
- Inline sessions (`--no-alt-screen`) print one-line rows to scrollback. `Ctrl+T` shows them in full.
- Narrow terminals shorten names and arguments.
- Turning the mod off brings back the standard drawing and stops grouping new commands. Existing command groups
  stay grouped.

## More

- [Included mods](../../../docs/collection.md)
- [Terminal UI reference](../../reference/terminal-ui.md)
