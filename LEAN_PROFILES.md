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

These are local Apple Silicon candidate profiles for the active Codex `0.159.1`
patch. They are not a public release or a qualified default. Build the patched
`codex`, `omd-mod`, `omd`, and `omd-contract` executables from
`upstream.lock.json` and `runtime/patches/manifest.json`. Pack the typed author
SDK with `mise exec -- pnpm --dir mods pack --pack-destination /path/to/release`
and copy that archive to `/path/to/release/mod-api.tgz`. Use Node `24.18.0` from
`mise which node`. The OMD Core profile installs the host, mod manager, author
SDK/CLI, a local package-control command, and the `omd_logo` presentation mod. It does not change
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
mod, enabled, and launches patched Codex with `OMD_MODE=omd`.
User-selected, trusted mods can run without selecting a task workflow contract.
`--profile full` installs twenty-three first-party candidate mods. A fresh OMD+ store enables
`omd_inspector`, `omd_workspace`, `omd_logo` and `omd_model_picker`; Codex's
`tui.copy_on_select` setting controls copy on mouse release. Claude, coordination, Git sidebar, LSP synchronization, recovery,
typed tasks, workflow, advisor review, lead-requested research, checks, graph
navigation, guideline governance, Pi prompts, repository analysis, source
knowledge, task tools, theme, reactive rules and programmable context are installed but disabled. Advisor every-turn selection and the separate research preset
require their own explicit host policy and allowance; installation does not
activate either. Attaching an
existing store (`--attach-store`, used by installer updates) keeps its
selections and adds newly bundled first-party packages disabled. Seven curated plugin source packages are available in
`/path/to/omd-candidate/bundles/oh-my-diff`; none is installed into Codex or
started. The deferred code-execution plugin, browser,
bridge service, external language servers, code-mode host, and sidecars are
absent from the installed base profile.

The staged plugins are guidance hooks, review policy, application bridges,
artifact reading, anchored edit, session review and curated memory. Their nested
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
mod errors, and staged plugins. The OMD+ profile's inspector mod supplies
`/omd`; direct mode has no inspector. To disable a broken first-party OMD+ mod:

```sh
/path/to/omd-bin/omd-package mod disable omd_workspace
```

Enable the Git sidebar with `/path/to/omd-bin/omd-package mod enable omd_git`;
`mod disable omd_logo` removes the logo in either profile;
the native `>_ OpenAI Codex (vVERSION)` session header remains.

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

The OMD+ profile includes an inactive `omd_claude_cli` mod. To use the official
Claude CLI's logged-in `claude.ai` subscription for one bounded task, enable
the mod and launch through its package command:

```sh
/path/to/omd-bin/omd-package mod enable omd_claude_cli
/path/to/omd-bin/omd-package claude --repository /absolute/repository \
  --model claude-sonnet-5 --max-requests 2 --prompt 'Your task'
```

The `--model` choice also accepts `claude-haiku-4-5-20251001`. The optional
`--max-requests` lowers the task limit from eight to one through eight. The mod requires
official Claude CLI `2.1.281` with a first-party Pro or Max login and Node
`24.18.0`. The command rejects inherited API-key and cloud overrides; it has
no API-key fallback. The mod package owns the model catalog, task setup,
request translation, and CLI transport in `index.ts`, `setup.mjs`, and
`transport.mjs`. Its signed assets are checked by the installed mod manager.
The command explicitly selects OMD's solo-evidence workflow with self-review
and self-verification; it does not claim independent review.
The native host retains route admission, process authority, host tool execution,
approvals, task limits, and usage accounting. Local task evidence is written
under the installation prefix's `tasks` directory. Move or retain that evidence
before uninstalling; uninstall refuses to remove an installation containing
task files. OMD Core includes no Claude route or assets.

For a user mod in the OMD Core profile, inspect its `mod.json` and source,
then use the installed `artifacts/omd-mod` binary to inspect, trust its exact
digest and declared capabilities, enable it in the store, and reload. The
authoring and recovery details are in [mods/README.md](mods/README.md). A mod's `error` in status is a failure to
repair or disable, not evidence that its behavior ran successfully.

An existing compatible store can be attached with `--attach-store` during a
new installation. OMD+ attach checks the exact pinned package source digests
and preserves each existing enabled or disabled choice. Use a separate prefix
and launcher directory for a side-by-side candidate upgrade. Removal deletes
only the managed launcher and installation prefix:

```sh
/path/to/omd-bin/omd-package uninstall
```

The mod store and Codex state remain. The installer refuses removal if its
launcher or pinned upstream fallback changed or the prefix contains a user file.
If you explicitly added the
staged plugin marketplace to Codex, remove its plugins and run
`codex plugin marketplace remove oh-my-diff` before uninstall; the installer
refuses to leave a marketplace pointing at a removed directory. Local candidate qualification
and package limits are recorded in `.docs/ROADMAP.md`.

Both profiles include the generic `omd` extension-command dispatcher and the
`omd-contract` selection tool. Their launchers select the installation's mod
store; only explicitly trusted and enabled command exports are available. For
example, `omd COMMAND --repo /absolute/project` routes to the selected
extension. No session-review or memory behavior is built into this binary.
Package installation and activation remain separate. The current host exposes
API `0.2.0-experimental.5`; API 0.1 packages are historical compatibility
fixtures and do not qualify as current package candidates.
