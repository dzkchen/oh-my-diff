# omd_workspace

Arrange the chat and panels the way you like. Turn it on and it owns the screen: your Git changes, a shell, your own terminal programs and any other mod's panels sit around the chat, which is the main view (region 0). By default they are numbered tabs of one dock to the right of the chat:

```text
─ Chat ──────────────────────────── 1 Changes  2 Shell  3 Git
transcript                         ╭──────────────────────────╮
                                   │ 3 changed                │
                                   │ M src/a.ts               │
                                   │ diff …                   │
› prompt                           ╰──────────────────────────╯
```

The `corner` layout puts one panel below the chat and the rest full height beside it:

```text
─ Chat ────────────────────╮╭ 2 Snake ───────────────────╮
transcript                 ││                            │
› prompt                   ││   ▪▪▪▪▪                     │
╭ 1 Changes ─────────────╮ ││         ●                   │
│ M src/a.ts             │ ││                            │
╰────────────────────────╯ │╰────────────────────────────╯
```

## Turn it on

It comes with OMD+ but starts off. Turn it on in `/mods`, or run:

```sh
omd-package mod enable omd_workspace
```

Without it nothing changes. `/workspace off` hides the workspace and `/workspace on` brings it back, without `/mods`.

## Arranging

- **Layouts.** `/workspace layout dock|stack|columns|grid|corner` picks a preset: `dock` (one tabbed dock, the default), `stack` (split panels in one column), `columns` (side by side), `grid` (two rows) or `corner` (one panel below the chat, the rest full height beside it). `side: left` mirrors them.
- **Moving.** `/workspace move PANEL left|right|up|down|tab` swaps a panel with its neighbour that way, or moves it out to the next level, or tabs it with its neighbour. `/workspace swap PANEL PANEL` exchanges two panels (`chat` counts as one).
- **Dragging.** Drag a panel by its title row onto another panel: its edges split beside it, its centre tabs with it. The chat takes the four edges.
- **Saving.** `/workspace layout save NAME`, `load NAME` and `delete NAME` keep up to 8 arrangements.

The last change you make wins and persists per profile store, including sizes you drag and tabs you pick. Another mod can arrange the workspace only until you change it or set `arrangement`; `/workspace reset` returns to the settings default (the `layout` preset, or the `arrangement` setting) and hands arranging back to mods. A change that doesn't fit what the host can draw is refused with the reason, and the previous arrangement stays.

Below `narrow_below` columns, splits that hold the chat stack top to bottom and splits of panels become a row, so a `dock` becomes a band below the prompt.

## Keys

These keys work while a panel has focus, and Tab moves between its controls. From the prompt, Ctrl+] enters the panels; Esc or Ctrl+] in a panel returns to the chat.

| Key | Does |
| --- | --- |
| `1`-`6` | Show that panel's tab, or focus it when it isn't in tabs |
| `[` / `]` | Previous / next tab |
| `{` / `}` | Previous / next tab inside a panel that has its own tabs |
| `=` / `-` | Grow / shrink the panels beside the chat (dragging a border works too) |
| `+` / `_` | Next / previous screen mode of the focused panel: normal, half, full |
| `0` | Main view (the chat) |
| `h`, `Left` / `l`, `Right` | Region on the left / right |
| `k`, `Up` / `j`, `Down` | Region above / below (Up and Down move inside a focused list first) |
| `?` | List the keys that apply here |
| `Enter` | In a running Shell or terminal panel, type in it (Ctrl+] leaves it) |

A mod has 32 keys; with many panels the alternate region keys, then the screen mode keys, are left out first.

Screen modes work for any panel and for the chat: half shows the chat beside that panel (or its tab group), full shows the panel with a compact chat below it, and `/workspace mode next chat` shrinks the panels to a quarter, then hides them. `dock` as the target means every panel. `/workspace mode normal` restores the arrangement.

## Panels

