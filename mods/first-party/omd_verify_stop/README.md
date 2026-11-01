# omd_verify_stop

Stops the agent from finishing a coding task with untested edits. When a turn would end after code edits and no test
or check has passed since the last edit, it continues the turn once with a short checklist. If a check then fails, it
continues once more with the failure. It's experimental, and neither OMD+ nor OMD Core installs it.

## Turn it on

```sh
omd install omd_verify_stop
omd mods enable omd_verify_stop
```

It asks for the `autonomous` grant: at most 2 `turn_stop` continuations per turn. It never queues turns. For `codex
exec`, trust it ahead of time (`omd-mod trust`); a headless run can't show the trust dialog.

## Use it

It watches tool output in the turn:

- Edits: `apply_patch` files, mod edit tools (`*_edit`, `*_write`, `*_create`) with `path`, `file_path` or
  `files[].path`, `sed -i`/`perl -i` and shell redirects into files. Docs (`.md`, `.rst`, `.txt`) don't count, and
  deleting a file the agent created doesn't either.
- Checks: test runners and build checks (pytest, `python -m unittest`, `runtests.py`, `cargo test|check|clippy`,
  `go test|vet`, `pnpm|npm|yarn test`, jest, vitest, tsc, `make test|check`, rspec, phpunit, mvn, gradle and others),
  passing on exit code 0. A check left running is settled when `write_stdin` reports its exit code.

When the turn would stop after an edit with no passing check since:

1. The first continuation asks it to reproduce the issue (only if nothing ran before the first edit), run the most
   relevant existing tests (naming the runner found from `Cargo.toml`, `go.mod`, `pyproject.toml`,
   `tests/runtests.py`, lockfiles and so on), check for regressions, delete scratch and reproduction files (listing the
   files it created) and leave existing tests alone unless the task needs a change.
2. The second continuation happens only when a check after the last edit failed, and carries the last 1,500 characters
   of its output.

It never continues when nothing was edited, when the turn ended with an error or when you interrupted it.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `max_continuations` | `2` | Continuations per turn, 0 to 2. `0` turns it off. |

## Needs and limits

- Commands are recognized by pattern. A test run through an unusual wrapper script doesn't count, and a shell edit
  made another way (for example a Python one-liner) isn't seen.
- A continuation costs a model request. A turn passing a check after its last edit costs nothing.
- A turn whose check couldn't run (a missing module or command, or no network) isn't continued: the agent can't
  verify there, and a missing import your change caused is treated the same way.
- Every mod together gets at most 4 continuations per turn.

## More

- [`turn_stop` interceptors](../../reference/sessions-and-turns.md#turn_stop-interceptors) in the mod API reference
- [`omd_edit_guard`](../omd_edit_guard/README.md), which catches syntax errors right after each edit
