# blast_radius

Pauses a risky shell command until you have seen what it would change. It's a port of the Claude Code mod
`blast-radius`. It's in the curated directory, but OMD+ and OMD Core don't install it.

## Install it

Pick it under Available in `/mods`, or run:

```sh
omd install blast_radius
omd mods enable blast_radius
```

It asks to pause the agent's shell commands, ask you to proceed or cancel, and run read-only commands in the sandbox to
measure a command's effect. The capabilities are `interception`, `terminal` and `exec`. See
[Manage mods](../../../docs/manage-mods.md) for the other ways to install and turn on a mod, and
[Trust and permissions](../../../docs/trust-and-permissions.md#what-a-mod-can-do) for what a capability allows.

## Use it

There's nothing to run. When the agent calls a risky `exec_command`:

1. Anything not risky runs untouched.
2. For a risky command, the mod measures the effect with read-only commands in a sandbox.
3. You choose Proceed or Cancel.
4. Cancel, dismissing, or any mod error denies the call. The model is told not to retry unless you ask.

Codex's own approval may still ask afterwards.

### What counts as risky

| Command | What you see |
| --- | --- |
| `rm` with `-r`, `-R`, `-f` or long forms | Files, size, first 10 names |
| `git reset --hard` | Tracked changes and a diff summary |
| `git checkout .`, `git restore .` (not `--staged` only) | Unstaged changes in the current folder |
| `git clean` | A dry run (`-n`) with your options, never `-f` |
| `git push` with `--force`, `-f`, `--force-with-lease` or `+ref` | Commits the push drops, as of the last fetch |
| `alembic upgrade`, `rails db:migrate`, `prisma migrate`, `manage.py migrate` | Pending migrations |
| any other `migrate` | No list. The prompt says it can't list the pending migrations. |

A `cd`, `pushd`, `popd` or `( subshell )` earlier in the line, or a `git -C` option, changes the folder measured.
`sudo`, `env`, `time`, `nice` and `VAR=value` are looked through. Only the first risky part of a compound command is
measured.

## Settings

It has no settings.

## Needs and limits

- The folder must be inside the repository. Paths with `~`, `$` or backticks, and a `cd` or `-C` to `-`, `~` or
  outside, aren't measured. The prompt says "could not measure" and still asks.
- The sandbox has no network, so migration status commands that need a database can fail. The prompt says so and
  still asks.
- Prisma runs through the runner your command used (`npx`, `pnpm`, `pnpm exec`, `yarn`, `bunx` or none). Any other
  prefix isn't measured.
- The report is one line, non-ASCII shown as `?`, cut at about 1,900 bytes.
- Only `exec_command` is checked, not `write_stdin`.

### Differences from upstream

The command classification follows the upstream rules.

- The pause, measurement and prompt use OMD's tool interceptor, `exec.run` and `terminal.prompt` instead of
  upstream's pane.
- Rails uses `bundle exec rails db:migrate:status`, not upstream's `bin/rails`.
- There is no 10-minute timeout or queue of held calls.

## More

- [Interceptors reference](../../reference/interceptors.md) for the tool interceptor this port uses.
- Credit: reimplemented over the Oh My Diff mod API from the Claude Code mod
  [`blast-radius` 0.1.0](https://github.com/anthropics/claude-code-playground/tree/e9ab132d4575390ecbadfc54649712432b1a3351/claude-code/mods/blast-radius)
  by Claude Code DevRel (Anthropic PBC), commit `e9ab132d4575390ecbadfc54649712432b1a3351`, licensed Apache-2.0.
