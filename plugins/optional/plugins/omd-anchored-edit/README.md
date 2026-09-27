# OMD anchored edits

Optional plugin `0.1.0-preview.1`, public mod API `.9`. The TypeScript component owns anchor validation, unique matching, line scope and replacement construction. The host provides ordinary reads and authorized compare-and-swap transactions. No anchor behavior was added to Rust.

Install the plugin from the repository's optional marketplace in the Codex home you explicitly choose:

```sh
codex plugin marketplace add /absolute/path/to/oh-my-diff/plugins/optional
codex plugin add omd-anchored-edit@oh-my-diff-optional
```

Installation supplies guidance and inert component files. Inspect `.codex-plugin/omd.json` with `omd-mod plugin-component PLUGIN_ROOT`; trust the reported component digest and exact `tools,workspace` capabilities in an external mod store, then enable that component explicitly:

```sh
omd-mod inspect COMPONENT_PATH
omd-mod trust STORE COMPONENT_PATH INSPECT_SHA256 tools,workspace
omd-mod enable STORE COMPONENT_PATH
```

Use the selected host's `OMD_MOD_STORE`. Full and platform-only users can install the component explicitly; neither profile enables it. Disable with `omd-mod disable STORE COMPONENT_PATH`. The ordinary patch tool remains available when this component is absent or disabled. Plugin removal alone does not remove a separately trusted component; disable that component as well.

The component's `read` tool returns exact UTF-8 text and SHA-256. Its `edit` tool accepts:

```json
{"files":[{"path":"src/value.ts","sha256":"SHA256_FROM_READ","start_line":3,"end_line":5,"edits":[{"before":"return oldValue;","after":"return newValue;"}]}]}
```

Each `before` must occur exactly once within the inclusive line range. Hash changes, ambiguity, overlap, generated-file markers, missing files or malformed input reject the whole proposal before any write. Whitespace and final newlines are preserved. Read denial stays a denial. Transaction failures require inspecting current files before retrying: per-file replacement is atomic, but multi-file rollback can conflict with another writer and is not crash-atomic.

Local acceptance uses Apple Silicon macOS, pinned Codex `0.157.0` and Node `24.18.0`. Native synthetic sessions prove actual writes, stale rejection, unchanged unrelated files, ordinary diff review, and the existing `apply_patch` path with the component disabled. This does not establish perfect edits, token savings or public support.
