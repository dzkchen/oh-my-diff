# Auto-continue

`omd_auto_continue` keeps a turn moving when nobody answers its prompt. If an approval, permission request, `request_user_input` question or MCP elicitation stays unanswered for two minutes, the mod answers it the way an away user safely would, and the turn carries on with the rest of its work. OMD+ enables it by default; turn it off in `/mods`.

When a request appears, a toast says how long you have. Answering before the deadline always wins; an answer given in the same instant as the deadline still takes effect, though the transcript note below may still appear. When the time runs out:

- Command and file-change approvals are declined (never approved).
- Permission requests are granted nothing.
- MCP elicitations are declined.
- Questions are answered with an instruction to proceed with the recommended option or best judgment and to state the assumption.

A transcript note visible to you and the model then says the request timed out (you may be away), so the model continues with work that does not depend on it.

The mod answers through the host's `app.respond` operation, which accepts only these results: it cannot approve a command, file change, permission or MCP request, so approving those stays with you or a mod holding an `approve` grant. A question answer is the mod's best-judgment instruction, which the model receives as your reply. It needs the interactive terminal; `codex exec` and headless hosts refuse it.

If you are viewing another thread when the time runs out, the mod retries every 10 seconds until you return or answer.

Setting: `timeout_seconds` (default 120, 1 to 86,400; 0 turns the timer off, including for requests already waiting), for example `omd-mod settings STORE omd_auto_continue '{"timeout_seconds": 300}'`.
