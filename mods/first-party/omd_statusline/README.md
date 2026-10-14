# omd_statusline

A configurable status line for OMD+, active by default. It draws below the
composer (or above it), replaces Codex's own status row while it is active and
routes `/statusline` to its editor. Disable the mod, or let it fail, and the
native row and the built-in `/statusline` return unchanged; your
`tui.status_line` setting is never written.

## Editor

`/statusline` opens a dialog with a live preview of the draft: placement,
preset, the segment list (Show/hide, Earlier, Later, Next line for multiline
layouts), glyphs, progress bars and thresholds. Apply saves the changed
settings, Cancel, Esc or dismissing the dialog discards the draft, Reset loads the defaults into the
preview. The same settings are editable in `/mods` and from a shell with
`omd-mod settings STORE omd_statusline '{"preset": "detailed"}'`.

| Setting | Default | Meaning |
| --- | --- | --- |
| `placement` | `below` | `below` or `above` the composer |
| `preset` | `compact` | `compact`, `detailed` or `custom` |
| `layout` | the detailed set | Custom layout: segment IDs separated by spaces, lines by `;` (at most 4) |
| `hidden` | empty | Segment IDs hidden from a preset |
| `glyphs` | `unicode` | `ascii` replaces arrows, bars and symbols |
| `bars` | `true` | Progress bar before the context percentage |
| `thresholds` | `context=70,90 limits=70,90 cost=5,20` | Warning and alert levels (percent, or USD for `cost`) |
| `tones` | empty | `segment=tone` overrides (`accent`, `success`, `attention`, `failure`, `muted`, `normal`) |
| `github` | `true` | Pull request and CI segments, once a token is connected |
| `refresh_s` | `30` | Git refresh interval in seconds (5–3600) |
| `scripts` | empty | JSON array of user scripts (below) |

`compact` shows `model context limits cost git omd`; `detailed` shows
`model effort provider context tokens cache cost limits` and
`git changes pr ci session tools agents plan omd` on a second line. A narrow
terminal drops trailing segments; colors follow the theme and `NO_COLOR`.

## Segments and their sources

| Segment | Source | Unknown or stale |
| --- | --- | --- |
| `model` | `model_response` requested and served model; `session.info`; `thread/settings/updated` | Hidden until known; `requested→served` when they differ |
| `effort` | `config/read` and `thread/settings/updated` | Hidden |
| `provider` | `model_response` provider and cost basis | `unpriced` or `unsettled` when the host reports no price |
| `context` | `usage.summarize` context (or the last lead request's input plus output) and the window from `config/read` or `thread/tokenUsage/updated` | `~` and muted after a compaction, rewind or model switch until the next response; compactions as `⟳N` |
| `tokens`, `cache` | `usage.summarize` per request, idempotent by request and attempt; cache TTL from `omd_cache_ttl_seconds` | Hidden before the first measured request |
| `cost` | Cost basis per request: provider-billed or provider-reported is billed, settled configured rates are an estimate (`~`, `est.`), subscription requests are `included`; the session ledger's settled charge replaces that sum when it is larger | `+?` while requests are unsettled or unpriced; never an invoice |
| `limits` | `account/rateLimits/read` and `account/rateLimits/updated` windows with reset countdowns | Hidden without account limits; `compact` shows the tightest window |
| `git`, `changes` | `git status --porcelain=v2`, `git diff --shortstat HEAD` and `git rev-parse` through `exec.run` on a timer and after edits | Hidden outside a repository and while a result belongs to another checkout |
| `pr`, `ci` | GitHub GraphQL through `http.request` to `api.github.com` with your enrolled token | `PR: /statusline github` without a token, `PR …` while loading, `rate-limited`, `offline` or `error` with backoff |
| `session` | Thread ID and the time since the thread started in this store | Hidden before `start` |
| `tools`, `agents`, `plan` | `tool_call`/`tool_result`, `agent` lifecycle and `turn/plan/updated` | Hidden when idle |
| `cwd` | Session working directory | Hidden |
| `omd` | The terminal event's mod counts, which the native row showed before | `N failed · /omd` in the failure tone; if this mod itself fails, the native row returns with the host's recovery text |

Nothing runs while drawing: Git, scripts and GitHub run in timer and lifecycle
callbacks, and the line draws their cached results.

## Pull requests and CI

Run `/statusline github` once and paste a GitHub token with read access to the
repository (a fine-grained token with Pull requests and Commit statuses read is
enough); run it again to replace the token. The host stores it, attaches it only to `https://api.github.com` and
never shows it to the mod. Without a token the mod makes no network request.
The repository is the `origin` remote on github.com and the pull request is
the newest one whose head is the current branch of that repository (pull
requests from forks with the same branch name are ignored).
It polls once a minute while checks are pending and every three minutes
otherwise, backs off to 15 minutes after failures, honours `retry-after` and
the rate-limit reset (also for `/statusline refresh`), and discards results for
a branch you have left.

## Scripts

`scripts` holds up to four entries:

```json
[{"id": "weather", "command": ["sh", "/Users/me/bin/statusline-weather.sh"], "interval_s": 300, "timeout_ms": 1500}]
```

Add `script:weather` to a custom layout to show it. Each run gets one JSON
object on stdin (schema 1): `segment`, `placement`, `viewport {columns, rows}`,
`now_ms`, `session {thread_id, cwd, started_at_ms, duration_ms}`, `model`,
`context {used, window, remaining, used_percent, compactions}`, `tokens`,
`cost {billed_usd, estimated_usd, included_requests, pending_requests,
unknown_requests}`, `limits`, `git`, `github {status, pr, ci}`, `plan`,
`tools_running` and `agents`. Fields are null when unknown. The first non-empty
stdout line is drawn: SGR colors map to theme tones, bold, italic and underline
are kept, OSC 8 `http(s)` links become links, and every other control sequence
is removed. Scripts run in the `exec.run` sandbox (no network, a private HOME,
read-only workspace) with a 100–5000 ms deadline and 8 KiB of output; a hang
shows `timed out`, a non-zero exit `failed`. Results are redrawn from cache and
dropped when the script's entry changes. Scripts come only from your settings,
never from a repository file.
