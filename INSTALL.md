# Installing OMD Core and OMD+

Both profiles use one `install.sh` curl entry point and the same patched host and
author tools. OMD Core supplies the modding ecosystem for user-selected
extensions; OMD+ also contains the selected first-party collection.

| Public profile | Install selector | Runtime identity |
| --- | --- | --- |
| OMD Core | `--profile platform` | `OMD_INSTALL_PROFILE=platform_only` |
| OMD+ | `--profile full` | `OMD_INSTALL_PROFILE=full` |

The selectors are internal names; the public labels and status metadata use
OMD Core and OMD+.

These are local Apple Silicon profiles for the active Codex `0.162.1`
patch. They are not a public release or a qualified default. Build the patched
`codex`, `codex-code-mode-host`, `omd-mod`, `omd`, `omd-contract` and `omd-broker`
executables from `upstream.lock.json` and `runtime/patches/manifest.json`: check
out the pinned Codex tag, run `scripts/normalize_upstream_lock.py` and
`scripts/apply_runtime_patch.py` on it, `cargo build --release` the six binaries,
and sign and pack them with `scripts/release_lock.py`. Use Node 24.18 or a
later 24.x (`mise which node`); any upstream Codex `0.162.x` serves as the
fallback. The OMD Core profile installs the host, mod manager, author
SDK/CLI, a local package-control command, the `omd_logo` presentation mod, the `omd_mods`
control screen and the `omd_update` update notices. It does not change
`CODEX_HOME`, `CODEX_SQLITE_HOME`, the selected Codex account, or project files.
Verify the host and SDK artifacts with
`python3 -m scripts.release_lock --artifact-dir /path/to/release`.

Release artifacts require `build-provenance.json`, written by the build workflow
after a successful build from the verified patch and dependency lock. It binds
the compiler, build arguments, configuration and unsigned binary hashes to the
signed binary hashes. Packaging includes and verifies this record. Old binaries
without a record must be rebuilt; generating a release lock cannot certify them.
This is a local build record, not an independently signed builder attestation.

To create a checksum-bound prebuilt archive and install either profile locally:

```sh
python3 -m scripts.package pack --artifact-dir /path/to/release --output /path/to/omd-package.tar.xz
python3 -m scripts.package install --archive /path/to/omd-package.tar.xz --sha256 PRINTED_SHA256 \
  --upstream /path/to/upstream/codex --profile platform --prefix /path/to/omd-prefix \
  --bin-dir /path/to/omd-bin --store /path/to/omd-mod-store --node "$(mise which node)"
```

Use `--profile full` for the provisional OMD+ collection. The archive is
verified before installation. For an automated patch-and-build install:

```sh
python3 -m scripts.package source-install \
  --repository /absolute/local/codex-mirror --author-archive /path/to/release/mod-api.tgz \
  --output-archive /path/to/source-built-omd-package.tar.xz \
  --upstream /path/to/upstream/codex --profile platform --prefix /path/to/omd-prefix \
  --bin-dir /path/to/omd-bin --store /path/to/omd-mod-store --node "$(mise which node)"
```

Use `--profile full` for OMD+. An
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
python3 -m scripts.profiles --prefix /path/to/omd-prefix --bin-dir /path/to/omd-bin install \
  --profile platform --binary /path/to/patched/codex --manager /path/to/patched/omd-mod \
  --omd /path/to/patched/omd --omd-contract /path/to/patched/omd-contract \
  --author-archive /path/to/release/mod-api.tgz \
  --node "$NODE_PATH" --store /path/to/omd-mod-store
