# omd_lsp_view

Looks up hover text, definitions, references, symbols, errors, code actions and formatting from your language servers,
in a popup or a card above the prompt. It's off by default in OMD+. OMD Core doesn't include it.

## Turn it on

It uses the language servers that [`omd_lsp_sync`](../omd_lsp_sync/README.md) runs, so turn that on first, with a
server on your `PATH`. Then turn on `omd_lsp_view` in `/mods`, or run:

```sh
omd mods enable omd_lsp_sync
omd mods enable omd_lsp_view
```

[Manage mods](../../../docs/manage-mods.md) covers the other ways to turn a mod on or off.

## Use it

Lines and columns start at 1. `PATH` is relative to the repository.

| Command | What it does |
| --- | --- |
| `/lsp hover PATH:LINE[:COL]` | Show the documentation at a position. |
| `/lsp definition PATH:LINE[:COL]` | List where a symbol is defined. |
| `/lsp references PATH:LINE[:COL]` | List where a symbol is used. |
| `/lsp actions PATH:LINE[:COL]` | List code actions. `Enter` on one applies it after you confirm. |
| `/lsp symbols PATH` | List the symbols in a file. |
| `/lsp format PATH` | Format a file, after you confirm. |
| `/lsp diagnostics [PATH]` | List the errors in a file, or in every tracked file. |
| `/lsp workspace QUERY` | Search symbols across running servers. |
| `/lsp open PATH:LINE` | Show the lines around a position, with that file's errors. Starts its server if needed. |
| `/lsp editor PATH:LINE` | Open the position in the editor command set as `editor` in `host.json`. |
| `/lsp pane` | Pin the results above the prompt, or pop them out again. `Alt+l` focuses the pinned results. |
| `/lsp back` or `/lsp close` | Go back to the results, or close the view. |
| `/lsp servers` | Show or hide a card of running servers, their open files and current errors. |

In a large repository a server runs without the workspace index, and `/lsp servers` shows `degraded:` and the reason.

For example, `/lsp references src/app.ts:12:8` lists every use of the symbol at line 12, column 8. `Enter` on a location
shows the lines around it, with Open in editor and Back.

## Settings

It has no settings.

## Needs and limits

- If `omd_lsp_sync` is off, the view tells you to turn it on.
- It adds no language server of its own, and shows nothing until you ask.
- A missing server, an unsupported request or a stale file returns the reason.
- Code actions that run server commands are listed but refused.

## More

- [Included mods](../../../docs/collection.md)
- [Terminal UI](../../reference/terminal-ui.md) in the mod API reference
- Credit: based on the editor code intelligence in [neoism](https://github.com/parkers0405/neoism) by Parker Settle and
  the Neoism contributors (MIT); reimplemented, no code copied.
