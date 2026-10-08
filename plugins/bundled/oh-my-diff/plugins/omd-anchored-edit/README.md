# OMD anchored edits

Optional plugin component `0.3.0-preview.1`, public mod API `0.2.0-experimental.5`. The TypeScript component owns anchor computation, verification, relocation and line assembly; the host provides reads, a read-only `rg` run and authorized compare-and-swap transactions. No anchor behavior is in Rust.

Install the plugin from the bundled `oh-my-diff` marketplace in the Codex home you explicitly choose:

```sh
omd-package plugins
codex plugin add omd-anchored-edit@oh-my-diff
```

Installation supplies guidance and inert component files. Inspect `.codex-plugin/omd.json` with `omd-mod plugin-component PLUGIN_ROOT`; trust the reported component digest and exact `tools,fs.read,fs.write,exec` capabilities in an external mod store, then enable that component explicitly:

```sh
omd-mod inspect COMPONENT_PATH
omd-mod trust STORE COMPONENT_PATH INSPECT_SHA256 tools,fs.read,fs.write,exec
omd-mod enable STORE COMPONENT_PATH
```

Use the selected host's `OMD_MOD_STORE`. OMD+ and OMD Core users can install the component explicitly; neither profile enables it. Disable with `omd-mod disable STORE COMPONENT_PATH`. The ordinary patch tool remains available when this component is absent or disabled. Plugin removal alone does not remove a separately trusted component; disable that component as well.

Tools:

- `read {paths, offset?, limit?}` returns `LINE#HASH|content` lines. The four-character Crockford base32 hash covers the line number and content, so repeated lines still get distinct anchors.
- `search {pattern, path?, glob?, literal?, ignore_case?, context?}` runs `rg --json` read-only and returns matches and context lines with the same anchors.
- `edit {files: [{path, edits}]}` applies `replace`, `delete`, `insert_before`, `insert_after`, `append` and `prepend` ops (at most 8 files and 32 ops) against one read and submits a single transaction.

Only cited lines are verified. A mismatched anchor is relocated only when exactly one line within 16 lines holds the original content; the call then returns that fresh anchor and writes nothing. Ambiguous, stale and malformed anchors, overlapping ranges, missing, generated and no-op edits are all reported together before any write. Successful edits return a compact diff whose added lines carry fresh anchors. CRLF, mixed line endings, final-newline state and bytes outside edited lines are preserved. Calls refuse more than 96 KB of files, because every read counts against the host's per-callback receipt budget. Read and search denials stay denials. Per-file replacement is atomic; multi-file rollback can conflict with another writer and is not crash-atomic.

Ported from [`@d3ara1n/pi-hashline-edit`](https://pi.dev/packages/@d3ara1n/pi-hashline-edit) 0.7.1 (d3ara1n, MIT) and [`pi-hashline-edit-pro`](https://pi.dev/packages/pi-hashline-edit-pro) 4.4.4 (RimuruW and Yugimob, MIT); see `THIRD_PARTY_NOTICES.md`. Allocation-based anchors, the persistent undo log and regex bulk replace are not ported, and the earlier whole-file-hash `before`/`after` interface is retired. Local fixtures cover anchors, drift, CRLF, limits and denial; live-session parity, edit quality and token savings remain unqualified.
