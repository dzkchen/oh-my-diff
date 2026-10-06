# Review fixes — 2026-10-05

Base: `96cb4279eb4e7c151efcb50dd1e0a2aecf23250d`, preserving changes since reviewed `4893666`.
All fifteen findings were confirmed against current source. This is a bounded repair, not whole-project clearance.
The user approved generic admitted service-launch snapshots and shared checkout ownership leases.
No commits, deployments, live-provider calls, browser sessions, or PTY acceptance runs were performed.

## Finding → fix → regression

| # | Verdict | Fix | Regression evidence |
|---|---|---|---|
| 1 | Confirmed | Carry cancellation, deadline, admitted source/generation and thread/context epoch through queued requests; validate again at deferred effects and confirmation release. | Dropped receiver/upstream cancellation; thread A→B→A and cancelled confirmation; guard removal fails. |
| 2 | Confirmed | Launch admitted package bytes and verified dependency snapshots; redirect helper paths, confine dependency symlinks, bound capture, deny original roots. Cursor setup enrolls SDK closure digest. | Mutate originals after capture, preserve relative dependency links and executable files, reject escapes; reopening mutable originals fails. Package reload fixture checks unchanged-config fast path. |
| 3 | Confirmed | Finalize interception once before effective readiness and parallel/serial admission. | Two parallel-safe originals rewritten to serial tool never overlap; original-tool admission fails. |
| 4 | Confirmed | Capture exact reviewed tree; lock and validate real index, commit exact tree with ref CAS, preserve excluded staged entries, merge exact OID; refuse failed preview commands. | Prestaged shared setup remains uncommitted; preview/index and commit-boundary changes rejected; failed branch diff rejected. Original implementations fail these regressions. |
| 5 | Confirmed | Paginate activity, reject unavailable/incomplete inventory, hold shared checkout leases in sessions and require exclusive enrolled lease during removal. | Incomplete/paginated inventory, cross-process exclusion, release, rename identity. Disabled exclusive locking fails. |
| 6 | Confirmed | Validate owner/current binding on cache hits, key full authority/reference, clear caches on context changes. | Revoked cached document/image rows unavailable; removing validation fails. |
| 7 | Confirmed | Keep quota issuer as Codex account; do not attribute it to lead provider/credential; clear old-account samples. | Other-provider route quota unavailable and Codex issuer explicit; old attribution fails. |
| 8 | Confirmed | Immutable content-addressed bodies, one registry CAS publication, digest verification on restore and UTF-8 byte bounds. | Registry overflow retains old body/provenance; corrupted body rejected; multibyte bound enforced. Old publication fails. |
| 9 | Confirmed | Reconcile stale/disabled services across the shared runtime; await stop before replacement registration. | Old generations/disabled owners stop and release IDs/snapshots; other-session current service survives; disabled cleanup fails. |
| 10 | Confirmed | Registration-owned cancellation, bounded connections/forwards/credential lookups, header/body bounds, idle and total deadlines with streaming. | Real loopback sockets: revoke before headers/during body, immediate streaming flush, idle/total limits and saturation. Removing cancellation fails. |
| 11 | Confirmed | Remove expired queued commands, filter polling, isolate reply failures in JS/Python/Rust/Java adapters. | Expired queue is empty; failed expired reply does not discard later live command. Old host/client fail. |
| 12 | Confirmed | Stable separate lock, read-only status, fsynced atomic document replacement for mutation. | Status preserves bytes/inode/mtime; mutation replaces inode while old descriptor retains old bytes. Old status rewrites fail. |
| 13 | Confirmed | Recoverable update transaction journal, atomic manifest writes, startup reconciliation and exclusive updater lock. | Actual subprocess exit at both rename boundaries and manifest publication; next invocation recovers. Old updater fails all three; concurrent updater refused. |
| 14 | Confirmed | Bound header read itself by remaining capacity plus one. | Newline-free input consumes only 8,193 bytes including preceding headers; old read consumes entire oversized input. |
| 15 | Confirmed | Apply same-model suppression before every-turn filtering/evidence/spawn. | Default every-turn suppression and explicit opt-out; original branch fails. |

