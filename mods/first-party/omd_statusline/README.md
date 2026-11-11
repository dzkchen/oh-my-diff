# omd_statusline

Shows model, context, limits, cost and git state in a configurable status line next to the prompt. It's on by
default in OMD+. OMD Core doesn't include it.

## Turn it off

It replaces Codex's own status row. Turn it off in `/mods`, or run:

```sh
omd mods disable omd_statusline
```

[Manage mods](../../../docs/manage-mods.md) covers the other ways to turn a mod on or off.

When the layout shows the `context` segment, it also hides Codex's own `N% context left` footer indicator, so context
isn't shown twice. When the mod is off, or if it fails, Codex's own status row, context indicator and `/statusline`
command come back. Your `tui.status_line` setting is never changed.

## Use it

Run `/statusline` to open the editor, in the same panel as `/config`. Its subtitle previews your draft live, using
live data where it has arrived and sample values for the rest, so a segment you just turned on shows at once.

- The Settings tab contains placement, preset, glyphs, bars and warning levels, with Save, Discard changes and Reset
  to defaults.
- The Segments tab has Save too. It lists each segment by a plain name, in layout order: put it on a line or hide
  it, and use Move earlier and Move later to reorder. Order edits the whole layout as text.
- Up and Down move, Left and Right switch tabs, `Space` or `Enter` changes the highlighted item and `/` searches.
- While the draft differs from your saved settings, the subtitle says `Unsaved changes` and Save reads
  `Save (unsaved changes)`. `Esc` closes without saving, and reopening `/statusline` brings the draft back.
  Discard changes drops it.
- Reset to defaults restores the defaults (`tones`, `github`, `refresh_s` and `scripts` keep their values).

Presets:

- `auto` (default): your Codex `tui.status_line` items mapped to segments, plus `context` and `omd`, or `compact` when you haven't
  set `tui.status_line`. The editor says `Layout from your Codex tui.status_line` when it applies. Items with no
  matching segment (such as `hostname`, `codex-version` or `approval-mode`) are left out. Choosing another preset or
  saving a layout in the editor replaces it.
- `compact`: `model tier context limits cost cache git omd`
- `detailed`: `model effort tier provider context tokens cache cost limits`, then
  `git changes pr ci session tools agents plan omd` on a second line

A narrow terminal drops trailing segments, but never the `N failed · /omd` alert: it moves to the end of its line
and other segments go first. Colors follow your theme and `NO_COLOR`.

### Segments

- `model`, `effort`, `provider`: the model (`requested→served` if they differ), reasoning effort, provider.
- `tier`: the processing tier name (such as Fast), from the model catalog, or Flex. With no tier configured it shows
  the model's catalog default; hidden when no tier applies, as in Codex's own model label.
- `profile`: `profile: <name>` when the active user config layer is a `--profile` one. Not in a preset; add it to a
  custom layout.
- `workspace`: `workspace: <name>` for the selected ChatGPT workspace. Not in a preset; add it to a custom layout.
- `context`: tokens and percent left, such as `258k left (99%)`, with a bar of what's left. The percent matches Codex's
  own `% context left`; without a known window it shows tokens used. `~` and muted after a compaction (a shorter summary replacing the earlier
  conversation), rewind or model switch. `⟳N` counts compactions.
- `tokens`, `cache`: token use and cache state.
- `cost`: session cost, never an invoice. `~` or `est.` marks an estimate, `included` marks subscription use, and `+?`
  means some cost is still unsettled or unknown. `omd_usage` (`Alt+a`) breaks it down by request.
- `limits`: account rate-limit windows with reset countdowns. Refreshes every minute and on `/statusline refresh`, so an account usage reset is picked up even while idle.
- `git`, `changes`: branch and diff summary. Git runs only when a shown segment (`git`, `changes`, `pr`, `ci`) or a
  script needs it, and only the commands those segments need.
- `pr`, `ci`: GitHub pull request and checks.
- `session`: thread id and elapsed time.
- `tools`, `agents`, `plan`: running tools, agents and plan progress.
- `cwd`: working directory.
- `omd`: mod counts, or `N failed · /omd` when one failed.

Segments with nothing to show are hidden.

### Pull requests and CI

