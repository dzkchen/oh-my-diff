# OMD anchored edits

Optional plugin component `0.2.0-preview.1`, public mod API `0.2.0-experimental.5`. The TypeScript component owns anchor validation, unique matching, line scope and replacement construction. The host provides ordinary reads and authorized compare-and-swap transactions. No anchor behavior was added to Rust.

Install the plugin from the repository's optional marketplace in the Codex home you explicitly choose:

```sh
codex plugin marketplace add /absolute/path/to/oh-my-diff/plugins/optional
codex plugin add omd-anchored-edit@oh-my-diff-optional
```

Installation supplies guidance and inert component files. Inspect `.codex-plugin/omd.json` with `omd-mod plugin-component PLUGIN_ROOT`; trust the reported component digest and exact `tools,fs.read,fs.write` capabilities in an external mod store, then enable that component explicitly:

```sh
omd-mod inspect COMPONENT_PATH
omd-mod trust STORE COMPONENT_PATH INSPECT_SHA256 tools,fs.read,fs.write
omd-mod enable STORE COMPONENT_PATH
```

Use the selected host's `OMD_MOD_STORE`. OMD+ and OMD Core users can install the component explicitly; neither profile enables it. Disable with `omd-mod disable STORE COMPONENT_PATH`. The ordinary patch tool remains available when this component is absent or disabled. Plugin removal alone does not remove a separately trusted component; disable that component as well.

The component's `read` tool returns exact UTF-8 text and SHA-256. Its `edit` tool accepts:

```json
{"files":[{"path":"src/value.ts","sha256":"SHA256_FROM_READ","start_line":3,"end_line":5,"edits":[{"before":"return oldValue;","after":"return newValue;"}]}]}
```

Each `before` must occur exactly once within the inclusive line range. Hash changes, ambiguity, overlap, generated-file markers, missing files or malformed input reject the whole proposal before any write. Whitespace and final newlines are preserved. Read denial stays a denial. Transaction failures require inspecting current files before retrying: per-file replacement is atomic, but multi-file rollback can conflict with another writer and is not crash-atomic.

Historical API 0.1 acceptance used Apple Silicon macOS, pinned Codex `0.157.0` and Node `24.18.0` to check actual writes, stale rejection, unchanged unrelated files, ordinary diff review, and the existing `apply_patch` path with the component disabled. Current API 0.2 offline fixtures cover anchor and transaction decisions; live-session parity, perfect edits, token savings and public support remain unqualified.
