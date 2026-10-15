# Idle compaction

`omd_idle_compact` compacts a large conversation that has gone idle just before the provider's prompt cache expires. If you come back later, the next request reprocesses the compaction summary instead of the whole uncached context. OMD+ enables it by default; turn it off in `/mods`. The trade-off is that the conversation continues from a summary instead of your full context.

After every main-thread model response the mod arms a timer for 90% of the cache lifetime, measured from the start of that request, when the provider last read or wrote the cache. When a turn ends without a later response (an interrupt or an error) it re-arms from the same point. When the timer fires, it compacts if the thread is idle, or if the turn is waiting on you (a command, patch or permission approval, a `request_user_input` question or an MCP elicitation). A turn running a long tool is left alone, and so is a cache that has already expired (for example after the computer slept), since compacting it would reprocess the whole context anyway. Compacting a waiting turn cancels the pending request, as `/compact` does. The transcript then shows `Compacted while idle, before the prompt cache expired`, and names the cancelled approval or question so you can ask Codex to continue.

Cache lifetime, in order:

1. The `cache_ttl_minutes` setting when it is above 0.
2. A lifetime the provider reports in the response usage (`omd_cache_ttl_seconds`, set by the Claude route for its 5-minute and 1-hour caches). Responses that only read the cache keep the lifetime that provider last reported.
3. 30 minutes otherwise. Codex sends no retention setting, so OpenAI's defaults apply. GPT-5.6 and later keep a prefix for at least 30 minutes after its last write or reuse. GPT-5.5 keeps one for typically about 30 minutes, up to 24 hours. Earlier models default to 24-hour retention (typically about 30 minutes) unless the organization uses Zero Data Retention, which keeps entries only about 5 to 10 minutes; set `cache_ttl_minutes` in that case.

Local providers (`ollama`, `lmstudio`, `oss`) are skipped, whatever `cache_ttl_minutes` says. If you are viewing another thread when the timer fires, the mod retries every 15 seconds until the cache expires. Approvals and questions from other threads (subagents) don't count as this thread waiting on you. Contexts below `min_tokens` (default 100,000) are never compacted, because a small context costs little to reprocess. Codex's own compactions (automatic or `/compact`) disarm the timer until the next response.

Settings: `omd-mod settings STORE omd_idle_compact '{"cache_ttl_minutes": 10, "min_tokens": 50000}'`.
