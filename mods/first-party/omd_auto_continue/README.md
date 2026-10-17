# Auto-continue

Keeps a turn moving when nobody answers a prompt for two minutes.

## Turn it off

It's on by default in OMD+. Turn it off in `/mods`.

## How it works

When an approval, permission request, `request_user_input` question or MCP elicitation appears, a toast shows how long you have. If you answer first, your answer wins.

When the time runs out:

- Command and file-change approvals are declined, never approved.
- Permission requests are granted nothing.
- MCP elicitations are declined.
- Questions get an instruction to proceed with the recommended option or best judgment, and to state the assumption.

A transcript note then tells you and the model that the request timed out, so the model carries on with work that doesn't depend on it.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `timeout_seconds` | `120` | Wait before answering (1 to 86,400). `0` turns the timer off, including for requests already waiting. |

```sh
omd-mod settings STORE omd_auto_continue '{"timeout_seconds": 300}'
```

## Needs and limits

- It can't approve anything. Approving stays with you or a mod holding an `approve` grant.
- It needs the interactive terminal. `codex exec` and headless hosts refuse it.
- If you're viewing another thread at the deadline, it retries every 10 seconds until you return or answer.
