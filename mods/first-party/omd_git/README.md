# omd_git

Opt-in Git sidebar: branch, a short commit graph, changed files and confirmed
actions. Every write runs real `git` with guards that refuse a changed status,
HEAD, index or file, and discards keep a backup outside the repository.
Tracked-file recovery requires the anticipated index content after Git's worktree
filters, computed before discard. Intervening edits or changed filter output make
recovery refuse the write; the backup remains available. Node streams the filtered
index content into SHA-256, so file size does not consume the Git preview limit.
Discard is refused if the filter or fingerprint command fails.

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
/omd_git:github watch [OWNER/REPO#N | PR URL | #N]
/omd_git:github unwatch [KEY]
/omd_git:github token [remove] add or remove the read-only GitHub token
/omd_git:pr [KEY]              pull request details, or every watch
```

## GitHub pull request and CI status

Read-only remote monitoring for up to 5 explicitly watched pull requests on
github.com. `watch` without an argument finds the open pull request whose head
repository is the current branch's push remote (`branch.<name>.pushRemote`,
`remote.pushDefault`, then its upstream remote), including a fork's pull
request into its parent; `#N` uses the `upstream` or `origin` remote. The
GitHub pane lists each watch; Enter on a row opens its details. `unwatch`
without a key stops the watch whose details are open, or the only watch; keys
match case-insensitively.

Each watch is bound to the repository owner and name, the pull request number
and its current head SHA. One GraphQL query reads the state, draft flag, merge
state, review decision and every status check of the head commit with
`isRequired`, paged 50 at a time; a head change while paging restarts on the
new head. Workflow runs named by those checks are then fetched by run ID over
REST, kept only when their `head_sha` matches, with their run attempt; a run
whose checks become pending again is re-fetched, so a superseded attempt is
not reported. Each poll reads up to about 58 KB and continues a second later
until every page and run is loaded; until then the watch is labelled
incomplete and never shown as passing. More than 20 runs are counted in the
checks but not listed. A merge state of BLOCKED is shown next to the checks,
since a required check that never reported is not in the rollup.

Polling runs only while an open watch exists: every 30 s while a check or run
is in progress or the merge state is unknown, every 5 minutes otherwise, and 10
s after each turn for watches older than 30 s that are not backing off from an
error. Errors back off exponentially to
15 minutes, `Retry-After` and exhausted rate limits pause every request, and a
denied or missing pull request retries after 15 minutes. A merged or closed
pull request stops polling. A missing, rejected or removed token stops polling
until `/omd_git:github token` adds one, or asks again for an empty or rejected
one. Results show the GitHub response time;
cached, failed or token-less results are labelled stale or unknown.

The token is a secret owned by this package and bound to
`https://api.github.com`; the host attaches it and the mod never reads it. Use
a fine-grained token with read-only Metadata, Pull requests, Checks, Actions
and Commit statuses access; GitHub does not report a fine-grained token's
permissions, so the read-only scope is the user's choice. The package only
sends GET requests and GraphQL queries; it never merges, pushes, comments,
reviews or re-runs CI. With `notices` on, a watch that settles to passing or
failing, merges, closes or gets a new review decision sends a terminal
notification; the first load does not.

Ported behavior: watches, merge and review state and required-check buckets
from [cc-pr-tracker](https://github.com/sezaakgun/cc-pr-tracker) (Seza Akgün,
MIT), and adaptive CI polling from
[gh-ci-status](https://github.com/diegorv/claude-functions-hook/tree/11e1d052427e1bb9d38668d4779f343b0693c2b5/plugins/gh-ci-status)
(Diego R. v., no license found); see `THIRD_PARTY_NOTICES.md`. Both are
reimplemented over the OMD mod API; no code is copied.

Settings: `side`, `width`, `icons`, `commits`, `notices`. Capabilities:
`commands`, `exec`, `fs.read`, `fs.write`, `store`, `lifecycle`, `terminal`,
`events`, `credentials`, `http` (`https://api.github.com` with the package's
own secret).
