# omd_files

A file manager in the workspace dock, modeled on yazi: parent, current and preview columns, tabs, find, a frecency
jump, previews, rename, move, Trash and delete, and adding a file to the prompt. It's off by default in OMD+.
OMD Core doesn't include it.

```text
╭ / ──╮┏ /src ━━━━━━━━━━━┓╭ lib ───────────────╮
│ docs│┃  ▶ lib/         ┃│  util.ts           │
│▶ src│┃    a2.ts        ┃│  index.ts          │
│ READ│┃    a10.ts       ┃│                    │
╰─────╯┗━━━━━━━━━━━━━━━━━┛╰────────────────────╯
1/3  Open: l | Parent: h | Find: / | Jump: z | …
```

## Turn it on

It draws inside [`omd_workspace`](../omd_workspace/README.md), so turn that on first. Then turn on `omd_files` in
`/mods`, or run:

```sh
omd-package mod enable omd_workspace
omd-package mod enable omd_files
```

Turn on [`omd_frecency`](../omd_frecency/README.md) too for the `z` jump list.
[Manage mods](../../../docs/manage-mods.md) covers the other ways to turn a mod on or off.

## Use it

Open the Files tab in the dock, and these keys apply while it has focus. `?` lists them. Esc returns to the chat.

| Key | Does |
| --- | --- |
| `h` / `l`, `Enter` | Parent directory / enter the directory or open the file in your editor |
| `j` / `k` | Next / previous entry |
| `g` `g` / `G` | First / last entry |
| `J` / `K` | Scroll the preview |
| `t` | New tab in the current directory (at most 9) |
| `1`–`9` | Show that tab; a digit without a tab says so instead of switching dock tabs |
| `[` / `]`, `q` | With several tabs: previous / next tab, close this tab |
| `/`, `n` / `N` | Find a name in the current directory (lowercase ignores case), next / previous match |
| `z` | Jump to a file `omd_frecency` ranks, or type a path |
| `r` | Rename, or move with a path from the current directory |
| `d` | Move to the Trash, after you confirm |
| `D` | Delete permanently, after you confirm |
| `@` | Add an `@` mention of the entry to the prompt, quoted (`@"my notes.md"`) when the path has spaces, quotes or trailing punctuation |
| `.` | Show or hide dotfiles |

The brackets and `q` stay with the workspace dock while there is one tab.

| Command | What it does |
| --- | --- |
| `/files go PATH` | Jump to a path, for example `/files go src/lib` |
| `/files go` or `/files go .` | Jump to the workspace root |

A tab whose directory is gone opens its nearest parent that still exists. A rename onto an existing name is refused,
and a rename that changes only letter case works on case-insensitive disks too.

Previews:

- Directories list up to their first 100 entries.
- Text files show their first 300 lines (about 16 KB), highlighted in your syntax theme by their extension.
- PNG, JPEG, GIF, WebP, HEIC, BMP and TIFF images are drawn as pictures (Kitty, iTerm2, Ghostty and WezTerm graphics,
  or half-block cells) from a JPEG thumbnail that macOS `sips` makes.
- Other files show their size.

## Settings

It has no settings.

## Needs and limits

- [`omd_workspace`](../omd_workspace/README.md) turned on. Opening a file needs `editor` in `host.json`; without it a
  text, Markdown, PDF or image file opens in its macOS app after you confirm.
- `d` runs outside the session sandbox (the `os` grant, limited to the Trash commands below) because the Trash is
  outside the workspace. It uses the first that runs: `/usr/bin/trash` (macOS 15 and later), a `trash` on `PATH`,
  `gio trash` (Linux), then Finder through `osascript`, which macOS may ask you to allow. Without any of them `d` says
  so; use `D`.
- Rename, move and `D` run in the session sandbox, so they work only inside the workspace and where the sandbox allows
  writes.
- A directory lists its first 1,000 entries (fewer when names are long), and the current column shows the 150 around
  the selection.
- The listing follows file changes on disk (a `workspace.watch`, not polling) and is listed again at the end of every
  turn, so ignored folders such as `dist/` stay current.
- Each session thread keeps its own tabs and selection, and gets them back when you resume it.

## More

- [Included mods](../../../docs/collection.md)
- [`omd_git`](../omd_git/README.md), the Git panel in the same dock
- [Terminal UI](../../reference/terminal-ui.md) and [workspace watches](../../reference/workspace-files.md#workspacewatch)
  in the mod API reference
