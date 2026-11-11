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
| `/undo show` | Previews what `/undo` would do: each file with the lines the turn added and removed, which files it created or deleted, and which you've edited since. It changes nothing, and works while a turn runs |
| `/redo` | Brings back what the last `/undo` removed |
| `/undo list` | The recorded turns, newest first, with the files each changed |

Run `/undo` again to step further back, one turn at a time. `/redo` brings back the most recently undone turn, even
after later turns, as long as the files it touches haven't changed since.

### What protects your work

- `/undo` only touches files the turn changed. If you've edited any of them since, it changes nothing, names those
  files and waits for `/undo force`.
- It never touches your staged changes, `HEAD`, branches or commits. If the agent committed during the turn, the
  commit stays and only the files go back.
- It refuses while a turn is running, and it checks that the session may write each file first. A turn still marked
  running after 3 hours (for example after a crash) no longer blocks it.
- If the turn replaced a file with a directory and that directory now holds anything else, even ignored files, it
  refuses even with `force`, because putting the file back would delete them.
- If an undo stops partway (a permission or Git error), run `/undo` again: files already put back count as done, and
  `/redo` still brings back the files as they were before the first attempt.
- Untracked files count: a file you had but never committed is put back too. Tracked files are also restored even
  when they match a `.gitignore` pattern.

## What it records

- At the start and end of each turn it stores the work tree as a Git commit, using its own index file in `.git`
  (`omd-checkpoint-0.index` to `-3.index`, at most four per checkout, used in turn so concurrent sessions don't
  collide), so your staged changes are untouched. The first turn in a checkout removes
  `omd-checkpoint-*.index` files left by earlier versions.
- It keeps the last 10 turns that changed files, in one history per checkout shared by every Codex session there. Each
  is kept alive by a ref under `refs/omd/checkpoints/<checkout>/`, one namespace per checkout so linked worktrees
  keep each other's refs, and older ones are removed. Once removed, `git gc` can delete their data.
- The history lives in `.git/omd/state/omd_checkpoint.json`.

## Needs and limits

- A Git repository and `git` on your `PATH`. Outside a repository nothing is recorded, and `/undo` says why.
- Ignored files aren't recorded, so changes to them (build output, `node_modules`) aren't undone.
- Submodules and nested repositories aren't undone.
- The first snapshot in a large repository hashes every file, so the first turn can start a few seconds later. Later
  snapshots reuse that work. A snapshot that takes more than 20 s is stopped, `/undo list` shows the reason and that
  turn isn't recorded.
- The `refs/omd/checkpoints/*` refs show up in `git log --all` and `git for-each-ref`, and `git push --mirror` would
  push them.
- It asks for `commands`, `lifecycle`, `inventory`, `store`, `exec`, `os` (for `git` only, without network),
  `fs.read` and `fs.write` (see [Trust and permissions](../../../docs/trust-and-permissions.md#what-a-mod-can-do)).
