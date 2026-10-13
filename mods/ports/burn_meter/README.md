# burn_meter

Session spend as a burning fuse above the prompt.

The band shows `BURN`, the plan windows from the account's rate limits (`5h 42% in 2h 0m`, `wk 12% in 3d 2h`), a fire bar, the session's priced spend with what it would buy (`$1.30 = 0.12 burritos`, alternating with McDoubles), the busiest model's tokens, the lifetime total and a `hide` button. Crossing $1, $5, $10, $25 or $50 in a session shows a toast once.

`/burn` opens a dialog like upstream's pane: `SESSION BURN` with the lifetime total, a larger fuse, `Limits` bars, a `Per turn` bar for each finished turn (last 12, the costliest in orange) and `That is` comparisons. `/burn show` and `/burn hide` toggle the band (any other argument acts as `show`), `/burn lifetime` prints the lifetime total, `/burn demo` burns from $0 to $30 in 20 seconds with the threshold toasts. Every reply but `lifetime`, `hide` and `demo` is the session summary with a `Models:` line.

## Spend

Only priced responses count as spend: `model_response` cost with basis `settled` or `provider_reported`. Responses on an included subscription say `included in plan`, and responses with no price say `cost unknown`; neither is added as $0. Each request and attempt is counted once. The lifetime total is in the user-scoped store, shared by every session; the session's figures are thread-scoped state, so they fork and resume with the thread.

With a plan window available the fire is as long as the shortest window's use; otherwise it grows with the spend (log scale, full at $99).

## Motion

The fire flickers only while the amount rolls to a new value (70 ms frames, about two seconds) and during `/burn demo`; otherwise it draws once and runs no timer. With reduced motion the amount jumps to the new value and the fire does not move.

## Compared with omd_usage

`omd_usage` is OMD's opt-in usage HUD: a per-request ledger with cache, quota and category breakdowns, budgets and published summaries. `burn_meter` is a playful view of the same `model_response` figures: one band, a fire bar, food comparisons and threshold toasts. They can run together.

## Limits of this port

- Upstream drew the fire with a `Raster` element; this port draws it with block characters in a component module, at most 96 columns wide, with at most 12 colour runs per row, and without the white flash on the bar's leading edge.
- The fire and the burrito/McDouble rotation move only while the amount rolls or the demo runs; upstream sparks and rotates every 6 s while idle. This keeps an idle session at zero redraws.
- The amount and comparison sit above the fire instead of at the top of the right-hand column, and `BURN`'s colour follows the real spend, not the demo ramp.
- Without a price the band says `included in plan` or `cost unknown` instead of `$0.00`, and `That is` appears only for priced spend.
- `/burn` is a modal dialog; upstream's pane stays open beside the prompt.
- The plan windows come from `account/rateLimits/read`, refreshed at session start and after each turn. Accounts without rate limits show no plan bars.
- Model names from Claude model IDs are shortened like upstream (`claude-opus-5-5` to `opus 5.5`); other IDs are shown as they are.

## Capabilities

- `model`: `model_response`, for cost and tokens.
- `lifecycle`: `start`, `resume`, `turn_start` and `turn_end`, for per-turn cost and refreshing plan windows.
- `terminal`: the band, the dialog, the fire module and the threshold toasts (`terminal.notice`).
- `store`: thread-scoped state and the user-scoped `lifetime` key.
- `commands`: `/burn`.
- `account`: plan windows through `api.usage.rateLimits()`.

No network, processes, files or model calls.

## Credit

Reimplemented over the Oh My Diff mod API from the Claude Code mod
[`burn-meter` 0.1.0](https://github.com/OneWave-AI/claude-code-mods/tree/e6da26ca36a88eec3be25605d30fa20f2c1c0cec/burn-meter)
by OneWave AI, commit `e6da26ca36a88eec3be25605d30fa20f2c1c0cec`, licensed MIT.
The thresholds, comparisons, number formats, fire colors and the `/burn` commands follow upstream.

```text
MIT License

Copyright (c) 2026 Claude Code Mods contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
