# omd_continue

Resumes interrupted work in the current session with `/continue [note]`.

It isn't `/resume` (which picks a session), and it never runs on its own.

## Turn it on

It comes with OMD+ but starts off. Turn it on in `/mods`, or run:

```sh
omd mods enable omd_continue
```

OMD Core doesn't include it, but you can install it yourself.

## Use it

Type `/continue`, or add a note such as `/continue check the build`.

It submits one turn with this fixed instruction, then your note:

> Resume the interrupted task. First check the workspace, conversation and running processes to find the last completed step, partial edits and side effects. Continue from the first unfinished step without redoing or reverting finished work, then run the relevant verification.

After the note comes a short summary of the last turn (at most eight items per list):

- How it ended and why.
- Tool calls that were aborted or have no recorded result.
- Commands and processes still running.
- Files it changed.

A line is left out when the host didn't record that fact.

## When it does nothing

- A turn is running: it refuses with a short note.
- The last turn completed, or none was recorded: it shows a note and submits nothing, unless you add a note.

## Needs and limits

- It works after an error, `Ctrl-C`, `codex resume` or a crash. After a crash the last turn shows as `interrupted`.
- Turns from before you enabled the mod have no summary.
- While the mod is enabled, the host records turn activity and checks the workspace around every tool call.
- It needs the `commands` and `sessions` permissions.
