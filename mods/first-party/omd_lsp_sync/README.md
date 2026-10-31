# omd_lsp_sync

Runs your language servers in the background so the agent sees the errors each edit introduces, and can go to
definitions, find references and rename. It's off by default in OMD+. OMD Core doesn't include it.

A language server is the program your editor uses to find errors and jump to definitions, such as
`pyright-langserver` for Python.

## Turn it on

Turn it on in `/mods`, or run:

```sh
omd mods enable omd_lsp_sync
```

[Manage mods](../../../docs/manage-mods.md) covers the other ways to turn a mod on or off.

It needs a language server on your `PATH`:

| Language | Servers tried, in order |
| --- | --- |
| Python | `pyright-langserver`, `pylsp`, `jedi-language-server` |
| TypeScript and JavaScript | `typescript-language-server`, `vtsls` |
| Rust | `rust-analyzer` |
| Java | `jdtls` |

## Use it

It has no commands of its own. After a tool call that can write files, OMD adds to the tool's result the errors the edit
introduced in each edited file, and the errors it fixed. Warnings are left out, and nothing is added when nothing
changed. When the agent reads a supported file with a shell command such as `cat` or `sed -n`, it also gets that file's
existing errors.

For example, if the agent's edit to `app.py` leaves an undefined name, the tool result lists that error, and the next
edit that fixes it lists it as fixed.

The agent also gets tools for definition, references, code actions, symbol rename and file rename. To look at the
results yourself, turn on [`omd_lsp_view`](../omd_lsp_view/README.md) as well.

## Settings

It has no settings.

## Needs and limits

- It asks to run your language servers in the sandbox, read and watch workspace files, add errors to tool results, add
  tools the agent can call, edit files for renames and code actions, ask you to confirm, share its servers with
  `omd_lsp_view` and keep its state. The capabilities are `exec`, `fs.read`, `outputs`, `tools`, `fs.write`,
  `terminal`, `services`, `store`, `lifecycle`, `inventory` and `events` (see
  [Trust and permissions](../../../docs/trust-and-permissions.md#what-a-mod-can-do)).
- It never installs a language server. Install one from the table under [Turn it on](#turn-it-on).
- A language without an installed server is skipped, and the agent is told why.
- A server starts only when a file in that language is changed or read, so the first edit in a language already
  reports its errors. A patch that only deletes files starts no server.
- A server that has been idle for 15 minutes is stopped when the session goes idle. The next change in that language
  starts it again.
- Sometimes OMD can't tell exactly which files changed. Then it re-reads the files already open in a server, and the
  status reads `resynced: <reason>` until the next change it tracks. That happens after:
  - more than 64 unannounced changes (for example a `git checkout` or `pnpm install`);
  - more than 128 changed paths, or 16,000 bytes of path names, at once;
  - a change outside the read scope.
- A repository over 20,000 files or 128 MiB is too large to track: the status reads
  `degraded: workspace index exceeds bounds`, and open files are still re-read.
- Feedback is capped at 4 KB per tool call, with at most 8 new and 8 fixed errors per file. If a check can't finish,
  the result says so.
- When the agent's tools edit files, they back up first and roll back on failure. They edit text in local files only.
  Code actions that run server commands are refused. Definition and references can open a file the server hasn't seen
  yet, within the same budget, and refuse a file that changed since the server last read it.
- Remote files and full editor parity are not covered.

## More

- [Included mods](../../../docs/collection.md)
- [Tools](../../reference/tools.md) and [workspace changes](../../reference/workspace-files.md) in
  the mod API reference
- Credit: based on [pi-lens](https://github.com/apmantza/pi-lens) by Apostolos Mantzaris (MIT); reimplemented, no code
  copied. Auto-fix, commit blocking and security scanners are not included.
