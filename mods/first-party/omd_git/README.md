# omd_git

Opt-in Git sidebar: branch, a short commit graph, changed files and confirmed
actions. Every write runs real `git` with guards that refuse a changed status,
HEAD, index or file, and discards keep a backup outside the repository.

The sidebar shows the Changes panel open and folds the commit graph and the
file, commit and branch Actions; Tab reaches a panel title and Enter (or a
click) unfolds it. Its panels follow the session status of `omd_workspace`.

```text
/omd_git:changes               branch and changed files
/omd_git:log                   recent commits
/omd_git:show [PATH|staged]    a file's diff, or the staged diff of a commit preview
/omd_git:act stage|unstage|discard [PATH]
/omd_git:message TEXT          set the commit message
/omd_git:commit                preview the staged commit; Confirm commits
/omd_git:checkout              preview switching to the selected branch
/omd_git:restore               restore the last discarded file
/omd_git:refresh               reload the sidebar (Alt+g)
```

Settings: `side`, `width`, `icons`, `commits`. Capabilities: `commands`, `exec`,
`fs.read`, `fs.write`, `store`, `lifecycle`, `terminal`.
