# omd_preview

Opens a response or a local Markdown, code or diff file as a themed page in your browser, draws Mermaid diagrams as text, and shows pasted images above the prompt.

## Turn it on

It comes with OMD+ but starts off. Turn it on in `/mods`, or run:

```sh
omd-package mod enable omd_preview
```

## Use it

| Command | What it does |
| --- | --- |
| `/preview` | Open the last response in your browser |
| `/preview N` | Open the Nth most recent response. `/preview list` numbers them. |
| `/preview PATH` | Open a Markdown, code or diff file. Use `./PATH` if the file is named like a subcommand. |
| `/preview PATH --watch` | Re-render the browser page when the file changes (up to 8 files; not with `--inline`). A missing file is awaited through a watch on its parent directory; one in the repository root or in a missing directory is retried instead, backing off from 2 s to once a minute, until it exists. `/preview unwatch` stops. |
| `/preview ... --inline` | Show it in a terminal dialog instead. `/preview close` closes it. |
| `/preview diagrams [N]` | List Mermaid diagrams from the last 10 responses, or open diagram N with its source and a copy button |
| `/preview image [N]` | Preview the Nth image in your draft |
| `/preview server [PORT]` | Open a server this session is listening on |

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `thumbnails` | `true` | Show your draft's images in a row above the prompt, each with a Preview button |
| `diagrams` | `unicode` | Draw Mermaid diagrams with box-drawing characters. `ascii` uses plain characters, `off` leaves the source. |

## Needs and limits

- You need `node` on your `PATH`. Pages are written to `.omd/preview` in the repository.
- Files up to 5 MB, responses up to about 48 KB. The inline view shows the first 4 KB of Markdown or code and 48 KB of a diff.
- Highlighting, math and browser diagrams load pinned files from a CDN. Offline they stay as plain source.
- Browser pages escape source HTML but can load remote and local images.
- Terminal diagrams cover flowcharts, sequence, class, state and ER diagrams and bar and line charts, up to 4 per response. Others keep their original fence.
- Thumbnails cover the first 16 images in the draft, PNG and JPEG up to 8 MiB. Other attachments show a text tile.
- There is no PDF export.

Credit: based on [pi-markdown-preview](https://github.com/omaclaren/pi-markdown-preview) by Oliver MacLaren, [claude-mermaid](https://github.com/galElmalah/claude-mods) by Gal Elmalah and [Claude Image View](https://github.com/jarrodwatts/claude-image-view) by Jarrod Watts (all MIT); reimplemented, no code copied.
