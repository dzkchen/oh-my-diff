# omd_usage

Shows what your session is using in a Usage dialog: context, cache, cost, quota, tasks and workers, request by
request. It's off by default in OMD+. OMD Core doesn't include it.

The status line below the prompt (`omd_statusline`) shows the summary.

## Turn it on

Turn it on in `/mods`, or run:

```sh
omd mods enable omd_usage
```

[Manage mods](../../../docs/manage-mods.md) covers the other ways to turn a mod on or off.

## Use it

| Command or key | What it does |
| --- | --- |
| `Alt+a` or `/usage toggle` | Open or close the Usage dialog. Its expanded view lists recent requests. |
| `/usage` | Open the dialog, or refresh it when it's open. `close` closes it. |
| `/usage budget 5` | Warn when spend reaches 80% and 100% of 5 USD. `0` removes the budget. |
| `/usage roles on` | Split each request by role (system, context, user, tool output). `off` turns it back off. |
| `/usage codex` | Open Codex's own usage menu (account usage, usage limit reset). The dialog's Codex usage button does the same. |

With a budget set, a notice appears once at 80% and once at 100%, and the dialog shows spend against the budget. Requests with no price yet (unsettled or unknown cost) are not in the figure; the notice and the dialog say how many.

Esc closes the dialog, and Tab moves between its buttons (Refresh, Expanded or Compact, Close). Enter presses the focused button. The dialog's first row lists these keys.

Changes apply from your next message.

## Settings

Change settings in `/mods`.

| Setting | Default | What it does |
| --- | --- | --- |
| `budget_usd` | `0` | Soft budget in USD. `0` means no budget. |
| `categories` | `false` | Show the request breakdown by role. It runs on every request, so it's off by default. |

## Needs and limits

- Costs come from what each provider reports. Requests on your ChatGPT plan count as included. Extra-usage credits
  spent past the plan's limit aren't reported per request. A cost the provider doesn't report shows as unknown, not
  zero.
- When Codex reports dollar usage for the lead thread through `account/usage/read`, the dialog and budget use that
  amount instead of the lead's configured-rate estimate. The mod reads it when the dialog opens or refreshes and,
  with a budget set, at every turn end. Workers' estimates and billed spend still count. If Codex reports no amount,
  the dialog and budget keep using the estimate.
- Totals cover the last 120 requests in the session, not lifetime spend. The budget also counts what older requests
  cost before they left that window.
- Quota windows are listed per account (Codex, Claude, Cursor), each under the account that reported it. No window
  depends on which model route (model setup) you're using.
- Cache expiry shows when the provider reports how long its cache lasts, or as a 30-minute estimate for OpenAI API
  responses with cache activity. Reads retain the reported lifetime for the same provider, route, credential and
  requested/served model among retained conversation requests. An OpenAI 12-hour cache keeps its write deadline;
  a read extends it only to at least 30 minutes ahead. ChatGPT plans and unpriced OpenAI responses show none. Rows with nothing to report
  (no workers, no paid API use, no plan, no running tools, no quota window) are left out.
- Running tools list the calls started while the dialog is open, so the mod doesn't rewrite its state on every tool
  call when nothing shows them.
- While it's on, it takes over Codex's `/usage`; `/usage codex` opens Codex's own menu.
- The budget only warns. OMD's own spending limits, such as a paid profile's allowance, still decide what runs.
- Claude and OpenRouter usage need `omd_claude_cli` or `omd_profiles`. See
  [Use other providers](../../../docs/use-other-providers.md).

## More

- [Included mods](../../../docs/collection.md)
- [`omd_statusline`](../omd_statusline/README.md), which shows the usage summary below the prompt
- [`omd_profiles`](../omd_profiles/README.md) and [`omd_claude_cli`](../omd_claude_cli/README.md)
