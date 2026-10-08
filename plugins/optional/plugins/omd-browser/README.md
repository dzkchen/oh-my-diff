# OMD browser

Optional plugin `0.1.0-preview.3` with the `omd-browser` skill, the
`omd_browser` MCP server and the `omd_browser` mod component. It drives
persistent Chromium sessions from OMD's
[managed browser bundle](../../../../browser/README.md). Codex's per-tool MCP
approval (`prompt` by default) is the authorization boundary for agents, as it
was for the managed Playwright browser. The mod component is inspected, trusted
and enabled separately; it shows sessions beside the conversation and adds
design mode.

## Setup

Provision the managed bundle (Node, Playwright and Chromium headless shell),
then write the plugin configuration to
`$OMD_MOD_STORE/plugin-config/omd-browser.json`, or point `OMD_BROWSER_CONFIG`
at another file. Without a configuration the server lists no tools.

```sh
python3 scripts/browser_bundle.py provision /absolute/browser-bundle
codex plugin add omd-browser@oh-my-diff
```

```json
{
  "bundle": "/absolute/browser-bundle",
  "profiles": {
    "default": { "allow": ["localhost:3000"] },
    "work": { "vault": true, "captcha": true },
    "chess": { "pane": true, "user_only": true }
  }
}
```

The server runs under the `node` (20 or newer) on Codex's `PATH`. Optional
top-level fields are `data` (default `$OMD_MOD_STORE/plugin-data/omd-browser`)
and `idle_minutes` (default 10). A profile applies to the session of the same
name, case-insensitively; storage and lookups use lowercase names, and duplicate
case aliases in configuration are rejected. Its fields are `allow` (exact `host:port` private destinations, default
none), `adblock` (default on), `vault`, `captcha`, `pane` and `user_only` (all
off by default). Only the user edits this file; the agent's sandbox cannot
write it.

To use the in-OMD view, inspect, trust and enable the mod component with the
digest the first command reports, then set its `endpoint` setting to
`browser_endpoint` (the sidecar grant ID below):

```sh
omd-mod plugin-component /absolute/path/to/plugins/optional/plugins/omd-browser
omd-mod trust /absolute/mod-store /absolute/path/to/plugins/optional/plugins/omd-browser/mod INSPECT_SHA256 commands,terminal,store,lifecycle,events,exec,network,composer,services
omd-mod enable /absolute/mod-store /absolute/path/to/plugins/optional/plugins/omd-browser/mod
```

Add this owner-scoped entry to the `services` array in the store's `host.json`,
using canonical paths and SHA-256 digests of Node and `scripts/endpoint.mjs`:

```json
{
  "id": "browser_endpoint",
  "mod_id": "omd_browser",
  "program": "/absolute/node",
  "program_sha256": "NODE_SHA256",
  "arguments": ["/absolute/plugin/scripts/endpoint.mjs", "/absolute/mod-store/plugin-data/omd-browser/pane.json"],
  "requests": true,
  "read_hashes": {"/absolute/plugin/scripts/endpoint.mjs": "HELPER_SHA256"},
  "read_paths": ["/absolute/mod-store/plugin-data/omd-browser/pane.json"]
}
```

The handoff reads only that endpoint file through `sidecars.invoke`; ordinary
mod execution and agent tools still cannot read the mod store. Keep the store
outside `CODEX_HOME` and other protected credential directories. The helper
needs no network access. Do not grant the profile directory or vault, or move
the endpoint into an agent-readable workspace. Its bearer token stays out of
mod state and model output.

## Tools

- `browser_navigate`, `browser_snapshot` and `browser_act` open pages and return
  compact accessibility snapshots whose `[ref=eN]` markers name elements to act
  on. `interactive_only` keeps controls only and `scope_ref` snapshots one
  subtree; every snapshot is capped (6,000 characters by default) and prefixed
  as untrusted page data.
- `browser_tabs` lists, selects and closes tabs; `browser_sessions` lists
  running sessions or closes one.
- `browser_screenshot` returns a JPEG proof of the viewport, full page or one
  ref and saves it under `data/screenshots`.
- `browser_handoff` opens a live view in the user's browser and waits until they
  press Done (9 minutes at most); a cancelled tool call ends the wait.
- `browser_vault` and `browser_login` are listed only when a profile enables the
  vault, and `browser_captcha` only when a profile enables CAPTCHA helpers.

