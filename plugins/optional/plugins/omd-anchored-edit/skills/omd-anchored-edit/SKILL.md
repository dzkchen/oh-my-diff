---
name: omd-anchored-edit
description: Apply a small edit using exact current file hashes, unique text anchors and explicit line scope through the optional OMD anchored-edit component.
---

Use only when the separately trusted `omd_anchored_edit` component is enabled. Its plugin installation alone does not enable a tool or grant write permission.

Read the selected files with the component's `read` tool. Copy the returned whole-file `sha256` and exact `before` text, preserving spaces, tabs, CRLF and final newlines. For each file specify `start_line` and `end_line` (inclusive, one-based) and replacements `{before, after}`. An anchor must occur exactly once in that line scope. Use a smaller scope to distinguish repeated text; never guess a hash or normalize whitespace. At most eight files and 32 nonoverlapping edits are accepted in one transaction.

The plugin resolves anchors and sends complete new bytes plus expected hashes to the public workspace transaction service. The host checks permissions, concurrent changes and cancellation, replaces each file atomically, and attempts checked multi-file rollback. Intermediate multi-file states and rollback conflicts remain possible.

On `fallback`, no transaction was attempted: reread the file and use the ordinary `apply_patch` path with its existing permissions. Generated files, new files, non-UTF-8 files, malformed, stale or ambiguous anchors need ordinary patch review. On `denied`, respect the permission failure. On `transaction_failed`, inspect files and the diff before retrying; do not assume rollback succeeded. Never silently widen scope or retry stale anchors.

After success, review the ordinary diff and run relevant checks. This tool does not stage or commit changes, promise perfect edits, or establish token savings. If absent, disabled or broken, use the existing patch tool.
