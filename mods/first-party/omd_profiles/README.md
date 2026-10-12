# Account and provider profiles

`omd_profiles` switches one OMD+ session between ChatGPT subscription accounts, OpenAI API keys and OpenAI- or Anthropic-compatible providers (OpenRouter, local endpoints) without restarting. It is installed inactive in OMD+ and can be installed explicitly in OMD Core.

```text
/profile add chatgpt work                 # native ChatGPT sign-in for another account
/profile add api_key openai-key           # masked OpenAI API key entry
/profile add provider openrouter openrouter https://openrouter.ai   # masked key for another provider
```

```sh
omd-package profiles --setup --add work --credential work --protocol responses \
  --url https://chatgpt.com/backend-api/codex/responses --upstream-model gpt-6.1-sol
omd-package profiles --setup --add router --credential openrouter --protocol chat \
  --url https://openrouter.ai/api/v1/chat/completions --upstream-model anthropic/claude-sonnet-5 \
  --window 200000 --paid 3:15 --allowance 5 [--max-output 32000] [--reasoning] [--cache-control]
omd-package profiles --setup --remove router
omd-package profiles [--model work] [codex args]   # launch with the profiles provider
```

```text
/profile                 # profiles, billing, availability and the current one
/profile use router      # applies at this thread's next turn; paid profiles ask first
/profile refresh work    # native token refresh
/profile remove work     # native credential removal
```

How it works:

Provider tool names use distinct aliases of at most 64 characters, including names
that collide after namespace flattening or truncation. Tool history and returned
calls map back to the original namespace and name.

- Credentials are enrolled, refreshed and removed by the host's native flows (`credentials.request`); the mod never sees a token. Each profile is a `host.json` lead route on the `omd_profiles` provider that names its credential, so the host puts that account's token on each request.
- Setup writes the route, a Codex catalog entry (the bundled entry when the upstream model is a Codex model, otherwise `--window` is required) and the router table. The host rereads `host.json` routes, so a profile added while a session runs can be selected there with `/profile use`; the `/model` list shows new profiles after the next launch.
- `/profile use` (or the Profiles list in the compact `/model` picker) updates the current thread's native model and effort while idle, then records the route switch for its next turn: the thread, attachments and tool history stay, and its footer, `/status` and following turns use the chosen profile's model and context window. A refused or unsettled switch blocks model requests, shows `profile switch failed` in the status line and gives its reason in `/profile`. Each turn on a profiles thread restarts the router if it stopped (host workers live at most `worker_limits.seconds`, 30 minutes by default; setup no longer raises that limit).
- The host rereads limits and allowances at each turn, so a paid profile added while a session runs is admitted from the next turn; an edited profile (price, credential, model) applies from the next turn to threads already on it.
- Setup checks every value before writing anything: `--paid` needs two prices above zero, `--window` and `--max-output` whole token counts, and paid profiles an allowance. `--reasoning` sends Anthropic thinking or a Chat Completions effort (`none` sends none); Anthropic thinking blocks, with their signatures, go back to the profile that produced them on later requests, as Anthropic requires around tool calls. `--cache-control` lets a `chat` profile receive a `model.complete` cache mark as content `cache_control` (OpenRouter accepts it; strict Chat Completions servers reject unknown fields, so it is off by default); `anthropic` profiles always get it.
- The router (a loopback Responses provider started with `providers.register`) forwards `responses` profiles unchanged and adapts `chat` (Chat Completions) and `anthropic` (Messages) profiles: tools become JSON-schema functions (freeform tools take an `input` string), images pass through, developer messages after the first turn become user text, and usage maps back for the ledger with cache writes, the served model, the raw provider usage (`omd_native_usage`), OpenRouter's billed `usage.cost` (`omd_reported_cost`) and Anthropic cache TTLs (`omd_cache_ttl_seconds`). It sees the injected token only to forward it.
- Paid profiles need `--paid INPUT_USD:OUTPUT_USD` per million tokens and a host allowance (`--allowance USD`); the host admits and records each request against it. ChatGPT profiles are included subscription usage and report no charge.

Recovery: the session needs the enabled mod because its provider is the router. If the mod is disabled or broken, requests fail with the provider error; re-enable it (`/mods enable omd_profiles`) or start a plain `codex` session. Removing a credential stops the profiles that use it at their next request; rerun setup with `--remove` to drop them. A forked or new thread starts on the launch profile; the router rejects a thread larger than a profile's window with `context_length_exceeded` before calling the provider.

Limitations: reasoning produced before a switch is never sent again on that conversation, even after switching back (its encrypted content belongs to the account that produced it); reasoning never reaches `chat` profiles, and `anthropic` profiles get only their own thinking blocks; a stream the provider closes early fails instead of completing; inline images count as about 1,500 tokens in the window check; hosted tools (web search, tool search) are dropped for those protocols. Providers that omit usage are recorded from a 4-bytes-per-token estimate (`omd_usage_estimated`). The Claude CLI route is a separate provider and stays a separate launch (`omd-package claude`); a thread cannot switch between providers. Live subscription evidence covers an in-session Sol→Astra switch on one account with preserved history, native model/status and catalog-window updates, plus disable/re-enable recovery. Browser enrollment, distinct-account switching, OpenAI API, OpenRouter, other Chat Completions and Anthropic-compatible routes remain outside that live evidence.

Inspired by [Crush](https://github.com/charmbracelet/crush) provider setup and session model switching; no code copied.
