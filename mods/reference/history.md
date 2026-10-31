# History and compaction

Use it when a mod edits what the model sees, what is stored, or how and when the thread compacts. It covers the
bounded view of each model request, store-time redaction, durable transcript rewriting and compaction interception.

| Mechanism | Capability | What it changes |
| --- | --- | --- |
| [Model-bound history](#model-bound-history-history_v1) | `history` | One model request; the transcript is unchanged |
| [Store-time history rewriting](#store-time-history-rewriting-history_persist_v1) | `history_persist` | Text written to the rollout and the prompt-recall file |
| [Durable transcript rewriting](#durable-transcript-rewriting-history_rewrite_v1) | `history_write` (experimental) | The persisted transcript |
| [Compaction interception](#compaction-interception-compaction_intercept_v1) | `compaction` | How and when the thread compacts (experimental) |

Capabilities are listed in [Capabilities](capabilities.md). Entries are frozen in Mod API `1.0.0` unless marked
experimental (see the [registry table](stability-and-migration.md#experimental-entries-in-the-registry)).
Runs on Apple Silicon macOS.

## Model-bound history (`history_v1`)

`replace('history')` receives a bounded view of each model request's items and may return `{drop?, replace?,
insert?}`.

Each item in the view contains `index`, `type`, `role`, `call_id`, `editable`, a 2 KiB text preview, the byte size and
the `images` count.

The view contains the newest items in order, keyed by their original `index`. It has at most 2,048 items and must fit
the callback's 4 MiB runner request.

### History edit rules

- Messages, tool outputs and tool call arguments can be replaced; replacing a message with images keeps only the
  new text.
- A reasoning item can be dropped only together with the item it precedes, and an insert cannot separate them.
- Call and output items are dropped as pairs.
- The last item (the current input) is kept.
- Inserts are `user` or `developer` text.

An edit changes only the request being sent. The transcript and resume data stay unchanged, and the host records each
applied edit. An invalid edit or a failing mod leaves the original request.

## Store-time history rewriting (`history_persist_v1`)

`api.intercept('history_persist', …)` (authority grant `history_persist`) rewrites history text before the host
stores it, so a mod can redact it. It sees every text written to the thread's rollout and to the prompt-recall file
(`~/.codex/history.jsonl`). Each batch arrives as `{thread_id, entries}`, and an entry is
`{index, kind, role, call_id, text}`.

Redaction applies to stored text only. The model sees the original text until the thread is resumed, forked or
rolled back from the rollout.

### `history_persist` entry kinds

`kind` is one of:

| `kind` | Group | Text it covers |
| --- | --- | --- |
| `message` | response item | its text |
| `agent_message` | response item | its text |
| `reasoning` | response item | summary and raw text |
| `function_call` | response item | its arguments |
| `custom_tool_call` | response item | its input |
| `local_shell_call` | response item | each command word and environment value |
| `tool_search_call` | response item | each string in its arguments |
| `function_call_output` | response item | its text |
| `custom_tool_call_output` | response item | its text |
| `tool_search_output` | response item | tool descriptions |
| `web_search_call` | response item | queries, URLs, patterns |
| `image_generation_call` | response item | the revised prompt |
| `delivered_message` | text kept beside an item | its text |
| `sender_user_messages` | text kept beside an item | its text |
| `event:user_message` | event copy | its text |
| `event:agent_message` | event copy | also a turn's last agent message |
| `event:reasoning` | event copy | its text |
| `event:plan` | event copy | its text |
| `event:goal` | event copy | a thread goal's objective |
| `event:command_execution` | event copy | command words, input and output |
| `event:function_call_output` | event copy | its text |
| `event:mcp_tool_call` | event copy | each argument string, result text, structured content string and error |
| `event:dynamic_tool_call` | event copy | each argument string, output text and error |
| `event:file_change` | event copy | added and deleted file contents, diffs, stdout and stderr |
| `event:web_search` | event copy | query, action and result strings |
| `event:review` | event copy | custom instructions, hint, findings and explanation |
| `event:image_generation` | event copy | the revised prompt |
| `event:hook_prompt` | event copy | the prompt |
| `event:collab_agent_tool_call` | event copy | the prompt |
| `inter_agent_communication` | other | its text |
| `compacted` | other | a compaction summary and its replacement history |
| `prompt_history` | other | a prompt-recall entry |

### `history_persist` returns and batching

Return `{entries}` with only `text` changed, or pass a changed input to `next`. A reordered, added, dropped or
relabelled entry is rejected.

A batch is split across callbacks of at most 48 KiB of JSON-encoded entries (escaping counts). A longer text
arrives as consecutive entries with the same index, split after its last whitespace within the budget, so only a
long run without whitespace is cut inside a token.

### `history_persist` effects and limits

- Item ids, call ids, roles, order and count never change.
- A rewritten response item contains `rewritten {revision, op: "redact", by}` and reads as not original. `by` names
  each mod whose interceptor changed the text (`mod:<id>`), and `host` when the host withheld entries.
- A rewritten user message drops its text elements.
- The interceptor gets no host operations.

Not offered:

- identifiers, names, paths and status fields
- images and other binary payloads
- encrypted content
- extension-owned items (standalone web search, image generation and sleep)
- subagent activity
- realtime transcripts

### `history_persist` failures

- A failing optional interceptor keeps the original text.
- A failing required interceptor, or a persist runtime that fails while one is installed, stores `[withheld: a
  required history_persist interceptor failed]` instead (a withheld prompt-recall entry is not written).

## Durable transcript rewriting (`history_rewrite_v1`)

Experimental: the `history_write` capability is experimental.

A mod with the `history_write` authority grant changes the persisted transcript itself by calling
[`app.request`](app-bridge-and-approvals.md) with `thread/rewrite {threadId, expectedRevision?, edits?, undo?}`, on
the current thread or a thread it started.
Revoking the mod drops `history_write`.

### Reading rows

Without `expectedRevision` the call only reads `{revision, rows}`; `edits` or `undo` without it fail with
`history_rewrite_invalid`.

A row pairs a display item with its model items: a message, or a tool call with its output. Each row is
`{id, turnId, kind, access}`:

- `kind` is `message.<role>`, the tool call type or a display item type.
- `access` is `edit`, `delete` (reasoning, web search, image generation and display-only items) or `frozen`
  (compaction, configuration and rows before the newest compaction checkpoint).

### Edits

1 to 256 `edits` (or `undo`, not both) apply in order as one revision:

| Edit | Meaning |
| --- | --- |
| `{op: "delete", id}` | Delete the row |
| `{op: "replace", id, items}` | Replace the row's items |
| `{op: "insert", before? \| after?, items}` | Insert items; with neither `before` nor `after` it appends after the last row |
| `{op: "move", id, before? \| after?}` | Move the row |

- `items` is one Responses `message` (`user`, `assistant` or `developer`) or one tool call followed by its output
  with the same `call_id`.
- A replacement keeps the row's role or call id; an inserted call id must be new to the thread.
- A replaced or inserted message gets a matching display item.
- A replaced or inserted tool row keeps only its model items, so it leaves replay and export views.
- Images are referenced by `image_url` (a URL or data URL) or `file_id`.
- Host metadata in the items is dropped and ids are assigned by the host.

### Rewrite errors

| Error | When |
| --- | --- |
| `history_rewrite_invalid` | `edits` or `undo` without `expectedRevision`, or not exactly one of 1 to 256 `edits` and `undo` |
| `history_rewrite_busy` | A turn is in progress or agent mail is pending on the thread |
| `history_revision_conflict` | A stale `expectedRevision` |

The host repeats the busy check atomically when the thread unloads, so a turn that starts meanwhile is never cut off
and the thread stays loaded. Retry once the thread is idle.

Any refused edit leaves the transcript unchanged.

### What a rewrite does

A rewrite copies the whole edited transcript to a new rollout and switches the thread to it, so resume,
`thread/turns/list`, `thread/items/list`, search and export read the result. Every client receives
`thread/rewritten {threadId, revision}` and the terminal reloads the transcript. The replaced rollout is kept
unchanged.

- Each inserted, replaced or moved model item contains `rewritten {revision, op, source?, by: "mod:<id>"}` metadata.
  It loses the host's execution, delivery and tool-call inventory metadata and so never proves that a tool ran.
- The approval reviewer's transcript labels rewritten messages and tool rows as not original.
- Receipts, usage and evidence records are not rewritten.

### Undo and the revision log

`undo: true` restores the transcript the latest rewrite replaced and keeps rows added since; undoing an undo redoes
it.

The host keeps a per-thread revision log, anchored by the authority broker when it is deployed. Resume fails with:

- `history_anchor_mismatch` or `history_original_mismatch` when the log or an original referenced by the latest
  committed rewrite changed;
- `history_anchor_unavailable` when the deployed broker cannot be asked.

An interrupted rewrite, including a record torn by a crash, is rolled forward or discarded on the next access.

## Compaction interception (`compaction_intercept_v1`)

Experimental: the `compaction` interceptor is experimental.

`api.intercept('compaction', (input, next) => …)` (capability `compaction`) sees every compaction of the lead
thread once. That includes manual `/compact` and automatic pre-turn, mid-turn and post-turn compaction.
`implementation` is `local` for local summarization, `remote` for provider compaction or `budget` for a token-budget
reset.

### Compaction input

| Field | Meaning |
| --- | --- |
| `trigger` | The compaction trigger |
| `reason` | The upstream reason: `user_requested`, `context_limit`, `model_downshift` or `comp_hash_changed` |
| `phase` | `standalone_turn`, `pre_turn`, `mid_turn` or `post_turn` |
| `budget` | `{tokens, auto_limit, context_window, hard}` |
| item count | The number of history items |
| `history` | A bounded view: the newest 1,024 items, 512-byte previews within 128 KiB |
| `summary_prompt` | The summary prompt; `next` may change it only for local summarization |

`next` runs the host's compaction once (each provider attempt passes route admission, accounting and request
policy) and returns `{summary, history, usage, provider_call}`, where `history` views the new history.

### Compaction handler answers

A handler that does not call `next` may answer:

| Answer | Effect |
| --- | --- |
| `{skip: reason}` | No compaction; automatic compaction is not offered again this turn |
| `{defer: reason}` | No compaction; offered again at the next trigger |
| `{summary}` | The host builds its standard history: recent user messages plus the summary, with no provider call |
| `{history: {keep, insert?}}` | A custom replacement history |

A handler that called `next` may replace its result with `{summary}` or `{history}`, whose indices then refer to
the new history.

- `keep` lists the items kept verbatim; tool calls and their outputs, and a reasoning item and the item it
  precedes, are kept or dropped together.
- `insert` adds `user` or `developer` text `before` an index.

### Compaction refusals and failures

- The host refuses a replacement it estimates at the context window or more (`compaction_replacement_over_limit`).
- A skip or deferral when the context is already full (`budget.hard`) fails the turn with `compaction_required`
  naming the mod instead of compacting anyway.
- A failing required interceptor fails the compaction; a failure after `next` keeps the host's result with a
  diagnostic.

### Compaction summarizers and results

A custom summarizer calls [`model.fork`](model-calls.md#modelfork) (the conversation on its own route) or
[`model.complete`](model-calls.md#modelcomplete) and answers
`{summary}`.

Interrupting the turn cancels a waiting chain. The installed result persists as the normal compaction checkpoint,
so resume reads it.

`compaction_start {turn_id, trigger}` (`manual` or `auto`) fires before the `compaction` interceptors run, whatever
they then decide. `compaction_end` reports `outcome` (`compacted`, `replaced`, `skipped`, `deferred` or `failed`),
`by` and `provider_call`. Both are observe-only events of the `lifecycle` capability: a handler cannot change or
stop the compaction.

### Evidence across compaction

With the `sessions` capability, `turn_end` delivers `evidence`, a completed-turn packet of the turn's visible records.
Completed-turn packets retain bounded original visible records across a host-observed compaction, tagging each
segment's records with its history revision. Compaction summaries do not replace those records. An unobserved
history reset or interrupted compaction still rejects evidence explicitly. The mod chooses how to select and
summarize a truncated packet.
