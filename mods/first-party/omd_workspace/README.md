# omd_workspace

A tabbed dock beside the chat. Turn it on and it owns the screen: your Git changes, a shell and any other mod's panels are numbered tabs of one dock to the right of the chat, which is the main view (region 0).

```text
─ Chat ──────────────────────────── 1 Changes  2 Shell  3 Git
transcript                         ┌──────────────────────────┐
                                   │ 3 changed                │
                                   │ M src/a.ts               │
                                   │ diff …                   │
› prompt                           └──────────────────────────┘
```

On a narrow terminal (below `portrait` columns) the dock becomes a band below the prompt, tabs across its top:

```text
─ Chat ──────────────────────────────
transcript

› prompt
 1 Changes  2 Shell  3 Git
┌───────────────────────────────────┐
│ M src/a.ts                        │
└───────────────────────────────────┘
```

## Turn it on

It comes with OMD+ but starts off. Turn it on in `/mods`, or run:

```sh
omd-package mod enable omd_workspace
```

Without it nothing changes. `/workspace off` hides the workspace and `/workspace on` brings it back, without `/mods`.

## Keys

Focus moves natively, so these keys work while the dock has focus. From the prompt, Ctrl+] enters the dock; Esc or Ctrl+] in the dock returns to the chat.

| Key | Does |
| --- | --- |
| `1`-`9` | Show that tab (focus stays in the dock) |
| `[` / `]` | Previous / next tab |
| `{` / `}` | Previous / next tab inside a panel that has its own tabs |
| `=` / `-` | Grow / shrink the dock (dragging its border works too) |
| `+` / `_` | Next / previous screen mode of the dock: normal, half, full |
| `0` | Main view (the chat) |
| `h`, `Left` / `l`, `Right` | Region on the left / right |
| `Tab` | Next region |
| `?` | List the keys that apply here |
| `Enter` | In the Shell tab, type in the running shell (Ctrl+] leaves it) |

Screen modes also work for the chat: `/workspace mode next chat` shrinks the dock to a quarter, then hides it. In full mode the dock keeps a compact chat below it. `/workspace mode normal` restores the layout.

### Stack mode

With `"layout": {"mode": "stack"}` the panels are split panels instead of tabs, each titled `N Title`: `1`-`9` focus that panel, `[` / `]` switch the tabs of a panel that has them, and `+` / `_` change the focused panel's screen mode. Below `portrait` columns the panels sit in a row below the chat.

## Panels

- **Changes:** `git status` of the current directory, refreshed when a turn ends, when the list gets focus and on `/workspace refresh`. Select a file for its diff against `HEAD` (an untracked file shows as all added).
- **Shell:** focusing the tab focuses its `Start shell` button; Enter (or a click) starts the shell after you confirm. It runs in the session sandbox without network.
- **Other mods:** `omd.workspace` 1.0.0 lets a mod `register {id, title, site, tabs?, order?}` (any id but a built-in one, `chat` or `dock`), `unregister {id}` and list `panels`. Titles are at most 30 bytes (tab titles 32) without control characters and sites must be `<mod>/<name>`; the workspace only places them, the registering mod draws them. Built-in panels come first, then registrations by `order`. A panel with `tabs` (up to 4) becomes a tab of the dock holding its own tab bar.

## Commands

| Command | What it does |
| --- | --- |
| `/workspace` | Status and usage |
| `/workspace on`, `off` | Show or hide the workspace |
| `/workspace tab N\|next\|previous` | Show a dock tab |
| `/workspace tab next\|previous PANEL` | Switch a panel's own tab |
| `/workspace grow`, `shrink` | Resize the dock by 5% |
| `/workspace mode next\|previous\|normal\|half\|full [PANEL\|dock\|chat]` | Change a screen mode (in the tabbed dock a panel means the dock) |
| `/workspace start` | Start the shell |
| `/workspace diff PATH`, `refresh` | Show a changed file's diff, reload the list |
| `/workspace config` | The settings file, effective keys and layout, ignored keys and an example |
| `/workspace reset` | Forget sizes, tabs and screen modes |

Resizing (dragging the border or `=` / `-`), clicking a tab and the tab keys persist per profile store: the dock size, the shown tab, stacked panel heights and each panel's own tab.

## Settings

Set these in `/mods` or in `settings/omd_workspace.json` (or `.yaml`) in the mod store; `/workspace config` prints the path and an example.

| Setting | Default | What it does |
| --- | --- | --- |
| `keybinding` | `{}` | `{"ACTION": "KEY"}` or `"<disabled>"`. Actions: `panel_1` to `panel_9`, `main`, `left`, `left_alt`, `right`, `right_alt`, `next`, `help`, `mode_next`, `mode_previous`, `tab_previous`, `tab_next`, `panel_tab_previous`, `panel_tab_next`, `grow`, `shrink`, `focus_shell`. A key is a single character, a named key such as `Left` or `Tab`, F2–F12, or `Ctrl+x` / `Alt+x` with a lowercase letter or digit (not Ctrl+c, d, h, i, j, m or z). Invalid keys keep the default and show in `/workspace config`. |
| `layout` | `{}` | `mode`: `tabs` (default) or `stack`; `panels`: ids in order (default: built-ins, then registrations); `side`: `right` (default) or `left`; `ratio`: `[panels, chat]` widths (default `[1, 2]`); `portrait`: columns below which the panels move below the chat (above it with `"side": "left"`), default 84 |

## Needs and limits

- Needs `git` on your `PATH` for the Changes panel. A directory outside a Git repository shows "Not a Git repository".
- At most 6 tabs (4 panels in stack mode) and 10 panel sites, counting each tab of a panel that has tabs; extra panels are left out. The first 50 changed files are listed, and a diff is cut at about 30 KB or 1,000 lines.
- Below 60 columns or 12 rows the host drops the layout and shows its own.
- The narrow band sits below the prompt, not between the transcript and the prompt: the host draws the transcript and the prompt as one chat area.
- The dock size is shared between the wide and the narrow layout (default a third, from `ratio`) and stays between 15% and 85%.
- Tab titles that don't fit the dock's width are cut off; those tabs are still reachable by number or `[` / `]`.
- In stack mode, `dock` is not a screen-mode target; a mode whose panel is gone acts on all panels.
