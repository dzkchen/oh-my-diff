# omd_auto_continue

Declines unanswered approvals and responds to unanswered questions after a wait (two minutes by default). For
questions, it tells the agent to continue already-authorized work and use best judgment for optional choices.
It never approves an action or settles a required decision. It's off by default in OMD+. OMD Core doesn't include it.

## Turn it on

Turn it on in `/mods`, or run:

```sh
omd mods enable omd_auto_continue
```

To turn it off again, run `omd mods disable omd_auto_continue`.

[Manage mods](../../../docs/manage-mods.md) covers the other ways to turn a mod on or off.

## Use it

A toast counts down the wait for an approval, permission request, agent question (`request_user_input`) or MCP
elicitation (a form from a connected tool server). If you answer before the deadline, the mod uses your answer.

When the time runs out:

- Command and file-change approvals are declined, never approved.
- Permission requests are granted nothing.
- MCP elicitations are declined.
- Questions get an instruction to continue already-authorized work, use best judgment for optional choices, and state
  the assumption. A timeout does not grant permission, authorize spending or settle a required decision.

A transcript note tells you that the request timed out. The model receives the tool's answer or denial. For each
declined approval it also gets one short notice with its next request, saying the decline was a timeout, not a refusal,
and not to retry actions that need approval. Neither note changes any earlier message, so the provider can still reuse
its cache of the conversation.

The deadline starts when the request appears. Delayed delivery or a repeated notification does not extend it.
Requests explicitly addressed to another thread are ignored. That includes a sub-agent's approval blocking its lead:
an automatic decline would fail the delegated task, so those requests stay pending for you instead of being answered
on the timeout.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `timeout_seconds` | `120` | Wait before answering (1 to 86,400). `0` turns the timer off, including for requests already waiting. |

Change settings in `/mods`, which changes one setting at a time, or from a shell with `omd-mod`, the low-level tool
that works on a mod store directly. The shell form replaces all of the mod's saved settings, so any setting you leave
out goes back to its default:

```sh
STORE=~/.local/share/oh-my-diff/stores/full
omd-mod settings "$STORE" "$STORE/sources/omd_auto_continue" '{"timeout_seconds": 300}'
```

## Needs and limits

- It can't approve anything. Only you, or a mod you gave the `approve` grant, can approve.
- It needs the interactive terminal. `codex exec` and headless hosts refuse it.
- If you're viewing another thread at the deadline, it retries every 10 seconds until you return or answer.
- The timeout applies only to requests nobody answered. It doesn't measure or refresh a prompt cache, sends no keepalive
  or prewarm requests and doesn't change cache policy.
- Continued work can consume subscription allowance or API tokens. See
  [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching) and
  [Codex billing](https://learn.chatgpt.com/docs/pricing) for the API and subscription rules.

## More

- [Included mods](../../../docs/collection.md)
- [Approvals](../../reference/app-bridge-and-approvals.md#approvals-approval_v1) in the mod API reference
- [`omd_idle_compact`](../omd_idle_compact/README.md), the other mod that acts while you're away
