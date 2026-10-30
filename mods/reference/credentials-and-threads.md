# Credentials and threads

How mods enroll and use credential profiles and secrets, how services get isolated launch snapshots, and how thread
store data, turn cancellation, turn activity and recorded sessions are read. Use it when a mod needs a token, a
secret or thread-scoped history.

## Credentials, secrets and routes (`credentials_v1`, `secrets_v1`)

### Credential profiles and secrets

`credentials.list` returns profiles without secret material, with `status` `ready` once enrolled; secrets are
listed only to the mod that owns them.

`credentials.request` opens native flows from user contexts: ChatGPT sign-in, masked API-key entry, refresh and
removal, and `{kind: 'secret', label, origin}` for an origin-bound secret owned by the calling mod.

- Labels are unique in the store, so enrolling an existing label fails with `credential_profile_label_exists`.
- `{action: 'refresh', profile}` on the mod's own secret asks for a new value and replaces it.
- A mod can remove only its own secrets, and the confirmation names the profile's kind and label.

### Routes and sidecars

Route entries may name a `credential`; its token replaces the request's authorization after upstream auth, and a
missing or expired credential blocks the request. `routes.select {route, scope}` applies a configured route at the
next request or for the thread.

`sidecars.start {id, credential?, secrets?}` injects a host-approved credential and the caller's own secrets
(`OMD_SECRETS`, JSON `[{id, label, origin, value}]`) into the sidecar only; values never reach the mod runtime or
the model.

`sidecars.status {id}` returns `{id, running, started_at_ms}` for a sidecar or provider service the caller started
in this process. Compare `started_at_ms` with a store entry's `provenance.at` to tell whether it predates a change.

### Credential origins

Every credential profile sends its token to one origin, fixed at enrollment:

| Profile kind | Origin |
| --- | --- |
| `chatgpt` | `https://chatgpt.com` |
| `api_key` | `https://api.openai.com` |
| `provider` | The `https` origin passed as `origin` to `credentials.request {action: 'enroll', kind: 'provider', label, provider?, origin}`, which the enrollment prompt shows |

A route `credential` is injected only into requests whose URL has that origin; any other route fails with
`credential_origin_mismatch`.

### Credential gateway (`credential_gateway_v1`)

Sidecars never receive credential tokens (`credential_gateway_v1`). When the host's service grant lists profile IDs
in `credentials` (network required), the sidecar gets `OMD_CREDENTIAL_GATEWAY`, a loopback URL with a per-sidecar
secret path that closes when the sidecar stops.

A request to `$OMD_CREDENTIAL_GATEWAY/PROFILE/PATH` is sent over HTTPS to `PATH` on that profile's origin with
`Authorization: Bearer` (or `x-api-key` when the request sets `x-omd-credential-header: x-api-key`) and the
response streams back. Redirects aren't followed. Stopping the sidecar cancels its in-flight gateway requests and
streams.

| Gateway limit | Value |
| --- | --- |
| Connections, globally | at most 16 |
| Forwards per registration | four |
| Connection and inactivity timeout | 30 seconds |
| Total deadline | 10 minutes |

### `omd-mod credentials`

`omd-mod credentials STORE` lists profiles without secrets.

`omd-mod credentials STORE add-secret MOD_ID LABEL ORIGIN` reads a value from stdin and stores it as a secret owned
by `MOD_ID` for `ORIGIN`, the same profile `credentials.request {kind: 'secret'}` creates. It replaces the value of
that mod's existing secret with the same label and origin, prints the profile, and asks for broker authorization
when the authority broker is deployed. Package setup scripts use it to enroll a key without writing it to disk.

`providers.register {id, secrets?}` delivers owned secrets to a provider service as `sidecars.start` does. It reads
the store's `host.json` services at call time, so a grant written during the session needs no restart. A routed grant
with a loopback `responses_url` defines its `route.provider` for the process (at startup when its mod is active, and
at each registration) unless the configuration already defines it; a grant with exactly one secret uses it as the bearer token. A
thread resumed after its provider is gone continues on the configured provider.

