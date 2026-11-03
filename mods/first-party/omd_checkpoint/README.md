# omd_checkpoint

Takes a snapshot of your files before and after each turn, so `/undo` can put back exactly what the agent changed in
the last turn and `/redo` can bring it back. It's experimental, and no install profile includes it.

```text
› /undo
• Undid the 14:02 UTC turn: Restored 3 files and deleted 1 file. /redo puts it back. Commits and branches are unchanged.
```

## Turn it on

```sh
omd install omd_checkpoint
omd mods enable omd_checkpoint
```

The first turn after that asks once whether the mod may run `git`.

## Use it

| Command | What it does |
| --- | --- |
| `/undo` | Puts back every file the last recorded turn changed: edited and deleted files get their old content, and files it created are deleted |
| `/undo force` | The same, even over edits you made after that turn; those edits are saved first, so `/redo` brings them back |
| `/redo` | Brings back what the last `/undo` removed |
| `/undo list` | The recorded turns, newest first, with the files each changed |

Run `/undo` again to step further back, one turn at a time. A new turn that changes files ends the chance to `/redo`
the turns you undid.

### What protects your work

- `/undo` only touches files the turn changed. If you've edited any of them since, it changes nothing, names those
  files and waits for `/undo force`.
- It never touches your staged changes, `HEAD`, branches or commits. If the agent committed during the turn, the
  commit stays and only the files go back.
- It refuses while a turn is running, and it checks that the session may write each file first.
- Untracked files count: a file you had but never committed is put back too.

## What it records

- At the start and end of each turn it stores the work tree as a Git commit, using its own index file in `.git`
  (`omd-checkpoint-THREAD.index`), so your staged changes are untouched.
- It keeps the last 10 turns that changed files, in one history per checkout shared by every Codex session there. Each
  is kept alive by a ref under `refs/omd/checkpoints/`, and older ones are removed. Once removed, `git gc` can delete
  their data.
- The history lives in `.git/omd/state/omd_checkpoint.json`.

## Needs and limits

- A Git repository and `git` on your `PATH`. Outside a repository nothing is recorded, and `/undo` says why.
- Ignored files aren't recorded, so changes to them (build output, `node_modules`) aren't undone.
- Submodules and nested repositories aren't undone.
- A turn's snapshot has a 3.5 s limit for `git add`. The first one in a large repository hashes every file and can
  take longer. When a snapshot fails, `/undo list` shows the reason and that turn isn't recorded.
- The `refs/omd/checkpoints/*` refs show up in `git log --all` and `git for-each-ref`, and `git push --mirror` would
  push them.
- It asks for `commands`, `lifecycle`, `inventory`, `store`, `exec`, `os` (for `git` only, without network),
  `fs.read` and `fs.write` (see [Trust and permissions](../../../docs/trust-and-permissions.md#what-a-mod-can-do)).
