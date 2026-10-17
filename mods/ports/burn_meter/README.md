# burn_meter

Shows your session spend as a burning fuse above the prompt.

## Install it

From the curated directory:

```sh
omd install burn_meter
omd mods enable burn_meter
```

## What you see

- `BURN` and your plan windows (`5h 42% in 2h 0m`, `wk 12% in 3d 2h`).
- A fire bar.
- Session spend and what it would buy (`$1.30 = 0.12 burritos`, alternating with McDoubles).
- The busiest model's tokens, your lifetime total and a `hide` button.

Crossing $1, $5, $10, $25 or $50 in a session shows a toast once.

## Use it

| Command | What it does |
| --- | --- |
| `/burn` | Open the dialog: lifetime total, `Limits` bars, a `Per turn` bar for each of the last 12 turns and `That is` comparisons |
| `/burn show` / `/burn hide` | Show or hide the band |
| `/burn lifetime` | Print the lifetime total |
| `/burn demo` | Burn from $0 to $30 in 20 seconds, with the toasts |

## Good to know

- Only priced responses count. Subscription responses say `included in plan`, unpriced ones `cost unknown`. Neither adds $0.
- The lifetime total is shared by every session.
- The fire follows your shortest plan window, or grows with spend (full at $99) without one.
- It moves only while the amount changes. With reduced motion it stays still.
- For budgets and breakdowns, see `omd_usage`. They can run together.

## Limits of this port

- The fire uses block characters, up to 96 columns wide, with no white flash on the bar's edge.
- It doesn't spark or rotate comparisons while idle.
- `/burn` is a modal dialog; upstream's pane stays open beside the prompt.
- Accounts without rate limits show no plan bars.
- The band is drawn by a component module, which is experimental.

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
