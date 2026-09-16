# Optional application bridge

The bridge is a development-only, opt-in path from browser/Node applications
and Rust, Python, or Java services to one local Oh My Diff session. It captures
errors and warning/error logs and serves only state names declared by both the
operator policy and the application. It does not inspect a DOM, heap, process,
browser profile, or arbitrary expression on its own.

## Authorization and version binding

Start from [`policy.example.json`](policy.example.json). Put the completed policy
outside the repository in a private directory, use an absolute connection-file
path in that directory, and hash the policy:

```sh
shasum -a 256 /absolute/private/path/bridge-policy.json
```

Add `"application_bridge": true` to the enabled controlled manifest's
`capabilities` and add the exact external reference:

```json
"bridge": {
  "path": "/absolute/private/path/bridge-policy.json",
  "sha256": "replace-with-policy-sha256"
}
```

Activation fails if the policy is missing or changed. The managed launcher adds
the bridge MCP only for that enabled capability. The host binds an ephemeral
IPv4 loopback port, creates the connection file with mode `0600`, and issues a
random session token. Every client must match its policy adapter, application
ID, application-version SHA-256, reproduction ID, and allowed browser origin.
Do not put the connection descriptor or token in source, logs, URLs, or browser
storage. Pass its `url` and `token` into browser development bootstrap through a
server-side or local development configuration that is not shipped to users.

## Adapters

- Browser and Node: [`client.mjs`](client.mjs) is the shared fetch client.
  Browser capture is explicit through `captureConsole` and
  `captureWindowErrors`; Node file loading and process-error hooks are in
  [`node-client.mjs`](node-client.mjs).
- Python: [`python/omd_bridge.py`](python/omd_bridge.py) uses the standard
  library and owns only its optional daemon polling thread.
- Rust: [`rust`](rust) pins Serde and uses a blocking loopback client. The caller
  chooses whether to start its bounded polling thread; it does not require or
  take over Tokio.
- Java: [`BridgeClient.java`](java/src/main/java/dev/ohmydiff/bridge/BridgeClient.java)
  supports JDK 11 or newer through `HttpClient` and an optional daemon polling
  thread, with no logging framework or uncaught-exception handler installed
  automatically.

For every adapter, call `expose(name, handler)` before `connect`, then enable
only the error/log hooks the application owner wants. The handler is invoked
only after an `omd_bridge` `request_state` call for a policy-allowlisted name.
Close the client during application shutdown.

## Data and lifecycle

The host accepts `error`, `exception`, and warning/error `log` events. It drops
debug/noise, collapses consecutive duplicates while retaining a repeat count,
caps individual payloads and total in-memory evidence, and reports oversized,
capacity, duplicate, and irrelevant drop counts. Common credential fields and
Bearer/Basic/query-style secret strings are redacted recursively before
retention. Application-supplied task, version, and reproduction fields never
override the policy-bound envelope.

`omd_bridge` supports `status`, filtered `events`, `request_state`, and
`teardown`. Teardown rotates the token, rejects pending state requests, clears
all in-memory evidence, closes the loopback listener, and removes the connection
file. Normal MCP process exit performs the same teardown. Collected evidence is
otherwise memory-only for the bridge process lifetime; Codex conversation/tool
retention remains governed by the configured Codex environment.

Validate the host, denial paths, bounds, and live five-adapter exchange with:

```sh
python3 -m unittest tests.test_bridge
```

The loopback smoke needs permission to bind `127.0.0.1`. The browser adapter
test executes the browser module with an enforced Origin header; full browser
interaction and Chromium lifecycle remain covered by the separate bundled
browser acceptance.
