# omd_workspace

A lazygit-style workspace. Turn it on and it owns the screen: numbered side panels (a shell and your Git changes, plus any other mod's panels) beside the chat, which is the main view (region 0).

```text
┌ 1 Terminal ──┐┌ Chat ─────────────┐
│              ││ transcript        │
├ 2 Changes ───┤│                   │
│ M src/a.ts   ││ prompt            │
└──────────────┘└───────────────────┘
```

## Turn it on

It comes with OMD+ but starts off. Turn it on in `/mods`, or run:

```sh
omd-package mod enable omd_workspace
```

Without it nothing changes. `/workspace off` hides the workspace and `/workspace on` brings it back, without `/mods`.

## Keys

Focus moves natively, so these keys work while a panel has focus. From the prompt, Ctrl+] enters the last panel; Esc or Ctrl+] in a panel returns to the chat.

| Key | Does |
| --- | --- |
| `1`-`9` | Focus that panel (only panels on screen) |
| `0` | Main view (the chat) |
| `h`, `Left` / `l`, `Right` | Panel on the left / right |
| `Tab` | Next panel |
| `?` | List the keys that apply here |
| `+` / `_` | Next / previous screen mode of the focused panel: normal, half, full |
| `[` / `]` | Previous / next tab of a panel that has tabs |
| `Enter` | In the Terminal panel, type in the running shell (Ctrl+] leaves it) |

Screen modes also work for the chat: `/workspace mode next chat` shrinks the side panels to a quarter, then hides them. In full mode a panel keeps a compact chat below it. `/workspace mode normal` restores the layout.

## Panels

- **Terminal:** focusing the panel focuses its `Start shell` button; Enter (or a click) starts the shell after you confirm. It runs in the session sandbox without network.
- **Changes:** `git status` of the current directory, refreshed when a turn ends, when the list gets focus and on `/workspace refresh`. Select a file for its diff against `HEAD` (an untracked file shows as all added).
- **Other mods:** `omd.workspace` 1.0.0 lets a mod `register {id, title, site, tabs?, order?}`, `unregister {id}` and list `panels`. Sites must be `<mod>/<name>`; the workspace only places them, the registering mod draws them. Built-in panels come first, then registrations by `order`.

## Commands

| Command | What it does |
| --- | --- |
| `/workspace` | Status and usage |
| `/workspace on`, `off` | Show or hide the workspace |
| `/workspace mode next\|previous\|normal\|half\|full [PANEL\|chat]` | Change a screen mode |
| `/workspace tab next\|previous PANEL` | Switch a panel's tab |
| `/workspace start` | Start the shell |
| `/workspace diff PATH`, `refresh` | Show a changed file's diff, reload the list |
| `/workspace config` | The settings file, effective keys and layout, ignored keys and an example |
| `/workspace reset` | Forget dragged sizes and screen modes |

Dragging a split border and clicking a tab persist per profile store: the side width, the panel heights and each panel's tab.

## Settings

Set these in `/mods` or in `settings/omd_workspace.json` (or `.yaml`) in the mod store; `/workspace config` prints the path and an example.

| Setting | Default | What it does |
| --- | --- | --- |
| `keybinding` | `{}` | `{"ACTION": "KEY"}` or `"<disabled>"`. Actions: `panel_1` to `panel_9`, `main`, `left`, `left_alt`, `right`, `right_alt`, `next`, `help`, `mode_next`, `mode_previous`, `tab_previous`, `tab_next`, `focus_shell`. A key is a single character, a named key such as `Left` or `Tab`, F2–F12, or `Ctrl+x` / `Alt+x` with a lowercase letter or digit (not Ctrl+c, d, h, i, j, m or z). Invalid keys keep the default and show in `/workspace config`. |
| `layout` | `{}` | `panels`: ids in order (default: built-ins, then registrations); `side`: `left` or `right`; `ratio`: `[side, chat]` widths (default `[1, 2]`); `portrait`: columns below which the panels move to the chat's top edge (bottom with `"side": "right"`) in a row (default 84) |

## Needs and limits

- Needs `git` on your `PATH` for the Changes panel. A directory outside a Git repository shows "Not a Git repository".
- At most 4 panels and 10 layout cells; extra panels are left out. The first 50 changed files are listed, and a diff is cut at about 30 KB or 1,000 lines.
- Below 60 columns or 12 rows the host drops the layout and shows its own.
- In portrait the panels sit on the `side` edge: on top by default, below the chat with `"side": "right"`.
- Dragged ratios are shared between the wide and the portrait layout.
