# omd_editor

Opt-in first-party mod (`0.1.0-preview.1`, API `0.2.0-experimental.5`): a
built-in editor for workspace files. It edits text in buffers inside the
terminal through the public focused-component input (`document` with
`keys: true`) and saves only through hash-checked `workspace.transaction`
writes, so it never saves over a change made by an agent, another session or
another program after the buffer was read.

```text
/edit PATH[:LINE]               open a buffer (up to eight); LINE is the saved file's
/edit                           show or hide the editor
/edit save | close [save|discard|cancel] | reload | keep | review | overwrite
/edit undo | redo | find TEXT | next | line N | insert | buffer N | refresh
/edit pane | hide               pane site or popup; hide keeps the buffers
```

Alt+u focuses the buffer; Ctrl+] (Ctrl+5 where the terminal sends it so) or
Ctrl+C leaves it. The popup is modal: outside the buffer, Tab, arrows and Enter
act on its rows (Editor actions first, so hide is two Ups away), and slash
commands go through once it is hidden; the pane site is not modal. While
focused:

| Key | Action |
| --- | --- |
| text, paste, Enter, Tab, Backspace, Delete | edit (Enter keeps indentation, Tab inserts the file's indent) |
| arrows, Home/End, PageUp/PageDown, Ctrl+Home/End | move; with Shift, select |
| Ctrl+a | select all |
| Ctrl+s | save |
| Ctrl+u / Ctrl+y | undo / redo (Ctrl+Z stays the terminal's suspend key) |
| Ctrl+f, then type; Enter next, Esc done | find (smart case); Ctrl+g finds the next match |
| Ctrl+e | insert the selected lines (or the cursor line) into the composer as `path:lines` with the text |
| Esc | clear the selection |

The buffer shows line numbers, syntax colors for common languages (block
comments, Python triple-quoted strings and multi-line template literals carry
across lines), the cursor and selection, find matches and Git gutter markers against `HEAD`: `+` added,
`~` modified and `-` lines deleted above. The status line shows `●` for unsaved
changes, the cursor, LF or CRLF, a missing final newline and the marker
counts; the status row shows unsaved buffers while the editor is hidden.
Markers fill in right after a buffer opens and refresh when `HEAD` changes at
the end of a turn, on `/edit refresh` and after a restart.

**Saving and conflicts.** A save sends the buffer with the hash it was read
with. If the file changed on disk, the save is refused and the buffer is
marked: reload from disk, keep your buffer, or review the file on disk against
your buffer and overwrite after a confirmation, which again fails if the file
changes after the review. Agent edits, other sessions and watched external
writes reload a clean buffer and mark a dirty one. A refused or failed write
leaves the buffer dirty with the reason. Closing a dirty buffer asks to save,
discard or keep editing. Line endings and the final-newline state are kept;
files with mixed line endings, binary files and files over 100 KB are refused.

**Recovery.** Buffers, undo history and the cursor live in thread-scoped mod
state (`state_scope: "thread"`): each session has its own buffers, which
survive a crash, a reload or a restart, fork with the session and are removed
with it. Only the active buffer's text is kept in that state: switching away
from a buffer parks it, a clean one is read again from disk when it comes
back, and an unsaved one is kept in the session's thread store
(`store.put {scope: 'thread'}`) until then. On start or resume the editor rechecks every buffer against the disk,
reloads clean ones that changed, marks dirty ones and names the recovered
unsaved buffers.

**Composition.** `/pane split right site omd_editor/editor` in `omd_panes`
places the editor in a pane after `/edit pane`; otherwise it opens as a popup,
which is also the fallback for inline sessions and terminals too small for
panes. With the `git` setting a Git row stages or unstages the file through
`omd_git`; with the `lsp` setting a buffer offers definition, references,
hover, code actions, symbols, diagnostics and formatting through
`omd_lsp_view` and the servers `omd_lsp_sync` already runs, so there is no
second language server. The servers read the saved file: in a buffer with
unsaved edits the cursor is mapped to its line in the saved file, so
definition, references and hover work on every line not edited since the
save, and symbols and diagnostics describe the saved file; formatting and code
actions write the file, so they wait for a save, after which a clean buffer
reloads. Edit here on an `omd_lsp_view` location opens it in a buffer, on the
same line after your unsaved edits.

**Bounds.** A file opens up to 100 KB, and the active buffer with every
buffer's undo history stays within 100 KB of state, so that a callback result
carrying the buffer and a save stays within the host's 256 KiB limit; the
oldest undo steps are dropped first and an edit that cannot fit is refused.
Parking a large unsaved buffer and loading another large file in one step
would exceed a callback's 128 KiB of host results, so the second file loads in
the follow-up callback ("Opening PATH…"). The view draws the 200 lines around
the cursor and 400 characters per line around the cursor column. Each session
has its own buffers; two sessions editing one file are protected by the
hash-checked saves.

Capabilities: `commands`, `terminal`, `store` (parked unsaved buffers),
`lifecycle`, `events` (the watch, loading and Git-marker hop), `exec` (`git` reads), `fs.read`, `fs.write` and
`composer`.

No editor code was ported. The Tern reference named in the roadmap is still
unidentified, so nothing is attributed to it.
