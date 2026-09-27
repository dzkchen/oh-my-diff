# Mod API reference

This reference is version-matched to `@oh-my-diff/mod-api` and host API
`0.1.0-experimental.9` on OMD `0.1.0` and Codex `0.157.0`. The package's
[`api.d.ts`](api.d.ts) is the complete typed surface. A store also generates
`active-host.d.ts` and `installed-contracts.d.ts`; those files identify the
running host and the exact service contracts available to consumers.

## Author commands

| Command | Result |
| --- | --- |
| `omd-mod-author create DIR ID` | Minimal typed package with pnpm scripts and offline tests |
| `omd-mod-author examples DIR` | Live routing, coordination, recovery, terminal, workflow, and stream-replacement mod examples |
| `pnpm check` | Strict TypeScript validation against this exact SDK |
| `pnpm test` | Engine-owned scenario execution with no provider requests |
| `pnpm run run` | Runs the same deterministic scenario and prints the full trace |
| `pnpm debug` | Runs an intentional failure and retains its mapped source location |
| `pnpm run package` | Produces a checked package directory, JavaScript debug build, source map, and digest report |
| `pnpm watch -- STORE` | Re-inspects unchanged capabilities, approves the edited digest, and queues reload |
| `omd-mod-author report STORE` | Declared-versus-used capabilities, services, operations, and environment |
| `omd-mod-author events STORE` | Composition order, scope precedence, events, replacements, and conflicts |
| `omd-mod-author diagnostics STORE OUTPUT` | Reproducible JSON bundle with paths, settings, environment, and credentials removed |
| `omd-mod-author explain DENIAL` | Cause, safe remedy, and the authority boundary for a denial |

The `omd-mod` binary is part of the OMD engine. Set `OMD_MOD_BIN` only when a
development build is not already on `PATH`; set `OMD_MOD_NODE` to the supported
Node 24.18.0 executable. pnpm is the package manager. The repository also
publishes equivalent `mise run mods:*` tasks without making pnpm a mise tool.

## Package commands

| Command | Result |
| --- | --- |
| `omd-mod package-plan STORE REQUEST_JSON` | Resolve and preview the exact graph, authority, settings, and activation changes |
| `omd-mod package-apply STORE REQUEST_JSON CONFIRMATION` | Re-resolve and atomically apply only the unchanged preview |
| `omd-mod package-lock STORE` | Print exact current versions, sources, integrity, trust, settings, and rollback history |
| `omd-mod selection-status STORE` | Show saved user/project selections, precedence, source errors, and setting keys without running mod code |
| `omd-mod package-enable STORE ID` | Re-enable an unchanged trusted package at the next turn boundary, retaining settings and state |
| `omd-mod package-disable STORE ID` | Disable a managed package without deleting source, state, or cache |
| `omd-mod plugin-preview CODEX_BIN CODEX_HOME NAME@MARKETPLACE CANDIDATE` | Compare a local plugin candidate and its skills/hooks against the installed cache without applying it |
| `omd-mod package-rollback-plan STORE ID` | Preview the prior integrity-addressed package version |
| `omd-mod package-rollback STORE ID CONFIRMATION` | Restore the prior cached package disabled, preserving explicit settings |
| `omd-mod package-uninstall-plan STORE ID` | Preview removal and reject installed dependents |
| `omd-mod package-uninstall STORE ID CONFIRMATION` | Remove the managed selection while retaining local source, state, cache, and history |

A package-index file is bounded JSON with schema 1:

```json
{
  "schema": 1,
  "packages": {
    "example": [
      {
        "version": "1.2.3",
        "source": {
          "kind": "repository",
          "repository": "https://example.invalid/example.git",
          "revision": "0123456789abcdef0123456789abcdef01234567",
          "subdirectory": "mod"
        },
        "integrity": "SHA256_FROM_OMD_MOD_INSPECT"
      }
    ]
  }
}
```

A managed package manifest must declare `license` and `provenance`; the
scaffold emits both with placeholders to change. Package rollback repoints the
selection at the immutable store cache, so returning to editable local
development is a fresh local install of the rolled-back source.

Resolution selects the highest exact/caret-compatible semantic version and then
checks the index integrity against the manifest, entrypoint, and every declared
lifecycle script. Each dependency needs its own exact trust entry. Index files
do not grant capabilities or script execution.

