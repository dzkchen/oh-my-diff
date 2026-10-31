# omd_advisor

Gets a second model's opinion on a decision, a stalled attempt or a claimed completion, and flags output you should
know about. It's off by default in OMD+. OMD Core doesn't include it.

## Turn it on

Turn it on in `/mods`, or run:

```sh
omd-package mod enable omd_advisor
```

[Manage mods](../../../docs/manage-mods.md) covers the other ways to turn a mod on or off.

Then pick the model the advisor runs on. That's the `route` setting, which has no default. In `/mods`, open Advisor,
then Advisor model. Or choose Add a helper model there to use the model you're chatting with on your ChatGPT plan.
Other worker routes (model setups in `host.json`) need their own model access and allowance. Until `route` is set, the
advisor reports `unavailable` with the routes it can use, and the status line reads `Advisor: no route set`.

## Use it

| Command or key | What it does |
| --- | --- |
| `/advisor [focus]` | Ask the model you're chatting with (the lead) to consult the advisor, optionally about one focus. The lead decides what to adopt. |
| `/observations` | With `observe` on, list the "You should know" notes and the observer state. |
| `/observations N` | Open note N with its detail and source. `Alt+m` then Enter does the same from the list above the prompt. |
| `/observations dismiss N` or `all` | Dismiss one note, or every note. |

For example, `/advisor the migration order` asks for a review focused on the migration order.

## Settings

Change settings in `/mods`.

| Setting | Default | What it does |
| --- | --- | --- |
| `route` | none | Worker route the advisor runs on |
| `triggers` | `[]` | Consult automatically on `failure` (same call failed twice), `loop` (same output three times) or `completion` (turns that changed files) |
| `every_turn` | `false` | Review every completed lead turn |
| `mode` | `advisory` | `blocking` also needs a workflow contract with an advisor review gate |
| `share` | `conversation`, `diff`, `files` | What the advisor may see |
| `skip_same_model` | `true` | Skip reviews, observation and `/advisor` asks when the advisor and the lead use the same model |
| `observe` | `false` | Flag behavior changes, unresolved failures and decisions needed in the lead's output |

## Needs and limits

- It asks to add `/advisor`, `/observations` and a consult tool, read the conversation with its tool calls, the diff
  (`git diff`) and workspace files, run the advisor model on a worker route, add its findings to the lead's context,
  submit review receipts to a workflow contract, follow turns and tool output, show notes and keep its state. The
  capabilities are `commands`, `tools`, `sessions`, `sessions_tools`, `exec`, `fs.read`, `agents`, `model`, `context`,
  `contracts`, `lifecycle`, `outputs`, `terminal` and `store` (see
  [Trust and permissions](../../../docs/trust-and-permissions.md#what-a-mod-can-do)).
- Advice is a second opinion, not an approval. Review and verify yourself.
- The prompt is capped at 8 KB. Keys, tokens and credentials are redacted first, but that is a pattern filter, not a
  guarantee.
- The conversation section contains the newest complete history records that fit in 2.5 KB. It never cuts a record off.
  When the newest record alone is larger, the section says so instead.
- A finding whose quoted evidence isn't found is dropped.
- The observer, like reviews, runs only after turns that completed.
- Observer notes are for you only. They never reach the lead or block anything.

## More

- [Included mods](../../../docs/collection.md)
- [Routes](../../reference/routes.md) and [model calls](../../reference/model-calls.md) in the mod API reference
- [`omd_workflow`](../omd_workflow/README.md) for the contracts that `blocking` mode needs
- Credit: ask and trigger modes based on [pi-advisor-flow](https://pi.dev/packages/pi-advisor-flow) by Philip Brembeck
  (MIT); the observer follows the "You should know" behavior of Claude Code 2.1.287. No code copied.
