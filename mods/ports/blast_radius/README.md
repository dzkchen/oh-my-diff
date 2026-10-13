# blast_radius

Holds a risky shell command until you have seen what it would change.

On every `exec_command` call the mod classifies the command. Anything else runs untouched. For a risky one it measures the effect with read-only, sandboxed `exec.run` calls, asks with a native Proceed / Cancel choice (`terminal.prompt`) and runs the command only on Proceed, with a `Blast Radius: running it` toast. Cancel, dismissing, a prompt that cannot be shown, or a mod error denies the call with a reason the model sees ("do not retry unless the user asks"). Codex's own approval may still ask afterwards when the command needs it.

## What counts as risky

| Command | Measured with |
| --- | --- |
| `rm` with `-r`, `-R`, `-f` or long forms | `find` and `du -k` over the expanded paths: files, size, first 10 names |
| `git reset --hard` | `git status --porcelain` (tracked changes) and `git diff --shortstat HEAD` |
| `git checkout .`, `git restore .` (not `--staged` only) | the unstaged subset of the same status, limited to the current folder |
| `git clean` | `git clean -n` with your `-d`, `-x`, `-X`, `-e` and pathspecs, never `-f` |
| `git push` with `--force`, `-f`, `--force-with-lease` or `+ref` | `git log <source>..<remote>/<branch>`: commits the push drops, as of the last fetch |
| `alembic upgrade`, `rails db:migrate`, `prisma migrate`, `manage.py migrate`, other `migrate` | the tool's status or history command, pending migrations only |

`cd`, `pushd`, `popd`, `( subshell )` and `git -C` earlier in the line move the folder measured. `sudo`, `env`, `time`, `nice`, `VAR=value` and a leading backslash are looked through. Only the first risky segment of a compound command is measured.

## Limits of this port

- Measurements run in OMD's sandbox, so the folder must be inside the repository. A `cd` or `-C` to `-`, to `~` or outside the repository, and paths using `~`, `$` or backticks, are not measured. The prompt then says "could not measure" and still asks.
- `exec.run` has no network and a private `HOME`. Migration status commands that need a database can fail; the prompt says so and still asks.
- The Prisma lister runs `prisma migrate status` through the runner the command used (`npx`, `pnpm`, `pnpm exec`, `yarn`, `bunx` or none; any other prefix is not measured). The Rails lister is `bundle exec rails db:migrate:status`; upstream used `bin/rails`, which `exec.run` cannot start from inside the repository.
- Git runs with `LC_ALL=C` so its output parses the same in every locale.
- The report is one line (`Command: … · Would … · note · files`) because the native prompt shows its message as one wrapped line; upstream's pane listed one file per line with colours. Non-ASCII characters are shown as `?`, and the report is cut at about 1,900 bytes.
- A failed measurement says `could not measure it` with the error, where upstream had separate wording for a missing folder, a non-Git folder and a failed dry run. There is no 10-minute timeout or queue of held calls; the native prompt waits.
- Only `exec_command` is intercepted, not `write_stdin` or tools that run commands another way.

## Capabilities

- `interception`: a required `tool` interceptor for `exec_command`, so a mod fault fails the call closed rather than letting it run.
- `terminal`: `terminal.prompt` confirmation.
- `exec`: read-only `exec.run` for `pwd`, `bash`, `env` (to run `git`), `python3`, `alembic`, `bundle` and the Prisma runner.

No state, store, settings or network.

## Credit

Reimplemented over the Oh My Diff mod API from the Claude Code mod
[`blast-radius` 0.1.0](https://github.com/anthropics/claude-code-playground/tree/e9ab132d4575390ecbadfc54649712432b1a3351/claude-code/mods/blast-radius)
by Claude Code DevRel (Anthropic PBC), commit `e9ab132d4575390ecbadfc54649712432b1a3351`, licensed Apache-2.0.
The command classification follows the upstream rules; the hold, measurement and prompt use OMD's tool interceptor, `exec.run` and `terminal.prompt` instead of upstream's pane.
