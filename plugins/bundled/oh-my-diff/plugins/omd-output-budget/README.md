# omd-output-budget

Keeps large shell and tool results out of the model's context. A result over its budget reaches the model as a
bounded excerpt: the command header with its exit status, the first and last lines, and for a failed call the error
and warning lines from the middle, with markers for what was left out. The complete output is kept by content hash,
and the model can page it or search it instead of rerunning the command.

The plugin adds guidance for the model. The budget and tools come from its mod component, `omd_output_budget`.

## Turn it on

Add the plugin, then enable its component with these capabilities:

```text
interception,tools,store,lifecycle
```

[Plugins](../../../../README.md) has the steps to add a plugin and enable a component.

## Use it

The component budgets every tool result the model receives, except its own tools' results. Calls made by code-mode
cells get their complete output, and the cell's own result is budgeted instead. A merged batch call passes through
whole (`omd_tool_absorb` runs each call in it as its own budgeted call).

- A result within its budget passes through unchanged.
- A larger one becomes an excerpt that ends with an `[omd_output_budget: …]` marker naming the output's id.
- `read` pages a kept output or document by line.
- `search` ranks kept outputs and documents for a query and returns matching lines with their ids and line numbers.
- `fetch` downloads a documentation page with `curl` through the session's own command tool, so the session's
  sandbox, network permission and approvals apply. It keeps the page's text and returns its outline.

Codex normally cuts a command's output to about 10,000 tokens before anything else sees it. While the component is
enabled, threads it starts get a 65,536-token tool output limit. When the model leaves `max_output_tokens` unset on
`exec_command` or `write_stdin`, the component raises it to 65,536 tokens. The kept output then covers up to about
256 KB. Past that, Codex still cuts the middle, and the excerpt says so. An output longer than the 256 KiB an
interceptor sees ends its excerpt with the kept output's real last lines. The component never changes the command
itself.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `result_bytes` | `16384` | Bytes of one result delivered before it becomes an excerpt (1024 to 262144) |
| `turn_bytes` | `131072` | Bytes of results delivered in one turn before every further result is cut to the floor (4096 to 1048576) |
| `floor_bytes` | `4096` | Excerpt size once a turn's budget is spent, at most `result_bytes` (1024 to 65536) |

## Needs and limits

- Outputs and documents are kept per thread. The newest 120 stay searchable. Older ones are dropped.
- The per-turn count is kept per thread. Tool calls that run in parallel can be counted in either order.
- Search ranks outputs by their most frequent words (about 2 KB of them per output) and reads the best four in full,
  or the one you name. A query word that no output's index contains makes it read the newest outputs too. It reads
  about 640 KB per search at most, and `partial` says when it stopped early.
- One `read` scans about 640 KB from the start of an output. `next_cursor` continues from where the last one ended.
- `fetch` refuses pages over 2 MB, keeps the first 240 KB of a page's text and refuses URLs with quotes, spaces,
  backslashes, backticks or `$`.
- If the host can't keep the full output, the model gets its head and tail, at most about 40 KB as Codex would send,
  marked as such.
- Threads that already exist keep their tool output limit when you enable the component.

## More

- [Remove a plugin](../../../../README.md#remove-a-plugin)
- Credit: behavior ported, without code, from [`context-mode`](https://pi.dev/packages/context-mode) 1.0.169
  (Elastic-2.0) and [`@moyai/pi-session-hoarder`](https://pi.dev/packages/@moyai/pi-session-hoarder) 0.2.0
  (Apache-2.0). See [`THIRD_PARTY_NOTICES.md`](../../../../../THIRD_PARTY_NOTICES.md).
