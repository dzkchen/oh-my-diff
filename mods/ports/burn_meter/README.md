# burn_meter

Shows what the current thread has spent as a burning fuse above the prompt. It's a port of a Claude Code plugin in
the curated directory. OMD+ doesn't install it, and it isn't in the bundled collection.

## Install it

Pick it under Available in `/mods`, or run:

```sh
omd install burn_meter
omd mods enable burn_meter
```

It asks for `terminal`, `model`, `lifecycle`, `store`, `commands` and `account`. See
[Manage mods](../../../docs/manage-mods.md) for the other ways to install and turn on mods, and
[Trust and permissions](../../../docs/trust-and-permissions.md) for what a grant allows.

## Use it

The band above the prompt shows:

- `BURN` and your plan windows (`5h 42% in 2h 0m`, `wk 12% in 3d 2h`).
- A fire bar.
- The thread's spend and what it would buy (`$1.30 = 0.12 burritos`, alternating with McDoubles).
- In and out tokens for the model with the most output tokens (two models at 140 columns or wider), your lifetime
  total and a `hide` button.

Crossing $1, $5, $10, $25 or $50 in a thread shows a toast once.

| Command | What it does |
| --- | --- |
| `/burn` or `/burn panel` | Open the dialog: lifetime total, `Limits` bars, a `Per turn` bar for each of the last 12 turns and `That is` comparisons |
| `/burn show` / `/burn hide` | Show or hide the band |
| `/burn lifetime` | Print the lifetime total |
| `/burn demo` | Open the dialog and burn from $0 to about $30 in 20 seconds, with the toasts up to $25 |

## Settings

It has no settings.

## Needs and limits

- Only priced responses count. Subscription responses say `included in plan`, unpriced ones `cost unknown`. Neither
  adds $0.
- Spend, toasts and the per-turn chart are per thread. The lifetime total is shared by every thread.
- The fire follows your shortest plan window, or grows with spend (full at $99) without one.
- It moves only while the amount changes, and no animation runs while idle. With reduced motion it stays still.
- The fire uses block characters, with no white flash on the bar's edge. Its width is capped at 96 columns, and the
  band's fuse box is at most 64 columns wide.
- `/burn` is a modal dialog. Upstream's pane stays open beside the prompt.
- Accounts without rate limits show no plan bars.
- For budgets and breakdowns, see `omd_usage`. They can run together.

## More

- [Terminal UI reference](../../reference/terminal-ui.md) for the band, dialog and component modules.
- Credit: reimplemented over the Oh My Diff mod API from the Claude Code mod
  [`burn-meter` 0.1.0](https://github.com/OneWave-AI/claude-code-mods/tree/e6da26ca36a88eec3be25605d30fa20f2c1c0cec/burn-meter)
  by OneWave AI, commit `e6da26ca36a88eec3be25605d30fa20f2c1c0cec`, licensed MIT. The thresholds, comparisons, number
  formats, fire colors and the `/burn` commands follow upstream. The full MIT license text is in
  [`THIRD_PARTY_NOTICES.md`](../../../THIRD_PARTY_NOTICES.md).