## Sessions and network policy

Each named session is a persistent Chromium profile under `data/profiles/NAME`,
so cookies and storage survive restarts while tabs and page state last for the
running session. At most four sessions run at once; a session closes after
`idle_minutes` without calls, and a crashed browser is relaunched by the next
call. Stopping the server closes every browser.

A `user_only` profile is for the user alone. Agent tools refuse its session,
`browser_sessions` neither lists nor closes it, design mode cannot capture it
and it never idles out; only the user ends it, from the pane or `/browser end`.

Every connection goes through a per-session guard proxy on `127.0.0.1`. It
resolves the host once, refuses private, loopback, link-local, carrier-grade
NAT, multicast and local IPv6 addresses unless the profile allows that exact
`host:port`, never allows cloud-metadata addresses (`169.254.0.0/16`,
`fd00:ec2::254`, `100.100.100.200`), and connects to the address it checked, so
a rebinding DNS answer cannot redirect the browser. WebRTC cannot send UDP
outside the proxy. With `adblock`, connections to common ad and tracker domains
are refused. Results report the refused destinations. Only http(s) URLs open,
downloads are refused and page dialogs are dismissed.

## Live view

The live view listens on a random `127.0.0.1` port behind a random path token
and checks the `Host` header. It shows screenshots about three times a second
and forwards clicks, typing and scrolling to the page. The browser sessions
themselves cannot reach it, because loopback is blocked by default. It opens with
`open` (macOS) or `xdg-open`; if that fails, the server writes the URL to its
standard error.

## Browser pane

Use `/browser open` with the endpoint sidecar grant above for the protected
default store. The older `omd_panes` text client still requires a direct file
read and cannot use that store; its private handoff remains a separate decision.

A profile with `"pane": true` can also be browsed inside OMD. The server then
keeps the live-view listener running and writes its address and token to
`data/pane.json` (mode 0600), removed on shutdown. `omd_panes` reads that file
(its `browser` setting) and opens `scripts/pane.mjs` in a terminal pane with
loopback-only network. The pane shows the page as the snapshot text with
`[eN]` refs and drives the same session the agent uses: `o` opens a URL, `c`
clicks a ref, `t` fills one, `p` presses a key, `b`/`f`/`r` go back, forward
and reload, `/` and `n` find, `i` switches to a half-block screenshot and `q`
quits. The pane follows the agent's navigation. While a pane is attached,
`browser_handoff` shows its reason in the pane and `d` returns control, so the
external live view is not opened. The guard proxy, ad blocking and vault
redaction apply as for tool calls. Anything that can read `pane.json` or type
into the pane can drive that session, so the flag is off by default.

The same endpoint also serves `cdp`, `pick` (design mode) and `close`. `cdp`
is a full-duplex NDJSON pipe to the session's current tab: the request body
carries Chrome DevTools Protocol commands `{id, method, params}` and the
response streams `{id, result | error}`, the screencast and navigation events,
`{attached: {generation}}` whenever it binds a new tab and `{generation}` on
every navigation. Only screencast, navigation history, device-metrics/focus
emulation and input methods pass (no `Runtime`, `Network` or `Storage`), and
`Page.navigate` takes http(s) URLs only. The page generation counts main-frame
navigations and tab changes; picks from an older generation are refused with
`stale_generation`, including navigation or tab changes during capture. Source
maps share the five-second capture deadline and a two-million-byte streaming
limit; timeout or oversize maps leave source locations unavailable. The full
`state` text is withheld from user-only sessions.

## In-OMD view (`omd_browser` mod)

The `omd_browser` mod draws a pane-enabled session beside the conversation:
`/browser open [SESSION] [URL]` opens it in an `omd_panes` site (or shows the
`/pane split right site omd_browser/view` command when `omd_panes` is off).
Set the mod's `endpoint` setting to the `browser_endpoint` grant ID. One long-lived viewer
(`scripts/viewer.mjs`, started with `process.start` and `process_raster_v1`,
loopback only) drives the tab over the `cdp` pipe: the host tells it the
pane's drawable cells and cell pixels, it sizes the page so its text matches the
terminal's (about 2× on Retina) and streams screencast JPEGs at exactly the
drawn pixel size, which the host draws without a mod callback (Kitty and
Ghostty placeholders, iTerm2 inline images in Orca, iTerm2 and WezTerm,
half-blocks elsewhere). JPEG quality adapts both ways to the 256 KiB frame
limit. Clicks, double clicks, drags (also outside the pane), hover and the
wheel map to the exact page position; clicking the page focuses the keyboard
row, so typing, pasting and keys reach the page (Ctrl+] leaves). Alt+←/→ go
back and forward, Ctrl+R or F5 reloads and Alt+↑/↓/0 zoom; the address row
navigates; `/browser pick`, `hide` and `end` toggle design mode, hide the view
(the session keeps running) or end the session. When the viewer or the server
stops, a three-second timer reconnects through the current `pane.json`.
Another mod opens a
session with the `omd.browser` service (`open {session, url?, user_only?, zoom?}`; the zoom survives viewer reconnects,
`close {session, end?}`); with `user_only` it refuses a profile that is not
user-only.

