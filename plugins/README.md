# Bundled Codex plugins

OMD ships two Codex plugins in the local `oh-my-diff` marketplace:

- `omd-guidance-hooks` contains three explicit skills and two controlled
  lifecycle hooks. It has no MCP server, app connector, network dependency, or
  TypeScript mod.
- `omd-repository-tools` exposes the retained `omd-graph` and `omd-health`
  operators through seven prompt-approved local MCP tools and includes the
  `$omd-repository-tools:omd-code-health` skill. It has no network dependency,
  app connector, hook, or TypeScript mod.

The private installer copies the hash-pinned marketplace to
`$OMD_PREFIX/plugins/oh-my-diff` without editing shared Codex state. Installation
into Codex is a separate operator action:

```sh
codex plugin marketplace add "$OMD_PREFIX/plugins/oh-my-diff"
codex plugin add omd-guidance-hooks@oh-my-diff
codex plugin add omd-repository-tools@oh-my-diff
```

Review and trust the plugin hook hashes when Codex prompts. Do not bypass hook
trust. The hooks do nothing unless `OMD_MODE=enabled` and the active controlled
manifest selects the corresponding communication or reactive capability.

Invoke the skills explicitly:

- `$omd-guidance-hooks:omd-simplicity-guidance` with `full-short-v1` or
  `tiny-selected-v1`;
- `$omd-guidance-hooks:omd-concise-updates` for lead-to-user communication;
- `$omd-guidance-hooks:omd-structured-reports` for worker output when the controlled manifest
  selects structured reports.

The native runtime remains authoritative for guideline promotion and rollback,
instruction priority, held-out isolation, structured report admission, reactive
rule bounds, permissions, accounting, child isolation, and context rebuilds.
The `PostToolUse` hook records exact successful host events for native
consumption. Codex does not emit `PostToolUse` for failed, blocked, or aborted
calls, so the existing native lifecycle contributor remains the bounded fallback
for those measured event gaps and for an absent or untrusted hook.

The repository plugin requires the managed `omd-graph` and `omd-health`
executables on `PATH`. Its tool server accepts only a canonical absolute
repository and normalized repository-relative artifact paths, refuses symlinked
or escaping paths, bounds request/runtime/output sizes, and invokes the Rust
operators without a shell. Every returned artifact includes a SHA256 receipt,
and health-report paging refuses a file that no longer matches its check
receipt. Every tool call prompts through Codex. A health exit code of 2 is
returned as a completed report with introduced findings, while other nonzero
exits remain refusals. The tool never edits source.

Use `graph_snapshot` to create the JSON graph and deterministic static HTML,
then `graph_validate`, `graph_html`, or `graph_select` against fresh source.
The existing native `/graph` view remains the optional live terminal navigator
over that same JSON; no second terminal mod is required. Use the health skill to
create an explicitly approved baseline, run the one-shot check, and page through
introduced, debt, and uncertain findings without treating repair scope as edit
authorization.

Remove the installed copy and marketplace before deleting the private prefix:

```sh
codex plugin remove omd-guidance-hooks@oh-my-diff
codex plugin remove omd-repository-tools@oh-my-diff
codex plugin marketplace remove oh-my-diff
```