```

`--profile platform` creates a store holding only the `omd_logo` presentation
mod, the `omd_mods` control screen and the `omd_update` notices, all enabled, and launches patched Codex
with `OMD_MODE=omd`. Neither adds task behavior.
User-selected, trusted mods can run without selecting a task workflow contract.
`--profile full` installs the first-party launch collection. A fresh OMD+ store enables
`omd_inspector`, `omd_logo`, `omd_mods`, `omd_update`, `omd_model_picker`,
`omd_plan_removal`, `omd_statusline`, `omd_tool_lines` and `omd_plan_panel`; Codex's
`tui.copy_on_select` setting controls copy on mouse release. The Claude route, LSP synchronization and code
intelligence, workflow, advisor review, `/preview`, frecency file ranking, account and provider profiles,
the privacy policy, the usage HUD and `/continue` (`omd_claude_cli`, `omd_lsp_sync`, `omd_lsp_view`, `omd_workflow`,
`omd_advisor`, `omd_preview`, `omd_frecency`, `omd_profiles`, `omd_privacy`, `omd_usage` and `omd_continue`) are installed but
disabled. Advisor every-turn selection requires its own explicit host policy and allowance;
installation does not activate it. Attaching an
existing store (`--attach-store`, used by installer updates) keeps its
selections and settings, replaces changed first-party package sources with the new release's (re-trusted, and
re-enabled when they were on, also when an earlier attempt stopped between replacing and re-trusting), and adds
newly bundled first-party packages disabled. Each installation keeps a copy of
its first-party sources, so a rollback or an interrupted update restores the store to the active installation's.
`--previous PREFIX` carries the activation choice and route setups of the installation being replaced. Three plugin source packages are available in
`/path/to/omd-prefix/bundles/oh-my-diff`; none is installed into Codex or
started. The upstream `codex-code-mode-host`, built from the same pinned tree,
is installed beside `codex`, because current models run shell commands through
it. External language servers, Python, Bun and other sidecars are absent from
the installed base profile.

The staged plugins are anchored edit, artifact reading and code execution. Their nested
skills and mod components are source inventory, not enabled extensions.
See [plugin setup](plugins/README.md) for each component's separate trust and
activation steps. OMD Core can install the same packages explicitly.

Packages outside this launch collection are not shipped.

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
enables, disables, re-trusts an edited source, browses the directory, installs
any [package reference](#install-and-manage-mods), updates, rolls back, removes
and reloads through native confirmations. Changes
apply at the next turn without a restart. The native `/omd` view is the
recovery path when `/mods` is disabled or broken: it toggles each mod and links
to plugins, skills and hooks. The OMD+ inspector moved to `/inspect`; direct
mode has neither. To disable a broken first-party mod from a shell:

```sh
/path/to/omd-bin/omd-package mod disable omd_inspector
```

`mod disable omd_logo` removes the logo in either profile;
the native `>_ OpenAI Codex (vVERSION)` session header remains.

`omd-package mod enable omd_usage` turns on the provider usage HUD: context,
cache, cost and quota panels and a Usage dialog (Alt+a)
([details](mods/first-party/omd_usage/README.md)).

`omd-package mod enable omd_privacy` turns on a fail-closed final-request policy:
secrets and the PII rules you select become stable opaque placeholders in every
provider-bound request, and shell reads of sensitive paths ask first; `/privacy`
shows the rules and counts ([details](mods/first-party/omd_privacy/README.md)).

`OMD_CONTROLLED_MANIFEST` fails closed on the current host. Configure routes and grants in
the mod store, trust and enable `omd_workflow`, and select the schema-2 contract
with `omd-contract`. Enabling the mod does not select a contract or grant a
provider. The workflow has local synthetic coverage; installed-profile and
live-provider qualification remain separate gates.

The OMD+ profile includes inactive `omd_claude_cli` and `omd_profiles` route mods.
`omd_claude_cli` uses the official Claude CLI's logged-in
`claude.ai` Pro, Max, Team or Enterprise plan, or with `--billing api` its Anthropic Console login; `omd_profiles` switches between ChatGPT
accounts, API keys and compatible providers
([details](mods/first-party/omd_profiles/README.md)). Set a route up once, then launch sessions on it:

```sh
/path/to/omd-bin/omd-package claude --setup
/path/to/omd-bin/omd-package claude --model sonnet
/path/to/omd-bin/omd-package claude --model haiku exec 'Your task'
/path/to/omd-bin/omd-package profiles --setup --add NAME --credential NAME \
  --protocol responses --url URL --upstream-model MODEL
