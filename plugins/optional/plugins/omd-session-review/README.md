# OMD session review

Optional plugin component `0.2.0-preview.1`, public mod API `0.2.0-experimental.3`. The TypeScript component owns session selection, duplicate detection, classification and the report. The generic host supplies a read-only, repository-scoped session index and command dispatch. No report logic was added to Rust.

```sh
codex plugin marketplace add /absolute/path/to/oh-my-diff/plugins/optional
codex plugin add omd-session-review@oh-my-diff-optional
omd-mod plugin-component PLUGIN_ROOT
omd-mod inspect COMPONENT_PATH
omd-mod trust STORE COMPONENT_PATH INSPECT_SHA256 commands,sessions
omd-mod enable STORE COMPONENT_PATH
omd session-review --repo /absolute/project --store STORE --since 2026-09-01..2026-09-26
```

Use the actual component path and digest returned by inspection, and an external mod store selected by `OMD_MOD_STORE` or `--store`. Installation alone does not trust or enable the component. Both profiles support explicit installation. Neither activates it. Disable with `omd-mod disable STORE COMPONENT_PATH`; disabling the component is separate from removing the guidance plugin.

The end date is exclusive. Add `--session ID` for each selected session. Without IDs the command selects at most 12 newest eligible sessions from a bounded 100-row listing. It reads at most two pages per session, 24 pages and 48 KiB of projected source text. The report records bounds, omitted data, duplicate tasks and revision changes. It contains explicit-preference and inferred-pattern proposals, or no change. A repeated inferred pattern requires two distinct tasks; equivalent initial requests and parent tasks are deduplicated conservatively.

`omd-session://` citations identify session/turn/item/revision for source verification; they are not an installed app URL handler. The scan is deterministic and intentionally conservative, not a full semantic analysis. Redacted and truncated records are not used for proposals. No model request, network call, memory write, extension creation, activation or instruction edit is available to this command.

By default the dispatcher uses the selected Codex home and current opt-out database. Use `--home PATH` for an explicitly selected home. If layered repository/system configuration redirects SQLite storage, supply its actual `--sqlite-home PATH`; unavailable or unknown privacy policy fails closed. No records are scanned when the component is disabled.

Historical API 0.1 acceptance used pinned Codex `0.157.0`, Node `24.18.0` and synthetic sessions on Apple Silicon macOS, including plugin installation/removal and sandboxed dispatch. Current API 0.2 offline fixtures cover bounded selection, revision drift and fail-closed reports; personal sessions, live dispatch parity and real user productivity remain unqualified.
