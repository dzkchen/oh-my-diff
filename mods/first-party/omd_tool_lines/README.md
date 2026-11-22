# omd_tool_lines

Makes the transcript read like the Codex desktop app. Adjacent agent shell commands collapse into one muted line of
verb phrases in first-use order, and while one runs the line shows it. Other tools each get one short step line. It's
on by default in OMD+. OMD Core doesn't include it.

```text
• Read files, ran commands, searched files
• Running git -C work/qwen-doc sparse-checkout set docs
✗ Ran commands · 1 failed · exit 255
✗ Command failed (ls -lh /data) · exit 2
• Searched the web for qwen3 release notes
• Edited tui/src/transcript_view/layout.rs · +9 −3
• Papers, Code and Prior started working
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
- A group with failures is marked `✗` with its failed and interrupted counts and the latest failure's exit code; a
  single failed command reads `Command failed (…)` with its exit code, and a failed MCP or app tool shows its first
  error line. Open the row for the output.
- Only shell commands group. Web searches, edits, MCP and app tools and subagent rows stay one line each, and
  `Started` / `Interacted with` subagent activity lines are drawn natively.
- An opened group shows every command with its native output.
- Your own `!cmd` commands, approvals, `/diff` and the assistant's messages look the same as before.
- Inline sessions (`--no-alt-screen`) print one-line rows to scrollback. `Ctrl+T` shows them in full.
- Narrow terminals shorten the line.
- Turning the mod off brings back the standard drawing and stops grouping new commands. Existing command groups
  stay grouped.

## More

- [Included mods](../../../docs/collection.md)
- [Terminal UI reference](../../reference/terminal-ui.md)
