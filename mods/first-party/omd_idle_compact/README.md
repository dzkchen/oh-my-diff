# omd_idle_compact

Compacts a large idle conversation near an estimated prompt-cache deadline. The conversation continues from a shorter summary, which loses detail and changes the reusable prompt prefix. Compaction uses the provider; savings and faster responses are not guaranteed.

## Turn it off

It is on by default in OMD+. Turn it off in `/mods`, or run:

```sh
omd mods disable omd_idle_compact
```

## Use it

- In `auto`, OpenAI subscription responses are left alone: signed-in Codex/Work has persistent caching. Other responses with cache activity or a reported lifetime set a timer for 90% of the estimated interval. An explicit interval also works without cache activity. Timing starts at the request's start, so a long response does not extend the estimate.
- When it fires, the thread is compacted if it is idle or waiting on you (an approval, a `request_user_input` question or an MCP elicitation).
- Compacting a waiting turn cancels the pending request, as `/compact` does. The transcript says `Compacted after the estimated prompt-cache idle interval` and names the cancelled approval or question, so you can ask Codex to continue.
- A turn running a long tool is left alone. A timer past the estimated interval is skipped, for example after the computer slept.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `cache_ttl_minutes` | `auto` | Estimated idle interval in minutes: `auto`, `5`, `10`, `30`, `60`, `120` or `720` (12 hours). This does not configure the provider's cache. |
| `min_tokens` | `100000` | Smaller contexts are never compacted. |

Change settings in `/mods`, or from a shell (this replaces the mod's saved settings):

```sh
STORE=~/.local/share/oh-my-diff/stores/full
omd-mod settings "$STORE" "$STORE/sources/omd_idle_compact" '{"cache_ttl_minutes": "10", "min_tokens": 50000}'
```

## Cache lifetime

The mod uses the first that applies:

1. `cache_ttl_minutes`, when not `auto`.
2. OpenAI subscription responses in `auto` are skipped, following the [October 20 persistent-caching announcement](https://x.com/thsottiaux/status/2112712984644784534). Unpriced OpenAI responses are also skipped: ordinary signed-in sessions have this label, and usage alone cannot distinguish them from unpriced API sessions. An API user without configured billing metadata can choose an explicit interval.
3. A lifetime the provider reports (the Claude route reports its 5-minute and 1-hour caches). Later cache reads reuse that interval only for the same provider, route, credential and model.
4. A 30-minute estimate for other `openai` responses with positive cache-read or cache-write tokens. Unknown providers without a reported lifetime are skipped.

OpenAI documents a 30-minute minimum for GPT-5.6+ API caches, refreshed by reads, and an optional 12-hour Responses cache. Older models and retention policies differ. An API integration selects the latter with `prompt_cache_options: {"ttl": "12h"}`; the pinned Codex client and this mod do not select that policy.

For an API route already configured for 12-hour caching, `cache_ttl_minutes: "720"` sets the mod's estimate. Subsequent reads preserve the estimated expiry or extend it to 30 minutes after the read, whichever is later; they do not restart 12 hours. When the mod first observes a cache read without a matching earlier estimate, it uses only that 30-minute refresh because the original write time is unknown. An explicit interval also opts subscription conversations into compaction.

Codex credit billing has no separate cache-write charge; API-key usage follows API pricing. Persistent caching does not mean unlimited usage or free cached input. See [OpenAI caching](https://developers.openai.com/api/docs/guides/prompt-caching#cache-lifetime) and [Codex pricing](https://learn.chatgpt.com/docs/pricing).

## Needs and limits

- Local providers (`ollama`, `lmstudio`, `oss`) are skipped, whatever `cache_ttl_minutes` says.
- If you're viewing another thread when the timer fires, it retries every 15 seconds until the estimated interval ends.
- Approvals and questions from subagents don't count as the thread waiting on you.
- Codex's own compactions (automatic or `/compact`) disarm the timer until the next response.