## Offline scenarios

A `mod.test.json` file uses schema 1. `virtual_time_ms` fixes `Date.now()` and
zero-argument `new Date()` inside every callback. `host_operations` supplies an
ordered result/error queue for each approved host operation. Any unmocked call
fails before external work, and every result records `paid_requests: 0`.
`settings` is a map from mod ID to that mod's explicit settings; the author
commands apply it through `omd-mod settings` before the run, so configured
behaviour is testable offline. A store-level `omd-mod test STORE SCENARIO` uses
the store's own settings instead.

A mod that fails to activate reports its retained cause, so a missing service
provider, denied capability or source error names itself instead of only asking
for a reload.

Steps can advance virtual time, invoke tools or commands, dispatch ordinary
events, model-request and response-stream middleware, tool outcomes and agent
lifecycle, reload at a safe boundary, mount a terminal view, and interact with
a mounted key or component ID. Component interaction activates buttons, inputs,
and selectors with an optional `value`; copy actions return without touching the
system clipboard. A step can carry `expect`, `expect_error`, or `cancelled`.
Additional trusted packages are listed in `packages`, enabling provider/consumer
and conflict fixtures without shared globals or ambient authority.

API `.8` adds `task_scoped: true` on `api.tool` and the `tool_exposure` event.
Before each sampling step, the event receives the host checkpoint, thread ID,
and only the current mod's optional tool names. It returns `{enable: [...]}`
for a subset of those names. A missing or failed decision exposes none of that
mod's optional tools; an invalid or foreign name disables the mod with a visible
error. Ordinary registered tools and every native tool keep their existing
exposure. The checkpoint is capped at 16 KiB; a larger record appears as `null`
and selects no checkpoint-dependent tools. A tool still executes through native
permission, cancellation, accounting, and workflow gates. Context contributors
can attach a bounded subordinate fragment for the same task without replacing
base instructions. In an offline scenario, `{"type":"tool_exposure", "payload":
{...checkpoint...}}` records the exact names registered for that step.

## Typed worker and workspace operations

`agents.spawn` accepts a host-authorized route and a `workspace` of `read_only`
or `isolated_worktree`. A writable child receives a captured, isolated worktree
under the native task scratch area; its parent repository is never its working
directory. `agents.wait` and `agents.result` return a host-attested thread
reference and SHA256 of the final text. A mod should validate that text against
its declared result schema and source-reference rules before calling
`agents.result` with `consume: true`. The host requires consumption before
`workspace.integrate` accepts that mod's private handle.
The typed-task mod reads the native checkpoint before spawning, passes its
bounded objective and revision into each worker prompt, and reports the
revision with the validated batch. It never marks acceptance criteria complete
on behalf of the parent.

`workspace.integrate` captures the worker's changed paths, merges against the
current parent snapshot, runs the task's configured executable check on an
isolated candidate, and obtains a candidate review before applying the exact
checked delta. It refuses conflicting parent edits, a changed candidate, a
failed check or review, or a changed parent before apply. The native ledger
owns allowance, permissions, lifecycle, and evidence. A failed apply retains
diagnostic evidence and may need operator inspection; external concurrent
writers are not locked. Cancellation, mod disable, and turn end retire owned
handles and clean their worktrees. Direct mode never loads this mod.

## Workspace reads, transactions, and write observation

The experimental `workspace` capability grants `workspace.read`,
`workspace.transaction`, `workspace.request_rename`, and the `workspace_write`
and `workspace_pre_rename` events. The host accepts only
the current canonical local repository and checks the effective read and write
permissions for every path. Reads return UTF-8 text and SHA256 for at most 128
repository-relative paths and 4 MiB. A transaction requires an exact
`expected` SHA256 or `null` for every affected path, plus bounded `writes` and
optional `{old,new}` renames. It rejects stale files, symlinks, `.git` paths,
overlapping moves, and changes outside the declared scope. Files are replaced
atomically one at a time, with a checked rollback after cancellation or a
failed multi-file operation; an external writer that changes a touched path
during rollback causes a visible conflict that needs inspection. This is not
a repository-wide filesystem transaction or a replacement for user approval.