## Design mode

Run `/browser pick` and click elements in the frame. Each pick records the
element's selector path, outer HTML (4,000 characters at most), three ancestors
and its neighbours, a set of non-default computed styles, a cropped screenshot,
the page URL, origin, time and generation, and the original file and line of
matching CSS rules when the page's source maps establish them (otherwise the
note says they are unavailable). Notes collect in a tray of up to eight: type
an instruction for the focused note, re-select it after a hot reload to see
whether its HTML or styles changed, or remove it. Check notes and press Enter
to insert them, with their screenshots, at the end of the selected session's
draft in one compare-and-write against the draft revision. Page data is
labelled untrusted and fenced. Notes leave the tray only after the inserted
text is read back from the draft; a changed draft or failed insertion keeps
them, and a retry finds an earlier insertion by its marker instead of adding
it twice. Nothing is submitted: the user reviews and sends the draft.

## Login vault

`browser_vault enroll ORIGIN` opens a local form where the user types a username
and password. Records are encrypted with AES-256-GCM, with the origin bound as
associated data, in `data/vault.json` (mode 0600). The key lives in the macOS
Keychain item `omd-browser-vault`. `browser_login` fills a record only when the
page and the login form's frame have exactly the saved origin, and filled
passwords are redacted from later results in that session. The agent can list
record ids, origins and usernames, but never receives a password. Unlike the
roadmap's original plan, the vault does not use host `credentials.request`
secrets, because MCP servers cannot receive them; the maintainer chose this
design on 2026-09-30.

## CAPTCHA helpers

`browser_captcha` handles reCAPTCHA, hCaptcha and Turnstile checkboxes with
pointer movement, and waits on Cloudflare-style interstitials. It stops after
three stages, never repeats an attempt on the same page and widget, and hands
image or persistent challenges to the user through the live view. It uses no
external solver and never rotates identity or fingerprints. Use it only on flows
the user is authorized to complete.

## Scope and credit

Ported from [BetterWright](https://github.com/BetterWright/betterwright) 2.8.8
by The BetterWright Project and contributors (MIT). This package reimplements
selected behavior: named persistent sessions, ref snapshots, proof screenshots,
the guard-proxy network policy, live handoff, ad blocking, the origin-bound
vault and bounded CAPTCHA helpers. It copies no code. It does not port
BetterWright's JavaScript execution tool, built-in agent, local models, stealth
fingerprinting, Electron control, system-browser cookie import, downloads,
recording or evidence checklist.

Design mode reimplements the manual selection workflow of
[terminal-browser](https://github.com/zenbu-labs/terminal-browser/tree/ea63ea4904785649c5505b612d5fdbb704b203fa/claude-code-plugin)
0.0.2 by Zenbu Labs, Inc. (MIT): element picking, an annotation tray and
delivery of picked HTML, styles and screenshots to the agent. It copies no code
and uses managed Chromium instead of a second Electron browser, with no OS input
helper or vendor telemetry.

Batch 4fc ran the server against managed Chromium on local fixture pages:
frames, pointer and key input, picks with CSS source maps, stale generations,
re-selection after reload and user-only refusals
([Batch 4fc audit](../../../../.docs/audits/batch4fc-browser-play-design-20261007.md)).

A local run against a fixture server covered sessions, policy refusals,
isolation, persistence, handoff, cancellation, crash recovery, idle shutdown and
vault origin binding ([Batch 3f audit](../../../../.docs/audits/batch3f-browser-preview-20260930.md)).
Real sites, Keychain enrollment and real CAPTCHA widgets were not exercised.
