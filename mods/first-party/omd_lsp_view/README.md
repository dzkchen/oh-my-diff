# omd_lsp_view

Opt-in first-party mod (`0.2.0-preview.1`, API `0.2.0-experimental.5`): a
code-intelligence view over the language servers that
[`omd_lsp_sync`](../omd_lsp_sync/README.md) already runs. It adds no second
client; enable both.

```text
/lsp hover|definition|references|actions PATH:LINE[:COL]
/lsp symbols|diagnostics|format PATH
/lsp diagnostics                every tracked file
/lsp workspace QUERY            workspace symbols from running servers
/lsp open PATH:LINE | editor PATH:LINE | pane | back | close
```

Lines and columns are 1-based. Slash commands cannot call framed processes or
services, so `/lsp` shows "Asking the language server…", publishes the request
on `omd_lsp_view/request`, and the mod's own channel callback calls
`omd.lsp`'s `query` method and republishes the view. Results open in a popup;
Pin to pane moves them to the `omd_lsp_view/lsp` site (`/pane split right lsp`
in `omd_panes`). Enter on a location shows the surrounding lines with Open in
pane (`omd_panes`), Open in editor (the host's `editor` setting), Edit here
(an `omd_editor` buffer, on the same line even with unsaved edits) and Back;
Enter on a code action applies it after a confirmation. Formatting also
confirms first. Without an enabled `omd_lsp_sync` the host keeps this mod
inactive with `service_provider_missing`; if the provider fails later, the
view says to enable it.

`/lsp open PATH:LINE` is a file view: it also asks for that file's
diagnostics, which starts its server on demand, and lists the file's errors
under the excerpt (Enter jumps). A Language servers pane in the sidebar shows
each running or failed server, its open documents and current errors from
`omd_lsp_sync/status`.

`omd_panes` opens the view from the file tree (symbols, diagnostics, format)
and from a selected viewer line (definition, references, hover per symbol,
code actions, symbols, diagnostics, format) when its `lsp` setting is on.

Capabilities: `commands`, `terminal`, `store`, `events` (the request hop),
`exec` (`pwd` and `awk` for excerpts) and `services` (imports `omd.lsp`
1.0.0).

Ported from [neoism](https://github.com/parkers0405/neoism)'s editor code
intelligence (Parker Settle and the Neoism contributors, MIT; see
`THIRD_PARTY_NOTICES.md`); reimplemented over the OMD mod API, no code copied.