/path/to/omd-bin/omd-package profiles [--model NAME]
```

Setup writes the route's model catalog (the Claude setup first checks the CLI and
reads its context windows),
adds the route's service grant and local token to the store's `host.json`,
enables the mod and makes the managed `codex` launcher define the provider.
Launching adds the provider, model and catalog to an ordinary OMD+ session, so
enabled mods, their data, `/status` and resume work as usual; `--model` takes a
slug, family shortcut or profile name and further arguments go to `codex`. The Claude route
requires official Claude CLI `2.1.296` and keeps inherited API-key and cloud
overrides away from it; the billing source chosen at setup is enforced on every request, with no
fallback between plan limits and API credits. The native host keeps process
authority, tool execution, approvals and usage accounting; each Claude model
call admits one upstream request. `ask_claude: true` gives other leads an
opt-in Claude delegation tool. The package READMEs list each route's limits.
OMD Core includes no route or assets.

For a user mod in the OMD Core profile, inspect its `mod.json` and source,
then use the installed `artifacts/omd-mod` binary to inspect, trust its exact
digest and declared capabilities, enable it in the store, and reload. The
authoring and recovery details are in [mods/README.md](mods/README.md). A mod's `error` in status is a failure to
repair or disable, not evidence that its behavior ran successfully.

An existing compatible store can be attached with `--attach-store` during a
new installation. Attaching replaces changed first-party package sources with the new installation's
and preserves each existing enabled or disabled choice. Use a separate prefix
and launcher directory for a side-by-side upgrade. Removal deletes
only the managed launcher and installation prefix:

```sh
/path/to/omd-bin/omd-package uninstall
```

The mod store and Codex state remain. Direct installation refuses a launcher directory that already holds any of
`codex`, `omd`, `omd-contract`, `omd-mod`, `omd-package` or `omd-mod-author`, dangling links included. Removal
journals itself once its checks pass, so an interrupted `omd-package uninstall` finishes when run again and keeps
any launcher replaced in the meantime. `install.sh uninstall` also removes every older installation, failed
attempts, staged updates and session markers; it refuses, leaving the current installation intact, when an older
one cannot be removed. Once removal of the current installation has started, an interruption leaves the upstream
commands restored and the next installer command finishes the uninstall. The stores under `ROOT/stores` stay, with
the `ROOT/catalog` copies that `/mods` Browse installs of OMD's own mods run from, and the `ROOT/.install.lock`
file that serializes installer commands.

## Install and manage mods

In `/mods`, **Browse the directory** opens a searchable catalog of the curated
index; pick a mod, pick a version (blocked versions are listed separately), choose
**Install for** (me or this project) and review the install. **Add from source**
takes any reference below, and is the fallback when the directory is unavailable.
Installing never enables a mod: review what it exposes, then enable it from its
row. The same flow runs from a shell, with the same preview and approval path:

```sh
omd mods catalog [QUERY]                       # search the curated directory
omd install ID[@VERSION]                       # a directory release
omd install npm:@author/omd-mod@1.2.3          # an npm package (exact version, ^range or latest)
omd install 'git+https://github.com/author/repo#v1.2.3:mod'   # URL#REF:DIRECTORY, REF defaults to HEAD
omd install ./my-mod                           # a folder (./, ../, ~/ or absolute)
omd mods inspect REFERENCE                     # preview without installing
omd mods list                                  # installed mods, with quarantine state
omd mods enable ID                             # also: disable, update, remove, rollback
omd mods events                                # the redacted security log
omd mods reset-lock                            # set an unreadable package lock aside
```

Private and scoped registries come from your npmrc exactly as npm and pnpm read
it (`@scope:registry=…`, `//host/:_authToken=${NPM_TOKEN}`).

