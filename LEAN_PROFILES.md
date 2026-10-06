# OMD Core and OMD+ candidate profiles

Both profiles use one `install.sh` curl entry point and the same patched host and
author tools. OMD Core supplies the modding ecosystem for user-selected
extensions; OMD+ also contains the selected first-party collection.

| Public profile | Install selector | Runtime identity |
| --- | --- | --- |
| OMD Core | `--profile platform` | `OMD_INSTALL_PROFILE=platform_only` |
| OMD+ | `--profile full` | `OMD_INSTALL_PROFILE=full` |

These internal selectors, installation paths, schema-1 records and lock filenames
remain unchanged. They identify the same profiles; the public labels and status
metadata use OMD Core and OMD+. No unreleased-format migration is needed.

These are local Apple Silicon candidate profiles for the active Codex `0.160.1`
patch. They are not a public release or a qualified default. Build the patched
`codex`, `omd-mod`, `omd`, and `omd-contract` executables from
`upstream.lock.json` and `runtime/patches/manifest.json`. Pack the typed author
SDK with `mise exec -- pnpm --dir mods pack --pack-destination /path/to/release`
and copy that archive to `/path/to/release/mod-api.tgz`. Use Node 24.18 or a
later 24.x (`mise which node`); any upstream Codex `0.160.x` serves as the
fallback. The OMD Core profile installs the host, mod manager, author
SDK/CLI, a local package-control command, the `omd_logo` presentation mod, the `omd_mods`
control screen and the `omd_update` update notices. It does not change
`CODEX_HOME`, `CODEX_SQLITE_HOME`, the selected Codex account, or project files.
The historical `0.155.1` candidate and private build remain frozen. Verify the
current host and SDK artifacts with
`python3 -m scripts.lean_release_lock --artifact-dir /path/to/release`.

To create a checksum-bound prebuilt archive and install either profile locally:

```sh
python3 -m scripts.lean_package pack --artifact-dir /path/to/release --output /path/to/omd-package.tar.xz
python3 -m scripts.lean_package install --archive /path/to/omd-package.tar.xz --sha256 PRINTED_SHA256 \
  --upstream /path/to/upstream/codex --profile platform --prefix /path/to/omd-candidate \
  --bin-dir /path/to/omd-bin --store /path/to/omd-mod-store --node "$(mise which node)"
```

Use `--profile full` for the provisional OMD+ collection. The archive is
verified before installation. For an automated patch-and-build install:

```sh
python3 -m scripts.lean_package source-install \
  --repository /absolute/local/codex-mirror --author-archive /path/to/release/mod-api.tgz \
  --output-archive /path/to/source-built-omd-package.tar.xz \
  --upstream /path/to/upstream/codex --profile platform --prefix /path/to/omd-candidate \
  --bin-dir /path/to/omd-bin --store /path/to/omd-mod-store --node "$(mise which node)"
```

Use `--profile full` for the OMD+ candidate. An
optional `--target-dir` retains a separate Cargo build cache. The source route
verifies the upstream commit, normalizes the lock, applies the hash-checked
patch, and builds the matching binaries. It requires Rust 1.95.0 and the pinned
Cargo dependencies.
The source package records its own exact binary hashes. Compiler build paths
can make those hashes differ from the prebuilt archive; the installer checks
the same source, patch, profile inventory, package contents, and pinned host
version before activation. Omit `--output-archive` to discard the source-built
archive after installation.

Run these commands from this checkout, replacing the paths with the local
patched build and separate writable installation directories:

```sh
NODE_PATH="$(mise which node)"
python3 -m scripts.lean_profiles --prefix /path/to/omd-candidate --bin-dir /path/to/omd-bin install \
  --profile platform --binary /path/to/patched/codex --manager /path/to/patched/omd-mod \
  --omd /path/to/patched/omd --omd-contract /path/to/patched/omd-contract \
  --author-archive /path/to/release/mod-api.tgz \
  --node "$NODE_PATH" --store /path/to/omd-mod-store
```

