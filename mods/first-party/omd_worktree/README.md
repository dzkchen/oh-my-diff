# omd_worktree

Opt-in first-party mod (`0.1.0-preview.1`, API `0.2.0-experimental.5`) for
parallel agent tasks in Git worktrees. It extends upstream Codex `/worktree`,
which keeps its managed checkouts, rather than replacing it.

```text
/omd_worktree:new TASK [--base REF] [--branch NAME] [--issue ID] [--reuse]
/omd_worktree:list                 searchable roster (also the omd_worktree/roster site)
/omd_worktree:switch PATH|BRANCH   resume the latest session there, or start one
/omd_worktree:import PATH [TASK]   adopt a worktree created outside OMD
/omd_worktree:integrate PATH|BRANCH   review and merge into this checkout
/omd_worktree:archive PATH|BRANCH  remove a clean checkout, keep its branch
/omd_worktree:remove PATH|BRANCH   remove it, then optionally delete a merged branch
/omd_worktree:prune                forget worktrees deleted outside OMD
```

**Create.** The base is a local or remote branch or a commit (default: the
current branch). The branch is `branch_prefix` (default `omd/`) plus the issue
and a slug of the task unless `--branch` overrides it; a branch already checked
out elsewhere is reused only with `--reuse`. Checkouts go to `root` (default
`<repository>.worktrees/<branch>`). One confirmation previews the path, branch,
base and setup; then the mod runs `git worktree add`, applies setup and starts a
session in the new root, named after the task. Codex binds that session's
permission profile to the worktree root.

**Setup** is opt-in and path-scoped: `shared` lists repository-relative paths to
`symlink` or `clone` from the main checkout, for example
`[{"path": "node_modules", "mode": "symlink"}]`, and `copy` lists files such as
`.env`, copied only after a separate confirmation because they may hold secrets.
A failed setup step is reported and the worktree is kept.

**Integrate** runs from the destination checkout, which must have no
uncommitted tracked changes. It shows the task branch's commits, changed files
and diff, plus any uncommitted work in the task worktree (untracked files by
name); that work is committed there under the task name when you choose
**Commit and merge**, only if the worktree still matches the preview. The merge
runs only after rechecking that this checkout's HEAD and clean status (and,
without a commit step, the branch tip) still match. A conflict aborts the merge
and restores the checkout.
Merge commits use the repository's Git identity or exported `GIT_AUTHOR_*` and
`GIT_COMMITTER_*` variables.

**Cleanup** never forces: it refuses dirty, locked, current or busy checkouts,
keeps session history, keeps unmerged branches and deletes a merged branch only
after its own confirmation. The mod never stashes, resets or deletes
another session's work, and commits it only through **Commit and merge**.

**Permissions.** Codex protects `.git`, and checkouts live outside the
repository, so creation, integration and removal need a permission profile that
grants both; without it the mod prints this snippet and upstream `/worktree`
remains available:

```toml
default_permissions = "worktrees"

[permissions.worktrees]
extends = ":workspace"

[permissions.worktrees.filesystem.":workspace_roots"]
".git" = "write"

[permissions.worktrees.filesystem]
"/path/to/repository.worktrees" = "write"
```

Worktrees isolate files, not processes or credentials; they are not a security
sandbox. The `omd.worktrees` 1.0.0 service lists worktrees with their task and
issue for `omd_layout`.

Capabilities: `commands`, `terminal`, `lifecycle`, `store`, `exec` (`git`,
`mkdir`, `ln`, `cp`), `threads` (thread start and name), `sessions` (thread
list), `builtins` (resume) and `services`.
