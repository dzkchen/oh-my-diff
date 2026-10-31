# Thread data and recorded sessions

Use it when a mod cancels a turn, keeps data per thread, reads what happened in recent turns, reads recorded
sessions (a thread's saved history, not a live `codex` process) or keeps the current conversation as evidence.
Messaging live sessions and starting turns are in [Peers, power holds and mod-started turns](sessions-and-turns.md).

Host features: `store_thread_v1`, `turn_activity_v1`. The thread-scoped `store.*` operations are in
[State and storage](state-and-storage.md#store-operations).

Mod API `1.0.0`: every operation on this page is frozen. Platform: Apple Silicon macOS.

## `turns.abort`

`turns.abort {turn_id}` (capability `threads`) requests cancellation of the named active turn in the current thread
from a user or event callback. Require `turn_abort_v1`.

- `{accepted: true}` means cancellation was accepted, not that cleanup has completed.
- A stale or absent turn, queued input or competing cancellation returns `accepted: false`.
- Tool callbacks cannot call it, and it cannot target another thread.
- Successful cancellation wakes idle listeners after cleanup.

```ts
api.on('turn_start', e => {
  const { accepted } = api.host.call('turns.abort', { turn_id: e.turn_id });
});
```

## Thread-scoped store and `resume`

`store.*` accepts `scope: 'thread'`: data forks with the thread, is removed when the thread is deleted and kept
when it is archived.

The `resume` event fires when the lead thread is resumed.

- `last_turn` is the last turn in the [turn activity](#turnsactivity) log as `{turn_id, status}`, with `status`
  `completed`, `interrupted`, `failed` or `in_progress`. It is null when there is none.
- `restarted` is true when this process hadn't run the thread before, and false when the same process resumes it
  again.

## Explicit thread resume

When a saved thread is resumed, the host reopens that thread's task [ledger](routes.md#ledger) instead of starting a
new one. The ledger keeps its requests, exposure, observed lead usage and uncertain in-flight requests.

- Repository, thread identity, original limits and saved journal must validate.
- Reopening a ledger without a resume, changed limits and completed tasks are refused.
- Agent handles and snapshot handles don't survive a process restart. A mod must reconcile saved pending work
  without silently spawning replacements.

## `turns.activity`

`turns.activity {thread_id?, turn_id?, last?}` reads turn outcomes, tool calls, processes and file changes for the
current thread. Event, tool and terminal slash command callbacks can call it. The host records activity only while
the source of at least one enabled mod contains a `turns.activity` call. It returns `{turns, recording}`, and each
turn has:

| Field | Meaning |
| --- | --- |
| `turn_id`, `started_at`, `ended_at` | The turn and its times |
| `outcome` | `completed`, `aborted`, `error`, `interrupted`, `running` or `unknown`, with `reason` and `error` |
| `unrecorded_end` | The turn ended while nothing was recording |
| `tool_calls` | `{call_id, tool, started_at, finished_at, outcome, output_replaced?}` |
| `processes` | `{id, kind: 'exec' \| 'managed', command, running, exit_code}` |
| `files` | `{path, before, after, source}` |
| `truncated` | The turn's lists were cut |

- File changes come from the same workspace observer as `workspace_change`, which rereads only files whose size,
  ctime or inode changed.
- Commands record their exit code when they finish, including commands that outlive their tool call.
- The log is removed when the thread is deleted.

```ts
const { turns, recording } = api.host.call('turns.activity', { last: 1 });
```

## `sessions.list`

`sessions.list {since?, until?, cursor?, limit?}` pages this repository's recorded sessions that allow memory (Codex
memory mode `enabled`). It returns `{sessions, cursor, revision, scan_truncated, unavailable, projection}`; each
session has `session_id`, `task_id`, `parent_id`, `timestamp`, `revision`, `handle`, `history_mode`,
`inherited_history` and `incomplete_tail`. Pass a session's `session_id`, `revision` and `handle` to `sessions.read`.

## `sessions.read`

`sessions.read {session_id, revision, handle, cursor?, max_bytes?}` pages one session's
`local_visible_records` and returns `{session, records, cursor, bytes, projection, projection_truncated}`:

| Record | Fields |
| --- | --- |
| `message` | `role`, `text` |
| `tool_call` | `name`, `call_id`, `arguments` |
| `tool_result` | `call_id`, `output` (text parts only) |

- The host replaces each credential line in a record with `[redacted]`, keeps line endings and sets `redacted`.
  Credential lines are lines:
  - naming a credential (`Authorization:`, `api_key`, `password=`, …);
  - assigning a secret-like name (`TOKEN=…`, `"secret": …`, `AWS_SECRET_ACCESS_KEY=…`);
  - containing a known token prefix (`sk-`, `ghp_`, `AKIA…`) or URL credentials (`scheme://user:password@`);
  - inside private-key blocks.
- A record over 2,048 characters is cut and gets `truncated`.
- Without the `sessions_tools` capability, tool records contain `bytes` and `sha256` of their arguments or output
  instead of the text.
- Reasoning and other item types are left out.
- A page contains at most 16 KiB. A session returns at most 4,096 records, keeping the oldest, and sets
  `projection_truncated` when it cuts more.
- A changed rollout fails the read against its `revision`.
- `sessions.list` and `sessions.read` serve mod CLI commands (`api.command(name, …, {cli})`) and `context`
  callbacks, not terminal slash commands.

## `sessions.snapshot`

`sessions.snapshot {call_ids?}` (capabilities `sessions` and `sessions_tools`) preserves the current thread's
committed conversation records, including visible tool calls and outputs, in a caller-bound evidence reference. It
returns `{evidence, provenance: {sha256, bytes, items, revision}}`. Reading the evidence with `evidence.read` needs
`store`.

- `call_ids` selects 1 to 32 unique call ids, and the selection must include each complete call and output pair.
- Evidence storage's 256 KiB limit still applies.
- This does not expose hidden reasoning.
- [`agents.spawn {parent_history: true}`](agents.md#parent-history) delivers the same history to a worker.

| Error | When |
| --- | --- |
| `history_call_selection_invalid` | `call_ids` is empty, over 32, has duplicates or an id over 128 bytes |
| `history_call_or_output_missing` | A selected call lacks its call or its output |

```ts
const history = api.host.call('sessions.snapshot', { call_ids: ['warmup'] });
```

## Session reads and the SQLite home

This section is for operators who move Codex's state database: it says where session reads look for SQLite.

Live session reads use the runtime's configured state database, including a separate SQLite home. Standalone
commands, mod CLI commands run with `omd COMMAND --repo PATH`, resolve the selected user configuration/profile and
`CODEX_SQLITE_HOME`; `--sqlite-home` explicitly selects the state directory.

- If a repository or system configuration redirects SQLite, a standalone command requires that explicit directory
  rather than guessing.
- Relative SQLite directories are rejected.
- The reader opens `state_5.sqlite` read-only before and after a read, and doesn't modify transcripts or memory
  opt-out state.
