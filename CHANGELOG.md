# Changelog

Generated from [`changelog.json`](changelog.json) by `mise run release`; the Oh My Diff site and GitHub Releases use the same entries. Entries before the first release are daily development notes.

## [1.0.0-rc.1](https://github.com/dzkchen/oh-my-diff/releases/tag/v1.0.0-rc.1) — 2026-10-17

Release candidate for Oh My Diff 1.0.0, the first public beta: Codex 0.163.0 with a TypeScript mod host, the OMD Core and OMD+ collections and a signed curl installer.

### New

- Installer: one curl command installs OMD Core or OMD+, with `omd update`, update channels, rollback, profile switching and an uninstall that restores upstream Codex.
- Signed releases: the installer and `omd update` refuse a release whose manifest is unsigned or doesn't match its archive.
- OMD+ mods on by default: status line above or below the prompt (`omd_statusline`), plan panel, tool lines, idle compaction before the prompt cache expires, and auto-continue for approvals and questions left unanswered for two minutes.
- Opt-in mods: Claude subscription as a native provider with status, billing routes and extra usage (`omd_claude_cli`, Claude CLI 2.1.296), `/continue`, and a preview thumbnail strip.
- Claude Code ports: `burn_meter`, `token_weather` and `blast_radius`, each installable with one command.
- Mod API: multi-file packages, component modules on the draw path, live continuations, raw process streams and raw terminal frames.
- Mod API: composer key interception, completion rows and mention reads; persisted-history interception, session tool records and prompt-cache marks.
- Mod authors: typed mocks and an offline test kit, scaffold and reload workflows, manifest schema checks in `omd-mod`, and published mod index entries.
- Managed mod policy that fails closed, with deployment sync and provenance checks.
- Update channels `stable`, `prerelease` and `nightly` (`omd update channel`); release candidates install from `prerelease`.

### Changed

- Pinned to Codex 0.163.0.
- The repository holds only the launch collection: OMD Core installs 3 mods; OMD+ adds 8 more on by default, 11 opt-in mods and 3 inert plugins.
- Mod API `0.2.0-experimental.5`: entries marked frozen in the conformance registry keep their shape; experimental ones, such as `terminal.blit` and `process_raster_v1`, may change.
- Mod callbacks reuse a warm runner per package with smaller requests; package listings and terminal views are cached.
- Mod UI drops backdrops and glass effects; the package listing is narrower.
- `/continue` is opt-in.
- Docs: short install, collection, manage-mods and write-a-mod guides, an agent mod guide, and every mod README on one template.
- Release archives include the licenses and third-party notices.
- The mod API reference is split into topic pages.

### Fixed

- Security: mod realm containment, private store files, owner-only component events, config redaction, sealed provider port hand-off, a protected runner and an MCP approval gate.
- Security: the broker binds stores and evidence to their owner; a runner memory watchdog stops runaway mods at 512 MiB.
- Install: resumable uninstall and recovery, release asset URL and SHA-256 required together, and a warning when the `codex` on PATH isn't the OMD launcher.
- Mod runtime: runner reuse and cancellation, transactional reloads, state migration on `state_version` changes, thread-scoped routes and state, and receipt budget edge cases.
- Mod runtime: the idle watchdog no longer kills stateful runners; offline timers bind to the right thread.
- Terminal UI: Esc closes mod completion popups on the first press; modal dialogs, button hotkeys, prompt wrapping, ASCII glyphs and pane scroll; host diagnostics are never clipped.
- Terminal UI: raw-frame retries, hidden raster backoff and mouse-look motion capture.
- Mods: status line startup and refresh timing, stale LSP answers and bounded resync of large or non-UTF-8 files, preview truncation notices and watch retries.
- Mods: Claude route extra usage, billing reruns and error mapping; `/burn` and token usage in the ports.
- Upstream-direct mode keeps upstream Codex behavior, with no footer status prefix.
- Install: a piped install without `--profile` shows the profile prompt; the first thread after a reboot no longer fails with `protected_path_unavailable`; installed `omd-package` commands no longer look for mod sources; uninstall removes the installation's own Codex plugins and marketplace.
- Security: the authority broker checks roles, refuses to pin an older signed release, and refreshes its root tooling only from the newest signed manifest.
- Mod runtime: workspace folders that don't exist take no lease.
- Terminal UI: `/config` in the surface list, rendered selections cleared each frame, Alt-key fallbacks; advisor route setup.
- Installer accepts Node 24 on PATH when mise is absent (#242)

### Decided

- 1.0.0 ships labeled beta: not every planned capability is in yet.
- Packages outside the launch collection return in post-launch waves.

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
