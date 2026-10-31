# omd_lsp_sync

Runs your language servers in the background so the agent sees the errors each edit introduces, and can go to definitions, find references and rename.

## Turn it on

It comes with OMD+ but starts off. Turn it on in `/mods`, or run:

```sh
omd mods enable omd_lsp_sync
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
- A server starts only when a file in that language is changed or read, so the first edit in a language already reports its errors. A patch that only deletes files starts no server.
- When OMD cannot report exactly what changed, it re-reads the files already open in a server instead, and the status reads `resynced: <reason>` until the next tracked change. That happens after:
  - more than 64 unannounced changes (for example a `git checkout` or `pnpm install`);
  - more than 128 changed paths, or 16,000 bytes of path names, at once;
  - a change outside the read scope.
- A repository over 20,000 files or 128 MiB is too large to track: the status reads `degraded: workspace index exceeds bounds`, and open files are still re-read.
- Feedback is capped at 4 KB per tool call, with at most 8 new and 8 fixed errors per file. If a check can't finish, the result says so.
- The agent also gets tools for definition, references, code actions, symbol rename and file rename. Edits use a backup and roll back on failure. They cover text edits in local files only. Actions that run server commands are refused. Definition and references open a target file the server has not seen yet, within the same budget, and refuse a target that changed since the server looked.
- Remote files and full editor parity are not covered.

Credit: based on [pi-lens](https://pi.dev/packages/pi-lens) by Apostolos Mantzaris (MIT); reimplemented, no code copied. Auto-fix, commit blocking and security scanners are not included.