Commands take `--scope user|project`, `--store PATH` and `--yes`, and `omd
install` also `--version V`. Install, update, remove, rollback and enable print a preview (source,
integrity, license, capabilities, authority exposure, dependencies, install
scripts, secret environment and an approval note) and ask `Proceed? [y/N]` on a
terminal. Without a terminal they exit with code 2 (`package_approval_required`)
unless `--yes` is given; other failures exit 1. A Git `REF` may be a branch or
tag; the plan locks the commit it resolves to, and an offline install needs a
commit. npm packages need a public registry (`https`, or loopback `http`), are
checked against the registry's sha512 integrity, must have no runtime
`dependencies`, and never run npm install scripts. Sharing and publishing a mod
is described in [mods/REFERENCE.md](mods/REFERENCE.md#publish-a-mod-to-npm).

`omd update` updates OMD itself; `omd mods update ID` updates one mod. An update
keeps a mod on only if it was on and its grant, authority scopes and origin are
unchanged; otherwise enable it again after reviewing the preview.

If a mod misbehaves, stop it from a shell. These work when OMD's TUI or control
mod is broken, because `omd-mod` is native:

```sh
omd mods disable ID                            # stop it, keep grant and data
omd mods quarantine ID "reason"                # disable and block this version and integrity
omd mods revoke ID                             # disable and drop its grant; re-enabling needs a new trust
omd mods unblock ID                            # lift a quarantine (stays off)
/path/to/omd-bin/omd-mod package-disable /path/to/omd-mod-store ID
/path/to/omd-bin/omd-mod package-quarantine /path/to/omd-mod-store ID "reason"
/path/to/omd-bin/omd-mod revoke /path/to/omd-mod-store ID
/path/to/omd-bin/omd-mod security-events /path/to/omd-mod-store
```

A quarantined mod refuses enable, reinstall and rollback but keeps its data,
cache and sources.

Permissions you deliberately grant (`os`/unsandboxed, network, approve, secrets)
still run with that authority. Scanning, integrity checks, signatures and
inclusion in the directory do not make a mod safe, and a trusted service
provider acts with its own authority for any caller.

## Updates

Installations made with `install.sh` update themselves through the same verified transaction. Each release on
GitHub (`dzkchen/oh-my-diff`, tag `vVERSION`) carries the archive and the `omd-release.json` manifest that
`scripts.package pack` writes beside it: version, target, upstream Codex tag, mod API, Node and archive SHA-256. A
release is compatible when its target matches, its Codex minor matches your upstream `codex` and your Node satisfies
it; the newest compatible release on your channel is offered, and a newer incompatible one is reported with its
requirement. Until a release is published, checks report that none is available.

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
and it installs the next time OMD starts with no other session open. **Update now** in `/update` only records a request;
the next OMD launch downloads, verifies and installs the release, once no other session is open. With `omd_update`
disabled in `/mods`, background checks and automatic updates stop, and `omd update` still works.
Automatic updates download in the background and install at launch the same way, and a release that failed once is
not retried automatically. A failed update rolls back and keeps the current version; an update interrupted at any
point is repaired by the next launch or installer command. Updates keep the profile, activation choice, route setups,
settings, credentials, Codex state and user-installed mods; they never update user-installed mods (`omd mods update ID` does), and when enabled
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

Broker installation imports the unchanged configuration's exact valid grants,
including secret grants and expiry, without re-trusting or toggling selections.
Stale selections are skipped. This import does not certify package origins;
source-restricted packages need a verified reinstall after broker deployment.

Organizations restrict and deploy mods with an administrator policy, on either profile:

```sh
/path/to/omd-bin/omd-package policy install policy.json  # sudo; root-owned policy file, keeps the previous one
/path/to/omd-bin/omd-package policy rollback             # sudo; swap back to the previous file
/path/to/omd-bin/omd-package policy remove               # sudo
/path/to/omd-bin/omd-package policy explain              # targets, deployment generation and each mod's scope and refusal
/path/to/omd-bin/omd mods sync [--offline|--rollback]    # deploy the policy's packages to this account's store
```

With the broker deployed, an administrator can keep the policy in the broker instead
(`omd-mod policy set FILE`, one administrator dialog). Existing deployment tools fit
around these commands: an MDM profile or configuration-management run installs OMD and
the policy file as root, then runs `omd mods sync --store STORE` as each user (for example
from a launch agent) against the organization's own folders, Git hosts, npm registry or
mirrored catalog; no hosted fleet service or provider secret is involved. Until that sync
deploys a policy package, every surface the package could intercept fails closed, so
run it right after installing the policy. Mods the policy
deploys can't be turned off in `/mods` or `/omd`; disabling or resetting user mods there
leaves them running. Policy fields, refusals and recovery are in
[mods/REFERENCE.md](mods/REFERENCE.md#administrator-policy-and-managed-deployment).

The installer refuses removal if its
launcher changed, no upstream `codex` that runs remains on `PATH`, or the prefix
contains a user file; an upgraded upstream (for example `brew upgrade codex`) is
fine. With `install.sh`, `status`, `rollback` and `uninstall` also accept
`--upstream /path/to/codex`. A `codex`, `omd`, `omd-contract`, `omd-mod`,
`omd-package` or `omd-mod-author` already in the launcher directory and not
managed by the installer is moved to `NAME.before-omd` and restored on
uninstall. A failed first installation restores those commands and removes new
launchers. Recovery restores commands if installation stopped before activation;
after activation it completes the active installation's launchers.
Rolling back restores the previous generation's binaries, launchers
and first-party mod sources but keeps the rest of the mod store; an older
generation is not guaranteed to read newer store data.
If you explicitly added the
staged plugin marketplace to Codex, remove its plugins and run
`codex plugin marketplace remove oh-my-diff` before uninstall; the installer
refuses to leave a marketplace pointing at a removed directory.

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
API `0.2.0-experimental.5`; API 0.1 packages no longer load.
