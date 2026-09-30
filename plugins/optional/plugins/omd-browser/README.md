# OMD browser

Optional plugin `0.1.0-preview.1` with the `omd-browser` skill and the
`omd_browser` MCP server. It drives persistent Chromium sessions from OMD's
[managed browser bundle](../../../../browser/README.md). The plugin has no mod
component; Codex's per-tool MCP approval (`prompt` by default) is the
authorization boundary, as it was for the managed Playwright browser.

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
    "work": { "vault": true, "captcha": true }
  }
}
```

The server runs under the `node` (20 or newer) on Codex's `PATH`. Optional
top-level fields are `data` (default `$OMD_MOD_STORE/plugin-data/omd-browser`)
and `idle_minutes` (default 10). A profile applies to the session of the same
name; its fields are `allow` (exact `host:port` private destinations, default
none), `adblock` (default on), `vault` and `captcha` (both off by default).
Only the user edits this file; the agent's sandbox cannot write it.

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

A local run against a fixture server covered sessions, policy refusals,
isolation, persistence, handoff, cancellation, crash recovery, idle shutdown and
vault origin binding ([Batch 3f audit](../../../../.docs/audits/batch3f-browser-preview-20260930.md)).
Real sites, Keychain enrollment and real CAPTCHA widgets were not exercised.
