# omd_chess

Opt-in `/chess` for playing on [Chess.com](https://www.chess.com/) beside the
conversation. The mod owns only the preset (session `chess` at
`https://www.chess.com/play/online` at 80% zoom, so a half-width pane gets
Chess.com's side-by-side board layout), the open and close flow and the coding
notices; the `omd_browser` mod from the [omd-browser plugin](../../../plugins/optional/plugins/omd-browser/README.md)
draws the live page, takes your clicks and keys, and keeps the session.

## Setup

1. Configure omd-browser with a user-only pane profile and enable its
   `omd_browser` mod component (see the plugin README):
   `"chess": { "pane": true, "user_only": true }`.
2. Enable `omd_panes` so the view opens in a pane beside the conversation, and
   enable `omd_chess`.

## Use

- `/chess` opens the page in the `chess` session and places the view to the
  right of the conversation. Log in on the page yourself and make your own
  moves: click a piece, then its destination (dragging works too). Focus the
  keyboard row under the board to type, for example your login.
- `/chess hide` hides the view; the game keeps running. `/chess end` closes the
  browser session. Nothing else closes it: finished coding turns, idle time and
  agents never do.
- While Chess.com is open, the status row shows whether a coding turn is
  running or finished, and a finished turn shows a short toast. Approvals,
  the composer and Ctrl+] (leave the keyboard row) stay available.
- `/chess system` opens Chess.com in your system browser instead. That is a
  disclosed fallback outside OMD, with no pane and no coding notices.

## Boundaries

The session is user-only: omd-browser refuses it to agent tools, leaves it out
of `browser_sessions` and design mode, and the mod registers no tools, context
or transcript entries, so credentials, the game and any analysis stay away from
coding and advisor agents. Keystrokes pass through the mod's own callbacks to
the page and are never stored. There is no chess engine, automatic move, game
scraping or PubAPI use.

Batch 4fc covered the mod with offline runner tests and the browser path with
managed Chromium on local fixture pages
([audit](../../../.docs/audits/batch4fc-browser-play-design-20261007.md)).
