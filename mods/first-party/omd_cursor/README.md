# Cursor route

`omd_cursor` lets an OMD+ session use Cursor models through your Cursor account and the official [Cursor TypeScript SDK](https://cursor.com/docs/sdk/typescript). It is experimental, installed inactive in OMD+, and can be installed explicitly in OMD Core.

```sh
omd-package cursor --setup                  # installs the SDK, enrolls in the browser, lists models, writes the store grant, enables the mod
omd-package cursor                          # interactive session on Cursor Auto (or the first listed model)
omd-package cursor --model cursor-gpt-6 exec 'Your task'
```

Setup installs `@cursor/sdk@1.0.35` with pnpm into `<prefix>/cursor/sdk` (the SDK is not bundled; Cursor's license applies). It then opens Cursor's browser login, which mints a Cursor API key for "Oh My Diff" (90 days by default). The key never touches disk in the prefix. Setup hands it to `omd-mod credentials STORE add-secret omd_cursor cursor ORIGIN`, which stores it as a broker-held secret owned by `omd_cursor` (with the authority broker deployed, this asks for authorization). The host injects it only into the route's service process, through `providers.register {secrets}`; the mod runtime and the model never receive it. A denied or abandoned login leaves any existing enrollment and grant untouched. Each setup run is a fresh enrollment that replaces the stored key; a transport still serving the old key or route yields the shared port to the first one started after setup. Setup lists the models your account can use, together with their reasoning parameters, adds a `cursor` service grant and local token to the store's `host.json`, and makes the managed launcher define the provider.

How a turn runs:

Setup pins the SDK dependency tree in the service grant. Launch copies verified
dependencies and the admitted package helpers into a private sandbox snapshot;
the transport loads the SDK only from that snapshot. Changing installed code
cannot change an already admitted helper. Changed SDK dependencies require setup
again. A custom SDK entrypoint must live in a dedicated directory separate from
the installation prefix and mod store.
For an installed SDK entry, setup pins the dedicated installation root above
its outermost `node_modules`, including package metadata and dependencies.

- The SDK runs locally (no cloud agent and no repository upload). Cursor's built-in tools, ambient `.cursor` settings, rules and MCP servers are turned off. The agent works in an empty private directory, so it reaches your repository only through OMD tools.
- Every Codex tool in the request, including deferred tools loaded through `tool_search`, is offered to Cursor as an SDK custom tool. When Cursor calls one, the transport parks the run and returns the call to Codex. Codex then executes it under OMD's sandbox, approvals and mods. The next request returns the output and the same run continues. Parallel calls are handed to Codex together. Tools loaded mid-turn are called through `omd_call`. Hosted web search is not offered.
- Cursor keeps its own system prompt and context. Codex's base instructions are not sent. A new agent receives the developer context (permissions, environment) and the transcript. A thread's follow-up resumes the same Cursor agent from its local store (`/private/tmp/omd-cursor-<uid>`, lost on reboot), including after a transport restart. A forked thread, a concurrent request or an unknown history starts a new agent seeded with the transcript; tool exchanges are replayed only as text. Codex reasoning effort maps to the model's reasoning parameter when it has one. A model change applies to the next run.
- Interrupting Codex cancels the Cursor run, and so does sending a new message while tools are pending. Pending tool calls expire after ten minutes.

Accounting:

- Each response reports the input, output, cache-read, cache-write and reasoning tokens that Cursor observed. It also carries the agent, run, request, model and time in `usage.omd_cursor`.
- The route is `provider_billed`. The host admits and counts Cursor requests (lead and `cursor` route children) without reserving exposure or bounding the body, and records each response as `unsettled` until Cursor prices it. Admitted leads count toward `host.json` `limits.requests`.
- Cursor settles billed cost after a run ends. The transport polls `getUsage` at 0 s, 15 s, 1 min and 5 min, prices each run from its new usage entries and logs the settlement to `usage.jsonl` against the OMD request (`x-omd-request-id`) that ended the run. After each turn the mod applies its own thread's settlements to the OMD ledger with `ledger.settle`, checking every minute for six minutes, so the charged amount appears in `/status` as a `provider_reported` cost. Settlements of delegated children and of runs that settle later stay in the log only. The mod reads only the newest 32 KiB of the log. `/cursor usage` shows each run's raw list cost and charged cost, and runs still unsettled.
- A transport that resumes an agent from an earlier session first reads that agent's usage as its baseline, so earlier runs are never charged to a later request.
- `charged` is what Cursor bills beyond included usage. A zero charge can mean plan-included, BYOK or credit-grant usage; the SDK does not say which pool paid. A newly settled charge is announced in the next response's reasoning summary.
- Plan pools, included spend and spend limits come from `GetCurrentPeriodUsage`, an undocumented Cursor dashboard RPC that ships inside the SDK. The transport calls it at most once a minute after a run. The snapshot is labelled undocumented, may break with any SDK update, and never fails a request. `/cursor usage` and `usage.omd_cursor.plan` show the latest snapshot. No Cursor source reports cache expiry or context windows, so the catalog assumes 200K tokens.
- When Cursor refuses a request for plan usage or rate limits, the turn fails as `rate_limit_exceeded`. OMD never falls back to another route or a paid API key.

`/cursor` (doctor) shows the SDK version, account, key expiry, discovered models and posture.

Each callback applies at most eight ready settlements. A remaining ready batch
continues at one-second intervals after the six-minute window while charges
are being applied; failed settlements remain in the log for a later turn.

Verified offline against a fake SDK: lead turns with OMD tools, parallel calls, tool search, images, effort, follow-up resume, fork, restart recovery, cancellation, plan-limit failure, missing or expired enrollment, denied login and delayed charges. Pinned Codex 0.160.1 accepts the catalog and executes a relayed `exec_command` call (`OMD_TEST_CODEX`). An offline OMD-mode session ran the full path: broker-held enrollment, provider registration, a relayed tool call, provider-reported ledger entries and a `ledger.settle` charge. Not verified: a real Cursor account. Subscription support stays unclaimed until an authorized account-backed run.

Cost:

- Installed SDK: 43.8 MB, including the 10.2 MB darwin-arm64 platform package plus zod, protobuf, connect and statsig.
- SDK import: about 75 ms and 65 MB RSS in the service process.
- Transport overhead: 2.6–5.1 ms p50 and 3.5–13.3 ms p95 per request over two runs with 201 messages and 40 tools, measured against a fake SDK.
- With the mod disabled, nothing runs. With it enabled in a session that uses another provider, it costs one `config/read` per thread start. In a Cursor session it also reads the usage log after each turn, then once a minute for six minutes.
