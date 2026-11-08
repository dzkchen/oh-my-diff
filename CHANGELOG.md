# Changelog

Generated from [`release/changelog.json`](release/changelog.json) by `mise run release`; the Oh My Diff site and GitHub Releases use the same entries. Entries before the first release are daily development notes.

## [1.5.0](https://github.com/dzkchen/oh-my-diff/releases/tag/v1.5.0) — 2026-11-08

Per-terminal mod settings, lower resource use in idle and background sessions, Codex 0.167.0, and fixes across first-party mods, the git panel, threads and the installer.

### New

- Mods: `/mods` and the `/omd` mod list can apply a mod's on/off and settings to this terminal only; terminal-only choices last until the terminal closes, and "Keep these for every terminal" saves them
- Idle sessions: an unfocused or idle terminal redraws once a second and pauses theme animation, and unused mod runners are released, while agents, tools and monitors keep running; focus or input resumes full speed

### Changed

- Codex: updated to 0.167.0, including Guardian review, provider-error handling, deferred-tool discovery and audio attachments, with OMD's approval and review boundaries kept
- Subagents: delegated results arrive once through the parent thread's mailbox instead of a second wake prompt, and helper agents follow the hooks and execution policy of the thread that started them
- Claude: sessions through omd_claude_cli reuse the prompt cache between requests, so plan limits last about as long as in Claude Code
- Privacy: omd_privacy no longer asks before a shell command that names a sensitive file by default; secrets in its output are still redacted, and Sensitive paths in its settings turns asking back on
- Performance: lower mod callback cost, faster exec output paging, cached store reads and no stream decoding when no mod listens
- Workspace: omd_workspace keeps its arrangement, sizes, tabs, panels and on/off per conversation, so terminals on different conversations no longer share one layout

### Fixed

- Mods across terminals: a mod's saved state changed in one terminal or attached client redraws it in the others, while its UI state, settings and enablement stay with each terminal
- Rollback: after `omd update rollback`, the previous release still reads the mod store this one wrote
- Clients: a client a mod launches starts again, recovery shows a mod whose renderer keeps failing and reports reload errors instead of failing, and the TUI attaches to the server's mod host only in Oh My Diff mode
- Git panel: discarding, staging or attaching a hunk is refused when the file changed since it was shown, so unreviewed changes are never discarded
- Threads: opening a thread no longer deletes other threads' saved data, forked sessions no longer receive their parent's monitor results, and each thread's evidence stays its own
- Undo: a retried `/undo force` keeps its `/redo`, and each checkout keeps its own checkpoints
- Mods: the first mod command after a minute idle answers at once, idle sessions stop drawing frames that change nothing, `/mods ACTION ID` asks which copy when an id is installed for both you and the project, and dialogs size to their content
- Cursor and subagents: Cursor settles cost against the run that ended, and a subagent restart refuses a route whose provider, account or billing changed
- Kernels: Python and Bun cells no longer show output written by an earlier cell's threads or timers
- LSP: same-line results are kept, lines past the end of a file are refused, and trimmed errors are no longer reported as new
- Workflow and accounts: checkpoint decisions are capped by size, a lost store race no longer fails a workflow, and `/profile` refreshes accounts when it lists or selects them
- Verify stop: a command joined with `||` or `;` no longer counts as a passing check
- Installer: `omd update check` prints a one-line status, an unknown `omd update` action fails in one line, uninstall leaves no empty folders, mods that left the profile stay trusted across updates, uninstall and mod maintenance block new sessions first, and `omd mini` points to `omd install` when omd_mini is missing
- Tools: `omd-package` prints one line per mod, `omd-mod-author` is quieter and reloads newly named assets in watch mode, and `omd-package plugins` creates CODEX_HOME first

## [1.4.2](https://github.com/dzkchen/oh-my-diff/releases/tag/v1.4.2) — 2026-11-04

Signed mod updates, account switching for new threads, keyboard panel arranging, turn undo and redo, and fixes for themes and overlapping turns.

### New