`workspace.request_rename` captures the source and absent destination, invokes
selected `workspace_pre_rename` subscribers before the move, and accepts one
`{status:"ready",expected,writes}` proposal. No proposal, an unsupported
operation, or an unavailable server yields `{status:"fallback",reason}`.
Conflicting proposals fail visibly. The host checks all expected hashes and
effective write permissions, then applies the companion writes and move in one
checked transaction. A subscriber can read additional companion files before
returning its proposal. The [independent workspace example](examples/workspace)
demonstrates this path without using a language server.

`workspace_write` is delivered after an OMD tool call changes a source file,
with the tool call ID, path, and before/after hashes. Only a selected mod that
subscribes to the event triggers its index scan. The scan excludes `.git`,
`.omd`, `.docs`, package and Python caches, `target`, `node_modules`, `.venv`,
`venv`, `build`, and `dist`, and is
bounded to 20,000 files and 128 MiB. A failed scan reports `unavailable` rather
than claiming write coverage; more than 128 changed paths or 16 KiB of path
names also reports `unavailable`. The independent example also shows a direct
transaction for a mod tool. A change outside the thread's effective read
scope reports `unavailable` without exposing its path or hash.

The experimental `process` capability grants `process.which`, `process.start`,
`process.exchange`, `process.status`, and `process.stop`. The host resolves an
installed executable and its hash, verifies that identity at launch, and runs
it in a read-only repository sandbox with restricted network access and a
private scratch directory. The framed JSON exchange has bounded message size,
wait, output, and session count. Sessions belong to one mod and generation;
disable, reload, cancellation, and thread stop clean them up. A process cannot
write the repository through this API. The first-party `omd_lsp_sync` mod owns
the Python server choice and language protocol; it is installed inactive with
Full OMD and can also be installed explicitly in a platform-only store. It
never installs a language server. Absent or unsupported servers report fallback.
`api.host.tryCall` returns `{ok:true,value}` or `{ok:false,error}` for an
expected unavailable operation, so a mod can report fallback without treating
server absence as a callback failure. Both `call` and `tryCall` remain subject
to the same declared capability and host permission checks.

`process.start` accepts `transport: "stdio"` by default. Its only DAP
transport is `"stdio_dap"` for `python3 -m debugpy.adapter`. The host frames
DAP messages and allows the local loopback binding debugpy requires while
keeping external network access restricted. It owns process group termination
and starts adapters with a cleared host environment and an owner-only scratch
directory. The opt-in debugger package in `plugins/optional/omd-debugger`
exposes **Python launch only**; LLDB, Delve and attach are not supported. Its mod requires
separate review, trust, and enablement. Plugin installation does not activate
the mod or install Python or debugpy. The local on-demand marketplace is not
part of either release installation profile.

## Terminal identity, rich lines, picker and selection

Terminal views are drawn on Codex's alternate screen, including its default
fullscreen transcript; inline `--no-alt-screen` sessions keep only status
segments and commands. The `terminal` input carries a read-only `identity`
(`terminal_identity_v1`): `codex_version` from the installed build,
`install_profile` (`full`, `platform_only`, `private`, `unknown` or
`unreported`), effective `mode` (`enabled` or `platform`), and installed,
enabled and active mod counts. Upstream-style direct mode loads no mods.

`terminal_rich_line_v1` adds a one-row `line` component with up to 12 styled
`spans` (`text`, `tone`, `bold`; 256 characters in total), whose `label` is
the accessible text, and optional `min_width`/`max_width` (1–500 columns) on
`box`. Native draws a bounded box only when the site's inner width fits, and
header height counts only drawn boxes. Header rows are never spaced by the
comfortable density.

`terminal_picker_theme_v1` adds `theme.picker = {layout, brand?}`. `compact`
restyles only the native model and reasoning pickers; native keeps rows,
labels, warnings, keys, digit shortcuts, session actions and persistence, and
never restyles approval, permission, trust, elicitation or update prompts. A
missing, disabled or broken mod leaves the native picker.

`terminal_selection_v1` adds a view or patch `selection` policy
`{copy_on_release, sources, min_chars}` for released mouse drags in the
transcript, composer and transcript pager; one mod may set it. Native performs
the single fail-closed clipboard write. Without a valid policy, the existing
enabled/platform release copy stays. Subscribers to the observe-only
`selection` event receive `{source, chars, lines, copied, reason?}` after each
release, never the selected text; `reason` is `policy_off`, `too_short`,
`clipboard_unavailable` or `clipboard_failed`. Keyboard selection keeps native
copy keys.

