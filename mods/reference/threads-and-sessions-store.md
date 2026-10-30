# Threads, turns and sessions

Use it when a mod cancels a turn, keeps data per thread, reads what happened in a turn, or pages recorded sessions.
Host features: `store_thread_v1`, `turn_activity_v1`. The thread-scoped `store.*` operations are in
[State and storage](state-and-storage.md#store-operations).

## `turns.abort`

`turns.abort {turn_id}` (`threads`) requests cancellation of the named active turn in the current thread from a
user or event callback. Require `turn_abort_v1`.

- `{accepted: true}` means cancellation was accepted, not that cleanup has completed.
- A stale or absent turn, queued input or competing cancellation returns `accepted: false`.
- Tool callbacks cannot call it, and it cannot target another thread.
- Successful cancellation wakes idle listeners after cleanup.

## Thread-scoped store and `resume`

`store.*` accepts `scope: 'thread'`: data forks with the thread, is removed when the thread is deleted and kept
when it is archived. `resume` carries `last_turn` and `restarted`.

## `turns.activity`

`turns.activity {thread_id?, turn_id?, last?}` reads turn outcomes, tool calls, processes and file changes for the
current thread from event, tool and terminal slash command callbacks, recorded only while an enabled mod's source calls
`turns.activity`.

- File changes come from the same workspace observer as `workspace_change`, which rereads only files whose size,
  ctime or inode changed.
- Commands record their exit code when they finish, including commands that outlive their tool call.
- The log is removed when the thread is deleted.

## `sessions.list`

`sessions.list {since?, until?, cursor?, limit?}` pages this repository's recorded sessions that allow memory.

## `sessions.read`

`sessions.read {session_id, revision, handle, cursor?, max_bytes?}` pages one session's
`local_visible_records`:

| Record | Fields |
| --- | --- |
| `message` | `role`, `text` |
| `tool_call` | `name`, `call_id`, `arguments` |
| `tool_result` | `call_id`, `output` (text parts only) |

- Each record has credential lines replaced by `[redacted]` (`redacted`; line endings kept) and is cut to 2,048
  characters with `truncated`.
- Without the `sessions_tools` capability, tool records carry `bytes` and `sha256` of their arguments or output
  instead of the text.
- Reasoning and other item types are left out.
- Pages hold at most 16 KiB, and a session at most 4,096 records (`projection_truncated`, the oldest are kept).
- A changed rollout fails the read against its `revision`.
- `sessions.list` and `sessions.read` serve mod CLI commands (`api.command(name, …, {cli})`) and `context`
  callbacks, not TUI slash commands.

Credential lines are lines:

- naming a credential (`Authorization:`, `api_key`, `password=`, …);
- assigning a secret-like name (`TOKEN=…`, `"secret": …`, `AWS_SECRET_ACCESS_KEY=…`);
- holding a known token prefix (`sk-`, `ghp_`, `AKIA…`) or URL credentials (`scheme://user:password@`);
- inside private-key blocks.

## Session reads and the SQLite home

Live session reads use the runtime's configured state database, including a separate SQLite home. Standalone
commands resolve the selected user configuration/profile and `CODEX_SQLITE_HOME`; `--sqlite-home` explicitly
selects the state directory.

- If a repository or system configuration redirects SQLite, standalone dispatch requires that explicit directory
  rather than guessing.
- Relative SQLite directories are rejected.
- The pinned reader consults `state_5.sqlite` read-only before and after a read, and does not modify transcripts or
  opt-out state.
