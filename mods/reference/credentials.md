# Credentials

Use it when a mod needs a token or a secret: enrolling credential profiles and secrets, the origin each one is
bound to, how sidecars reach credentials through the gateway, and the `omd-mod credentials` command. Host features:
`credentials_v1`, `secrets_v1`. How `http.request` attaches a credential is in
[Authority grants](authority-grants.md#httprequest-redirects-and-credentials).

Entries are frozen in Mod API `1.0.0` unless marked experimental (see the
[registry table](stability-and-migration.md#experimental-entries-in-the-registry)). Runs on Apple Silicon
macOS; the broker that keeps credentials off disk is described in [Protected authority](protected-authority.md).

## Credential profiles and secrets

A credential profile is an enrolled token (ChatGPT sign-in, an API key or a provider key) bound to one origin. A
secret is a credential profile of kind `secret` that belongs to one mod.

`credentials.list` returns profiles without secret material, with `status` `ready` once enrolled. It lists a secret
only to the mod it belongs to.

`credentials.request` opens a native flow from [user contexts](host-model.md#callback-contexts):

- ChatGPT sign-in;
- masked API-key entry;
- refresh;
- removal;
- `{kind: 'secret', label, origin}`, which enrolls an origin-bound secret owned by the calling mod.

- Labels are unique in the store, so enrolling an existing label fails with `credential_profile_label_exists`.
- `{action: 'refresh', profile}` on the mod's own secret asks for a new value and replaces it.
- A mod can remove only its own secrets, and the confirmation names the profile's kind and label.

## Route credentials and sidecar secrets

A [route entry](routes.md#route-fields) in `host.json` may name a `credential`. The host replaces the request's
authorization with that credential's token after upstream authentication. A missing or expired credential blocks the
request. Choosing a route is in [`routes.select`](routes.md#routesselect).

A mod's own secrets reach its [sidecars](routes.md#sidecars) as `OMD_SECRETS`, never the mod's runner or the model.
Credential tokens reach a sidecar only through the [credential gateway](#credential-gateway).

## Credential origins

Every credential profile sends its token to one origin, fixed at enrollment:

| Profile kind | Origin |
| --- | --- |
| `chatgpt` | `https://chatgpt.com` |
| `api_key` | `https://api.openai.com` |
| `provider` | The `https` origin passed as `origin` to `credentials.request {action: 'enroll', kind: 'provider', label, provider?, origin}`, which the enrollment prompt shows |

The host injects a route `credential` only into requests whose URL has that origin. A route whose URL has another
origin fails with `credential_origin_mismatch`.

## Credential gateway

Sidecars never receive credential tokens. When a sidecar's [service grant](glossary.md#trust-and-authority) lists
profile ids in `credentials`, and the grant allows network, the sidecar gets `OMD_CREDENTIAL_GATEWAY`. It is a
loopback URL with a per-sidecar secret path, and it closes when the sidecar stops.

The gateway sends a request to `$OMD_CREDENTIAL_GATEWAY/PROFILE/PATH` over HTTPS to `PATH` on that profile's origin and
streams the response back. It adds `Authorization: Bearer`, or `x-api-key` when the request sets
`x-omd-credential-header: x-api-key`. Redirects aren't followed. Stopping the sidecar cancels its in-flight gateway
requests and streams.

| Gateway limit | Value |
| --- | --- |
| Connections, globally | at most 16 |
| Forwards per registration | four |
| Connection and inactivity timeout | 30 seconds |
| Total deadline | 10 minutes |

## `omd-mod credentials`

`omd-mod credentials STORE` lists profiles without secrets.

`omd-mod credentials STORE add-secret MOD_ID LABEL ORIGIN` reads a value from stdin and stores it as a secret owned by
`MOD_ID` for `ORIGIN`, the same profile `credentials.request {kind: 'secret'}` creates. If that mod already has a secret
with the same label and origin, the command replaces its value. It prints the profile. When the
[authority broker](protected-authority.md) is deployed, it asks for broker authorization. Package setup scripts use it
to enroll a key without writing it to disk.
