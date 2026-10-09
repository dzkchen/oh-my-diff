---
name: omd-anchored-edit
description: Edit files by citing per-line LINE#HASH anchors through the optional OMD anchored-edit component.
---

Use only when the separately trusted `omd_anchored_edit` component is enabled. Its plugin installation alone does not enable a tool or grant write permission.

Get anchors from the component's `read` tool (optionally `offset`/`limit`) or its `search` tool (ripgrep; `path`, `glob`, `literal`, `ignore_case`, `context`). Each line appears as `LINE#HASH|content`; the hash covers the line number and content. Never invent or guess an anchor.

Call `edit` with `files: [{path, edits}]`. Each edit is one of:

- `replace` with `anchor`, optional `end` (inclusive last line) and `lines`
- `delete` with `anchor` and optional `end`
- `insert_before` / `insert_after` with `anchor` and `lines` (the anchor line stays)
- `append` / `prepend` with `lines`

Only the cited lines are checked, so changes elsewhere do not block an edit. All edits in one call apply atomically or not at all; ranges must not overlap. On success the result lists `+LINE#HASH|content` for every changed line: use those anchors for the next edit of that file instead of rereading. CRLF, final-newline state and bytes outside the edited lines are preserved.

On `rejected`, nothing was written and every failure is listed: `moved_to` gives the fresh anchor when the cited line moved (resend with it); `stale` shows the current line (reread); `ambiguous` means reread. Use the ordinary patch tool for new, generated, oversized (over 96 KB per call) or non-UTF-8 files. On `denied`, respect the permission failure. On `transaction_failed`, inspect the files before retrying.

After success, run the relevant checks. If the component is absent, disabled or broken, use the existing patch tool.
