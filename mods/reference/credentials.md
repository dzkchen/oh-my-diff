# Credentials

Use it when a mod needs a token or a secret: enrolling credential profiles and secrets, the origin each one is
bound to, how sidecars get secrets and reach credentials through the gateway, and the `omd-mod credentials`
command. Host features: `credentials_v1`, `secrets_v1`. How `http.request` attaches a credential is in
[Authority grants](authority-grants.md#httprequest-redirects-and-credentials).

## Credential profiles and secrets

`credentials.list` returns profiles without secret material, with `status` `ready` once enrolled; secrets are
listed only to the mod that owns them.

`credentials.request` opens native flows from user contexts: ChatGPT sign-in, masked API-key entry, refresh and
removal, and `{kind: 'secret', label, origin}` for an origin-bound secret owned by the calling mod.

- Labels are unique in the store, so enrolling an existing label fails with `credential_profile_label_exists`.
- `{action: 'refresh', profile}` on the mod's own secret asks for a new value and replaces it.
- A mod can remove only its own secrets, and the confirmation names the profile's kind and label.

## Routes and sidecars

Route entries may name a `credential`; its token replaces the request's authorization after upstream auth, and a
missing or expired credential blocks the request. `routes.select {route, scope}` applies a configured route at the
next request or for the thread.

`sidecars.start {id, secrets?}` injects the caller's own secrets (`OMD_SECRETS`, JSON `[{id, label, origin,
value}]`) into the sidecar only; values never reach the mod runtime or the model. Credential tokens reach a sidecar
only through the [credential gateway](#credential-gateway).

`sidecars.status {id}` returns `{id, running, started_at_ms}` for a sidecar or provider service the caller started in
this process (`started_at_ms` is experimental). Compare `started_at_ms` with a store entry's `provenance.at` to tell
whether it predates a change.

`sidecars.invoke {id, input}` returns `{provider, program_sha256, source_hashes, result, untrusted: true}`.
`sidecars.stop {id}` is experimental.

## Credential origins

Every credential profile sends its token to one origin, fixed at enrollment:

| Profile kind | Origin |
| --- | --- |
| `chatgpt` | `https://chatgpt.com` |
| `api_key` | `https://api.openai.com` |
| `provider` | The `https` origin passed as `origin` to `credentials.request {action: 'enroll', kind: 'provider', label, provider?, origin}`, which the enrollment prompt shows |

A route `credential` is injected only into requests whose URL has that origin; any other route fails with
`credential_origin_mismatch`.

## Credential gateway

Sidecars never receive credential tokens. When the host's service grant lists profile IDs
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

## `omd-mod credentials`

`omd-mod credentials STORE` lists profiles without secrets.

`omd-mod credentials STORE add-secret MOD_ID LABEL ORIGIN` reads a value from stdin and stores it as a secret owned by
`MOD_ID` for `ORIGIN`, the same profile `credentials.request {kind: 'secret'}` creates. It replaces the value of that
mod's existing secret with the same label and origin, prints the profile, and asks for broker authorization when the
[authority broker](protected-authority.md) is deployed. Package setup scripts use it to enroll a key without writing it
to disk.
