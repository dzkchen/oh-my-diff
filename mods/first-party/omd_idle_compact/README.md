# Idle compaction

Compacts a large idle conversation just before the provider's prompt cache expires.

If you come back later, the next request reprocesses a short summary instead of the whole uncached context. The trade-off: the conversation continues from a summary, not your full context.

## Turn it off

It's on by default in OMD+. Turn it off in `/mods`.

## How it works

- After each model response, a timer is set for 90% of the cache lifetime.
- When it fires, the thread is compacted if it is idle or waiting on you (an approval, a `request_user_input` question or an MCP elicitation).
- Compacting a waiting turn cancels the pending request, as `/compact` does. The transcript says `Compacted while idle, before the prompt cache expired` and names the cancelled approval or question, so you can ask Codex to continue.
- A turn running a long tool is left alone. So is a cache that has already expired (for example after the computer slept).

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `cache_ttl_minutes` | `0` | Cache lifetime. `0` means detect it (see below). |
| `min_tokens` | `100000` | Smaller contexts are never compacted. |

```sh
omd-mod settings STORE omd_idle_compact '{"cache_ttl_minutes": 10, "min_tokens": 50000}'
```

## Cache lifetime

The mod uses the first that applies:

1. `cache_ttl_minutes`, when above 0.
2. A lifetime the provider reports (the Claude route reports its 5-minute and 1-hour caches).
3. 30 minutes. Codex sends no retention setting, so OpenAI defaults apply: at least 30 minutes for GPT-5.6 and later, typically about 30 minutes (up to 24 hours) for earlier models.

If your organization uses Zero Data Retention, entries last only about 5 to 10 minutes. Set `cache_ttl_minutes` in that case.

## Needs and limits

- Local providers (`ollama`, `lmstudio`, `oss`) are skipped, whatever `cache_ttl_minutes` says.
- If you're viewing another thread when the timer fires, it retries every 15 seconds until the cache expires.
- Approvals and questions from subagents don't count as the thread waiting on you.
- Codex's own compactions (automatic or `/compact`) disarm the timer until the next response.
