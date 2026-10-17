# omd_advisor

A second model gives you an independent opinion on a decision, a stalled attempt or a claimed completion, and can flag output you should know about.

## Turn it on

It comes with OMD+ but starts off. Turn it on in `/mods`, or run:

```sh
omd-package mod enable omd_advisor
```

It uses the model route in `route` (default `astra`), so that route needs its own model access and allowance. Each request goes through the usual admission and spending limits.

## Use it

| Command or key | What it does |
| --- | --- |
| `/advisor [focus]` | Ask the lead model to consult the advisor, optionally about one focus. The advice goes to the lead, which decides what to adopt. |
| `/observations` | With `observe` on, list the notes under "You should know" and the observer state. |
| `/observations N` | Open note N with its detail and source. `Alt+m` then Enter does the same from the list above the prompt. |
| `/observations dismiss N` or `all` | Dismiss a note, or every note. |

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `route` | `astra` | The model route the advisor runs on. |
| `triggers` | `[]` | Consult automatically: `failure` (same call failed twice), `loop` (same output three times) or `completion` (review turns that changed files). |
| `every_turn` | `false` | Review every completed lead turn. |
| `mode` | `advisory` | `blocking` also requires a workflow contract with an advisor review gate. |
| `share` | `conversation`, `diff`, `files` | What the advisor may see. |
| `skip_same_model` | `true` | Skip consultations when the advisor and the lead use the same model. |
| `observe` | `false` | Flag behavior changes, unresolved failures and decisions needed in the lead's visible output. |

## Needs and limits

- Advice is a second opinion, not an approval, and does not replace your own review or verification.
- The prompt is capped at 8 KB. Private keys, bearer tokens, credential assignments, URL credentials and AWS key ids are redacted first. That is a pattern filter, not a guarantee.
- Reviews cite exact quotes. A finding whose quote isn't in the evidence is dropped.
- Observer notes are for you only. They never reach the lead and never block anything.

Credit: ask and trigger modes based on [pi-advisor-flow](https://pi.dev/packages/pi-advisor-flow) by Philip Brembeck (MIT); the observer follows the "You should know" behavior of Claude Code 2.1.287. No code copied.
