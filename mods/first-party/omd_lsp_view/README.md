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
/lsp servers                    show or hide the Language servers card
```

Lines and columns are 1-based. Slash commands cannot call framed processes or
services, so `/lsp` shows "Asking the language server…", publishes the request
on `omd_lsp_view/request`, and the mod's own channel callback calls
`omd.lsp`'s `query` method and republishes the view. Each request carries a
number the view is waiting for; a request still queued after `/lsp close`,
Back or a newer request is dropped without querying the server. Results open in a popup;
Pin (`/lsp pane`) moves them to a Code intelligence card above the prompt.
Its controls remain clickable and keyboard-focusable; focused controls scroll
into view when the available height is limited. Enter on a location
shows the surrounding lines with Open in editor (the host's `editor` setting)
and Back; Enter on a code action applies it after a confirmation. Formatting also
confirms first. Without an enabled `omd_lsp_sync` the host keeps this mod
inactive with `service_provider_missing`; if the provider fails later, the
view says to enable it.

`/lsp open PATH:LINE` is a file view: it also asks for that file's
diagnostics, which starts its server on demand, and lists the file's errors
under the excerpt (Enter jumps). The mod draws nothing until asked: `/lsp
servers` toggles a Language servers card above the prompt with each running
or failed server side by side, its open documents and up to three current
errors from `omd_lsp_sync/status`. Neither card opens a sidebar.

Capabilities: `commands`, `terminal`, `store`, `events` (the request hop),
`exec` (`awk` for excerpts), `services` (imports `omd.lsp` 1.0.0) and
`inventory` (the repository root for `/lsp editor`).

Ported from [neoism](https://github.com/parkers0405/neoism)'s editor code
intelligence (Parker Settle and the Neoism contributors, MIT; see
`THIRD_PARTY_NOTICES.md`); reimplemented over the OMD mod API, no code copied.
