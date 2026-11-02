# Build an external client

How to build a renderer other than the terminal, such as a desktop window, an editor webview or a text console,
that attaches to a running OMD session and draws the same view as the terminal, with every mod's part combined. The
facts each step uses are in the [External clients reference](../../mods/reference/external-clients.md) and the
[`omd-client/1` protocol](../../mods/reference/omd-client-protocol.md).

## Before you begin

- A mod you can build and test, as in [Write your first mod](first-mod.md). The mod contains the client's adapter.
- A source checkout of OMD and a directory that contains the patched `codex` and `omd-mod`, for the conformance
  check.
- Two complete adapters to copy from: `mods/examples/external_client` (a text renderer) and
  `mods/examples/approval_desk` (a GUI-shaped renderer that answers approvals).

## Connect and draw

1. Choose a transport and start or find a listener, as in
   [Transports and auth](../../mods/reference/external-clients.md#transports-and-auth). For a local client, use
   `unix://`.
2. Start your UI process from the mod, as in
   [Client adapters](../../mods/reference/external-clients.md#client-adapters).
3. Connect with the [client SDK](../../mods/reference/external-clients.md#client-sdk-oh-my-diffmod-apiclient). It
   attaches, re-attaches after a disconnect and serializes actions.
4. Draw `snapshot.view.sites` by component type, and call `unsupported()` for every component your renderer can't
   draw.
5. Read images with `omd/resource/read`.
6. Send `omd/action` and `omd/client/event`, and answer the approval server requests your client handles through
   `onServerRequest`.
7. Re-render from the full snapshot after `onReconnect`.

## Package it as a desktop app

A desktop app starts Codex's app server, a `codex` mode with no terminal UI that clients connect to
(`codex app-server --listen unix://PATH`), or connects to a user's `codex --listen` session. It does this from its
main process and runs the SDK there. Oh My Diff ships no desktop app.

## Package it as a VS Code webview

1. In the extension host, start or find the listener with `--ws-auth capability-token` and `--ws-allowed-origin`
   set to the webview origin.
2. Use a base64url capability token. The server compares the raw token, and a browser subprotocol can't send `+`,
   `/` or `=`.
3. Pass the URL and token to the webview.
4. In the webview, load the SDK as ESM and connect over `ws://127.0.0.1:PORT`.

## Check it

From the OMD source checkout, run the conformance check. It drives both example adapters against a host with no
terminal (headless) and a live terminal session they attach beside (co-attached), with a scripted local provider:

```sh
python3 -m scripts.client_acceptance --binaries DIR
```

`DIR` is the directory that contains the patched `codex` and `omd-mod`.

## See also

- [`omd-client/1` protocol](../../mods/reference/omd-client-protocol.md) for every request, error and notification.
- [Security](../../mods/reference/external-clients.md#security) for what a client can't do.