- **Changes:** `git status` of the current directory, refreshed when a turn ends, when the list gets focus and on `/workspace refresh`. Select a file for its diff against `HEAD` (an untracked file shows as all added).
- **Shell:** focusing it focuses its `Start shell` button; Enter (or a click) starts the shell after you confirm. If the shell has ended, Enter brings the button back. It runs in the session sandbox, read-only and without network unless `shell_write` and `shell_network` say otherwise; the confirmation names what it may do. With `shell_write`, `git commit` works.
- **Your terminals:** each `terminals` entry is a panel that runs its program the same way, sandboxed with a scratch `HOME`, for example a game (`node demo/snake.mjs`) or a sandboxed `lazygit`. `/workspace start ID` or its button starts it.
- **Other mods:** see [Service](#service).

Each mod runs at most `pty_panes_per_mod` terminals at once (4 unless `mod_limits` in the store's `host.json` sets 1 to 16), and all mods 16. `/workspace config` and a refused start name the limit. Each running shell costs about 2 MiB and no idle CPU.

## Service

`omd.workspace` 1.1.0:

| Method | Does |
| --- | --- |
| `register {id, title, site, tabs?, order?, placement?}` | Adds or replaces a panel: any id but a built-in or terminal one, `chat` or `dock`; `site` is `<mod>/<name>`; `tabs` (up to 4) gives it its own tab bar. `placement {beside: 'chat' \| PANEL, edge: 'left' \| 'right' \| 'top' \| 'bottom' \| 'tab', share?: 5-95}` puts it next to the chat or a panel the first time it appears, instead of the default spot. |
| `unregister {id}` | Removes a panel. |
| `panels` | The shown panels in order. |
| `arrange {tree}` | Sets the whole arrangement, unless the user has arranged it (`/workspace reset` hands it back). A tree is `"chat"`, a panel id, `{split: 'horizontal' \| 'vertical', children: [2-4], ratio?}` or `{tabs: [panel ids]}`, with `chat` once and outside tabs. A refused tree returns `{error}` with the reason. |
| `arrangement {}` | `{tree, by: 'user' \| 'mod' \| 'settings', preset?}`: the arrangement with every shown panel. |

A registration persists until `unregister`, so a mod can register again on every start. Titles are at most 30 bytes (tab titles 32) without control characters; the workspace only places panels, the registering mod draws them. Panels missing from an arrangement join it by their placement, else the first tab group, else beside the last panel; panels that are gone are left out.

## Commands

| Command | What it does |
| --- | --- |
| `/workspace` | Status and usage |
| `/workspace on`, `off` | Show or hide the workspace |
| `/workspace layout PRESET\|save NAME\|load NAME\|delete NAME` | Pick, save, load or delete an arrangement |
| `/workspace move PANEL left\|right\|up\|down\|tab`, `swap PANEL PANEL` | Rearrange panels |
| `/workspace tab N\|next\|previous` | Show a panel's tab |
| `/workspace tab next\|previous PANEL` | Switch a panel's own tab |
| `/workspace grow`, `shrink` | Resize the panels beside the chat by 5% |
| `/workspace mode next\|previous\|normal\|half\|full [PANEL\|dock\|chat]` | Change a screen mode |
| `/workspace start [PANEL]` | Start the shell or a terminal panel |
| `/workspace diff PATH`, `refresh` | Show a changed file's diff, reload the list |
| `/workspace config` | The settings file, effective keys, layout and arrangement, shell access, the terminal limit, ignored settings and an example |
| `/workspace reset` | Return to the settings default and forget sizes, tabs and screen modes (saved layouts stay) |

## Settings

Every setting is its own row in `/mods` (open the workspace's settings there). The same names work in `settings/omd_workspace.json` (or `.yaml`) in the mod store, which wins over `/mods`; `/workspace config` prints its path, the effective values and an example:

```json
{"layout": "corner", "shell_write": true, "terminals": [{"id": "snake", "title": "Snake", "argv": ["node", "demo/snake.mjs"]}]}
```

| Setting | Default | What it does |
| --- | --- | --- |
| `layout` | `dock` | The preset: `dock`, `stack`, `columns`, `grid` or `corner` |
| `arrangement` | `{}` | A full tree (see `arrange` under [Service](#service)) that replaces the preset; an invalid one is listed under `Ignored:` in `/workspace config` |
| `border` | `rounded` | Frame of the panels: `rounded`, `plain`, `double` or `thick` |
| `side` | `right` | Side of the chat the presets put the panels on: `right` or `left` |
| `dock_size` | `33` | Percent of the width the panels take in `dock`, `stack` and `grid`, 15 to 85; resizing overrides it until `/workspace reset` |
| `narrow_below` | `84` | Columns below which the arrangement stacks (see [Arranging](#arranging)) |
| `panels` | empty | Panel ids in order, separated by commas (`changes, terminal`); panels you leave out are hidden, and unknown ids are listed under `Ignored:`; empty shows built-ins, terminals, then registrations |
| `shell_write` | `false` | Let the Shell write the workspace |
| `shell_network` | `none` | `loopback` lets the Shell reach services on this computer |
| `terminals` | `[]` | Up to 6 terminal panels: `{id, title, argv, write?: true, network?: "loopback"}`; `argv[0]` is the program |
| `key_ACTION` | see Keys | One per action: `key_panel_1` to `key_panel_6`, `key_main`, `key_left`, `key_left_alt`, `key_right`, `key_right_alt`, `key_up`, `key_up_alt`, `key_down`, `key_down_alt`, `key_help`, `key_mode_next`, `key_mode_previous`, `key_tab_previous`, `key_tab_next`, `key_panel_tab_previous`, `key_panel_tab_next`, `key_grow`, `key_shrink`, `key_focus_shell`. A key is a single character, a named key such as `Left` or `Home`, F2–F12, or `Ctrl+x` / `Alt+x` with a lowercase letter or digit (not Ctrl+c, d, h, i, j, m or z); `<disabled>` turns it off. Invalid keys keep the default and show in `/workspace config`. |

## Needs and limits

- Needs `git` on your `PATH` for the Changes panel. A directory outside a Git repository shows "Not a Git repository".
- At most 6 panels (`stack` and `columns` tab the ones past their fourth cell) and 10 panel sites, counting each tab of a panel that has tabs; extra panels are left out. The host draws 12 cells (the chat counts two), nests 6 levels and splits into at most 4; a move, drop or tree beyond that is refused. The first 50 changed files are listed, and a diff is cut at about 30 KB or 1,000 lines.
- Below 60 columns or 12 rows the host drops the layout and shows its own.
- The chat (transcript and prompt) is one area: panels go beside, above or below it, never between the transcript and the prompt.
- Sizes are kept per split by the panels in it, so they survive reordering but reset when a split gains or loses a panel.
- Tab titles that don't fit are cut off; those tabs are still reachable by number or `[` / `]`.
