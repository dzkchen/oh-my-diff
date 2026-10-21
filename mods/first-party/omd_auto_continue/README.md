# omd_auto_continue

Keeps a turn moving when nobody answers a prompt for two minutes.

## Turn it off

It is on by default in OMD+. Turn it off in `/mods`, or run:

```sh
omd-package mod disable omd_auto_continue
```

## Use it

When an approval, permission request, `request_user_input` question or MCP elicitation appears, a toast shows how long you have. If you answer first, your answer wins.

When the time runs out:

- Command and file-change approvals are declined, never approved.
- Permission requests are granted nothing.
- MCP elicitations are declined.
- Questions get an instruction to continue already-authorized work, use best judgment for optional choices, and state the assumption. A timeout does not grant permission, authorize spending or settle a required decision.

A transcript note tells you that the request timed out. The model receives the tool's answer or denial; the notice does not rewrite an earlier prompt and disrupt cache reuse.

The deadline starts when the request appears. Delayed delivery or a repeated notification does not extend it. Requests explicitly addressed to another thread are ignored.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `timeout_seconds` | `120` | Wait before answering (1 to 86,400). `0` turns the timer off, including for requests already waiting. |

From this checkout, using your mod store path for `STORE`:

```sh
omd-mod settings STORE mods/first-party/omd_auto_continue '{"timeout_seconds": 300}'
```

## Prompt caching

The timeout controls unanswered prompts; it does not measure or refresh a prompt cache. Signed-in Codex/Work has [persistent caching](https://x.com/thsottiaux/status/2112712984644784534), so this timer is for unattended progress. Continuing work can consume subscription allowance or API tokens. The mod sends no periodic keepalive or prewarm requests and does not change cache policy. See [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching) and [Codex billing](https://learn.chatgpt.com/docs/pricing) for the different API and subscription rules.

## Needs and limits

- It can't approve anything. Approving stays with you or a mod holding an `approve` grant.
- It needs the interactive terminal. `codex exec` and headless hosts refuse it.
- If you're viewing another thread at the deadline, it retries every 10 seconds until you return or answer.
