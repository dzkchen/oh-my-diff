# Plugin components and shell commands

How a plugin carries a mod component, how the `omd` shell command dispatches exported CLI aliases, and how session
reads and request helpers behave outside the TUI.

## Plugin component descriptor

A plugin can contain `.codex-plugin/omd.json` with:

```json
{"schema":1,"component":"component","sha256":"<inspected package digest>"}
```

The contained directory is an ordinary public-API package with `mod.json` and `index.ts`.

- Inspect it with `omd-mod plugin-component PLUGIN_ROOT`; the inspector rejects traversal, symlinks and digest
  changes.
- Trust and enable the inspected component through the existing mod-store workflow. The descriptor does not
  activate it.

## `omd COMMAND` shell dispatch

`omd COMMAND --repo PATH [--store STORE] [--home CODEX_HOME] [--sqlite-home DIR]` dispatches an exported CLI alias. It offers
`evidence.*` and `sessions.*` only; model and process operations are unavailable. The host store must be protected
from agent process writes. Ambiguous command ownership fails closed.

## Independent examples

Independent examples live in [`examples/virtual_reader`](../examples/virtual_reader),
[`examples/scoped_data`](../examples/scoped_data), [`examples/review_probe`](../examples/review_probe), and
[`examples/workspace`](../examples/workspace). They demonstrate shared interfaces, not production
implementations.

## Evidence across compaction

Completed-turn packets retain bounded original visible records across a host-observed compaction, tagging each
segment's records with its history revision. Compaction summaries do not replace those records. An unobserved
history reset or interrupted compaction still rejects evidence explicitly. The extension decides how to select and
summarize a truncated packet.

## Session reads and the SQLite home

Live session reads use the runtime's configured state database, including a separate SQLite home. Standalone
commands resolve the selected user configuration/profile and `CODEX_SQLITE_HOME`; `--sqlite-home` explicitly
selects the state directory.

- If a repository or system configuration redirects SQLite, standalone dispatch requires that explicit directory
  rather than guessing.
- Relative SQLite directories are rejected.
- The pinned reader consults `state_5.sqlite` read-only before and after a read, and does not modify transcripts or
  opt-out state.

## Request helper supervision

Granted request helpers use the host's bounded request supervisor. It captures a completed helper result before
returning it, then terminates the process group; cancellation, deadline and loss of the host also terminate the
group. Existing long-running service supervision remains separate. The helper, supplied by the extension, owns
request parsing, remote protocols and content selection.