- Mod updates: fixes to first-party mods now arrive between releases as signed mod updates; `omd update`, `/update` and automatic updates apply them, and `omd update rollback` undoes them
- Accounts: `/profile` chooses the account that `/new` uses without changing existing threads, and subscription setup discovers model defaults instead of asking for model names, context sizes or pricing
- Uninstall: `omd uninstall --purge` also signs out OMD accounts and clears caches, keeping shared Codex data
- Terminal panes: Allow and remember on a sandboxed start saves the approval for that workspace, mod, command and executable, so the same start doesn't ask again until its access or executable changes
- /btw: `/btw` alone opens a side conversation panel that lists earlier exchanges and takes a follow-up question
- Workspace: arrange panels with the keyboard alone (m, then Shift+arrows, T and = / -), F6 shows or hides the panels from the prompt, and number keys focus a panel whose tab is showing
- Undo: the experimental omd_checkpoint snapshots your files around each turn, so `/undo` puts back what the agent changed in the last turn and `/redo` brings it back, with `/undo show` to preview it first; it never overwrites edits you made since without `/undo force`
- Theme: an Aurora scene; the northern lights flare when a turn finishes, so you can tell from across the room that the agent is done

### Changed

- Shell commands: adjacent agent shell commands collapse into one expandable summary with running and failure counts
- Theme: switching themes no longer flashes, scene transitions are shorter, and prompts and menus stay opaque over the scene
- OMD+: omd_monitor and omd_observation_mask are now included (turn them on in `/mods`); omd_inspector, omd_model_picker, omd_idle_compact and omd_preview move to Experimental (install with `omd install ID`), so new installs no longer compact idle chats by default
- Plugins: OMD+ stages only omd-anchored-edit; omd-artifact-reading, omd-code-execution and omd-output-budget move to the separate oh-my-diff-experimental marketplace
- Monitors: watch several sources together, check pull-request completion, and run the next action when a watch settles
- Continue: cache-aware observation masking preserves recent context while reducing repeated tool output in a continued conversation
- Mod authors: session activations, background jobs, timer payloads and assistant-message identities support work that continues across callbacks

### Fixed

- Accounts: threads keep their provider across account switches and resumes, and account setup works again; reconnecting and removing ChatGPT, Claude, Cursor and API accounts now work the same way
- Theme: resizing the terminal keeps the theme background
- Working indicator: stays visible until the active task finishes
- Uninstall: a cleanup that fails partway can be retried
- Mods, updates and preview: `/mods cancel` says whether it dropped a waiting change, the updates panel labels times as UTC and hides update settings on installs the OMD installer didn't make, and `/preview FILE --watch` frees the place of a watched file that was deleted
- Usage: tool calls no longer rewrite the mod's whole saved state while the usage dialog is closed, and an agent event that changes nothing is skipped
- Files: arrow keys move through entries and directories, and a narrow dock stacks the preview below the list
- Status line: usage limits refresh while idle, and an empty snapshot clears old limits
- Theme: typing on a fresh thread no longer changes the scene's brightness, and the scene stays after the first prompt
- Workspace: a panel that goes away no longer leaves its screen mode behind, a key set twice is reported instead of silently turning another off, and focusing Changes no longer reruns git status every time
- Claude CLI: turning off extra usage in the mod's settings file now stops at extra usage too, instead of only the `/mods` setting counting
- Frecency: outside a Git repository `@` completion runs `git status` at most every 30 seconds instead of on every keystroke, deleted changed files are no longer offered, slash or shell commands no longer count as file uses, and a mention counts only if its turn starts within 2 minutes
- Advisor: automatic `failure` and `loop` consults cool down, once per call every 10 minutes and once every 2 minutes overall, so an agent retrying one failing command no longer pays for a second model on every other failure
- Claude CLI: `/claude login` works when the mod was installed from the catalog, instead of failing with setup_must_run_from_installed_mod after sign-in
- Input: typing stays responsive when turns overlap, and delayed callbacks keep the session that owns them
- Status line: child tools no longer trigger a diagnostic error in session timers
- Continue: saved originals are checked before history processing, and masking progress stays isolated to its route
- Installer: release verification and cleanup refuse unsafe inputs, and provider setup keeps credentials within its approved access
- Mods: corrected caching, saved state and prompt sanitization in first-party mods

## [1.4.0](https://github.com/dzkchen/oh-my-diff/releases/tag/v1.4.0) — 2026-11-02

Experimental harness mods that cut token use, /btw side questions, and a tool list that matches stock Codex so new threads keep the provider's prompt cache.

### New

- Harness mods: experimental omd_observation_mask, omd_verify_stop, omd_edit_guard, omd_env_bootstrap, omd_loop_guard and omd_plan_anchor; in a pilot benchmark the first four with the output-budget component cut estimated cost by about 25% with no loss in pass rate (see docs/benchmarks/harness-mods.md)
- Side questions: the opt-in omd_btw adds `/btw`, which answers a quick question on a helper route without interrupting the turn and remembers earlier side questions
- T3 Code: a guide for using OMD with T3 Code

### Changed

