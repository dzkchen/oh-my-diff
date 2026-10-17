# Changelog

Generated from [`changelog.json`](changelog.json) by `mise run release`; the Oh My Diff site and GitHub Releases use the same entries. Entries before the first release are daily development notes.

## [1.0.0-rc.1](https://github.com/dzkchen/oh-my-diff/releases/tag/v1.0.0-rc.1) — 2026-10-17

Release candidate for Oh My Diff 1.0.0, the first public beta.

### New

- Managed mod policy, deployment sync, typed tools, author testing
- Integrate author deployment, host fixes and release artifacts
- Add tool-lines mod, tool_call rows and warm render runner
- Composer key interception, token completion rows, mention reads
- Multi-file mod packages, live continuations, component modules
- Raw process streams, 48 KiB render text, test-kit state
- Persisted history interception, session tool records, cache marks
- Plan panel, continue, terminal view memoization and cached package listing
- Native Claude subscription status, billing routes and CLI 2.1.296
- Burn_meter, token_weather and blast_radius ports
- Published mod index entries and preview thumbnail strip
- Omd_statusline mod, below-composer site and native status-row control
- Idle compaction before prompt cache expiry
- Auto-continue for unanswered approvals and questions
- Codex 0.163.0 pin, omd-mod schema validation, thread-bound component events
- Release workflow, signed releases and launch docs (#27)

### Changed

- Cut the repository to the launch collection
- Run the terminal acceptance harnesses on the 0.161.0 empty state
- Return the app-server time provider directly
- Pin to codex 0.162.0
- 4 -> 1 🥹
- Code review fixes
- Code review fixes (clippy artifcts arent run)
- UI changes
- Create SECURITY.md for security policy
- Freeze launch API prims + reconcile surface coverage
- More fixes
- Update to codex v0.162.1
- Reuse identity-verified package digests in packages.list and warm them after mods-ready
- Spare runner context and deadline-driven paste flush
- Add raw frame transport and improve raster scheduling
- Frame transport finalized + fixes
- JIT raw frame acks + stale layout handles
- Cleaning up some stuff
- Not sure what this is
- .
- Drop backdrops and glass; narrower package listing
- Shared script helpers, one evidence resolver, module invocation
- Maintainer references, launch-cut inventory and stage narration removal
- Author examples row, client Node range, model.complete route doc
- Internal WebSocket framing helpers, reload-only client recovery type
- First-party scope and no fixture narration in mods README
- Plain names for release tooling, locks and products
- One first-party mod lock for every bundled package
- Plain feature labels in conformance and reference
- Example-owned author scenarios and one example list
- First-party READMEs without version strings
- Mod reference and compatibility without API history
- Environment.read value limit and discovery guidance
- Shared clock, UTF-8 cut and lock helpers; CLI and mod cleanups
- Native accounts fields, private dirs, session caches
- Prune comments
- Lean warm-runner requests, runner-side intrinsics freeze, review repairs

### Fixed

- Launch cut config + acceptance checks
- Launch cut acceptance checks, uninstall compatibility and docs
- Managed policy fails closed + review fixes
- Managed policy enforcement, provenance and host regressions
- Align installer pin and confirm attachment owner lookup
- 4.5 early review fixes across host, mods, SDK and installer
- Fixes
- Mod author scaffolding and reload workflows
- Launch mod recovery, profile switching and preview watches
- Preserve managed watch scopes and prune evicted local snapshots
- Per-package runner reuse, cancellation and UI-state invalidation
- Fix mouse-look motion capture and release handling
- Fix raw frame transport review findings
- Raw frame retry, hidden raster backoff, shared ack timer
- Esc closes mod completion popups on first press
- Composer key budget, mention budget and completion edge cases
- Component runner ownership, sleep refusal, client module sizing
- Process exit drain, null stdin, live output cleanup, render caches
- Cache-mark routing, ordered rollout appends, redaction boundaries
- Review findings for history, process streams and modules
- Clock-aware view reuse, live codex_config, opt-in /continue
- Claude route extra usage, billing reruns and error mapping
- Composer completion and mention handling
- Ownership scans and test evidence gates
- Enforce typed mod mocks and expand source validation
- Preserve UI state and module lifetimes
- Runtime authority and resource lifecycle
- Native ownership and runtime authority contracts
- Runtime validation and release integrity
- Reconcile lifecycle contracts with main
- Mod persistence and SDK efficiency
- Integrate runtime ownership fixes
- Integrate UI lifecycle with authority checks
- Receipt budgets, stale LSP answers and safe preview output
- Preview truncation notice, watch retries and frecency receipt budget
- Host state, credential, fork and package lifecycle hardening
- Module unmount race, fork precheck and shared helpers
- Port walkthrough fixes for /burn, token usage and prompt text
- Closer upstream parity for the Claude Code ports
- Blast_radius measurement, UI state reload writes, published index checks and preview strip hints
- Resumable uninstall, provider limits and tool-call validation
- Uninstall recovery, chat output limits, text-only profiles
- Installer profile prompt without a stale mod list
- Status line review fixes, per-project built-ins, theme warm-up
- Status line startup write without a thread
- Status line refresh timing, editor reset, built-ins lookup
- Transactional reloads, host-call stacks, prompt lines, test baselines
- Request policy exposure text, status reason, grant phrases
- Mod TUI helper duplication and duplicated patch pin fields
- TUI test fixtures and hook render reuse
- Shared install-profile selector, restored debug popup test
- In-realm mod TextEncoder, session.info reads and leftover removals
- Shared worker teardown, gate helpers, opt-in per-call host work
- No footer status prefix in upstream-direct mode
- Thread and checkout state migration on state_version changes
- Offline timer thread binding, pylsp harness wait, redundant tests
- Mod callback authority caching, preview preservation, runner encoder hardening
- Preview progress, migrate-handler preview flag, callback config cache, encoder prefix
- Mod realm containment, thread-scoped routes, config redaction and own-command keybindings
- Session cache eviction, shared private path helper
- Derive native-ownership vocabulary from first-party packages
- Treat auto, compact and idle as host words
- Reset pending requests on a new session instead of by wall clock
- Share offline timers across threads for mods without thread state
- Post-merge review repairs, runner memory watchdog, thread-scoped mods; Repairs from three reviews of the merged candidate: config reads keep env var names and writes refuse redacted values; the broker binds stores and evidence streams to their owner; a runner memory watchdog (512 MiB); the source scanner matches at identifier boundaries; offline scenarios validate terminal patches like the host; classic hooks answer only PermissionRequest; the runner clock covers Date() and Intl; boundary fixes for receipts and request lines; an interceptor ordering cycle disables only its declarers; refused receipts write no evidence. TUI: fail-closed command targets, modal dialogs, host diagnostics never clipped, cached attachment resources, completions that keep warm runners, and upstream behaviour in direct mode. Mods: advisor and lsp_sync state per thread, bounded lsp_sync resync with large-file and non-UTF-8 handling, statusline spans, plan panel, idle compaction retries, SDK reconnect. Docs and harness updated; release lock regenerated.
- TUI startup preview, bounded event queues, profiling removal
- Idle watchdog kills of stateful runners, dialog button hotkeys
- Mod prompt wrapping, ASCII glyphs, pane scroll, status, nesting
- Installer asset URL and SHA-256 required as a pair
- Host-check surface lists, Node flag and mod toggle reopen
- TUI per-frame path and document I/O, approval-gate docs
- Private store files, owner-only component events, shared redaction
- Sealed provider port hand-off nonce
- Repository-safe unrestricted programs, protected runner, MCP approval gate
- Installer channels, release lookup and nightly validation
- Nightly lock format, action pin, clippy gate, test pruning
- Installer warning when codex on PATH is not the launcher
- Anchored-edit component digest and descriptor digest check

## 2026-10-08 — Launch scope and upstream pin

A smaller launch collection, a planned API freeze and refreshed Codex.

### Changed

- Pinned to Codex 0.161.0
- Warm release targets across batch closeouts

### Fixed

- Untracked candidate files and tree parity

### Decided

- Core tooling and a smaller OMD+ launch
- API freeze before release qualification
- Remaining collection returns in two waves

## 2026-10-07 — Privacy and response previews

Opt-in redaction, richer previews and repairs across the mod ecosystem.

### New

- Opt-in secret and personal-data redaction
- Image thumbnails and inline Mermaid diagrams
- Output observer for advisor notes

### Fixed

- Secret-scan ordering and privacy policy
- Mermaid rendering and stale advisor notes
- Transcript pairing, notices and client isolation
- Nightly validation and archived dependencies

## 2026-10-06 — Client views and package controls

Richer terminal controls, external clients and reviewed package installation.

### New

- Rich controls, notices and JSX
- Rasters, pointer capture and image placement
- External-client protocol and approval desk
- Read-only GitHub PR and CI views
- Reviewed npm, Git and folder installs

### Fixed

- Transcript rewrite ordering and idle-turn races
- Client isolation and notice delivery
- Terminal layout, focus and image rendering
- Package protection, rollback and thread queues

## 2026-10-05 — History rewriting and updates

Mods gain composer controls, transcript rewriting and OMD update settings.

### New

- Composer drafts and prompt queues
- Compaction and lifecycle interception
- Durable transcript rewriting
- Update notices and opt-in automatic updates

### Changed

- Pinned to Codex 0.160.1
- Bounded request, ledger and rendering work

### Fixed

- Authority, accounting and request admission
- Persistence, packaging and recovery

## 2026-10-04 — Interception, agents and provider routes

Mods gain request controls, agent lifecycles and provider usage views.

### New

- HTTP, command and config interception
- Model controls and final-request policy
- Agent lifecycles and autonomous turn queues
- Agent-written session briefs
- Usage HUD and Cursor subscription route

### Fixed

- Peer sessions and provider accounting

## 2026-10-03 — Mini mode and authority

Scrollback, composed panels and protected host authority for mods.

### New

- Scrollback-first omd mini interface
- OMD Night palette
- Foldable session, Git, LSP and MCP panels
- Protected authority broker and credential gateway
- Managed processes and delegated approvals

### Changed

- Composed workspace sidebar and session status
- Mods can hide inline terminal sites
- Continuation interceptors replace exclusive hooks

### Fixed

- Launcher keeps the current working directory
- Mini interface switching and thread state
- Worker startup and delegated approval scopes
- Tool gates and rename guards

## 2026-10-02 — Host and mod repairs

Review fixes across the host, mods, installer and author tooling.

### Changed

- Installer accepts compatible upstream and Node versions
- Host callback rules documented

### Fixed

- Host lifecycle, state and package controls
- Mod permissions and terminal views
- Installer launchers and code-mode host packaging
- Author SDK imports

## 2026-10-01 — Workspace tools and provider profiles

More workspace tools, provider controls and interactive mod surfaces.

### New

- Interactive host calls and focused mod input
- Approval framing and streamed message templates
- Unix socket grants for mod commands
- Provider profiles and live route reload
- Workspace layouts and command palettes
- Task worktrees and session port discovery
- Herdr integration and MCP controls
- Editor and shared checkout mods

### Changed

- Spare mod runner for callbacks
- LSP context when reading files
- Mod state scoped by repository and thread

### Fixed

- Secret redaction in config reads

## 2026-09-30 — Tools, panes and mod controls

New workflow tools, workspace panels and controls for managing mods.

### New

- /continue for interrupted work
- /simplify review-policy plugin
- Optional workflow procedures plugin
- Opt-in /plan removal mod
- Hashline edits and advisor triggers
- Browser plugin and /preview Markdown mod
- Experimental Muse agent route
- Workspace panes, file tree and LSP view
- Notes vault and pinned plan panel
- /mods controls and native /omd recovery
- First-run profile card
- Frecency file ranking and powerline status

### Changed

- Debugger packaged as an optional plugin
- Claude CLI provider rebuilt
- LSP diagnostics after edits
- Inspector command moved to /inspect

### Fixed

- Context, reactive rules and theme review findings
- Host activity and workspace tracking
- Debugger lifecycle and cleanup
- Mod transports, sidecars and host review findings

## 2026-09-29 — Feature-agnostic host cleanup

Features move into mods as the host goes generic.

### New

- Generic host primitives for mods
- Platform host task operations
- Experimental API 0.2.0 builds .3 through .5
- Theme palettes and backdrops
- Reactive rules and programmable context mods

### Changed

- Features now owned by mods
- Pinned to Codex 0.159.1
- Only the current mod API kept
- Welcome logo and OMD Core / OMD+ branding

### Fixed

- Review findings across four commits
- Per-handle agent locks
- Route and gate checks
- Capacity versus slow-down API errors

### Decided

- Codex themes added to the roadmap

## 2026-09-27 — Shared APIs and host rework

Experimental API 0.2 adds generic host operations alongside review fixes.

### New

- Shared extension APIs between mods
- Local feature packages for optional plugins
- Experimental API 0.2 host primitives

### Changed

- One OMD mode replaces platform and enabled

### Fixed

- Git, LSP, Claude and installer review findings
- Advisor lane, sessions and graph outputs

### Decided

- A feature-agnostic host: mods are the features

## 2026-09-26 — Git sidebar and terminal mods

OMD now builds on upstream Codex’s fullscreen terminal.

### New

- Git sidebar mod
- Terminal visual treatment as mods

### Changed

- Dropped OMD’s own fullscreen TUI

### Decided

- A mod that removes /plan
- A lean pass on tests
- A guard against oversized shell output

## 2026-09-25 — Code cells, LSP sync, debugger

Three developer tools, all opt-in.

### New

- Persistent Python and Bun code cells
- LSP sync after every edit
- Python debugger (debugpy over DAP)

### Changed

- LSP sync rebuilt as a pure mod
- Roadmap grouped into batches

## 2026-09-24 — Claude models and subagents

Both ship as mods, not runtime changes.

### New

- Claude models via the official Claude CLI
- Typed subagent tasks

### Decided

- New features ship as mods, not Rust patches

## 2026-09-23 — Launch identity and installer

Packaging work, then a full review of the codebase.

### New

- OMD launch banner in the terminal
- Terminal extension surface for mods
- Apple Silicon prebuilt
- One-line installer (private for now)

### Changed

- Rebased on the latest Codex CLI

### Fixed

- Findings from a three-branch code review

## 2026-09-22 — Everything becomes an extension

Built-in features rebuilt as skills, hooks, plugins and mods.

### New

- Recovery and terminal mods
- Guidance, code graph and code health
- LSP adapters for five languages
- Review cadence and app bridges
- Reading URLs, GitHub, PDFs and notebooks
- Persistent JavaScript, optional Python
- Theme and focus-flow mods
- Curated extension index
- First live first-party mods

### Decided

- What goes in the lean first release
- Launch plan: proof first

## 2026-09-21 — Reproducible mod packages

Mods ship as versioned, reproducible packages.

### New

- Reproducible packages and updates
- Integration coverage matrix
- Full API conformance test
- Extension types: skill, hook, plugin, mod

### Changed

- Coordination policy moved from Rust to TypeScript
- Pinned to a newer Codex

## 2026-09-20 — Author tooling and rollback

Tools for people who write mods.

### New

- Versioned workflow contracts
- Installable first-party mod preview
- Public API coverage
- Compatibility versions and rollback
- TypeScript author tools

## 2026-09-19 — Rust meets TypeScript

Codex’s native extension points are now open to TypeScript mods.

### New

- Versioned mod API and loader
- Example mods

## 2026-09-17 — First mod loader

TypeScript mods can load, add tools and keep state.

### New

- Mod loader with context, tools and state

## 2026-09-16 — The pivot

OMD becomes a moddable Codex, not a fixed feature set.

### New

- Bundled browser tooling
- App bridge adapters

### Decided

- Product centers on TypeScript mods
- Benchmarks move to the end

## 2026-09-15 — Guidance, code intel, review

The agent learns your repo and double-checks its work.

### New

- Communication modes and reactive rules
- Repo knowledge and code graph
- Code-health guard and LSP checks
- Unified review system
- Adversarial completion gate
- Direct mode: plain upstream Codex
- First local install

## 2026-09-14 — Delegation and recovery

The first patched Codex runtime.

### New

- Isolated worker delegation
- Selectable worker contexts
- Recovery controls
- Durable task checkpoints
- Fullscreen TUI
- Versioned guidelines

### Decided

- First look at modding the harness

## 2026-09-13 — Hello, Oh My Diff

Measurement before claims. CAI is renamed Oh My Diff.

### New

- Benchmark infrastructure
- Frozen evaluation protocol

### Decided

- Rename: CAI → Oh My Diff
- No numbers until they’re measured

## 2026-09-12 — Pinned to upstream Codex

A custom build that still shares your Codex setup.

### New

- Upstream lock file
- Compatibility checks
- A skill for each roadmap task

## 2026-09-11 — Day zero

Started as CAI (“Cheaper AI”), a patch set for Codex.

### New

- Repo, PRD and roadmap
