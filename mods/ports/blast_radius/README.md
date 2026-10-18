# blast_radius

Holds a risky shell command until you have seen what it would change.

## Install it

From the curated directory:

```sh
omd install blast_radius
omd mods enable blast_radius
```

## How it works

1. Anything not risky runs untouched.
2. For a risky `exec_command`, the mod measures the effect with read-only commands in a sandbox.
3. You choose Proceed or Cancel.
4. Cancel, dismissing, or any mod error denies the call. The model is told not to retry unless you ask.

Codex's own approval may still ask afterwards.

## What counts as risky

| Command | What you see |
| --- | --- |
| `rm` with `-r`, `-R`, `-f` or long forms | Files, size, first 10 names |
| `git reset --hard` | Tracked changes and a diff summary |
| `git checkout .`, `git restore .` (not `--staged` only) | Unstaged changes in the current folder |
| `git clean` | A dry run (`-n`) with your options, never `-f` |
| `git push` with `--force`, `-f`, `--force-with-lease` or `+ref` | Commits the push drops, as of the last fetch |
| `alembic upgrade`, `rails db:migrate`, `prisma migrate`, `manage.py migrate`, other `migrate` | Pending migrations |

A `cd`, `pushd`, `popd`, `( subshell )` or `git -C` earlier in the line changes the folder measured. `sudo`, `env`, `time`, `nice` and `VAR=value` are looked through. Only the first risky part of a compound command is measured.

## Limits of this port

- The folder must be inside the repository. Paths with `~`, `$` or backticks, and a `cd` or `-C` to `-`, `~` or outside, aren't measured. The prompt says "could not measure" and still asks.
- The sandbox has no network, so migration status commands that need a database can fail. The prompt says so and still asks.
- Prisma runs through the runner your command used (`npx`, `pnpm`, `pnpm exec`, `yarn`, `bunx` or none). Any other prefix isn't measured.
- Rails uses `bundle exec rails db:migrate:status`, not upstream's `bin/rails`.
- The report is one line, non-ASCII shown as `?`, cut at about 1,900 bytes.
- There is no 10-minute timeout or queue of held calls.
- Only `exec_command` is checked, not `write_stdin`.

## Credit

Reimplemented over the Oh My Diff mod API from the Claude Code mod
[`blast-radius` 0.1.0](https://github.com/anthropics/claude-code-playground/tree/e9ab132d4575390ecbadfc54649712432b1a3351/claude-code/mods/blast-radius)
by Claude Code DevRel (Anthropic PBC), commit `e9ab132d4575390ecbadfc54649712432b1a3351`, licensed Apache-2.0.
The command classification follows the upstream rules; the hold, measurement and prompt use OMD's tool interceptor, `exec.run` and `terminal.prompt` instead of upstream's pane.
