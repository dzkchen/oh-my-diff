# omd_edit_guard

Catches syntax errors as soon as an edit introduces them. After each file edit it runs a fast syntax check on the
changed files and, when one fails, adds the error with file and line to the tool output so the model fixes it at once.
Neither OMD+ nor OMD Core installs it.

## Turn it on

```sh
omd install omd_edit_guard
omd mods enable omd_edit_guard
```

It needs no authority grant and works in `codex exec`. Checks run in the session sandbox.

## Use it

It checks the files of each successful `apply_patch` (added, updated and moved files) and of mod edit tools
(`*_edit`, `*_write`, `*_create`) with `path`, `file_path` or `files[].path`:

| Files | Checker |
| --- | --- |
| `.py`, `.pyw` | `python3` `ast.parse` |
| `.json` | `python3` `json.load` |
| `.js`, `.mjs`, `.cjs` | `node --check` |
| `.sh`, `.bash` | `bash -n` |
| `.rb` | `ruby -c` |
| `.php` | `php -l` |
| `.go` | `gofmt -l -e` |

It reports only errors the edit introduced: an updated file is reported when its `HEAD` version parses, a file it saw
parse earlier in the thread is reported, and a new file is always checked. A file it reported stays reported until
it parses. Nothing is added when every check passes.

## Needs and limits

- A checker missing from `PATH` is skipped. Files over 1 MB are skipped, and each check has 3 seconds.
- At most 8 files per edit and 800 bytes of error per file are reported.
- A file that already failed at `HEAD` and wasn't seen parsing is never reported, even for a new error.
- Shell edits (`sed -i`, redirects) aren't checked. TypeScript, Rust and other compiled languages aren't checked.
- In code mode a cell receives its tool's own result, so an error from an edit inside a cell is added to the output
  of the cell or the next tool call the model sees.

## More

- [Interceptors](../../reference/interceptors.md) in the mod API reference
- [`omd_verify_stop`](../omd_verify_stop/README.md), which asks for tests before the agent finishes