`--profile platform` creates a store holding only the `omd_logo` presentation
mod, the `omd_mods` control screen and the `omd_update` notices, all enabled, and launches patched Codex
with `OMD_MODE=omd`. Neither adds task behavior.
User-selected, trusted mods can run without selecting a task workflow contract.
`--profile full` installs forty-five first-party candidate mods. A fresh OMD+ store enables
`omd_inspector`, `omd_workspace`, `omd_logo`, `omd_mods`, `omd_update` and `omd_model_picker`; Codex's
`tui.copy_on_select` setting controls copy on mouse release. Claude, coordination, Git sidebar, LSP synchronization and code intelligence, recovery,
typed tasks, workflow, advisor review, lead-requested research, checks, graph
navigation, guideline governance, Pi prompts, repository analysis, source
knowledge, task tools, theme, reactive rules, programmable context, `/continue`, `/preview`, the Muse route, panes and file tree, the notes vault, frecency file ranking, the plan panel, plan-mode removal, account and provider profiles, the workspace layout with its palettes and task worktrees, the built-in editor, shared-checkout coordination, the mini interface, the experimental Cursor provider, Herdr pane status, MCP server status and setup, the prompt queue and the usage HUD are installed but disabled. Advisor every-turn selection and the separate research preset
require their own explicit host policy and allowance; installation does not
activate either. Attaching an
existing store (`--attach-store`, used by installer updates) keeps its
selections and settings, replaces changed first-party package sources with the new release's (re-trusted, and
re-enabled when they were on), and adds newly bundled first-party packages disabled. Each installation keeps a copy of
its first-party sources, so a rollback or an interrupted update restores the store to the active installation's.
`--previous PREFIX` carries the activation choice and route setups of the installation being replaced. Ten curated plugin source packages are available in
`/path/to/omd-candidate/bundles/oh-my-diff`; none is installed into Codex or
started. The upstream `codex-code-mode-host`, built from the same pinned tree,
is installed beside `codex`, because current models run shell commands through
it. The deferred code-execution plugin, browser, bridge service, external
language servers and sidecars are absent from the installed base profile.

The staged plugins are guidance hooks, review policy, application bridges,
artifact reading, anchored edit, session review, curated memory, debugger, procedures and browser. Their nested
skills, hooks and mod components are source inventory, not enabled extensions.
See [plugin setup](plugins/README.md) for each component's separate trust and
activation steps. OMD Core can install the same packages explicitly.

Enable the installed synchronization mod explicitly with
`/path/to/omd-bin/omd-package mod enable omd_lsp_sync`. It claims Python,
TypeScript, JavaScript, Rust and Java files whose server is installed; absent
servers report fallback. It discovers the executable without installing it, starts it
on demand, and sends document changes after observed OMD writes. Requested
file renames use the mod's pre-rename handler and the host's exact transaction
service. OMD Core users can install the same mod explicitly with
`omd-mod` and grant its declared capabilities.

Inspect and switch the effective profile:

```sh
/path/to/omd-bin/omd-package status
/path/to/omd-bin/omd-package activate direct
/path/to/omd-bin/omd-package activate full
```

Use `activate platform` for an OMD Core installation. `direct` immediately
selects upstream-style behavior inside the patched binary. `status` reports
the installed profile and public label, host mode, installed, enabled and active mods, source hashes,
mod errors, and staged plugins.

Both profiles start with a one-time card naming the profile and its active
mods. `/mods` lists every installed mod with what it adds, its scope, source,
API, capabilities and whether it is active, pending the next turn or failed; it
enables, disables, re-trusts an edited source, installs a local directory,
updates, rolls back, removes and reloads through native confirmations. Changes
apply at the next turn without a restart. The native `/omd` view is the
recovery path when `/mods` is disabled or broken: it toggles each mod and links
to plugins, skills and hooks. The OMD+ inspector moved to `/inspect`; direct
mode has neither. To disable a broken first-party mod from a shell:

```sh
/path/to/omd-bin/omd-package mod disable omd_workspace
```

Enable the Git sidebar with `/path/to/omd-bin/omd-package mod enable omd_git`;
`mod disable omd_logo` removes the logo in either profile;
the native `>_ OpenAI Codex (vVERSION)` session header remains.

`omd mini [codex arguments]` launches the scrollback-first mini interface over
the same session engine once `omd-package mod enable omd_mini` has run; it
needs a terminal, and `/omd_mini:switch` reopens the session in the full
interface at the next quit ([details](mods/first-party/omd_mini/README.md)).

`omd-package mod enable omd_usage` turns on the provider usage HUD: context,
cache, cost and quota panels, a Usage dialog (Alt+a) and the data for the
theme's status-line segments ([details](mods/first-party/omd_usage/README.md)).

`omd-package mod enable omd_prompt_queue` adds `/queue` and Alt+q: prompts you
capture are kept per thread, can be edited, reordered and joined, and are sent
as you, in order, when the session is idle ([details](mods/first-party/omd_prompt_queue/README.md)).

