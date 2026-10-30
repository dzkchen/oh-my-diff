# Final-request policy (`final_request_policy_v1`)

Use it when a mod must approve, redact or refuse the exact body of every model request, or when an administrator
declares a required request policy. The capability is `request_policy` in [Capabilities](capabilities.md).

`model_send` (capability `middleware`) runs on the exact body each request sends, after history, `model_request`
and the host's route, effort, section and output-ceiling edits; only the removal of item metadata a provider
rejects and compression follow.

- It covers lead, subagent and mod worker requests (`model.complete`, `model.fork`) and the session's internal
  requests (titles, reviews, memory, guardian), whose `scope.kind` is `internal` and which have no `provider` or
  `route`.
- Every attempt runs it again: turn and stream retries, a mod's stop-and-retry, compaction and route switches
  rebuild the body, and a transport retry resends the bytes that passed.
- A synthetic answer sends nothing and skips it.

## `model_send` input pages

The input is one page:

- `request_id`, `attempt`, `scope`, `provider`, `route` and `model`.
- `page` and `pages` (1-based).
- `cached`.
- `segments`: the non-empty string leaves of `instructions`, `input`, `tools` and `text` (and `prompt`, `images`
  and `traces` in image and memory summarization requests), except structural fields
  (`type`, `id`, `call_id`, `status`, `role`, `name`, `namespace`, `detail`, item metadata).
- `opaque` and `opaque_total`.

Each segment is `{id, kind, role, editable, text, bytes, sha256}`:

- `id` is the JSON pointer (`/input/3/content/0/text`).
- `kind` is the content kind: `agents_md.instructions`, `user.text`, or `message.<role>` without one,
  `instructions`, `tool_call.arguments`, `tool_call.input`, `tool_output`, `reasoning`, `tool_spec`,
  `output_schema`, `image.prompt`, `memory` or the item type.
- `bytes` is the UTF-8 size.

| Page limit | Value |
| --- | --- |
| Page | up to 96 KiB of JSON-encoded text |
| Piece of a longer segment | up to 80 KiB |
| Read-only `before` and `after` context per piece | up to 1 KiB |
| `opaque` entries | up to 256 in all |
| Pages per request | more than 128 refuses the request (`final_request_too_large`) |

A longer segment arrives in pieces, each with `offset` (where the piece starts in the whole text) and the `before`
and `after` context, so a match across a boundary is visible from both pieces.

`opaque` names values that are not scanned: images, audio and files first, then encrypted reasoning and compaction;
`opaque_total` counts every one.

## `model_send` edits and denials

`next` resolves to `{edits}` from the policies beneath. A handler calls `next` and returns `{edits}` keeping all of
those plus its own, or returns `{deny}` (with or without `next`).

- An edit `{segment, start, end, text}` replaces `text.slice(start, end)` of that segment on this page; `start`,
  `end` and `offset` are JavaScript string indices, never inside a surrogate pair (up to 4 KiB of replacement text,
  256 edits, no overlap).
- Only `editable` segments take edits: message text of any role, including user prompts, tool-call arguments (which
  must still parse as JSON when they did) and freeform input, tool output text and instructions.
- Policy floors (`permissions.`, `network_proxy.`, `managed_config.`, `collaboration_mode.` and `guardian.` kinds),
  reasoning, tool specs and output schemas can only be denied.
- After the edits are applied every policy sees the changed segments again; a second round of edits refuses the
  request (`final_request_unsettled`), so every policy approved the exact bytes sent.

## `model_send` verdict reuse

Verdicts are reused by segment digest, kind, role and `editable` for the same policy mods, their trusted sources,
settings and the host generation, and the same provider, route, model and `scope` (thread, agent and kind), so a
request pages only new text (`cached` counts the rest).

- An edit that leaves the text unchanged is ignored.
- A policy whose decision depends on anything else adds `cache: false` to its result, which every handler above it
  must keep, and those segments are paged again on the next request.
- At least one page runs for every request, with no segments when all are cached.

## When a request is refused (`final_request_refused`)

A request is refused, visibly as a turn or call error starting `final_request_refused`, when:

- a required `model_send` interceptor fails, times out, returns an invalid result, belongs to a faulted mod or
  waits more than 5 s for a busy runtime;
- any policy denies; or
- edits are invalid.

## Declared policies (`request_policy`)

A selection trusted with capability `request_policy` (which needs `middleware`) is a declared policy. While it is
enabled, every request except web search is refused (`request_policy_unavailable`) unless that mod is loaded,
healthy and has a required interceptor selecting `model_send`, including after a rejected selection, failed
activation, fault or failed reload.

- Image generation and edits and memory summarization pass the stage too (input images arrive as `opaque`).
  Web search is never policed or refused by final-request policies, even when the policy has failed: it sends recent
  conversation text and its queries as they are.
- While a required `model_send` interceptor or a declared policy exists, realtime calls and their websockets are
  refused (`request_policy_unsupported_transport`, naming the endpoint and the mods whose policy blocks it);
  Responses websockets are always off under OMD.
- Disable the mod in `/mods` or `/omd` to send again (only the administrator can disable a managed policy).
- Status `request_policy_unavailable` names the reason every request except web search is being refused, or is `null`.
- Without `model_send` interceptors or declared policies the stage does not run and the body is untouched.

## Records and coverage of final-request policy

Records keep digests, never segment text: chain traces hash each page's input and result, and the request evidence
records `final_request` (pages, scanned and cached segments, each edit's segment, range and the digest of the
replaced bytes) or `final_request_refused` with its reason.

- Transcripts, rollouts and resume data keep the original text; a retried or later request applies the same cached
  edits again.
- Coverage is the text listed above; images, audio, files, encrypted reasoning, provider-side tools, mods' own HTTP
  and sidecars, and terminal, log and resume originals are outside it, and the stage proves only what its policies
  detect.
