# omd_worktree

Opt-in first-party mod (`0.1.0-preview.1`, API `0.2.0-experimental.5`) for
parallel agent tasks in Git worktrees. It extends upstream Codex `/worktree`,
which keeps its managed checkouts, rather than replacing it.

```text
/omd_worktree:task TASK [--base REF] [--branch NAME] [--issue ID] [--reuse]
/omd_worktree:list                 searchable roster (also the omd_worktree/roster site)
/omd_worktree:enter PATH|BRANCH    resume the latest session there, or start one
/omd_worktree:adopt PATH [TASK]    adopt a worktree created outside OMD
/omd_worktree:integrate PATH|BRANCH   review and merge into this checkout
/omd_worktree:park PATH|BRANCH     remove a clean checkout, keep its branch
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
and diff, plus any uncommitted work in the task worktree, including the full
content of up to eight new files (more must be committed there first; shared
setup paths are excluded even when already staged). **Commit and merge** commits
the captured tree under the task name only if the allowed files, real index and
branch tip still match. It holds Git's index lock across validation and commit,
preserves excluded staged entries, and merges the exact commit after rechecking
the destination HEAD and status. Captured-tree commits use `git commit-tree` and
do not run commit hooks. A conflict attempts merge abort and reports a recovery
failure if abort fails.
Dirty tracked or untracked content inside a submodule must be committed in
that submodule first. Preview and commit both enforce this; a clean changed
submodule commit can be captured as a gitlink.
Task names are kept in the mod's user-scope store, so every session sees them;
the roster, selection and preview belong to the session thread.
Merge commits use the repository's Git identity or exported `GIT_AUTHOR_*` and
`GIT_COMMITTER_*` variables.

**Cleanup** refuses dirty, locked, current or busy checkouts (shared setup
paths alone don't count as dirty and are removed with the checkout),
keeps session history, keeps unmerged branches and deletes a merged branch only
after its own confirmation. The mod never stashes, resets or deletes
another participating session's work, and commits it only through **Commit and merge**.
Removal requires a complete session inventory before and after confirmation.
Failed requests, malformed pages or inventories exceeding four pages of 100
sessions keep the checkout. A shared checkout lease excludes
other current-runtime sessions through removal; loaded idle sessions also hold
leases. Missing ownership information refuses removal. The confirmation requires
you to establish that older runtimes and other applications are not using the
checkout, because those applications do not participate in this lease protocol.

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
