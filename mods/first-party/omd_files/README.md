# omd_files

A file manager in the workspace dock, modelled on yazi's core and framed like the Git panel: parent, current and preview columns, tabs, find, a frecency jump, syntax-highlighted and image previews, rename, move and delete, and adding a file to the prompt.

```text
╭ / ──╮┏ /src ━━━━━━━━━━━┓╭ lib ───────────────╮
│ docs│┃  ▶ lib/         ┃│  util.ts           │
│▶ src│┃    a10.ts       ┃│  index.ts          │
│ READ│┃    main.ts      ┃│                    │
╰─────╯┗━━━━━━━━━━━━━━━━━┛╰────────────────────╯
1/3  Open: l | Parent: h | Find: / | Jump: z | …
```

## Turn it on

It comes with OMD+ but starts off, and it draws inside [`omd_workspace`](../omd_workspace/README.md), so turn that on first. Then turn on `omd_files` in `/mods`, or run:

```sh
omd-package mod enable omd_workspace
omd-package mod enable omd_files
```

Turn on [`omd_frecency`](../omd_frecency/README.md) too for the `z` jump list.

## Keys

Open the Files tab in the dock, and these keys apply while it has focus. `?` lists them. Esc returns to the chat.

| Key | Does |
| --- | --- |
| `h` / `l`, `Enter` | Parent directory / enter the directory or open the file in your editor |
| `j` / `k` | Next / previous entry |
| `g` `g` / `G` | First / last entry |
| `J` / `K` | Scroll the preview |
| `t` | New tab in the current directory (at most 9) |
| `1`–`9`, `[` / `]`, `q` | With several tabs: show that tab, previous / next tab, close this tab |
| `/`, `n` / `N` | Find a name in the current directory (lowercase ignores case), next / previous match |
| `z` | Jump to a file `omd_frecency` ranks, or type a path |
| `r` | Rename, or move with a path from the current directory |
| `d` | Delete, after you confirm |
| `@` | Add an `@` mention of the entry to the prompt |
| `.` | Show or hide dotfiles |

With one tab the digits and brackets stay with the workspace dock, so `1`–`6` still switch dock tabs. `/files go PATH` jumps to a path.

## Previews

- Directories list their first 100 entries.
- Text files show their first 300 lines (about 24 KB) highlighted in your syntax theme by their extension.
- PNG, JPEG, GIF, WebP, HEIC, BMP and TIFF images are drawn as pictures (Kitty, iTerm2, Ghostty and WezTerm graphics, or half-block cells) from a JPEG thumbnail that macOS `sips` makes.
- Other files show their size.

## Needs and limits

- [`omd_workspace`](../omd_workspace/README.md) turned on. Opening a file needs `editor` in `host.json`; without it a text, Markdown, PDF or image file opens in its macOS app after you confirm.
- Rename, move and delete run in the session sandbox, so they work only inside the workspace and where the sandbox allows writes. Delete removes for good; it does not use the Trash.
- A directory lists its first 1,000 entries, and the current column shows the 150 around the selection.
- The listing follows file changes on disk (a `workspace.watch`, not polling).
- The panel keeps state for the last two workspaces you used it in.