- Plan mode: a mod that turns off a builtin mode no longer removes tools, so the tool list matches stock Codex and a new thread's first request keeps the provider's shared prompt cache (about 12K tokens)
- OMD+: new installs ship omd_plan_removal and omd_plan_panel turned off, so plan mode works in Codex and T3 Code
- Output budget: a large code-file read becomes a head excerpt plus a line-numbered outline
- Launcher: `codex exec`, `codex app-server`, `codex completion`, `login`, `mcp` and other non-interactive commands never install or announce an OMD update; only the actual subcommand counts, so `codex -p exec` stays interactive
- Directory: the curated directory lists all four bundled plugins

### Fixed

- Installer: download errors name the requested URL and HTTP status, never a signed redirect URL
- Output budget: its component loads again
- /btw: the answering notice stays until the answer arrives

## [1.3.0](https://github.com/dzkchen/oh-my-diff/releases/tag/v1.3.0) — 2026-10-31

Oh My Diff now builds on Codex 0.166.0, with cross-provider subagents, a free panel workspace, Lazygit and Yazi panes, living themes and faster mods.

### New

- Subagents: a subagent can run on another provider's model (for example a Claude model through omd_claude_cli) and counts against worker limits; with omd_subagent_router an idle lead wakes when a subagent's result arrives, and mods get an opt-in `delegate_task` tool
- Subagents: ordered fallback models with the reason each route was skipped, and an opt-in restart of a delegated task once its provider's usage limit resets
- Profiles: a keyless Ollama profile for a local address, and `/profile window` sets how much of a thread a model sees
- Workspace: the opt-in omd_workspace mod arranges chat and panels freely (presets, saved layouts, `/workspace move` and `swap`); drag a panel title to dock it, Ctrl+] switches between the chat and the last panel, Esc returns to the chat
- Mods: opt-in omd_lazygit and omd_yazi run Lazygit and Yazi in a full terminal pane with keys, mouse, links and confirmed clipboard copy
- Themes: the opt-in omd_theme draws animated scenes behind the whole screen; `/theme` picks the scene, motion and background
- Monitors: the opt-in omd_monitor watches a background command, a file or a GitHub run and posts one message when it settles, so the agent doesn't poll
- Output budget: the omd-output-budget plugin turns large shell, code-mode and MCP results into excerpts that keep the exit status and failure lines; the full output stays searchable
- Mentions: omd_frecency ranks @ mentions by the branch's recent commits and recently saved files, an exact filename first
- Statusline: new `tier`, `profile` and `workspace` segments
- Mods: experimental omd_awake keeps the Mac awake while the agent works, optionally with the lid closed

### Changed

- Upstream: Codex 0.166.0; OMD 1.3.0 is the first release that supports it
- Plan mode: in OMD+, omd_plan_removal now removes Plan mode completely; a thread that still holds it runs in the default mode
- Performance: mods activate, start and save state faster, and the statusline and `/mods` render faster
- Sandbox: agent commands keep your Codex sandbox; OMD's protected paths (mod store, leases, secret files) are denied to every sandboxed command, file tools included
- Logo: shows the OMD version and profile (OMD+ or OMD Core); the slash popup lists each mod command once
- Mods: a mod can no longer replace or wrap a site another mod owns; layouts nest 6 levels and per-callback host limits rose (see the mod reference's migration notes)

### Fixed

- Turns: repositories with more than 8 MiB of tracked files no longer show a `turn_evidence` snapshot size diagnostic every turn
- Rewind no longer stalls for about 21 seconds
- TUI: mod callbacks no longer stall the UI, and mod cards no longer take Tab or swallow pastes and images
- Requests: web search works under final-request policies, and image generation and memory summarization are no longer refused
- Git panel: a rejected push offers `--force-with-lease` only when the branch has diverged, unstaging a rename unstages its old path, and edits refresh only what changed
- Subagents: idle cross-provider subagents no longer hold worker slots, and a reloaded agent keeps its own provider's settings
- Workspace: snapshots record tracked symlinks by their link text and refuse a file swapped for a symlink mid-read
- Installer: an aborted uninstall keeps the rollback point, rollback checks the generation it restores, a withdrawn installed release is reported and certificate errors get their own message
- Mentions: an `@` mention after a malformed `@"` is still recognised
- Packed baseline test expects upstream's empty recovery baseline (#351)
- Release gate failures in core and client acceptance (#352)

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

- Mod runtime: mods run in `omd-runner`, an embedded V8 runner that ships with Oh My Diff, so Node.js is no longer needed to run mods (#266)
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
