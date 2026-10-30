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

Pick a preset with `/workspace layout NAME`. `side: left` mirrors each one.

| Preset | Shape |
| --- | --- |
| `dock` (default) | One tabbed dock beside the chat |
| `stack` | Split panels in one column beside the chat |
| `columns` | The chat and panels side by side |
| `grid` | Two rows |
| `corner` | One panel below the chat, the rest full height beside it |

Then rearrange it:

- **Drag** a panel by its title row onto another panel. Dropping on an edge splits beside it; dropping in the centre tabs with it. In a tab group, grab the frame line under the tab bar.
- **Move** with `/workspace move PANEL left|right|up|down|tab`, or exchange two panels with `/workspace swap PANEL PANEL`. `PANEL` is a panel's number, title or id; `chat` counts as a panel.
- **Save** up to 8 arrangements with `/workspace layout save NAME`, then `load NAME` or `delete NAME`.

Your last change wins and is kept, including sizes you drag and tabs you pick. A change the host can't draw is refused with the reason and the old arrangement stays.

Other mods can arrange the workspace only until you change it. `/workspace reset` goes back to your settings and lets mods arrange again.

When the window is narrower than `narrow_below` columns, the chat stacks above the panels, and panels that were stacked sit side by side. A panel dropped there is placed in this narrow arrangement, which stays when the window widens. Even then, panels dropped beside the chat go above or below it, and panels dropped above or below another panel go beside it.

## Keys

From the prompt, Ctrl+] enters the panels. Esc or Ctrl+] in a panel returns to the chat. Tab moves between a panel's controls.

| Key | Does | Setting |
| --- | --- | --- |
| `1`–`6` | Show that panel (its tab, or focus it) | `key_panel_1` … `key_panel_6` |
| `0` | Back to the chat | `key_main` |
| `Left` or `h` | Region on the left | `key_left`, `key_left_alt` |
| `Right` or `l` | Region on the right | `key_right`, `key_right_alt` |
| `Up` or `k` | Region above (inside a list, moves in the list first) | `key_up`, `key_up_alt` |
| `Down` or `j` | Region below (same) | `key_down`, `key_down_alt` |
| `[` / `]` | Previous / next tab of the focused tab group | `key_tab_previous`, `key_tab_next` |
| `{` / `}` | Previous / next tab inside a panel with its own tabs | `key_panel_tab_previous`, `key_panel_tab_next` |
| `=` / `-` | Grow / shrink the panels (dragging a border works too) | `key_grow`, `key_shrink` |
| `+` / `_` | Next / previous screen mode: normal, half, full | `key_mode_next`, `key_mode_previous` |
| `Enter` | Type in a running Shell or terminal (Ctrl+] leaves it) | `key_focus_shell` |
| `?` | List the keys that work here | `key_help` |

To change a key, set its setting to one of:

- a single character, such as `m`
- a named key, such as `Home` or `PageDown`
- `F2` to `F12`
- `Ctrl+` or `Alt+` with a lowercase letter or digit, such as `Ctrl+g` (not Ctrl+c, d, h, i, j, m or z)
- `<disabled>` to turn it off

An invalid key keeps its default and is listed by `/workspace config`. The workspace binds at most 32 keys; with many panels the alternate region keys, then the screen mode keys, are dropped first.

Screen modes enlarge one panel for a while:

- **half** shows the chat beside that panel (or its tab group), half and half.
- **full** shows the panel with a small chat below it.
- On the chat, `/workspace mode next chat` shrinks the panels to a quarter, then hides them.

`/workspace mode … dock` applies to every panel, and `/workspace mode normal` brings back the arrangement.

## Panels

