# omd_rewind

Undoes the agent's file changes. Each turn that changes a file becomes a checkpoint, and `/rewind N` puts every file
back as it was before turn N, undoing that turn and every later one. It covers edits made with `apply_patch`, with
other edit tools and with shell commands. It's experimental, and no install profile includes it.

## Turn it on

```sh
omd install omd_rewind
omd mods enable omd_rewind
```

It needs no authority grant.

## Use it

| Command | What it does |
| --- | --- |
| `/rewind` | Lists the checkpoints, newest first, with each turn's prompt and the files it changed |
| `/rewind N` | Puts the files back as they were before checkpoint `N` and removes `N` and later checkpoints |
| `/rewind N force` | Rewinds even over a file you changed after the agent, or with files it can't restore |

- A file the turn created is deleted, a file it deleted comes back, and any other file gets its content from before
  the turn, including uncommitted changes you had made.
- Without `force`, `/rewind N` changes nothing when a file differs from what the agent last left in it, so your own
  later edits aren't lost by accident. It lists the files instead.
- The conversation stays as it is. After a rewind, the composer has a note for the agent that names the undone
  files, so it reads them again before editing.
- A turn that changes no file leaves no checkpoint. Rewinding is refused while a turn runs.

## How it works

Before the first tool call of a turn, the mod backs up the repository's uncommitted and untracked files, plus the
files an edit tool names. An unchanged file reuses its earlier backup. The host then reports each file a tool call
changes, with its content hash before and after. A file that was committed and unchanged when the turn started is
restored from that turn's `HEAD` commit with `git show`.

## Needs and limits

- Shell edits to committed files need a Git repository. Outside one, only `apply_patch` and edit tools that name
  their files are covered. A file it can't restore is marked in `/rewind` and left as it is.
- Files ignored by Git aren't tracked, since the host doesn't report changes to them.
- It keeps the last 20 checkpoints of a thread, at most 80 files per checkpoint and at most 48 new backups per turn.
  Above these limits a checkpoint is marked incomplete.
- Only tool calls from the model are recorded, including calls inside code-mode cells. Edits you make yourself, and
  edits from other mods' commands, aren't.
- Checkpoints belong to the thread, so a resumed session keeps them.

## More

- [Workspace files](../../reference/workspace-files.md) in the mod API reference
