# Changelog

Generated from [`release/changelog.json`](release/changelog.json) by `mise run release`; the Oh My Diff site and GitHub Releases use the same entries. Entries before the first release are daily development notes.

## [1.2.0](https://github.com/dzkchen/oh-my-diff/releases/tag/v1.2.0) — 2026-10-24

Oh My Diff now builds on Codex 0.164.0.

### Changed

- Upstream: Codex 0.164.0; OMD 1.2.0 is the first release that supports it
- Host release 1.2.0 (#313)
- Mod tooling: Node 24.22.1 (#313)

### Fixed

- Mods: a failed tool call no longer also shows a Mod diagnostics box (`tool_result_unavailable: failed`) when a mod's tool middleware only passes the failure on
- Mods: `omd-mod migrate` and `omd-mod rollback` treat `.` and `..` as package folders, not mod ids

## [1.1.1](https://github.com/dzkchen/oh-my-diff/releases/tag/v1.1.1) — 2026-10-23

Fixes updating from 1.0.0 and two copies of one mod both being turned on, which stopped every mod.

### Changed

- Host release 1.1.1 (#310)

### Fixed

- Updates: `omd update` from 1.0.0 no longer fails with `unknown field node` (#310)
- Mods: turning on a second copy of a mod, such as a Directory package beside the bundled copy, is refused with the copy to turn off first; before, both copies were rejected and `/mods` and every mod command failed with `mod_conflict` (#310)
- Updates: installing or updating turns off a Directory package that is on beside the bundled copy of the same mod, so a store already in that state works again (#310)
- Mods: `omd mods remove ID` removes only the package, not a bundled copy of the same mod (#310)

## [1.1.0](https://github.com/dzkchen/oh-my-diff/releases/tag/v1.1.0) — 2026-10-23

Add and switch ChatGPT, Claude, Cursor and API accounts inside the session, a minimal `omd mini`, ChatGPT-plan usage counted as included, and six more opt-in mods.

### New

- Accounts: `/profile add` signs in to a ChatGPT, Claude or Cursor account, or takes an OpenAI or Anthropic API key or another provider, inside the session, first profile included; switch accounts with `/profile`, Alt+s or the usage meter, which shows each account's last-seen 5h and weekly limits (#293, #298, #301)
- Claude CLI: several Claude accounts, each with its own login and models (`/claude login [api] [NAME]`, `/claude remove NAME`); any Claude CLI from `2.1.307` on works, so auto-update can stay on (#297, #298, #301)
- Cursor (`omd_cursor`, opt-in, experimental): Cursor models in `/model` with several accounts via `/cursor setup [NAME]` (#291, #298)
- `omd mini`: only the transcript, a bare prompt and one status line (model, context, limits or cost), for SSH sessions and small terminals (#291, #300)
- Opt-in mods: `omd_tool_absorb` runs identical read-only calls once, `omd_tool_fix` repairs clear-cut malformed tool calls, `omd_source_knowledge` keeps hash-checked source facts and lessons, and `omd_programmable_context` gives the Python kernel kept context variables, child agents and `/refine` (#291, #295)
- Mod API: `routes.write` lets a mod replace its own routes and service credentials after a confirmation, `thread/settings/update` accepts `modelProvider` with `model`, and `session.info` reports `process_id` (#293, #294, #298, #301)

### Changed

- Usage: ChatGPT-plan requests count as `included` instead of unknown cost, usage shows only in the status line below the prompt, and the usage dialog keeps Claude and Cursor limits apart from the Codex account (#299, #301)
- Mod API: shipped experimental entries with a first-party or example consumer are now frozen, among them `terminal.panel`, `providers.models`, `http.request`, `sessions.read`, component modules and the below-composer site
- Account mods (`omd_profiles`, `omd_claude_cli`, `omd_cursor`) need Node on `PATH` and say how to install it if it is missing (#301)
- `omd`: bare `omd`, `omd help` and `omd --help` list the mod, session and update commands; `omd help --all` shows every flag (#303)
- Workspace changes: `workspace_change` follows the repository's `.gitignore`, `.ignore` and exclude rules instead of a fixed skip list, so tracked `build/` and `dist/` files report changes (#305)
- Mod authoring: `omd-mod-author` prints one-line errors instead of stack traces, and `--help` prints usage (#306)

### Fixed

- Privacy: sensitive-path checks catch hyphenated key names, case, parent directories, globs, brace lists, `rev:path`, quoting and `.`/`..` path tricks, without slow patterns (#294, #301)
- Code execution: kernels keep output in write order, survive uncaught errors and `exit()`, and Bun no longer crashes when a background child writes (#294, #301)
- Accounts: every `host.json` change from a setup step is confirmed first and written under the host's lock; a declined or failed add can be retried (#301)
- Mods: `/preview --watch` keeps one watch per process and waits for a missing file; workflow keeps finished work; programmable context keeps the cached prompt prefix; source knowledge no longer invalidates facts it skipped (#294, #301)
- Terminal UI: status segments from app notifications redraw at once, the voice strip shows in the plain composer, and `omd mini` settings no longer leak into tool processes (#300, #301)
- Mods: OMD reports its own release (`1.1.0`) as the host release in errors, `omd-mod status` and generated types, so a package listing `1.1.0` in `compatibility.releases` loads (#305)

## [1.0.1](https://github.com/dzkchen/oh-my-diff/releases/tag/v1.0.1) — 2026-10-20

Mods run on an embedded V8 runner instead of Node, with faster startup and a fraction of the memory, plus install and package-control fixes.

### New

- Mod runtime: mods run in `omd-runner`, an embedded V8 runner that ships with Oh My Diff, so Node.js is no longer needed to run mods; each runner uses about 6–15 MB instead of about 43 MB and starts about twice as fast (#266)
- Package controls: `packages.index` pages with `cursor` and `limit`, and the `/mods` Directory reads large indexes in pages (#265)
- Advisor: `routes.add` adds a ChatGPT-plan helper route for a mod after a confirmation, granted per repository (#265)
- Claude CLI: `/claude login` runs in the background and `/claude code CODE` sends a pasted sign-in code (#265)
- Uninstall: `omd uninstall` removes Oh My Diff (#267)

### Changed

- Installer: the default curl command installs the newest stable release (#262), and the PATH line goes in the profile for your shell (#265)
- Mods: Logo, Mods and Update are required and stay on in `/mods` and `/omd`; `omd mods disable` still turns them off (#265)
- Mod settings: every first-party setting has a title and description, and route settings list only routes the mod may use (#265)
- Unsandboxed programs: a version-manager shim such as mise's or Volta's `node` runs the version it manages (#266)

### Fixed

- Code execution: output written after a cell ends no longer corrupts the result, and a cell's whole stdout and stderr is captured up to 64 KiB (#264, #265)
- Mods: a mod turned on mid-session starts at once, and a slash command retries once after a mod reload (#265)
- GitHub reader, `@` file search and `/preview --watch`: fewer false changes, fewer `git status` runs and no polling (#264)
- Author guide and write-a-mod: ten fixes from a clean-checkout walkthrough (#264)
- Idle compact: OpenAI subscription sessions are no longer compacted, other providers are compacted only after observed cache activity, and a 12-hour cache lifetime can be chosen (#269)
- Auto-continue: answers only requests from its own thread, keeps each request's first deadline, and its timeout answer is no longer consent for permissions, spending or a required decision (#269)

## [1.0.0](https://github.com/dzkchen/oh-my-diff/releases/tag/v1.0.0) — 2026-10-19

First public release, labeled beta: OMD Core and OMD+ on Codex 0.163.0 with the stable mod API 1.0.0.

### Changed

- Mod API `1.0.0` is stable and supported through 2027-10-19: frozen entries keep their shape and a breaking change needs a major version; experimental entries may change
- The launch collection's packages and the mod host are versioned `1.0.0`

### Fixed

- /preview in a fresh session says there are no responses yet (#255)
- Clearer mod author errors, scaffold and docs (#257)
- A mod command typed right after launch waits for the session instead of failing; a mod turned off after repeated failures says so, and `omd mods list` shows failed mods

## [1.0.0-rc.2](https://github.com/dzkchen/oh-my-diff/releases/tag/v1.0.0-rc.2) — 2026-10-19

Second release candidate: a native mod settings panel, Claude subscription models inside the session, keyboard-first mod dialogs and faster mod status.

### New

- Claude subscription in the session (`omd_claude_cli`, opt-in): `/claude login` in a terminal pane, your plan's Claude models in `/model`, and switching a thread between Claude and OpenAI from the next turn without a relaunch.
- `/mods` and `/statusline` open in Codex's native settings panel, with tabs, search and toggles, and redraw from real state after every change.
- Mod API: `terminal.panel`, `providers.models` and `model_provider` on thread settings (experimental).

### Changed

- Mod dialogs work from the keyboard: arrows move between controls, held keys repeat, Space toggles, and `/mods` filters as you type with fuzzy matching.
- `/mods` opens faster in OMD+: mod status is shared and the package listing is cached.

### Fixed

- Mods: `/mods` can't turn itself off or remove itself, an installed mod updates from its own panel instead of reinstalling, and `/omd`'s Reload mods works without an attached client.
- Terminal UI: the welcome logo stays while you type a command and hides after the first history line; mod diagnostics wrap and no longer fire for Codex's internal threads.
- Status line: a ChatGPT plan shows `included` instead of `unpriced · cost unknown`.
- Install: `omd-package activate direct` no longer exits right after launch on a machine where packaged Codex never ran.
- Mod runtime: a truncated evidence file is repaired instead of failing every later write; read-only agents accept only tools Codex has; one lead's new turn no longer drops another lead's tool outcomes.
- Install: the installer ends with the next step, `hash -r` or a new terminal before `codex`, because a shell that already looked up `codex` keeps starting plain Codex.
- Mods: a typed `/mods` action reports its own result while another change waits for `/mods apply`.

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
- Install: a piped install without `--profile` shows the profile prompt; Node 24 on `PATH` works without mise; the first thread after a reboot no longer fails with `protected_path_unavailable`; installed `omd-package` commands no longer look for mod sources; uninstall removes the installation's own Codex plugins and marketplace.
- Security: the authority broker checks roles, refuses to pin an older signed release, and refreshes its root tooling only from the newest signed manifest.
- Mod runtime: workspace folders that don't exist take no lease.
- Terminal UI: `/config` in the surface list, rendered selections cleared each frame, Alt-key fallbacks; advisor route setup.

## 2026-10-08 — Launch scope and upstream pin

A smaller launch collection, a planned API freeze and refreshed Codex.

### Changed

- Pinned to Codex 0.161.0
- Warm release build targets reused between builds

### Fixed

- Untracked candidate files and tree parity

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

## 2026-09-26 — Git sidebar and terminal mods

OMD now builds on upstream Codex’s fullscreen terminal.

### New

- Git sidebar mod
- Terminal visual treatment as mods

### Changed

- Dropped OMD’s own fullscreen TUI

## 2026-09-25 — Code cells, LSP sync, debugger

Three developer tools, all opt-in.

### New

- Persistent Python and Bun code cells
- LSP sync after every edit
- Python debugger (debugpy over DAP)

### Changed

- LSP sync rebuilt as a pure mod

## 2026-09-24 — Claude models and subagents

Both ship as mods, not runtime changes.

### New

- Claude models via the official Claude CLI
- Typed subagent tasks

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

## 2026-09-13 — Hello, Oh My Diff

Measurement before claims. CAI is renamed Oh My Diff.

### New

- Benchmark infrastructure
- Frozen evaluation protocol

## 2026-09-12 — Pinned to upstream Codex

A custom build that still shares your Codex setup.

### New

- Upstream lock file
- Compatibility checks

## 2026-09-11 — Day zero

Started as CAI (“Cheaper AI”), a patch set for Codex.

### New

- Repository and product plan
