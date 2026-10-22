# omd_cursor

Experimental. Lets a session use Cursor models through your Cursor account and the official [Cursor TypeScript SDK](https://cursor.com/docs/sdk/typescript).

## Turn it on

It needs Node and pnpm on your `PATH`, and `omd-mod` (the installer links it into `~/.local/bin`).

1. Enable `omd_cursor` in `/mods` and approve its trust dialog. It asks to run `node` outside the sandbox (`os`): setup installs the SDK, reaches the network and writes the mod store.
2. Run `/cursor setup`. A background `setup.mjs` installs `@cursor/sdk@1.0.35` with pnpm into `<store>/routes/cursor/sdk` (the SDK is not bundled; Cursor's license applies), then starts Cursor's browser login. The sign-in link appears in the transcript. Approve "Oh My Diff" there.
3. The login mints a Cursor API key (90 days by default). Setup hands it to `omd-mod credentials STORE add-secret omd_cursor cursor ORIGIN`, which stores it as a broker-held secret owned by `omd_cursor` (with the authority broker deployed, this asks for authorization). The key never touches disk, and the mod and the model never receive it: the host injects it only into the route's service process.
4. Setup lists the models your account can use (at most 16), writes the `cursor` service grant and local token to the store's `host.json`, registers the provider and adds the models to `/model`. Later sessions publish them at start with no step from you.

A denied or abandoned login leaves any existing enrollment and grant untouched. Each setup run is a fresh enrollment that replaces the stored key. Run `/cursor setup` again when the key expires or after changing the SDK dependencies (setup pins them in the service grant).

## Use it

| Command | What it does |
| --- | --- |
| `/cursor setup [NAME]` | Install the SDK, enroll in the browser, list models and publish them to `/model` (`/cursor login` is the same); `NAME` adds another account |
| `/cursor remove NAME` | Drop an account's models and route, and asks to remove its key |
| `/cursor` | Show the SDK version, each account and its key expiry, published models and posture |
| `/cursor usage` | Show each recent run's raw list cost and charged cost, runs still unsettled, and the plan snapshot |
| `/model` | Pick a Cursor model; the thread switches provider from its next turn and keeps its history |

## Several accounts

Each account is one broker-held secret owned by `omd_cursor` (labels `cursor`, `cursor-work`) and one route
(`cursor`, `cursor-work`); the single `cursor` service holds every account's key and runs a request with the key of
the account that owns its model (`cursor-auto.work`). Responses carry the account's last plan usage as a `cursor`
rate-limit family, which `omd_profiles` shows beside the account. The plan is read at most once a minute after a run,
so it can be a run behind, and the first request after a restart carries none. At most 16 models are listed across
accounts, each account's default first.

## How a turn runs

- The SDK runs locally (no cloud agent, no repository upload). Cursor's built-in tools, ambient `.cursor` settings, rules and MCP servers are off. The agent works in an empty private directory (`/private/tmp/omd-cursor-<uid>`, lost on reboot), so it reaches your repository only through OMD tools.
- Every Codex tool in the request, including tools loaded through `tool_search`, is offered to Cursor as an SDK custom tool. When Cursor calls one, the transport parks the run and returns the call to Codex, which executes it under OMD's sandbox, approvals and mods. The next request returns the output and the same run continues. Parallel calls are handed over together. Hosted web search is not offered.
- Cursor keeps its own system prompt and context; Codex's base instructions are not sent. A thread's follow-up resumes the same Cursor agent, including after a transport restart. A fork, a concurrent request or an unknown history starts a new agent seeded with the transcript; tool exchanges are replayed only as text. Codex reasoning effort maps to the model's reasoning parameter when it has one.
- Interrupting Codex cancels the Cursor run, and so does sending a new message while tools are pending. Pending tool calls expire after ten minutes.
- The SDK dependency tree is pinned in the service grant and launched from a private snapshot. A custom SDK entrypoint (for tests, `node setup.mjs SDK_ENTRY`) must live in a dedicated directory separate from the mod store.

## Accounting

- The route is `provider_billed`: the host admits and counts Cursor requests without reserving exposure, and records each response as `unsettled` until Cursor prices it. Admitted leads count toward `host.json` `limits.requests`.
- Cursor settles billed cost minutes after a run ends. The transport polls `getUsage` at 0 s, 15 s, 1 min and 5 min and logs each settlement to `usage.jsonl` against the OMD request that ended the run. After each turn the mod applies its thread's settlements with `ledger.settle` (checking every minute for six minutes, at most eight per callback), so the charge appears in `/status` as a `provider_reported` cost. The mod reads only the newest 32 KiB of the log through a sandboxed `tail`.
- `charged` is what Cursor bills beyond included usage. A zero charge can mean plan-included, BYOK or credit-grant usage; the SDK does not say which pool paid.
- Plan pools and spend limits come from `GetCurrentPeriodUsage`, an undocumented Cursor dashboard RPC bundled in the SDK. It is called at most once a minute after a run, may break with any SDK update and never fails a request. No Cursor source reports cache expiry or context windows, so the catalog assumes 200K tokens.
- When Cursor refuses a request for plan usage or rate limits, the turn fails as `rate_limit_exceeded`. OMD never falls back to another route or a paid API key.

## Status

Verified offline against a fake SDK: lead turns with OMD tools, parallel calls, tool search, images, effort, follow-up resume, fork, restart recovery, cancellation, plan-limit failure, missing or expired enrollment, denied login, delayed charges and setup through a stand-in `omd-mod`. Not verified: a real Cursor account; fixture-only support. Subscription support stays unclaimed until an authorized account-backed run.

## Cost

Measured on the pre-launch version (Codex 0.160.1) against a fake SDK; not re-measured on 1.0.

- Installed SDK: 43.8 MB, including the 10.2 MB darwin-arm64 platform package plus zod, protobuf, connect and statsig.
- SDK import: about 75 ms and 65 MB RSS in the service process.
- Transport overhead: 2.6–5.1 ms p50 and 3.5–13.3 ms p95 per request with 201 messages and 40 tools.
- With the mod disabled, nothing runs. Enabled in a session on another provider, it only republishes the models at start. In a Cursor session it also reads the usage log after each turn, then once a minute for six minutes.