## Git operations

The experimental `git` capability (`git_operations_v1`) grants `git.status`,
`git.log`, `git.diff`, `git.branches`, `git.switch_preview`, `git.stage`,
`git.unstage`, `git.commit`, `git.discard` and `git.switch` for the session repository in
enabled and platform modes. The host runs fixed `git` argument lists with
literal pathspecs, no pager, prompt, editor, external diff, text conversion or
filesystem monitor, a 10 s timeout (120 s for commit hooks), and bounded
output (500 status entries, 50 commits, 64 KiB diff, 100 branches). Paths must
be repository-relative, outside `.git` and host-protected OMD stores.

Reads run from lifecycle events and mod commands. Writes run only from
user-invoked mod commands and are refused when the session cannot write the
workspace. Writes require launching from the repository root and permission
for Git metadata as well as the affected files. Codex protects `.git` by default;
enabling the mod does not grant write access to it. A user-selected permission
profile must explicitly allow the repository's Git metadata before mutations
can run. Linked worktrees also require access to their shared Git directory.
Stage and unstage check every selected descendant; commits check staged paths
and rename sources; branch switches conservatively check both tracked trees.
Untracked directories are listed as individual files. Incomplete path listings
fail closed. Every Git subprocess, including lifecycle reads, hooks and
filters, uses Codex's macOS filesystem sandbox for the session's effective
permissions with networking disabled and protected OMD paths kept unwritable,
so a read cannot reach a file the session may not read. Timeout or cancellation terminates the process group,
including ordinary hook descendants. Every write takes a `fingerprint` returned by a read: stage,
unstage and discard compare the named paths (HEAD, porcelain record and
worktree size and modification time, captured before the diff is read);
commit compares the staged set; switch compares the fingerprint from
`git.switch_preview`, which binds the whole status, the branch name and its
destination commit and lists the paths that differ between `from` and `to`
(500 at most, with `local_changes` counting worktree entries). A mismatch fails with `stale_git_state`. Discard
restores only unstaged tracked changes and untracked files, refuses conflicts
and staged-only paths, and first copies each file (untracked files are moved)
to a timestamped backup in OMD state outside the repository (the platform mod
store or the enabled-mode evidence directory). Switch runs `git switch
--no-overwrite-ignore`, so Git refuses to overwrite local changes, including
ignored files the destination tracks; it never forces. Commit hooks run
as for a normal `git commit`. The first-party `omd_git` mod owns the sidebar,
previews and confirmations.

## Diagnostics and source maps

The engine transforms TypeScript with an inline source map and runs Node with
source maps enabled, so callback stacks resolve to the authored `index.ts` line.
Status retains a bounded per-mod log containing event, handler, generation,
outcome, and elapsed microseconds plus aggregate timing. It never adds mod-side
filesystem or process access.

The source-use report is derived from registrations and literal host/service
calls. It compares declared capabilities, service imports/exports, and admitted
environment access with what the source uses; undeclared use is rejected and
unused grants are reported. Diagnostics explain how to narrow or explicitly
approve authority, but tooling cannot grant permissions by itself.

## Composition and safety

The mod runtime is single-threaded and never runs re-entrantly. Request and
stream hooks wait up to 2 s while another request or stream hook holds the
runtime. When a non-hook callback holds it, such as a tool waiting for the agent
it spawned, a mod-spawned agent's request and every response stream proceed at
once without hooks; other requests wait up to 2 s first. Each skip is recorded as
`middleware_skipped` with the hook and reason, and a skipped or unsubscribed
stream runs without stream hooks for the rest of that response. The middleware
log records only selections, transformations and fallbacks, and stops growing
at 8 MiB.

`hook_budget_ms` bounds each JavaScript evaluation, not their sum. A callback
that makes host calls is replayed once per call, so the host re-runs the module
and that replay cost is the host's, not the mod's. The callback as a whole,
including every replay, is bounded by a separate 5 s host total; exceeding
either bound fails the callback with `callback_execution_budget`.

Dependencies run before consumers and remaining mods use lexical ID order.
Project scope shadows user scope without inheriting its state or grants.
Observers compose in that order; exclusive replacements, contract IDs, service
providers, and namespaced tools fail closed when contested. Native permissions,
credentials, accounting, cancellation, evidence, workflow enforcement, and
provider authorization remain outside the mod API.


