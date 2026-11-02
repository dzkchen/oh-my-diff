# omd_preview

Opens a response or a local Markdown, code or diff file as a themed page in your browser, and draws Mermaid diagrams
in the terminal with text characters. It's off by default in OMD+. OMD Core doesn't include it.

## Turn it on

Turn it on in `/mods`, or run:

```sh
omd mods enable omd_preview
```

[Manage mods](../../../docs/manage-mods.md) covers the other ways to turn a mod on or off.

## Use it

| Command | What it does |
| --- | --- |
| `/preview` | Open the last response in your browser |
| `/preview N` | Open the Nth most recent response. `/preview list` numbers them. |
| `/preview PATH` | Open a Markdown, code or diff file |
| `/preview PATH --watch` | Re-render the browser page when the file changes |
| `/preview ... --inline` | Show it in a terminal dialog instead. `/preview close` closes it. |
| `/preview diagrams [N]` | List Mermaid diagrams from the last 10 responses, or open diagram N with its source and a copy button |
| `/preview server [PORT]` | Open a server this session is listening on |

`--watch` follows up to 8 files and doesn't work with `--inline`. `/preview unwatch` stops watching.

For `/preview PATH`, use `./PATH` if the file is named like a subcommand. Spaces inside the path are kept as typed;
only `--` flags are removed.

With `--watch`, you can name a file that doesn't exist yet. OMD waits for it by watching its parent directory. For a
file in the repository root, or in a directory that doesn't exist yet, it checks again instead, every 2 s at first and
slowing to once a minute, until the file exists.

## Settings

Change settings in `/mods`.

| Setting | Default | What it does |
| --- | --- | --- |
| `diagrams` | `unicode` | Draw Mermaid diagrams with box-drawing characters. `ascii` uses plain characters, `off` leaves the source. |

## Needs and limits

- It asks to add `/preview`, read recent responses, the files you name and the ports this session listens on, run
  `node` in the sandbox to write pages to `.omd/preview`, open them in your browser, show a terminal dialog, keep its
  state and watch files. The capabilities are `commands`, `sessions`, `fs.read`, `exec`, `fs.write`, `terminal`,
  `store`, `events`, `lifecycle` and `inventory` (see
  [Trust and permissions](../../../docs/trust-and-permissions.md#what-a-mod-can-do)).
- You need `node` on your `PATH`. Pages are written to `.omd/preview` in the repository.
- Files can be up to 5 MB and responses up to about 48 KB. The inline view shows the first 4 KB of Markdown or code,
  or 48 KB of a diff. It also stops at 2,000 lines, or 60 KB once quotes and backslashes are escaped. A notice says
  when the view was cut.
- Highlighting, math and browser diagrams load pinned files from a CDN. Offline they stay as plain source.
- Browser pages escape source HTML but can load remote and local images.
- Terminal diagrams cover flowcharts, sequence, class, state and ER diagrams and bar and line charts, up to 4 per
  response. Others keep their original fence.
- There is no PDF export.

## More

- [Included mods](../../../docs/collection.md)
- Credit: based on [pi-markdown-preview](https://github.com/omaclaren/pi-markdown-preview) by Oliver MacLaren and
  [claude-mermaid](https://github.com/galElmalah/claude-mods) by Gal Elmalah (both MIT); reimplemented, no code
  copied.
