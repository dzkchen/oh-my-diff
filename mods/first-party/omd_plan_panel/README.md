# omd_plan_panel

Pins the current plan above the prompt, so you can see progress at a glance. It's on by default in OMD+. OMD Core
doesn't include it.

## Turn it off

Turn it off in `/mods`, or run:

```sh
omd mods disable omd_plan_panel
```

[Manage mods](../../../docs/manage-mods.md) covers the other ways to turn a mod on or off.

## Use it

The panel shows the plan Codex writes with its own `update_plan` tool. The mod adds no todo tool of its own:

```text
● Plan (2/5)
├─ ✓ Read the failing test
├─ ✓ Find the regression
├─ ◐ Fix the parser
├─ ○ Run the suite
└─ ○ Summarize
```

`○` pending, `◐` in progress, `✓` completed. A fully completed plan disappears when the next turn starts.

| Key or command | What it does |
| --- | --- |
| `Alt+p` or `/todos toggle` | Collapse the panel to its heading, or expand it again |
| `/todos` | Switch between the row limit and every step |

Both apply to the current thread and reset when OMD restarts. On macOS, `Alt+p` needs Option-as-Alt turned on in Kitty
(`macos_option_as_alt`) or Ghostty (`macos-option-as-alt`). Without it, `Option+p` types `π`.

## Settings

Change settings in `/mods`.

| Setting | Default | What it does |
| --- | --- | --- |
| `rows` | `8` | Most steps shown (2-40). Longer plans drop completed steps first, and the last row reads `+N more (X completed, Y pending)`. |

## Needs and limits

- It turns on Codex's `update_plan` tool for sessions where the panel is active. Nothing is written to `config.toml`.
- It shows only your session's own plan. Subagents (helper agents the main agent starts for part of a task) don't
  show or overwrite it.
- Plans survive compaction (when Codex replaces the earlier conversation with a shorter summary), `/resume` and
  restarts. OMD stores plans for the 16 most recent threads, up to 40 steps of up to 120 characters and 160 KiB in
  all, and drops the oldest threads first.
- A fork starts with no plan until its next update.

## More

- [Included mods](../../../docs/collection.md)
- Credit: reimplemented from
  [`@juicesharp/rpiv-todo`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo) 2.11.0
  (juicesharp, MIT; see `THIRD_PARTY_NOTICES.md`): the pinned panel, status glyphs, `done/total` heading, collapse
  key and completed-first overflow. This package reimplements that behavior over the OMD mod API and copies no code.
  The `todo` tool, dependencies and localization aren't ported.