## Shared data and review interfaces (.9)

Feature scheduling, prompts, result interpretation, anchor resolution, resource grammar, curation, and reports belong to extension code. The host checks capabilities, provenance, scope, current permissions, cancellation, and allowance. All interfaces are opt-in; a loaded library is not an active extension.

| Interface | Required capabilities/features | Authority and limits |
| --- | --- | --- |
| `turn_end.evidence`, `evidence.read` | `lifecycle`, `turn_evidence`; `turn_evidence_v1` | Full controlled-task host captures visible messages and tool references only for selected subscribers. No hidden reasoning or tool-output bodies. A descriptor binds extension, repository, thread, persisted selection revision, extension source hash, and digest; pages are 16 KiB, snapshots at most 256 KiB. Unavailable/reset history has no descriptor. Aborted turns never become completed evidence. |
| `review.request/result/wait/submit/cancel` | `review`; `accounted_review_v1` | Extension supplies a prompt and interprets the returned text. Native workers retain admission/accounting, independent context, read-only permissions, cancellation and cleanup. Submission requires an owned completed worker, exact result hash and unchanged candidate. Advice and warnings enter a bounded advisory lane of the ledger (at most `max_findings_per_cycle`, deduplicated by fingerprint) that never consumes enforced review cycles or open-finding budget and expires when the candidate changes. Blocking findings become an enforced ledger cycle. Review workers survive the next turn start and are cancelled when that turn ends; session shutdown can interrupt one that is still running. Blocking requires the host's explicit `review.extension_blocking` setting; every-turn requests also require `review.every_turn_advice`. |
| `workers.presets` and `agents.spawn.tools` | `agents`; `worker_presets_v1` | Lists only the caller's configured presets. Named presets require an exact repository/model/provider/URL grant, rechecked on every request. Subscription presets use `subscription_authorization`, `included_subscription: true` rates, zero monetary reservation and the native ChatGPT login at `https://chatgpt.com/backend-api/codex/responses` without provider overrides. Paid presets instead require `paid_authorization`, `paid_api_key: true` and nonzero reservation. Mixed declarations and route changes fail closed; model access still requires live qualification. Requests may only narrow a preset's tool ceiling. That ceiling is the set allowed under a read-only sandbox: `read`, `grep_files`, `list_dir`, `web`/`web_search` and the shell tools `shell`, `shell_command`, `exec_command` and `write_stdin`. The read-only sandbox, not the tool list, prevents writes. No model names, paid fallback or research trigger are selected by the host. Unpriced hosted search/tool declarations remain denied. |
| `api.virtualRead` and agent `read` | `virtual_reads`; `virtual_reads_v1` | One provider per nonreserved scheme. The common tool accepts exactly one local path or virtual URI and distinguishes its origin. Local reads preserve file permissions. Virtual responses preserve canonical identity, revision, cursor, anchors, provider/version and host text hash, and are marked untrusted. Continuation requires the expected revision. Text pages are at most 16 KiB. |
| `sidecars.invoke` | `sidecars`; `service_requests_v1` | Full host only. Requires a host-approved request-capable executable, executable hash, pinned source hashes and separate network/credential grants. Sends bounded JSON to a sandboxed read-only executable; accepts bounded JSON output. Virtual handlers may call only this operation or `workspace.read`, never transactions or worker operations. The plugin owns transport-specific behavior. |
| `knowledge.*`, `context.freeze/deliver` | `knowledge_read`/`knowledge_write`, plus `context` for context operations; `scoped_data_v1` | Host chooses the store and repository. Source facts retain exact anchors and refresh against current readable files. Secret screening covers the anchored lines only; `knowledge.inspect` reports a stale, denied or secret-bearing fact as `invalidated` instead of failing the call. Proposed lessons require a native user action before reuse. Frozen selections never expand during a task; source changes, deletion/reset and revoked permissions invalidate delivery. Workers cannot load another thread's handles. |
| `sessions.list/read` | `sessions_read`; `scoped_data_v1` | Exact repository and per-turn cwd, opt-out, visible local messages only. No raw file paths, hidden reasoning, tool bodies or inherited-history reconstruction. Listing is capped at 100 rows, each text page at 16 KiB. A scan reads each file's first line to select the repository and date range, then fully reads matching sessions newest first; it is capped at 4,096 directory entries and 128 MiB of matching sessions, and a capped scan only marks the list `scan_truncated`. Each summary carries an opaque `handle`; `sessions.read` requires it and opens only that session file, reporting `projection_truncated` when records exceed the projection. Paginated continuation files of one session are listed as separate rows with their own handles; files repeating the same ID and history base are rejected as ambiguous. The host reads the state database with an ordinary query-only SQLite connection, which may create its `-wal`/`-shm` files. Results disclose inaccessible files, truncation and incomplete final records. Pagination rejects revision drift and duplicate IDs. |
| `api.command(..., {cli})`, `omd COMMAND --repo PATH` | `commands`; `plugin_dispatch_v1` | Generic dispatch to exactly one enabled extension export. The CLI has scoped data operations but no model or process authority. Plugin components reuse ordinary mod trust, grants, sandbox, versioning and disable/recovery. |