Git mutations also need an explicit permission-profile grant for the repository's
Git metadata and affected files. Codex's default `.git` protection is respected;
enabling `omd_git` alone does not authorize writes. Run from the repository root.
Git hooks and filters keep the session's filesystem restrictions and have no
network access through this local Git interface.

`OMD_CONTROLLED_MANIFEST` fails closed on the current host. Configure routes and grants in
the mod store, trust and enable `omd_workflow`, and select the schema-2 contract
with `omd-contract`. Enabling the mod does not select a contract or grant a
provider. `omd_task_tools` requires the enabled `omd_workflow` service; the
package command rejects a missing dependency and restores the prior selection.
The earlier bounded live native-workflow task and its `unverified` receipt are
historical evidence, not qualification of this mod-owned workflow. Batch 2.55
has local synthetic coverage; installed-profile and live-provider qualification
remain separate gates.

The inactive `omd_typed_tasks` package can be enabled for a task with a selected
and initialized mod-owned workflow contract
with `/path/to/omd-bin/omd-package mod enable omd_typed_tasks`. Its
`tasks` setting declares each worker role, one host-authorized route, tools,
and a bounded JSON result schema. The mod validates all sibling results before
advancing any editing result. Edit workers require configured checks and an
authorized distinct review route; host integration remains separately gated.
Direct work remains available when the package is disabled or the selected
contract forbids children. Local Batch 2.55 runner coverage does not qualify
real-model quality or public support.

The OMD+ profile includes inactive `omd_claude_cli`, `omd_cursor` and
`omd_muse` route mods. `omd_claude_cli` uses the official Claude CLI's logged-in
`claude.ai` Pro or Max subscription; `omd_cursor` uses your Cursor account
through the official Cursor SDK, which setup installs with pnpm; `omd_muse` uses
a separately installed Muse Code with an MSP host (`muse serve`). Set a route up once, then launch sessions on it:

```sh
/path/to/omd-bin/omd-package claude --setup
/path/to/omd-bin/omd-package claude --model sonnet
/path/to/omd-bin/omd-package claude --model haiku exec 'Your task'
/path/to/omd-bin/omd-package cursor --setup
/path/to/omd-bin/omd-package cursor --model cursor-auto
/path/to/omd-bin/omd-package muse --setup
/path/to/omd-bin/omd-package muse
```

Setup checks the CLI or SDK, reads its model catalog and context windows,
adds the route's service grant and local token to the store's `host.json`,
enables the mod and makes the managed `codex` launcher define the provider.
Launching adds the provider, model and catalog to an ordinary OMD+ session, so
enabled mods, their data, `/status` and resume work as usual; `--model` takes a
slug or family shortcut and further arguments go to `codex`. The Claude route
requires official Claude CLI `2.1.285` and rejects inherited API-key and cloud
overrides; there is no API-key fallback. Cursor setup enrolls through Cursor's
browser login, hands the minted key to the broker as a mod-owned secret that only the route's
service receives, and turns off Cursor's own tools so the agent acts only
through OMD tools. The native host keeps process
authority, tool execution, approvals and usage accounting; each Claude model
call admits one upstream request. `ask_claude: true` gives other leads an
opt-in Claude delegation tool, and the Muse mod adds a read-only `research`
subagent tool. Muse approvals go through an OMD prompt unless `auto_approve` is
set. The package READMEs list each route's limits. OMD Core includes no route
or assets.

For a user mod in the OMD Core profile, inspect its `mod.json` and source,
then use the installed `artifacts/omd-mod` binary to inspect, trust its exact
digest and declared capabilities, enable it in the store, and reload. The
authoring and recovery details are in [mods/README.md](mods/README.md). A mod's `error` in status is a failure to
repair or disable, not evidence that its behavior ran successfully.

An existing compatible store can be attached with `--attach-store` during a
new installation. Attaching replaces changed first-party package sources with the new installation's
and preserves each existing enabled or disabled choice. Use a separate prefix
and launcher directory for a side-by-side candidate upgrade. Removal deletes
only the managed launcher and installation prefix:

```sh
/path/to/omd-bin/omd-package uninstall
```

The mod store and Codex state remain.

## Updates

Installations made with `install.sh` update themselves through the same verified transaction. Each release on
GitHub (`dzkchen/oh-my-diff`, tag `vVERSION`) carries the archive and the `omd-release.json` manifest that
`lean_package pack` writes beside it: version, target, upstream Codex tag, mod API, Node and archive SHA-256. A
release is compatible when its target matches, its Codex minor matches your upstream `codex` and your Node satisfies
it; the newest compatible release on your channel is offered, and a newer incompatible one is reported with its
requirement. No release is published yet (Batch 5c), so checks report that none is available.

