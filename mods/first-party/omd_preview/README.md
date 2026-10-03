# omd_preview

Opt-in first-party mod (`0.1.0-preview.2`, API `0.2.0-experimental.5`) that
renders a response or a local Markdown, code or diff file as a themed HTML page
and opens it in the browser.

```text
/preview                 the last response
/preview N               the Nth most recent response (/preview list numbers them)
/preview PATH            a workspace Markdown, code or diff file
/preview PATH --watch    also re-render PATH whenever it changes (at most 8 files)
/preview ... --inline    show it in a terminal dialog instead
/preview server [PORT]   open a server this session is listening on
/preview unwatch         stop watching files
/preview close           close the inline dialog
```

The bundled renderer (`render.mjs`, a package asset) runs in `node` from `PATH`
through `exec.run` and writes `.omd/preview/NAME.html` in the repository, so
file size is not limited by the mod callback budget (files up to 5 MB;
responses up to about 48 KB). Markdown is converted in the package: headings,
emphasis, links, images, lists and task lists, block quotes, tables, fenced and
indented code, `$…$` and `$$…$$` math and `mermaid` fences. Raw HTML in the
source is escaped, links and images keep only http(s), mailto, anchor and
relative targets, and relative targets resolve from the source file. A
content-security policy allows only the page's own inline script (by hash)
and the pinned CDN files. The page loads highlight.js 11.12.0, KaTeX 0.18.10
or Mermaid 12.0.0 from jsDelivr with SRI hashes only when it uses them; offline,
code stays plain and math and diagrams stay as source. The page follows the
browser's light or dark theme.

`--watch` records the file and checks its hash every two seconds on a host
timer, so edits by the agent, commands or other programs re-render it, also in
gitignored directories such as `.omd/notes`; the open page reloads every two
seconds, keeping its scroll position. `[[Note]]`, `[[Note|label]]` and
`[[Note#heading]]` wiki links render as links to `Note.md` beside the file. `--inline` shows Markdown, code and diffs
with the terminal's own components in a scrollable dialog (the first 4 KB of
Markdown or code and 48 KB of a diff, with CRLF, tabs and terminal escapes
normalized); images, math and diagrams render only in the browser. A declined
or unavailable browser leaves the written path in the message.

Capabilities: `commands`, `terminal`, `store`, `sessions` (reads responses
through `thread/turns/list` and listening ports through `sessions.ports`), `exec` (the renderer runs as a writing command under
`.omd/preview`), `fs.read`, `events` and `lifecycle` (the watch timer). There is
no pandoc, puppeteer, LaTeX or PDF export, and the terminal does not show
rendered page images.

Ported from [`pi-markdown-preview`](https://github.com/omaclaren/pi-markdown-preview)
0.19.1 by Oliver MacLaren (MIT). This package reimplements its preview behavior
with its own renderer and copies no code.
