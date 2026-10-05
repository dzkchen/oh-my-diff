# omd_usage

Opt-in provider usage HUD, installed inactive in OMD+ (`omd-package mod enable
omd_usage`). It adds Usage and Workers panels to the sidebar, a Usage dialog
(Alt+a or `/omd_usage:hud`) and the data behind `omd_theme`'s cache, quota
and spend status-line segments. `/omd_usage:budget 5` sets an optional
soft budget in USD (`0` removes it) and `/omd_usage:categories on` adds the
request category drilldown; both apply from the next turn. Settings:
`categories` and `budget_usd`.

- **Ledger.** Every `model_response` (lead, sub-agent and mod worker attempts)
  becomes one record keyed by request ID and attempt, with thread, turn, agent,
  provider, credential profile, route, requested and served model, the native
  ledger request number, tokens (input, cache read, cache write, output,
  reasoning), cost basis, the adapter's reported cost and the observation time.
  A repeated delivery is a no-op; a correction replaces the record only when it
  is at least as complete (measured usage, settled cost) and counts a revision,
  and `task.status` settles unsettled records by ledger request number. Records
  are ordered by observation time, so late deliveries never become the latest
  reading. State is per session thread (forks keep the parent's records and
  label them inherited); 120 records are kept and the dialog says how many
  older ones were dropped, so totals are retained totals, not lifetime spend.
- **Context.** Model, provider, route and reasoning effort, then the last lead
  response's input and output against the session's effective window
  (`thread/tokenUsage/updated`), with reserve and headroom from
  `model_auto_compact_token_limit` when configured (no built-in reserves).
  Workers never count toward it. The reading is marked stale after an installed
  compaction, a rewind or a model or provider switch. Observed growth per
  request and an approximate "requests before auto-compact" scenario appear once
  there are enough requests. `categories` adds a `model_request` observer that
  splits the assembled lead request by role (system, context, user, tool output)
  from section byte sizes (bytes ÷ 4, labeled approximate); it runs on the
  request path, so it is off by default. Compaction shows started versus
  installed, so a vetoed or failed one is visible.
- **Cache.** Cache read share of input (the adapters report input including
  cache reads and writes, so one denominator holds for every provider), cache
  writes when the provider reports them, and expiry only when the adapter
  reports a provider TTL (`omd_cache_ttl_seconds`, Anthropic's 5-minute or
  1-hour entries), counted from the last request that used the cache and
  labeled a projection; a generation-owned one-minute timer redraws that
  countdown until it passes and then stops (it records no observation).
  Otherwise expiry is "unavailable"; the HUD never claims a warm cache and sends
  no keepalive requests.
- **Cost.** Each record is billed (provider-reported, such as OpenRouter's
  `usage.cost` or a Cursor charge settled later in the ledger), a
  configured-rate estimate, unsettled, included subscription use (with the
  Claude CLI's list-equivalent estimate when reported), unknown (missing cost is
  not zero) or none (synthetic). Lead, workers and inherited records are totaled
  separately, and unknown subscription overage is said so.
- **Quota.** `account/rateLimits/read` at start and `account/rateLimits/updated`
  give each reported window (its own duration, used share, reset time and
  extra-usage credits). Readings carry no route, so they belong to the lead's
  latest provider and credential profile; readings before the first lead
  response are bound to the account of that response. Identical repeated
  readings only refresh their observation time. A projection at reset needs two
  readings in the current period spanning at least 5 minutes or a tenth of the
  window; otherwise it says the data is insufficient. After the reset time
  passes the window reads stale until a new reading arrives.
- **Surfaces.** The Usage panel shows cache, quota windows, spend, the paid
  allowance bar from `task.status` limits and the soft budget; the Workers panel
  shows plan progress, running sub-agents and running tools. The dialog's
  Expanded view adds a tokens-per-request sparkline and the 40 most recent
  records. The summary is published on `omd_usage/hud` for `omd_theme`. Glyphs
  are ASCII so the HUD reads the same without color or Unicode; inline (mini)
  sessions hide the sidebar.
- **Budget.** Spend at 80% of the soft budget turns the cost segment to
  attention and at 100% to failure. It is a warning only: the host's limits
  remain the spending authority.

Provider coverage comes from the route adapters: Codex subscription and API
(native Responses usage), the Claude CLI subscription (`omd_claude_cli`: served
model, cache read/write, TTL, list-equivalent cost), Claude API and OpenRouter
through `omd_profiles` (served model, cache writes, raw usage, OpenRouter's
billed cost, Anthropic TTL), Muse (`omd_muse`: cache writes) and Cursor
(`omd_cursor`: observed tokens, provider-billed charges that stay unsettled
until the mod settles them; plan pools are in `/cursor usage`). Live routes are
not exercised by the tests.

Capabilities: `agents` (`task.status`), `commands`, `store`, `terminal`,
`events`, `model` (`model_response`), `lifecycle`, `middleware` (`agent` and
`tool_call` events, the category observer), `threads` (notifications),
`config` (`config/read`), `account` (`account/rateLimits/read`) and
`inventory` (`session.info`).
