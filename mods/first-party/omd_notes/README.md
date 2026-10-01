# omd_notes

Opt-in first-party mod (`0.1.0-preview.1`, API `0.2.0-experimental.5`) for a
plain Markdown notes vault: a project vault in the repository (`vault`, default
`.omd/notes`) and an optional personal vault in any absolute directory
(`personal`).

```text
/note                       list notes (◇ project, ◆ personal; first 200)
/note open NAME|REF         open a note; an unknown name creates it
/note new [--personal] [TITLE]
/note from PATH:START-END   a note quoting workspace lines
/note response [N]          a note from the Nth most recent response
/note search TEXT | tags [TAG] | tasks
/note task REF:LINE         toggle a task
/note rename NAME           rename a project note and update links to it
/note append TEXT | edit | close
```

The view renders in the `omd_notes/notes` site: the sidebar without a layout,
or a pane with `omd_panes` (`/pane split right notes`). Alt+n opens it. An open
note shows its rendered Markdown, tags, outgoing `[[wiki links]]` (missing ones
offer to create the note) and backlinks. Links match note titles
case-insensitively, project first; `[[Title|alias]]` and `[[Title#heading]]`
work. Enter on a link, backlink, search hit or task opens or toggles it.

**Live preview.** The open note reloads within two seconds when its file
changes, including in gitignored or outside directories. The Preview button
opens a project note in `omd_preview` with `--watch`, which renders
`[[wiki links]]` as links and refreshes the page as the file changes.

**Writes.** Project notes change through `workspace.transaction` with the hash
of the text the view shows, so an edit made outside the view since it loaded
is refused and the note reloads instead of being overwritten. Personal notes are
written with a guard that the file still has that hash; they need write access
to the directory in your Codex permission profile, and otherwise stay
read-only. Renames rewrite links in up to 64 project notes in the same
transaction after a confirmation.

**Agent access** is off until `agent: true`. Then the model gets
`search`, `read` and `write` tools. `write` creates, replaces or appends to a
project note only after you accept a confirmation that shows the text; a
declined or unavailable prompt writes nothing. Notes stay separate from curated
memory.

`/note` also completes note names and subcommands as you type. The mod owns the
composer `completion` replacement for that and returns upstream ranking for `@`
mentions; another mod that owns `completion` cannot be enabled at the same time.

Capabilities: `commands`, `terminal`, `store`, `lifecycle`, `events` (the reload
timer), `exec` (`cat`, `grep`, `find`, `awk`, `tee`, `mkdir`), `fs.read`,
`fs.write`, `sessions` (responses), `tools` and `composer`.

Ported from [neoism](https://github.com/parkers0405/neoism)'s notes (Parker
Settle and the Neoism contributors, MIT; see `THIRD_PARTY_NOTICES.md`): vaults,
wiki links, backlinks, tags and tasks. This package reimplements that behavior
and copies no code; graphs, drawings and notebooks are not ported.