`providers.models {provider, name?, models}` lists up to 16 models `{slug, display, context_window,
efforts, default_effort?}` in `/model`, grouped under `name` (1–64 bytes, default `provider`). It needs a running `providers.register` registration whose
grant `route.provider` equals `provider`. Each call replaces that provider's list; unregistering, a stopped service
or disabling the mod drops it. It returns `{provider, models}` (the count). The models get Codex's standard tools
(shell, freeform `apply_patch`, tool search, multi-agent v2). Picking one switches the thread to that provider from the
next turn; history carries over except reasoning another provider produced. Codex sends an item id only in
`prefix_rest` form, so a provider gives its items ids without `_` unless every provider accepts them, and marks
plaintext function arguments with `encrypted_function_args: []`. A compaction checkpoint only another provider can
read is first rewritten as a plaintext summary by that provider (one request on its account); if that fails, the turn
shows a warning and runs without the summary.

### Service launch snapshots

Service launches use private read-only sandbox snapshots of the package's admitted entrypoint and assets,
preserving their relative paths. Original package paths are denied to the child.

Grants may include `code_roots` mapping canonical dependency directories to SHA-256 digests of sorted JSON
`[relativePath, kind, value]` rows: `kind` is `file` with a content SHA-256 or `link` with an internal relative
target. Verified bytes are copied without reopening the source; `OMD_SERVICE_ROOT` names the snapshot root, under
which absolute dependency paths are mirrored.

Changed dependencies require a new grant. Reload and disable stop stale services before their IDs can be reused.

## Thread store, resume and turn activity (`store_thread_v1`, `turn_activity_v1`)

### `turns.abort`

`turns.abort {turn_id}` (`threads`) requests cancellation of the named active turn in the current thread from a
user or event callback. Require `turn_abort_v1`.

- `{accepted: true}` means cancellation was accepted, not that cleanup has completed.
- A stale or absent turn, queued input or competing cancellation returns `accepted: false`.
- Tool callbacks cannot call it, and it cannot target another thread.
- Successful cancellation wakes idle listeners after cleanup.

### Thread-scoped store and `resume`

`store.*` accepts `scope: 'thread'`: data forks with the thread, is removed when the thread is deleted and kept
when it is archived. `resume` carries `last_turn` and `restarted`.

### `turns.activity`

`turns.activity {turn_id?, last?}` reads turn outcomes, tool calls, processes and file changes for the current
thread from event, tool and terminal slash-command callbacks, recorded only while an enabled mod's source calls
`turns.activity`.

- File changes come from the same workspace observer as `workspace_change`, which rereads only files whose size,
  ctime or inode changed.
- Commands record their exit code when they finish, including commands that outlive their tool call.
- The log is removed when the thread is deleted.

### `sessions.list`

`sessions.list {since?, until?, cursor?, limit?}` pages this repository's recorded sessions that allow memory.

### `sessions.read`

`sessions.read {session_id, revision, handle, cursor?, max_bytes?}` pages one session's
`local_visible_records`:

| Record | Fields |
| --- | --- |
| `message` | `role`, `text` |
| `tool_call` | `name`, `call_id`, `arguments` |
| `tool_result` | `call_id`, `output` (text parts only) |

- Each record has credential lines replaced by `[redacted]` (`redacted`; line endings kept) and is cut to 2,048
  characters with `truncated`.
- Without the `sessions_tools` capability, tool records carry `bytes` and `sha256` of their arguments or output
  instead of the text.
- Reasoning and other item types are left out.
- Pages hold at most 16 KiB, and a session at most 4,096 records (`projection_truncated`, the oldest are kept).
- A changed rollout fails the read against its `revision`.
- `sessions.list` and `sessions.read` serve mod CLI commands (`api.command(name, …, {cli})`) and `context`
  callbacks, not TUI slash commands.

Credential lines are those:

- naming a credential (`Authorization:`, `api_key`, `password=`, …);
- assigning a secret-like name (`TOKEN=…`, `"secret": …`, `AWS_SECRET_ACCESS_KEY=…`);
- holding a known token prefix (`sk-`, `ghp_`, `AKIA…`) or URL credentials (`scheme://user:password@`);
- private-key blocks.