- **Changes:** `git status` of the current directory, refreshed when a turn ends, when the list gets focus and on `/workspace refresh`. Select a file for its diff against `HEAD` (an untracked file shows as all added).
- **Shell:** focusing it focuses its `Start shell` button; Enter (or a click) starts the shell after you confirm. If the shell has ended, Enter brings the button back. It runs in the session sandbox, read-only and without network unless `shell_write` and `shell_network` say otherwise; the confirmation names what it may do. With `shell_write`, `git commit` works.
- **Your terminals:** each `terminals` entry is a panel that runs its program the same way, sandboxed with a scratch `HOME`, for example a game (`node demo/snake.mjs`) or a sandboxed `lazygit`. `/workspace start ID` or its button starts it.
- **Other mods:** see [Service](#service).

Each mod runs at most `pty_panes_per_mod` terminals at once (4 unless `mod_limits` in the store's `host.json` sets 1 to 16), and all mods 16. `/workspace config` and a refused start name the limit. Each running shell costs about 2 MiB and no idle CPU.

## Service

`omd.workspace` 1.2.0:

| Method | Does |
| --- | --- |
| `register {id, title, site, tabs?, order?, placement?, show?}` | Adds or replaces a panel (see below); one registered while the workspace is off shows when it is turned on. |
| `unregister {id}` | Removes a panel. |
| `panels` | The shown panels in order; none while the workspace is off. |
| `arrange {tree}` | Sets the whole arrangement, unless the user has arranged it (`/workspace reset` hands it back). A tree is `"chat"`, a panel id, `{split: 'horizontal' \| 'vertical', children: [2-4], ratio?}` or `{tabs: [panel ids]}`, with `chat` once and outside tabs. A refused tree returns `{error}` with the reason. |
| `arrangement {}` | `{tree, by: 'user' \| 'mod' \| 'settings', preset?}`: the arrangement with every shown panel. |
| `mode {level, target?}` | Sets the screen mode like `/workspace mode`: `level` is `normal`, `half` or `full`, `target` is `chat` (the default), `dock` or a shown panel id. Unregistering the target clears it; returns `{error}` while the workspace is off. |

`register` fields:

- `id`: any id except a built-in or terminal panel's, `chat` or `dock`.
- `site`: `<mod>/<name>`, drawn by the registering mod.
- `tabs`: up to 4 `{title, site}` entries, giving the panel its own tab bar.
- `show: true`: also brings it to the front of its tab group.
- `placement {beside, edge, share?}`: where it first appears. `beside` is `chat` or a panel id, `edge` is `left`, `right`, `top`, `bottom` or `tab`, and `share` is 5–95 percent.

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
| `dock_size` | `33` | Percent of the width the panels take in `dock` and `stack` (and `grid` with one panel), 15 to 85; resizing overrides it until `/workspace reset` |
| `narrow_below` | `84` | Columns below which the arrangement stacks (see [Arranging](#arranging)) |
| `panels` | empty | Panel ids in order, separated by commas (`changes, terminal`); panels you leave out are hidden, and unknown ids are listed under `Ignored:`; empty shows built-ins, terminals, then registrations |
| `shell_write` | `false` | Let the Shell write the workspace |
| `shell_network` | `none` | `loopback` lets the Shell reach services on this computer |
| `terminals` | `[]` | Up to 6 terminal panels: `{id, title, argv, write?: true, network?: "loopback"}`; `argv[0]` is the program |
| `key_…` | see [Keys](#keys) | One setting per key, listed in the Keys table |

## Needs and limits

- Asks for `fs.write` and `network` so `shell_write`, `shell_network` and terminals' `write` and `network` can work. Nothing writes or reaches the network unless you turn it on, and each start asks you first.
- Needs `git` on your `PATH` for the Changes panel. A directory outside a Git repository shows "Not a Git repository".
- At most 6 panels and 10 panel sites (each tab of a panel with tabs counts); extra panels are left out. `stack` and `columns` put panels past the fourth into tabs.
- The host draws at most 12 cells (the chat counts two), 6 levels deep, and splits into at most 4. A move, drop or tree beyond that is refused.
- Changes lists the first 50 files and cuts a diff at about 30 KB or 1,000 lines.
- Below 60 columns or 12 rows the host drops the layout and shows its own.
- The chat (transcript and prompt) is one area: panels go beside, above or below it, never between the transcript and the prompt.
- Sizes are kept per split by the panels in it, so they survive reordering but reset when a split gains or loses a panel.
- Tab titles that don't fit are cut off; those tabs are still reachable by number or `[` / `]`.
