# omd_idle_compact

When a large conversation sits idle, it compacts the conversation (replaces the earlier messages with a shorter
summary) shortly before the provider's prompt cache is estimated to expire. Your next message then sends that summary
instead of the whole history, which the provider no longer has cached. It's on by default in OMD+. OMD Core doesn't
include it.

The conversation continues from a shorter summary. That loses detail and changes the start of the conversation that
the provider can reuse from its cache.
Compaction uses the provider, and savings and faster responses are not guaranteed.

## Turn it off

Turn it off in `/mods`, or run:

```sh
omd mods disable omd_idle_compact
```

[Manage mods](../../../docs/manage-mods.md) covers the other ways to turn a mod on or off.

## Use it

There is no command. It works on its own:

- A response with cache activity, or one whose provider reports a cache lifetime, sets a timer for 90% of the
  estimated lifetime. Timing starts when the request starts, so a long response doesn't extend it.
- In `auto`, OpenAI subscription responses set no timer, because Codex sessions signed in with a ChatGPT plan have
  persistent caching. An explicit `cache_ttl_minutes` sets a timer even without cache activity.
- When it fires, the thread is compacted if it is idle or waiting on you: an approval, a question the agent asked you
  (`request_user_input`), or an MCP elicitation, which is a form a connected tool server (MCP server) asks you to fill
  in.
- Compacting a waiting turn cancels the pending request, as `/compact` does. The transcript says
  `Compacted after the estimated prompt-cache idle interval` and names the cancelled approval or question, so you can
  ask Codex to continue.
- A turn running a long tool is left alone. A timer past the estimated interval is skipped, for example after the
  computer slept.

### How it estimates the cache lifetime

The mod uses the first that applies:

1. `cache_ttl_minutes`, when not `auto`.
2. In `auto`, OpenAI subscription responses are skipped, following OpenAI's
   [persistent-caching announcement](https://x.com/thsottiaux/status/2112712984644784534). Unpriced OpenAI responses
   are skipped too. Ordinary signed-in sessions have that label, and usage alone can't tell them apart from unpriced
   API sessions. If you use an API key without configured billing metadata, set an explicit interval.
3. A lifetime the provider reports (the Claude route reports its 5-minute and 1-hour caches). Later cache reads reuse
   that interval only for the same provider, route, credential and model.
4. A 30-minute estimate for other `openai` responses with positive cache-read or cache-write tokens. Unknown providers
   without a reported lifetime are skipped.

OpenAI documents a 30-minute minimum for GPT-5.6+ API caches, refreshed by reads, and an optional 12-hour Responses
cache. Older models and retention policies differ. An API integration selects the 12-hour cache with
`prompt_cache_options: {"ttl": "12h"}`. The pinned Codex client and this mod don't select that policy.

For an API route already configured for 12-hour caching, `cache_ttl_minutes: "720"` sets the mod's estimate. Later
reads keep the estimated expiry or extend it to 30 minutes after the read, whichever is later. They do not restart
12 hours. When the mod first sees a cache read without a matching earlier estimate, it uses only that 30-minute
refresh, because the original write time is unknown. An explicit interval also opts subscription conversations into
compaction.

Codex credit billing has no separate cache-write charge. API-key usage follows API pricing. Persistent caching does
not mean unlimited usage or free cached input. See
[OpenAI caching](https://developers.openai.com/api/docs/guides/prompt-caching#cache-lifetime) and
[Codex pricing](https://learn.chatgpt.com/docs/pricing).

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `cache_ttl_minutes` | `auto` | Estimated idle interval in minutes: `auto`, `5`, `10`, `30`, `60`, `120` or `720` (12 hours). This does not configure the provider's cache. |
| `min_tokens` | `100000` | Smaller contexts are never compacted. |

Change settings in `/mods`, or from a shell with `omd-mod`, the low-level tool that works on a mod store directly. The
shell form replaces the mod's saved settings:

```sh
STORE=~/.local/share/oh-my-diff/stores/full
omd-mod settings "$STORE" "$STORE/sources/omd_idle_compact" '{"cache_ttl_minutes": "10", "min_tokens": 50000}'
```

## Needs and limits

- Local providers (`ollama`, `lmstudio`, `oss`) are skipped, whatever `cache_ttl_minutes` says.
- If you're viewing another thread when the timer fires, it retries every 15 seconds until the estimated interval
  ends.
- Approvals and questions from subagents (helper agents the main agent starts for part of a task) don't count as
  the thread waiting on you.
- Codex's own compactions (automatic or `/compact`) disarm the timer until the next response.

## More

- [Included mods](../../../docs/collection.md)
- [History](../../reference/history.md) in the mod API reference
- [`omd_auto_continue`](../omd_auto_continue/README.md), the other mod that acts while you're away
