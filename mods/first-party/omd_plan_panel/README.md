# omd_plan_panel

First-party mod, active by default in OMD+, that pins
the current plan above the composer. The plan is Codex's own `update_plan`
tool; the mod adds no second todo tool. Codex 0.163 registers that tool only with
`[tools.update_plan] enabled = true`, so the manifest's `codex_config` turns it on
for sessions where the panel is active (nothing is written to `config.toml`).

```text
● Plan (2/5)
├─ ✓ Read the failing test
├─ ✓ Find the regression
├─ ◐ Fix the parser
├─ ○ Run the suite
└─ ○ Summarize
```

`○` pending, `◐` in progress, `✓` completed. The heading is accented while
steps remain and dimmed once all are done; a fully completed plan disappears
when the next turn starts.

- **Alt+p** or `/todos toggle` collapses the panel to its heading and expands it
  again. On macOS, Alt+p needs Option-as-Alt in Kitty (`macos_option_as_alt`)
  and Ghostty (`macos-option-as-alt`); otherwise Option+p types `π`.
- **Row limit.** At most `rows` steps (default 8). When a plan is longer, completed
  steps are dropped first, then unfinished steps are truncated, and the last
  row reads `+N more (X completed, Y pending)`. `/todos` toggles between the
  limit and every step. Both toggles apply to the current thread only and reset
  when OMD restarts.
- **Session scope.** Each `turn/plan/updated` notification replaces the plan of
  the thread that sent it, and the panel shows only the plan of the session's
  own thread, so sub-agents neither show nor overwrite it. Plans live in the
  mod's state (the 16 most recent threads, 40 steps of up to 120 characters each), not in the model context, so they
  survive compaction, `/resume` and restarts. A fork starts with no plan until
  its next update.

Capabilities: `terminal`, `commands`, `store` (mod state) and `threads` (the
`turn/plan/updated` and `turn/started` notifications).

Ported from [`@juicesharp/rpiv-todo`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo)
2.11.0 (juicesharp, MIT; see `THIRD_PARTY_NOTICES.md`): the pinned panel, status
glyphs, `done/total` heading, collapse key and completed-first overflow. This
package reimplements that behavior over the OMD mod API and copies no code; the
`todo` tool, dependencies and localization are not ported.
