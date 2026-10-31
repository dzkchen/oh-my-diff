# omd_continue

Resumes interrupted work in the current session with `/continue [note]`. It's off by default in OMD+. OMD Core
doesn't include it.

## Turn it on

Turn it on in `/mods`, or run:

```sh
omd-package mod enable omd_continue
```

[Manage mods](../../../docs/manage-mods.md) covers the other ways to turn a mod on or off.

## Use it

Type `/continue`, or add a note such as `/continue check the build`. It isn't `/resume` (which picks a session), and
it never runs on its own.

It submits one turn with this fixed instruction, then your note:

> Resume the interrupted task. First check the workspace, conversation and running processes to find the last
> completed step, partial edits and side effects. Continue from the first unfinished step without redoing or reverting
> finished work, then run the relevant verification.

After the note comes a short summary of the last turn (at most eight items per list):

- How it ended and why.
- Tool calls that were aborted or have no recorded result.
- Commands and processes still running.
- Files it changed.

A line is left out when the host didn't record that fact.

It submits nothing when:

- A turn is running. It refuses with a short message.
- The last turn completed, or no turn was recorded, and you added no note. It shows a short message instead.

## Settings

It has no settings.

## Needs and limits

- It works after an error, `Ctrl+C`, `codex resume` or a crash. After a crash the last turn shows as `interrupted`.
- Turns from before you turned the mod on have no summary.
- While the mod is on, the host records turn activity and checks the workspace around every tool call.
- It asks to add `/continue` and read the session's recorded turn activity. The capabilities are `commands` and
  `sessions` (see [Trust and permissions](../../../docs/trust-and-permissions.md#what-a-mod-can-do)).

## More

- [Included mods](../../../docs/collection.md)
- [Turn activity](../../reference/threads-and-sessions-store.md#turnsactivity) in the mod API reference