```sh
omd update                      # install the newest compatible release (or the pinned one)
omd update status               # installed and available versions, policy, open sessions, last result
omd update check                # check now, ignoring the cadence
omd update enable | disable     # automatic updates (off by default)
omd update checks on|off        # background checks (on by default)
omd update channel stable|beta  # beta also offers GitHub pre-releases
omd update cadence daily|weekly
omd update pin VERSION|none     # hold an exact version
omd update rollback             # return to the previous installation
```

The launcher starts a detached check at most once per cadence and never waits for it; the result is cached in
`ROOT/update/state.json` and shown by the `omd_update` mod (`/update`, and once a day in a fresh session's welcome
area until you snooze or skip the release). Policy is `omd_update`'s settings, also editable in `/mods`;
`omd update` writes it to every profile store. An update installs only when no other OMD session is open, because the
store's first-party sources and trust change: with sessions open, `omd update` downloads and verifies the release
and it installs the next time OMD starts with no other session open; **Update now** in `/update` does the same.
Automatic updates download in the background and install at launch the same way, and a release that failed once is
not retried automatically. A failed update rolls back and keeps the current version; an update interrupted at any
point is repaired by the next launch or installer command. Updates keep the profile, activation choice, route setups,
settings, credentials, Codex state and user-installed mods; they never update user-installed mods, and when enabled
user mods do not support a release's mod API, automatic updates skip it and `omd update` asks first (`--yes` skips
the question).

To protect credentials, grants and evidence from same-user processes on macOS, deploy the OS-separated authority broker:

```sh
/path/to/omd-bin/omd-package broker install   # sudo; then one dialog to protect the current grants
/path/to/omd-bin/omd-package broker pin       # sudo; re-pin by hand
/path/to/omd-bin/omd-package broker status
/path/to/omd-bin/omd-package broker reset     # sudo; clears grants and anchors, keeps credentials
/path/to/omd-bin/omd-package broker uninstall # sudo; removes the broker and all its state
```

While the broker is deployed, installing a package adds its binaries to the pins, and `install.sh` upgrades and rollbacks re-pin exactly the active and previous installations; each asks for sudo once. `install.sh uninstall` and `omd-package uninstall` refuse while the broker is deployed; pruning an older installation uses `omd-package uninstall --keep-broker`. The protection boundary is described in [mods/REFERENCE.md](mods/REFERENCE.md#protected-authority-macos).

The installer refuses removal if its
launcher changed, no upstream Codex `0.160.x` remains on `PATH`, or the prefix
contains a user file; an upgraded upstream (for example `brew upgrade codex`) is
fine. With `install.sh`, `status`, `rollback` and `uninstall` also accept
`--upstream /path/to/codex`. A `codex`, `omd`, `omd-contract`, `omd-mod`,
`omd-package` or `omd-mod-author` already in the launcher directory and not
managed by the installer is moved to `NAME.before-omd` and restored on
uninstall. A failed first installation restores those commands and removes new
launchers. Recovery restores commands if installation stopped before activation;
after activation it completes the active installation's launchers.
Rolling back restores the previous generation's binaries, launchers
and first-party mod sources but keeps the rest of the mod store; Phase 11 makes no promise that an
older generation reads newer store data.
If you explicitly added the
staged plugin marketplace to Codex, remove its plugins and run
`codex plugin marketplace remove oh-my-diff` before uninstall; the installer
refuses to leave a marketplace pointing at a removed directory. Local candidate qualification
and package limits are recorded in `.docs/ROADMAP.md`.

Both profiles include the generic `omd` extension-command dispatcher, the
`omd-contract` selection tool and `omd-mod`, all on `PATH` next to `codex`.
`omd-package contract list|status|plan|select|clear` runs `omd-contract` against
the installation's store and the current repository. The `codex` launcher runs
Codex in embedded mode (`features.daemon_auto_start=false`) and exports
`OMD_NODE`. Their launchers select the installation's mod
store; only explicitly trusted and enabled command exports are available. For
example, `omd COMMAND --repo /absolute/project` routes to the selected
extension. No session-review or memory behavior is built into this binary.
Package installation and activation remain separate. The current host exposes
API `0.2.0-experimental.5`; API 0.1 packages are historical compatibility
fixtures and do not qualify as current package candidates.
