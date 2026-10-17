# omd_statusline

Shows model, context, limits, cost and git state in a configurable status line next to the composer.

## Turn it off

It's on by default and replaces Codex's own status row. Turn it off in `/mods`, or let it fail, and the native row and `/statusline` return. Your `tui.status_line` setting is never changed.

## Use it

Run `/statusline` to open the editor. It previews your draft live: placement, preset, segment order, glyphs, bars and thresholds.

Apply saves. Cancel or `Esc` discards. Reset restores the defaults (`tones`, `github`, `refresh_s` and `scripts` keep their values).

You can also edit settings in `/mods`, or from a shell:

```sh
omd-mod settings STORE omd_statusline '{"preset": "detailed"}'
```

Presets:

- `compact`: `model context limits cost git omd`
- `detailed`: `model effort provider context tokens cache cost limits`, then `git changes pr ci session tools agents plan omd` on a second line

A narrow terminal drops trailing segments. Colors follow your theme and `NO_COLOR`.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `placement` | `below` | `below` or `above` the composer |
| `preset` | `compact` | `compact`, `detailed` or `custom` |
| `layout` | the detailed set | Custom layout: segment IDs separated by spaces, lines by `;` (up to 4) |
| `hidden` | empty | Segment IDs to hide from a preset |
| `glyphs` | `unicode` | `ascii` uses plain characters |
| `bars` | `true` | Progress bar before the context percentage |
| `thresholds` | `context=70,90 limits=70,90 cost=5,20` | Warning and alert levels (percent, or USD for `cost`) |
| `tones` | empty | `segment=tone` overrides: `accent`, `success`, `attention`, `failure`, `muted`, `normal` |
| `github` | `true` | Pull request and CI segments, once a token is connected |
| `refresh_s` | `30` | Git refresh interval in seconds (5-3600) |
| `scripts` | empty | JSON array of your own segments (see Scripts) |

## Segments

- `model`, `effort`, `provider`: the model (`requested→served` if they differ), reasoning effort, provider.
- `context`: usage with a bar. `~` and muted after a compaction, rewind or model switch; compactions as `⟳N`.
- `tokens`, `cache`: token use and cache state.
- `cost`: session cost. `~` / `est.` for estimates, `included` for subscriptions, `+?` while unsettled. Never an invoice.
- `limits`: account rate-limit windows with reset countdowns.
- `git`, `changes`: branch and diff summary.
- `pr`, `ci`: GitHub pull request and checks.
- `session`: thread ID and elapsed time.
- `tools`, `agents`, `plan`: running tools, agents and plan progress.
- `cwd`: working directory.
- `omd`: mod counts, or `N failed · /omd` when one failed.

Segments with nothing to show are hidden.

## Pull requests and CI

1. Run `/statusline github`.
2. Paste a GitHub token with read access. A fine-grained token with Pull requests and Commit statuses read is enough.

Run it again to replace the token. It's sent only to `https://api.github.com`, and the mod never sees it. Without a token there's no network request.

It uses your `origin` remote on github.com and the newest pull request whose head is your current branch (forks are ignored). It polls every minute while checks are pending, every three minutes otherwise, and backs off after failures. `/statusline refresh` forces an update.

## Scripts

Add your own segment with up to four scripts:

```json
[{"id": "weather", "command": ["sh", "/Users/me/bin/statusline-weather.sh"], "interval_s": 300, "timeout_ms": 1500}]
```

Then add `script:weather` to a custom layout.

- Your script gets one JSON object on stdin (session, model, context, tokens, cost, limits, git, github, plan, tools, agents). Unknown fields are null.
- The first non-empty stdout line is drawn. Colors, bold, italic, underline and `http(s)` links are kept.
- It runs sandboxed: no network, private HOME, read-only workspace, 100-5000 ms deadline, 8 KiB output. A hang shows `timed out`; a non-zero exit shows `failed`.
- Scripts come only from your settings, never from a repository file.

## Limits

- Git, scripts and GitHub run on timers, so values can lag by a refresh interval.
