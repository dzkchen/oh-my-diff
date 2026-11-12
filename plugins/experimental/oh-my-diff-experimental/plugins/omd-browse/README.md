# OMD Browse

Codex uses a real browser as a command line. Each page becomes a man page: its forms are commands with flags,
its sections and tables can be read one at a time, and the JSON endpoints the site calls are learned and kept, so
next time the model calls the endpoint instead of clicking through the page. It drives your own Chrome, with your
logins, or a separate OMD browser profile, and installs nothing in the browser.

The plugin has one MCP tool, `browse`, the `omd-browse` skill and an optional mod component that shows the browser
live in the OMD terminal ([Watch and take over in the terminal](#watch-and-take-over-in-the-terminal)). It needs Node 22 or later on `PATH` and a
Chromium browser (Chrome, Chromium, Brave or Edge). `rec` needs `ffmpeg` for MP4 output.

Register the experimental marketplace from a checkout as described in [Plugins](../../../../README.md), then:

```sh
codex plugin add omd-browse@oh-my-diff-experimental
```

## A session

```text
› open en.wikipedia.org/wiki/Special:Search
[t1] Search - Wikipedia — https://en.wikipedia.org/wiki/Special:Search
Outline: s1 Search
Commands:
  search [--search-wikipedia <search>]
API (learned): opensearch  — `api NAME --help`
…

› api opensearch --help
opensearch: GET https://en.wikipedia.org/w/api.php
  parameters: --search* --action --format --formatversion --namespace --limit  (* = varied when learned)
  fixed query: action=opensearch format=json formatversion=2 namespace=0 limit=10

› api opensearch --search Anthropic | json .[1] | head 4
[
 "Anthropic",
 "Anthropic principle",
 "Anthropic–United States Department of Defense dispute",
```

- `open URL` prints the outline, the page's commands, tables, learned endpoints, aliases, stored secrets and the
  top of the content.
- `cat sN`, `grep`, `links`, `table N --json` read parts of it; `| grep`, `| head`, `| tail`, `| wc` and
  `| json PATH` filter any output; `;` chains commands.
- `click`, `fill`, `type`, `press`, `select`, `check`, `upload`, `scroll`, `wait` and every page form (`login
  --email … --password secret:gh`) act on `@refs` or labels and print only the lines that changed, plus any
  endpoint the page called.
- `api` lists endpoints learned on this site; `api NAME --param value` calls one with your session from the
  site's own tab. A call to an endpoint that changes data asks you first, in the terminal. `alias NAME COMMAND…`
  saves a command line for the site.
- `ask REASON` hands the tab to you; `adopt TEXT` asks to borrow one of your tabs; `shot`, `rec start|stop`,
  `console`, `net [--har]` and `js` collect evidence. `help` lists everything.

Learned endpoints and aliases are kept per site in `~/.local/share/omd-browse/sites/`. An endpoint is learned only
from JSON fetches the page itself makes to its own site, skipping analytics. Values the model typed become
parameters; the rest are kept as defaults it can override. Cookies are never stored; calls run inside the page with
your current session, and CSRF tokens are read from the page at call time.

## Use your own browser

1. In Chrome 144 or later, open `chrome://inspect/#remote-debugging` and turn on **Allow remote debugging for this
   browser instance**.
2. Ask Codex to open a page. Chrome asks whether to allow the connection; click **Allow**. It asks again each time
   Codex starts the server.

Agent tabs open in the background of your window. The agent works only in tabs it opened and their popups, or one
you lend it: `adopt` brings the tab forward with an **Allow** card, and the agent gets it only if you click. A lent
tab is never closed, only given back, and tabs you open from it stay yours. Tabs the agent opened close when the
Codex session ends or after 15 minutes unused. Chrome shows its "being controlled" bar while connected.

Without remote debugging turned on, the server opens a separate Chrome window with OMD's own profile, in
`~/.local/share/omd-browse/profile`. Sign in there once and it remembers.

## Watch and take over in the terminal

The `mod/` folder is a mod component. With it on, `/browse` docks the agent's current tab beside the chat as a live
picture. Click it to use the page yourself: clicks, scrolling, typing and pastes go to the tab, and Ctrl+] gives the
keyboard back to the chat. The pane follows whichever tab the agent works in, and its title says **your turn** while
the agent waits on `ask`. With the pane open, `ask` also works when the browser is headless or on a remote machine,
because you answer it in the pane.

The pane draws in Kitty, Ghostty, iTerm2, WezTerm and Orca as real images, and as colored half-block cells
elsewhere. It connects to the newest `browse` server on this machine through a socket in the data folder.

Turn the component on as described in [Turn on a component](../../../../README.md#turn-on-a-component) with:

```sh
PLUGIN=omd-browse
CAPABILITIES=interception,terminal,commands,store,exec,os
```

It runs `node` outside the sandbox, without IP network access, to relay frames and input; OMD asks you once before
the first start. It also shows a status line (tab, recording, endpoints learned this thread) and draws each `browse`
call as one compact row until you expand it.

## Secrets

Store a password or a TOTP seed for a site yourself; the model types it with `secret:NAME` or `totp:NAME` and
never sees it:

```sh
OMD_BROWSE="$(ls -d "${CODEX_HOME:-$HOME/.codex}"/plugins/cache/oh-my-diff-experimental/omd-browse/* | tail -1)/scripts/server.mjs"
node "$OMD_BROWSE" secret add github --origin https://github.com
node "$OMD_BROWSE" secret add github-2fa --origin https://github.com --totp
node "$OMD_BROWSE" secret list
node "$OMD_BROWSE" secret rm github
```

On macOS values go to your login Keychain (service `omd-browse`); elsewhere to `secrets/` in the data folder,
readable only by you. A secret is typed only into a field whose frame is on one of its origins, from inside that
frame. The field then reads `(filled)` and is drawn masked, `js` is off on that page until it navigates, requests
carrying the value are never learned, and the value is replaced with `[secret]` in anything the model sees. A stored TOTP seed makes 2FA one factor for that site.

## Settings

| Variable | Effect |
| --- | --- |
| `OMD_BROWSE_MODE` | `auto` (default): your browser when remote debugging is on, otherwise OMD's profile. `user`: only your browser. `managed`: only OMD's profile |
| `OMD_BROWSE_ALLOW` | Comma-separated hosts or origins agent tabs may load, such as `localhost:3000,github.com` |
| `OMD_BROWSE_BROWSER` | Browser executable for OMD's profile |
| `OMD_BROWSE_HEADLESS` | `1` runs OMD's profile without a window (`ask` then needs the `/browse` pane; no `adopt`) |
| `OMD_BROWSE_DATA` | Profile, site memory, secrets index, screenshots, recordings and HAR folder (default `~/.local/share/omd-browse`) |
| `OMD_BROWSE_IDLE_MINUTES` | Close unused agent tabs after this many minutes (default 15) |
| `OMD_BROWSE_SECRETS_FILE` | `1` keeps secrets in files instead of the macOS Keychain |

## Safety

The agent acts with your logins. Codex's MCP tool approval decides which calls need your consent. Learned endpoints
that change data, and GraphQL mutations, ask you in the terminal each time (an MCP elicitation); in a client that
can't ask, the agent must pass `--yes`, and aliases can't carry it. `OMD_BROWSE_ALLOW` limits where agent tabs and `api` calls go: other page loads are blocked, a tab that still lands
elsewhere is sent to `about:blank`, frames are held to it too, and service workers are bypassed. The allowlist checks page loads, not images,
scripts or fetches a page makes, and it doesn't apply while a tab is handed to you. `js` runs as the page. The
handoff card lives in an isolated world and accepts only a real click, so a page can't press it, and the agent
can't use the tab until the handoff ends. Dialogs on tabs you lent or handed off are left for you. Clicks on an
element covered by something else (a cookie banner, a modal) are refused with the covering element's ref. HAR files
replace authorization and cookie headers with `[redacted]`. Page text is labelled untrusted in every result, and page
text can't forge an `@ref`. CSRF tokens are sent only to the page's own origin. Recording pauses while a tab is
with you, and screenshots, recordings and HAR files are readable only by you.

## Limits

- An endpoint whose page sent an `Authorization` header (a token kept in page storage) is learned, but replaying
  it may fail; `api NAME --help` says so.
- Closed shadow roots are invisible to the page reader.
- With several Codex sessions using `browse`, the pane shows the server that was used last when it opened.
