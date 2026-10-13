# blast_radius

Holds a risky shell command until you have seen what it would change.

On every `exec_command` call the mod classifies the command. Anything else runs untouched. For a risky one it measures the effect with read-only, sandboxed `exec.run` calls, shows the result in a native confirmation (`terminal.prompt`) and runs the command only if you accept. Declining, dismissing, a prompt that cannot be shown, or a mod error denies the call with a reason the model sees ("do not retry unless the user asks").

## What counts as risky

| Command | Measured with |
| --- | --- |
| `rm` with `-r`, `-R`, `-f` or long forms | `find` and `du -k` over the expanded paths: files, size, first 10 names |
| `git reset --hard` | `git status --porcelain` (tracked changes) and `git diff --shortstat HEAD` |
| `git checkout .`, `git restore .` (not `--staged` only) | the unstaged subset of the same status |
| `git clean` | `git clean -n` with your `-d`, `-x`, `-X`, `-e` and pathspecs, never `-f` |
| `git push` with `--force`, `-f`, `--force-with-lease` or `+ref` | `git log <source>..<remote>/<branch>`: commits the push drops, as of the last fetch |
| `alembic upgrade`, `rails db:migrate`, `prisma migrate`, `manage.py migrate`, other `migrate` | the tool's status or history command, pending migrations only |

`cd`, `pushd`, `popd`, `( subshell )` and `git -C` earlier in the line move the folder measured. `sudo`, `env`, `time`, `VAR=value` and a leading backslash are looked through. Only the first risky segment of a compound command is measured.

## Limits of this port

- Measurements run in OMD's sandbox, so the folder must be inside the repository. A `cd` or `-C` to `-`, to `~` or outside the repository, and paths using `~`, `$` or backticks, are not measured. The prompt then says "could not measure" and still asks.
- `exec.run` has no network and a private `HOME`. Migration status commands that need a database can fail; the prompt says so and still asks.
- The Prisma lister is `pnpm exec prisma migrate status` and the Rails lister `bundle exec rails db:migrate:status`; upstream used `npx --no-install` and `bin/rails`, which `exec.run` cannot start.
- Non-ASCII characters in the report are shown as `?`, and the report is cut at 1,900 bytes to fit the prompt.
- Only `exec_command` is intercepted, not `write_stdin` or tools that run commands another way.

## Capabilities

- `interception`: a required `tool` interceptor for `exec_command`, so a mod fault fails the call closed rather than letting it run.
- `terminal`: `terminal.prompt` confirmation.
- `exec`: read-only `exec.run` for `pwd`, `bash`, `git`, `python3`, `alembic`, `bundle` and `pnpm`.

No state, store, settings or network.

## Credit

Reimplemented over the Oh My Diff mod API from the Claude Code mod
[`blast-radius` 0.1.0](https://github.com/anthropics/claude-code-playground/tree/e9ab132d4575390ecbadfc54649712432b1a3351/claude-code/mods/blast-radius)
by Claude Code DevRel (Anthropic PBC), commit `e9ab132d4575390ecbadfc54649712432b1a3351`, licensed Apache-2.0.
The command classification follows the upstream rules; the hold, measurement and prompt use OMD's tool interceptor, `exec.run` and `terminal.prompt` instead of upstream's pane.
