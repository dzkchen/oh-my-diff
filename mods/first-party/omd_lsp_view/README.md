# omd_lsp_view

Look up hover text, definitions, references, symbols, errors, code actions and formatting from your language servers, in a popup or a card above the prompt.

## Turn it on

It comes with OMD+ but starts off. Turn it on in `/mods` after [`omd_lsp_sync`](../omd_lsp_sync/README.md), which runs the language servers and needs one on your `PATH`:

```sh
omd-package mod enable omd_lsp_sync
omd-package mod enable omd_lsp_view
```

## Use it

Lines and columns start at 1. `PATH` is relative to the repository.

| Command | What it does |
| --- | --- |
| `/lsp hover PATH:LINE[:COL]` | Show the documentation at a position. |
| `/lsp definition PATH:LINE[:COL]` | List where a symbol is defined. |
| `/lsp references PATH:LINE[:COL]` | List where a symbol is used. |
| `/lsp actions PATH:LINE[:COL]` | List code actions. Enter on one applies it after you confirm. |
| `/lsp symbols PATH` | List the symbols in a file. |
| `/lsp format PATH` | Format a file, after you confirm. |
| `/lsp diagnostics [PATH]` | List the errors in a file, or in every tracked file. |
| `/lsp workspace QUERY` | Search symbols across running servers. |
| `/lsp open PATH:LINE` | Show the lines around a position, with that file's errors. Starts its server if needed. |
| `/lsp editor PATH:LINE` | Open the position in the editor command set as `editor` in `host.json`. |
| `/lsp pane` | Pin the results above the prompt, or pop them out again. Alt+l focuses the pinned results. |
| `/lsp back` or `/lsp close` | Go back to the results, or close the view. |
| `/lsp servers` | Show or hide a card of running servers, their open files and current errors. |

Enter on a location shows the lines around it, with Open in editor and Back.

## Needs and limits

- If `omd_lsp_sync` is off, the view tells you to turn it on.
- It adds no language server of its own, and shows nothing until you ask.
- A missing server, an unsupported request or a stale file returns the reason.
- Code actions that run server commands are listed but refused.

Credit: based on the editor code intelligence in [neoism](https://github.com/parkers0405/neoism) by Parker Settle and the Neoism contributors (MIT); reimplemented, no code copied.