## Qualification

Checkout leases coordinate participating current runtimes, including loaded idle sessions. Older runtimes and external applications do not participate; removal confirmation explicitly requires checking those users. Unknown ownership or unavailable filesystem creation identity fails closed. Windows exclusive removal remains unavailable rather than assuming safety.

Service snapshots bind admitted package bytes and enrolled dependency bytes inside the existing service sandbox. This does not claim protection from unrestricted same-user OS writes outside that sandbox. Changed SDK dependencies require setup enrollment again.

Worktree integration uses `commit-tree` for exact reviewed content; Git commit hooks do not run. Shared setup changes already present in prior committed history are not rewritten. Browser recovery tests use disposable local bundles, not an installed browser update.

## Validation and handoff

Native scratch retained for merge: `/private/tmp/omd-bcf/codex`; target: `/private/tmp/omd-bcf/target`.
All cargo commands use `codex-omd`, `codex-omd-extension`, `codex-tui`, and `codex-core` together.
Focused logs are retained under `/private/tmp/omd-cf-*.log` and `/private/tmp/omd-bcf/logs/`.

- JavaScript focused tests: context 5, usage 6, advisor 1, JS bridge 1; worktree expanded to 7; Cursor 5 plus dedicated SDK setup rerun.
- Python browser bundle: 10 tests, including real process interruption and concurrent updater exclusion.
- Python bridge: queue/adapter compilation checks 2, reply-isolation regression 1.
- Final native effective-tool test passed (1); surface/cache tests passed (2); OMD consent/cancellation/lease tests passed (10); admitted-package unchanged-reload integration test passed (1). The Node fixture required normal local sandbox-launch permission. Gateway/snapshot/service/framing tests passed (10), including all seven gateway regressions. A macOS fixture race was corrected by explicitly clearing inherited nonblocking mode on accepted test sockets; the complete group then passed.
- Negative controls reproduced each original finding or removed its protection; all temporary weakened source was restored.
- `mods:check` passed (`/private/tmp/omd-cf-mods-check-verified.log`). The registry-verification step needed network access; signature checks were retained. Native clippy passed without `-D`; the only warning is the unchanged `core/src/compact_remote_v2.rs` argument count.
- Source synchronization passed first application, idempotent second application and parity across all 8,423 files (515 patch destinations). Replay evidence: `/private/tmp/omd-cf-evidence/replay.json`; selected patch SHA-256: `28c2566c0739f67a83313a57ff394b1f6b9d11653a7d155da3930174b9cdcc86`.

Distributable artifact builds and derived-lock regeneration are explicitly deferred by the user to worktree merge. Source synchronization updates the selected patch, manifest, runtime mirrors and the patch digest in `upstream.lock.json`; it does not run artifact or derived-lock generation. Keep this scratch tree until the merge has completed those steps.

Full nightly/project test suites, release builds, Windows/Linux native builds, production deployment, paid/live providers, installer acceptance, browser/PTY acceptance and the original review's remaining coverage gaps are not claimed closed. Main-only planning documents were read; no roadmap checkboxes were changed.

## Integrated into fixes/findings (uncommitted) — 2026-10-06

The fifteen fixes are integrated into `fixes/findings` at `3934bc9`, with destination repairs preserved, no commits or staging, and main unchanged. Patch replay and parity pass; all 58 focused native regressions, 127 JavaScript cases, 27 Python cases and 16 lock/conformance checks pass. Clippy, ownership, formatting, typecheck, rebuilt signed artifacts, SDK packaging, exact source/artifact locks and all-package offline host scenarios pass. The source worktree is closed after source-fidelity verification; scratch cleanup is recorded in [the integration audit](.docs/audits/merge-b6e0-20261006.md). Broader review/release gates remain open.
