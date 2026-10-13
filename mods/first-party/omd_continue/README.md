# `/continue`

`omd_continue` adds a user-typed `/continue [note]` command that resumes interrupted work in the current session. It is not `/resume` (session selection) and never runs on its own. It is active by default in OMD+ and can be installed explicitly in OMD Core. It needs `commands` and `sessions`, adds no model-visible tool and registers no event, so ordinary turns are unchanged.

The command submits one turn containing this fixed instruction, followed by your note:

> Resume the interrupted task. First check the workspace, conversation and running processes to find the last completed step, partial edits and side effects. Continue from the first unfinished step without redoing or reverting finished work, then run the relevant verification.

After the note comes a bounded summary read from the host's turn-activity ledger: how the last turn ended and why, tool calls that were aborted or have no recorded result, commands and managed processes the host reports as still running, and files changed in that turn (at most eight per list). A line is left out when the host did not record that fact. The mod never guesses.

- While a turn is running, the command refuses with a short note.
- When the last turn completed, or no turn was recorded, it shows a note and submits nothing, unless you add a note (`/continue check the build`).
- The ledger persists in the mod store, so it works after an error, a Ctrl-C, `codex resume` and a crash. After a crash the last turn shows as `interrupted`.
- The host records the ledger only while an enabled mod's source calls `turns.activity`, so turns from before this mod was enabled have no summary. While recording, the host's workspace observer stats the workspace around each tool call and rereads only files whose size, ctime or inode changed.

Changing the instruction needs a recorded reason.
