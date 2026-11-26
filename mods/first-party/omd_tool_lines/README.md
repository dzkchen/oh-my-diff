# omd_tool_lines

Makes the transcript read like the Codex desktop app. All the agent's tool calls between two messages (commands,
reads and searches, web searches, MCP and app tools, edits, image views and subagents) collapse into one muted line of
verb phrases in first-use order, and while a step runs the line shows it. Open the line for one line per step. It's on
by default in OMD+. OMD Core doesn't include it.

```text
• Read files, ran commands, searched the web
• Running git -C work/qwen-doc sparse-checkout set docs
✗ Ran commands, edited a file · 1 failed · exit 255
• Papers, Code and Prior started working
```

Opened, the line lists its steps:

```text
• Read files, ran commands, searched the web
• Read bench.py
• Searched for refine in x.sh
✗ Command failed (ls -lh /data) · exit 2
• python3 bench.py --quick
• Searched the web for qwen3 release notes
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
| Click a tool line | Open or close it: a summary line lists its steps, a step line shows its full output. |
| `F4`, then `Up` or `Down`, then `Enter` | The same, from the keyboard. |
| `Ctrl+T` | Open the full transcript, where every row is shown in full. |

## Settings

It has no settings.

## Needs and limits

- It uses the `terminal` and `builtins` capabilities to draw tool rows and group tool calls. Its host needs
  `render_hooks_v1`, `builtins_v1`, `transcript_exec_groups_v1` and `transcript_tool_groups_v1`.
- A summary with failures is marked `✗` with its failed and interrupted counts and the latest failure's exit code; a
  failed command step reads `Command failed (…)` with its exit code, and a failed MCP or app tool shows its first
  error line. Open the step for the output.
- Consecutive subagent updates of one kind merge: `Papers, Code and Prior started working`, `Papers finished`.
- Viewed images draw natively when their step is listed.
- Your own `!cmd` commands, approvals, `/diff` and the assistant's messages look the same as before.
- Inline sessions (`--no-alt-screen`) print one-line rows to scrollback. `Ctrl+T` shows them in full.
- Narrow terminals shorten the line.
- Turning the mod off brings back the standard drawing and stops grouping new tool calls. Existing groups stay
  grouped.

## More

- [Included mods](../../../docs/collection.md)
- [Terminal UI reference](../../reference/terminal-ui.md)
