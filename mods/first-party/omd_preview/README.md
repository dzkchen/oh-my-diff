# omd_preview

Opt-in first-party mod that
renders a response or a local Markdown, code or diff file as a themed HTML page
and opens it in the browser, draws Mermaid diagrams in responses as text and
shows the draft's pasted images above the composer.

```text
/preview                 the last response
/preview N               the Nth most recent response (/preview list numbers them)
/preview PATH            a workspace Markdown, code or diff file (./PATH for a file named like a subcommand)
/preview PATH --watch    also re-render PATH whenever it changes (at most 8 files)
/preview ... --inline    show it in a terminal dialog instead
/preview diagrams [N]    list the Mermaid diagrams in the last 10 responses, or inspect one
/preview image [N]       preview the draft's Nth image
/preview server [PORT]   open a server this session is listening on
/preview unwatch         stop watching files
/preview close           close the inline dialog
```

The bundled renderer (`render.mjs`, a package asset) runs in `node` from `PATH`
through `exec.run` and writes `.omd/preview/response.html` for a response and
`.omd/preview/files/PATH.html` for a file, mirroring the repository-relative
path so different files never share a page. File size is not limited by
the mod callback budget (files up to 5 MB; responses up to about 48 KB). The
renderer refuses a link or file in place of an output directory and publishes
each page by renaming a freshly created file over it, so a planted link is
replaced rather than written through. Markdown is converted in the package: headings,
emphasis, links, images, lists and task lists, block quotes, tables, fenced and
indented code, `$…$` and `$$…$$` math and `mermaid` fences. Raw HTML in the
source is escaped, links and images keep only http(s), mailto, anchor and
relative targets, and relative targets resolve from the source file. A
content-security policy allows only the page's own inline script (by hash)
and the pinned CDN files, plus images from any source (`img-src * data: file:`),
so a document's remote and local images load when the page opens. The page loads highlight.js 11.12.0, KaTeX 0.18.10
or Mermaid 12.0.0 from jsDelivr with SRI hashes only when it uses them; offline,
code stays plain and math and diagrams stay as source. The page follows the
browser's light or dark theme.

`--watch` records the file in repository-scoped mod storage, so each
repository keeps its own watches, and checks its hash every two seconds on a host
timer, so edits by the agent, commands or other programs re-render it, also in
gitignored directories such as `.omd/notes`; a failed render is retried after
the file's next change, and the open page reloads every two seconds, keeping its scroll position.
A watch that cannot be saved (for example after a concurrent change) is reported
as not watched. `[[Note]]`, `[[Note|label]]` and
`[[Note#heading]]` wiki links render as links to `Note.md` beside the file. `--inline` shows Markdown, code and diffs
with the terminal's own components in a scrollable dialog (the first 4 KB of
Markdown or code and 48 KB of a diff, read with `head -c` so only that prefix
enters the callback, with CRLF, tabs and terminal escapes normalized, and a
note whenever the file continues past what is shown); a prefix that is not
UTF-8 text or whose JSON escaping would exceed the callback's receipt budget is
refused with the browser preview as the fallback. Images and math render only in the browser. A declined
or unavailable browser leaves the written path in the message.

## Mermaid diagrams in responses

A `render` hook on finished assistant messages draws closed ```` ```mermaid ````
and `~~~mermaid` fences as Unicode box drawing (`diagrams: ascii` for plain
ASCII, `diagrams: off` for none) in place of their source: flowcharts and
graphs (all four directions, node shapes, labels, dotted, thick, invisible and
bidirectional links, `&` chains, subgraphs listed below the drawing), sequence
diagrams (participants and actors, every arrow type, notes, `loop`/`alt`/`opt`/
`par`/`critical`/`break` blocks, `autonumber`), class diagrams (members,
generics, stereotypes, relations with cardinalities, namespaces and notes),
state diagrams (`[*]` start and end states, scoped inside composite states,
choice, fork and join, descriptions and notes), ER diagrams (attributes and
cardinalities) and `xychart-beta` bar and line charts. A host-side match
selects only messages that contain such a fence, so other messages never call
the mod; the host caches each drawing until the message, width or setting
changes. Text is measured in terminal cells (wide CJK, emoji and emoji sequences count
two, combining marks none), long labels wrap, and a graph that is too wide is drawn
in the other orientation. The source must be at most 4 KB, 300 statements,
60 nodes and 120 edges, and the drawing at most 200 rows, 10 KB and the
terminal width; at most four diagrams per response are drawn. Anything else
(an unsupported type, a parse error, an unclosed fence, a bound) keeps the
original fence with a one-line reason. Responses the host cut at the 4 KiB render-prop
limit (`truncated`) keep their native drawing and get the diagrams from their first 4 KiB
below it. `/preview diagrams N` opens the drawing, laid out for the dialog's width, with
its source and a copy button. The canonical transcript is never changed, and
disabling the mod restores the native drawing at once.

## Draft image thumbnails

With `thumbnails` (default on) the mod reads the draft after every composer
change and shows every PNG and JPEG attachment above the composer in one row:
each tile keeps its image's shape (from the pixel size `composer.read`
reports), and the tiles shrink together, from 8 rows (at most a quarter of the
terminal) down to 2, until the row fits the width; when even 2-row tiles do not
fit, the row ends with `+N more: /preview image K to M`, the command that opens
the hidden ones. Each tile has a `#N` Preview button (click the thumbnail too). The images come from the
host's draft attachment resources (`composer.read`), never from another
program's cache; other formats or files over 8 MiB show a text tile. Pasting,
removing or replacing an image, switching drafts and submitting update or clear
the tiles, `start` and `resume` re-read the draft, and a preview of an image
that left the draft closes. Kitty and Ghostty draw pixels; other terminals get
half-block cells and `NO_COLOR` or very narrow terminals the label. The host
hides the tiles while a question or approval is open. With `thumbnails: false`
the mod registers no composer callback.

Capabilities: `commands`, `terminal`, `store`, `sessions` (reads responses
through `thread/turns/list` and listening ports through `sessions.ports`), `exec` (the renderer runs as a writing command under
`.omd/preview`), `fs.read`, `fs.write`, `events`, `lifecycle` (the watch timer)
and `composer` (draft images). There is no pandoc, puppeteer, LaTeX or PDF
export.

Ported from [`pi-markdown-preview`](https://github.com/omaclaren/pi-markdown-preview)
0.19.1 by Oliver MacLaren (MIT). This package reimplements its preview behavior
with its own renderer and copies no code. The inline diagrams follow
[`claude-mermaid`](https://github.com/galElmalah/claude-mods) 0.3.1 by Gal
Elmalah (MIT) and the thumbnails [Claude Image
View](https://github.com/jarrodwatts/claude-image-view) 0.1.0 by Jarrod Watts
(MIT); both are reimplemented with no code copied.
