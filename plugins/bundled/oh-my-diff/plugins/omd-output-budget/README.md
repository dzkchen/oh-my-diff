# OMD output budget

Keep large shell and tool results out of the model's context. A result over its budget reaches the model as a
bounded excerpt: the command header with its exit status, the first and last lines, and the error and warning lines
from the middle, with markers for what was left out. The complete output is kept by content hash, and the model can
page it or search it instead of rerunning the command.

The plugin adds guidance. The tools come from a `mod/` component that you trust and enable separately.

## Install

```sh
omd-package plugins
codex plugin add omd-output-budget@oh-my-diff
```

## Enable the component

Adding the plugin doesn't enable the component. Use the mod store of the host you run:

```sh
omd-mod plugin-component PLUGIN_ROOT
omd-mod inspect COMPONENT_PATH
omd-mod trust STORE COMPONENT_PATH INSPECT_SHA256 interception,tools,store,lifecycle
omd-mod enable STORE COMPONENT_PATH
```

`plugin-component` prints the component path. `trust` takes the digest that `inspect` prints. For the store, see
[manage mods](../../../../../docs/manage-mods.md).

## Use

The component watches `exec_command`, `write_stdin`, `shell`, `shell_command`, code-mode `exec` cells and MCP tool
results.

- A result within its budget passes through unchanged.
- A larger one becomes an excerpt that ends with an `[omd_output_budget: …]` marker naming the output's id.
- `read` pages a kept output or document by line.
- `search` ranks kept outputs and documents for a query and returns matching lines with their ids and line numbers.
- `fetch` downloads a documentation page with `curl` through the session's own command tool, so the session's
  sandbox, network permission and approvals apply. It keeps the page's text and returns its outline.

Codex normally cuts a command's output to about 10,000 tokens before anything else sees it. While the component is
enabled, threads it starts get a 65,536-token tool output limit, and when the model leaves `max_output_tokens` unset
on `exec_command` or `write_stdin` the component raises it to 65,536 tokens. The kept output then covers up to about
256 KB; past that Codex still cuts the middle, and the excerpt says so. It never changes the command itself.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `result_bytes` | 6144 | Bytes of one result delivered before it becomes an excerpt |
| `turn_bytes` | 49152 | Bytes of results delivered in one turn before every further result is cut to the floor |
| `floor_bytes` | 2048 | Excerpt size once a turn's budget is spent |

## Limits

- Outputs and documents are kept per thread. The newest 120 stay searchable; older ones are dropped.
- The per-turn count is kept per thread; tool calls that run in parallel can be counted in either order.
- Search ranks outputs by their most frequent words and reads the best four in full (or the one you name), up to
  about 640 KB per search; `partial` says when it stopped early.
- `fetch` keeps the first 240 KB of a page's text and refuses URLs with quotes, spaces, backslashes, backticks or `$`.
- If the host can't keep the full output, the model gets its head and tail, at most about 40 KB as Codex would
  send, marked as such.
- Threads that already exist keep their tool output limit when you enable the component.

## Remove

```sh
omd-mod disable STORE COMPONENT_PATH
codex plugin remove omd-output-budget@oh-my-diff
```

## Credit

Behavior ported, without code, from [`context-mode`](https://pi.dev/packages/context-mode) 1.0.169 (Elastic-2.0) and
[`@moyai/pi-session-hoarder`](https://pi.dev/packages/@moyai/pi-session-hoarder) 0.2.0 (Apache-2.0). See
`THIRD_PARTY_NOTICES.md`.
