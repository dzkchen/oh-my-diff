# Changelog

Generated from [`changelog.json`](changelog.json) by `mise run release`; the Oh My Diff site and GitHub Releases use the same entries. Entries before the first release are daily development notes.

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