A service grant with `network: true` gives its sidecar or provider process unrestricted outbound network access even when the session's network is restricted; services without it inherit the session network policy. Its `read_paths` (at most 16) are the only reads added to the service sandbox. The first-party Claude CLI grant adds the Claude CLI and Node installations, `~/.claude`, `~/.claude.json`, `~/Library/Keychains` for the CLI login and the macOS system library paths its runtime loads. Network and keychain access are explicit host-approved grants, not defaults for other workers, checks or integrations.

Resources use private immutable files, digest verification, owner/thread/source/selection-revision checks, and a 64 MiB/1,024-entry store ceiling. Secret-pattern redaction is conservative; it is not a claim that arbitrary prose can be perfectly classified as secret. Known secret files remain subject to native read denial. A cancelled or denied call cannot be treated as evidence that an action completed.

`workspace.read` and `workspace.transaction` remain the edit interface. Transactions verify all expected hashes/absence before writing and provide checked rollback; replacement is atomic per file, not process-crash atomic across files. Extensions must surface rollback conflicts and preserve ordinary diff review.

## Plugin components and shell commands

A plugin can contain `.codex-plugin/omd.json` with `{"schema":1,"component":"component","sha256":"<inspected package digest>"}`. The contained directory is an ordinary public-API package with `mod.json` and `index.ts`. Inspect it with `omd-mod plugin-component PLUGIN_ROOT`; the inspector rejects traversal, symlinks and digest changes. Trust and enable the inspected component through the existing mod-store workflow. The descriptor does not activate it.

`omd COMMAND --repo PATH --store STORE [--home CODEX_HOME]` dispatches an exported CLI alias. A standalone explicit memory approval/removal/reset additionally requires the host's current operation confirmation token using `--confirm`; extension callbacks cannot supply user-action authority. The host store must be protected from agent process writes. Ambiguous command ownership fails closed.

Independent examples live in [`examples/virtual_reader`](examples/virtual_reader), [`examples/scoped_data`](examples/scoped_data), [`examples/review_probe`](examples/review_probe), and the existing [`examples/workspace`](examples/workspace). Their fixture tests demonstrate shared interfaces; they are not production advisor, GitHub, memory, edit-anchor or report implementations, and they do not establish live model usefulness or release qualification.

Completed-turn packets retain bounded original visible records across a host-observed compaction, tagging each segment's records with its history revision. Compaction summaries do not replace those records. An unobserved history reset or interrupted compaction still rejects evidence explicitly. The extension decides how to select and summarize a truncated packet.

Live session reads use the runtime's configured state database, including a separate SQLite home. Standalone commands resolve the selected user configuration/profile and `CODEX_SQLITE_HOME`; `--sqlite-home` explicitly selects the state directory. If a repository or system configuration redirects SQLite, standalone dispatch requires that explicit directory rather than guessing. Relative SQLite directories are rejected. The pinned reader consults `state_5.sqlite` read-only before and after a read, and does not modify transcripts or opt-out state.

Granted request helpers use the host's bounded request supervisor. It captures a completed helper result before returning it, then terminates the process group; cancellation, deadline and loss of the host also terminate the group. Existing long-running service supervision remains separate. The helper, supplied by the extension, owns request parsing, remote protocols and content selection.