1. Run `/statusline github`.
2. Paste a GitHub token with read access. A fine-grained token with Pull requests and Commit statuses read is enough.

The compact preset has no `pr` or `ci` segment: choose the detailed preset or add them to a custom layout, or the command
says they stay hidden.

Run it again to replace the token. It's sent only to `https://api.github.com`, and the mod never sees it. Without a
token there's no network request.

It uses your `origin` remote on github.com and the newest pull request whose head is your current branch (forks are
ignored). It polls every minute while checks are pending, every three minutes otherwise, and backs off after failures.
`/statusline refresh` forces an update.

### Scripts

Add your own segment with up to four scripts in the `scripts` setting:

```json
[{"id": "weather", "command": ["sh", "/usr/local/bin/statusline-weather.sh"], "interval_s": 300, "timeout_ms": 1500}]
```

Then add `script:weather` to a custom layout. Commands run without a shell, so paths must be absolute (`~` and
`$HOME` are not expanded).

- Your script gets one JSON object on stdin with `schema`, `segment`, `placement`, `viewport`, `now_ms`, `session`,
  `model`, `profile`, `workspace`, `context`, `tokens`, `cost`, `limits`, `git`, `github`, `plan`, and the counts `tools_running` and
  `agents`. Unknown fields are null.
- The first non-empty stdout line is drawn. Colors, bold, italic, underline and `http(s)` links are kept.
- It runs sandboxed: no network, private HOME, read-only workspace, 100-5000 ms deadline, 8 KiB output. A hang shows
  `timed out`, and a non-zero exit shows `failed`.
- Scripts come only from your settings, never from a repository file.

## Settings

Change settings in `/mods` or `/statusline`, which change one setting at a time, or from a shell with `omd-mod`, the
low-level tool that works on a mod store directly. The shell form replaces all of the mod's saved settings, so any
setting you leave out goes back to its default:

```sh
STORE=~/.local/share/oh-my-diff/stores/full
omd-mod settings "$STORE" "$STORE/sources/omd_statusline" '{"preset": "detailed"}'
```

| Setting | Default | What it does |
| --- | --- | --- |
| `placement` | `below` | `below` or `above` the prompt |
| `preset` | `auto` | `auto` (from `tui.status_line`), `compact`, `detailed` or `custom` |
| `layout` | the detailed set | Custom layout: segment ids separated by spaces, lines by `;` (up to 4) |
| `hidden` | empty | Segment ids to hide from a preset |
| `glyphs` | `unicode` | `ascii` uses plain characters |
| `bars` | `true` | Bar showing how much context is left |
| `thresholds` | `context=70,90 limits=70,90 cost=5,20` | Warning and alert levels (percent used, or USD for `cost`) |
| `tones` | empty | `segment=tone` overrides: `accent`, `success`, `attention`, `failure`, `muted`, `normal` |
| `github` | `true` | Pull request and CI segments, once a token is connected |
| `refresh_s` | `60` | Git refresh interval in seconds (5-3600) |
| `scripts` | empty | JSON array of your own segments (see [Scripts](#scripts)) |

## Needs and limits

- It asks to draw the status line and its editor, replace Codex's `/statusline` with its own, keep its settings, run
  timers, follow turns, tool calls and agents, read the model, thread, config and account rate limits, run `git` and
  your scripts in the sandbox, and ask you for a GitHub token that it sends only to `https://api.github.com`. The
  capabilities are `terminal`, `commands`, `builtins`, `store`, `events`, `lifecycle`, `model`, `middleware`, `threads`,
  `config`, `account`, `inventory`, `exec`, `credentials` and `http`, with `http` limited to `https://api.github.com`
  (see [Trust and permissions](../../../docs/trust-and-permissions.md#what-a-mod-can-do)).
- Git, scripts and GitHub refresh from one shared timer per thread, so values can lag by a refresh interval.
  Main-thread tool results trigger a Git refresh when a shown segment needs Git; child-agent tools are represented
  by the agent segment and do not schedule session timers. If the host's timer pool is full, the line still updates
  from events and the timer is retried at the next one.
- Pull request and CI segments need a GitHub token and an `origin` remote on github.com.

## More

- [`omd_usage`](../omd_usage/README.md) for the per-request breakdown
- [Included mods](../../../docs/collection.md)
