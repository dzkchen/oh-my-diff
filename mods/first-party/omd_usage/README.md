# omd_usage

Shows what your session is using in a Usage dialog: context, cache, cost, quota, tasks and workers, request by
request. It's off by default in OMD+. OMD Core doesn't include it.

The status line below the prompt (`omd_statusline`) shows the summary.

## Turn it on

Turn it on in `/mods`, or run:

```sh
omd-package mod enable omd_usage
```

[Manage mods](../../../docs/manage-mods.md) covers the other ways to turn mods on and off.

## Use it

| Command or key | What it does |
| --- | --- |
| `Alt+a` or `/omd_usage:hud toggle` | Open or close the Usage dialog. Its expanded view lists recent requests. |
| `/omd_usage:hud` | Open the dialog, or refresh it when it's open. `close` closes it. |
| `/omd_usage:budget 5` | Warn when spend reaches 80% and 100% of 5 USD: a notice appears once at each, and the dialog shows spend against the budget. `0` removes the budget. |
| `/omd_usage:categories on` | Split each request by role (system, context, user, tool output). `off` turns it back off. |

Changes apply from your next message.

## Settings

Change these in `/mods`.

| Setting | Default | What it does |
| --- | --- | --- |
| `budget_usd` | `0` | Soft budget in USD. `0` means no budget. |
| `categories` | `false` | Show the request breakdown by role. It runs on every request, so it's off by default. |

## Needs and limits

- Costs come from what each provider reports. Requests on your ChatGPT plan count as included. Extra-usage credits
  spent past the plan's limit aren't reported per request. A cost the provider doesn't report shows as unknown, not
  zero.
- Totals cover the last 120 requests in the session, not lifetime spend. The budget also counts what older requests
  cost before they left that window.
- Quota windows are listed per account (Codex, Claude, Cursor), each under the account that reported it. None is
  tied to the route you're on.
- Cache expiry shows only when the provider reports how long its cache lasts.
- The budget is a warning. OMD's spending limits still decide what runs.
- Claude and OpenRouter usage need `omd_claude_cli` or `omd_profiles`. See
  [Use other providers](../../../docs/use-other-providers.md).

## More

- [Included mods](../../../docs/collection.md)
- [`omd_statusline`](../omd_statusline/README.md), which shows the usage summary below the prompt
- [`omd_profiles`](../omd_profiles/README.md) and [`omd_claude_cli`](../omd_claude_cli/README.md)
