# omd_edit_guard

Catches syntax errors as soon as an edit introduces them. After each file edit it runs a fast syntax check on the
changed files and, when one fails, adds the error with file and line to the tool output so the model fixes it at once.
It's experimental, and neither OMD+ nor OMD Core installs it.

## Turn it on

```sh
omd install omd_edit_guard
omd mods enable omd_edit_guard
```

It needs no authority grant and works in `codex exec`. Checks run in the session sandbox.
Turn it on in the shell or `/mods` before a `codex exec` run: a headless run can't show the trust dialog, so a mod that
isn't trusted yet stays off.

## Use it

It checks the files of each successful `apply_patch` (added, updated and moved files) and of mod edit tools
(`*_edit`, `*_write`, `*_create`, `*_replace`) with `path`, `file_path` or `files[].path`. In a Git repository it also
checks the files a write-like shell command changed (a redirect, heredoc, `tee`, `sed -i`, `perl -i`, `cp`, `mv`,
`.write(`, `write_text(` or `writeFile`): it lists changed and untracked files before and after the command and checks
those whose content the command changed:

| Files | Checker |
| --- | --- |
| `.py`, `.pyw` | `python3` `ast.parse` |
| `.json` | `python3` `json.load` |
| `.js`, `.mjs`, `.cjs` | `node --check` |
| `.sh`, `.bash` | `bash -n` |
| `.rb` | `ruby -c` |
| `.php` | `php -l` |
| `.go` | `gofmt -l -e` |

It reports an error as introduced by the edit when the file's `HEAD` version parses or it saw the file parse earlier in
the thread; a file it reported stays reported until it parses. A new file that fails gets a softer note instead (again
after each shell command that writes it, while it stays untracked), since the file may use syntax the checker rejects (JSONC, JSX in a `.js` file, a newer Python than the sandbox's
`python3`). Nothing is added when every check passes.

## Needs and limits

- Checkers come from the sandbox's `PATH`, which may not include tools installed only through mise, nvm or pyenv; a
  missing checker is skipped without a message. Files over 1 MB are skipped, and each check has 3 seconds.
- At most 8 checkable files per edit and 800 bytes of error per file are reported.
- A file that already failed at `HEAD` and wasn't seen parsing is never reported, even for a new error.
- Shell commands are matched by pattern, so a write made another way (`python fix.py`, `npm run format`) isn't
  checked. Shell edits outside a Git repository, or beyond the first 200 changed checkable files, aren't checked
  either. TypeScript, Rust and other compiled languages aren't checked.
- In code mode a cell receives its tool's own result, so an error from an edit inside a cell is added to the output
  of the cell or the next tool call the model sees.

## More

- [Interceptors](../../reference/interceptors.md) in the mod API reference
- [Benchmark](../../../docs/benchmarks/harness-mods.md) of this mod with the other harness mods
- [`omd_verify_stop`](../omd_verify_stop/README.md), which asks for tests before the agent finishes
