# omd_lsp_sync

Runs your language servers in the background so the agent sees the errors each edit introduces, and can go to definitions, find references and rename.

## Turn it on

It comes with OMD+ but starts off. Turn it on in `/mods`, or run:

```sh
omd-package mod enable omd_lsp_sync
```

It needs a language server on your `PATH`:

| Language | Servers tried, in order |
| --- | --- |
| Python | `pyright-langserver`, `pylsp`, `jedi-language-server` |
| TypeScript and JavaScript | `typescript-language-server`, `vtsls` |
| Rust | `rust-analyzer` |
| Java | `jdtls` |

## Use it

It has no commands of its own. After a tool call that can write files, the agent's result gets the new errors in each edited file and the ones the edit fixed. Warnings are left out, and nothing is added when nothing changed. When the agent reads a supported file with a shell command such as `cat` or `sed -n`, it also gets that file's existing errors.

To look at the results yourself, turn on [`omd_lsp_view`](../omd_lsp_view/README.md) as well.

## Needs and limits

- A language without an installed server is skipped, and the agent is told why.
- It starts a server only when a file in that language is changed or read.
- Feedback is capped at 4 KB per tool call, with at most 8 new and 8 fixed errors per file. If a check can't finish, the result says the feedback is incomplete.
- The agent also gets tools for definition, references, code actions, symbol rename and file rename. Edits use a backup and roll back if they fail. They cover text edits in local files only; actions that run server commands are refused.
- Remote files and full parity with your editor's language support are not covered.

Credit: based on [pi-lens](https://pi.dev/packages/pi-lens) by Apostolos Mantzaris (MIT); reimplemented, no code copied. Auto-fix, commit blocking and security scanners are not included.
