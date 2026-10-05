# omd_reactive_rules

Opt-in OMD+ mod that stops a response when a completed output item matches an explicit rule, then asks the model to retry with that rule's reminder. It is installed inactive; enable it and configure `rules` to use it.

```json
{"rules": [{"id": "no-placeholders", "pattern": "TODO: implement", "reminder": "Write the implementation instead of a placeholder.", "max_activations": 1}]}
```

- `pattern` is a JavaScript regular expression of at most 128 characters with optional `flags: "i"`. Unbounded quantifiers (`*`, `+`, `{n,}`, counts above 64), backreferences, patterns that match empty text and duplicate patterns are rejected when the mod loads. The mod also bounds worst-case backtracking: it counts the paths and steps each rule can try from one text position, and all rules together may use at most 2,048 (a literal costs its length, `TODO[^\n]{0,64}implement` costs 653, and overlapping repeats such as `(a|aa){64}` or `a{0,64}a{0,64}` are rejected).
- Rules match the full text of each completed output item, so matches split across streamed tokens are found. Reasoning and tool calls carry no text and are never matched. When more than one rule matches the same item, the match is ambiguous and nothing is stopped.
- A rule activates at most `max_activations` times per turn (1 or 2), and the mod stops at most twice per turn, matching the host's retry bound, so a repeated match lets the output stand instead of ending the turn.
- The host keeps the completed item in the transcript, records that a mod stopped it, and retries under the same turn, admission and allowance. The reminder is lower-priority developer context. If tools already ran in the turn, the reminder says their effects remain; nothing is undone.
- Activated reminders are restated when the host rebuilds context after compaction, including after a restart of the same thread. A new thread, or resuming a different one, starts with none active.

Limits: the `response_stream` interceptor matches only completed `message` chunks, and each mod callback is a separate sandboxed process, so enabling this mod adds latency at the end of each answer. With the mod disabled, or enabled with no rules, the interceptor is not registered and adds nothing. It is optional: while the runtime stays busy for 2 s the host skips it, so a match can occasionally pass unchecked.
