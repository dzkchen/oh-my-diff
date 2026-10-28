# Packaging, publishing and offline scenarios

How packages are planned, installed, locked, protected and published, and how `mod.test.json` scenarios test a mod
offline. For the author-side commands, see [Authoring](authoring.md).

## Package commands

### Install, update and remove

| Command | Result |
| --- | --- |
| `omd-mod package-plan STORE REQUEST_JSON` | Resolve and preview the exact graph, per-package authority and grant changes, settings, and enablement |
| `omd-mod package-apply STORE REQUEST_JSON CONFIRMATION` | Re-resolve and atomically apply only the unchanged preview |
| `omd-mod package-lock STORE` | Print exact current versions, sources, integrity, trust, settings, and rollback history |
| `omd-mod package-rollback-plan STORE ID` | Preview the prior integrity-addressed package version |
| `omd-mod package-rollback STORE ID CONFIRMATION` | Restore the prior cached package disabled, preserving explicit settings |
| `omd-mod package-uninstall-plan STORE ID` | Preview removal and reject installed dependents |
| `omd-mod package-uninstall STORE ID CONFIRMATION` | Remove the managed selection while retaining local source, state, cache, and history |
| `omd-mod plugin-preview CODEX_BIN CODEX_HOME NAME@MARKETPLACE CANDIDATE` | Compare a local plugin candidate and its skills/hooks against the installed cache without applying it |

### Trust, credentials and runner

| Command | Result |
| --- | --- |
| `omd-mod credentials STORE` | List credential profiles (id, label, kind, provider, origin, status) without secret material |
| `omd-mod credentials STORE add-secret MOD_ID LABEL ORIGIN` | Store stdin as a secret owned by `MOD_ID` (replacing that mod's same-label secret) and print the profile |
| `omd-mod authorize-runner STORE` | With the authority broker deployed, grant the `omd-runner` beside this `omd-mod` as the store's runner (the installer runs it after each update); without the broker it does nothing |
| `omd-mod trust-all STORE PACKAGES_JSON` | Trust several exact packages (`[{path, sha256, capabilities, scope?}]`) in one configuration write, so a store protected by the authority broker asks once |
| `omd-mod broker-grants-import STORE [SNAPSHOT_JSON]` | Without a snapshot, capture the exact current configuration. With that unchanged snapshot, protect existing valid selections without changing capabilities, secret grants, expiry, settings or activation; report stale selections as skipped. Also grants the `omd-runner` beside this `omd-mod` as the runner; imports no package-source provenance. |

### Selection, policy and protection

| Command | Result |
| --- | --- |
| `omd-mod selection-status STORE` | Show managed, project and user selections, precedence, administrator refusals, source errors, and each setting's origin without running mod code |
| `omd-mod package-sync STORE [--offline\|--rollback]` | Deploy the [administrator policy](safety.md#administrator-policy-and-managed-deployment)'s packages unattended, or reactivate the previous generation |
| `omd-mod policy show\|clear\|rollback`, `policy check\|set FILE`, `policy explain STORE [PROJECT_DIR]` | Print, validate, store (administrator) or explain the administrator policy |
| `omd-mod package-enable STORE ID` | Re-enable an unchanged trusted package at the next turn boundary, retaining settings and state |
| `omd-mod package-disable STORE ID` | Disable a managed package without deleting source, state, or cache |
| `omd-mod package-quarantine STORE ID REASON` | Disable the package and block its installed version and integrity; enable, reinstall and rollback of it are refused while data, cache and sources stay |
| `omd-mod package-unblock STORE ID` | Lift the blocks; the package stays disabled |
| `omd-mod revoke STORE MOD_ID_OR_PACKAGE` | Disable the mod and drop its grant (capabilities and secret environment cleared) |
| `omd-mod security-events STORE` | Print the store's redacted security log |

## Package requests

### Native `package-plan` and `package-apply` requests

For native `package-plan` and `package-apply`, `REQUEST_JSON` is:

```ts
{action?, source, index?, scope?, offline?, trust, settings?}
```

| Field | Meaning |
| --- | --- |
| `action` | `install` (the default) or `update` |
| `trust` | `{packages: {ID: {capabilities, lifecycle?, dependencies?, secret_environment?}}}`: each package needs its exact capability and lifecycle grants, and dependencies need explicit trust too |
| `settings` | Maps package IDs to setting objects; an update preserves existing settings when omitted |

Apply the identical request with the preview's `confirmation` string.

### `packages.preview` and `packages.apply` requests

The higher-level `packages.preview`/`packages.apply` operations and `omd` CLI use:

```ts
{action, id?, source?, reference?, version?, index?, scope?}
```

`action` is one of `install`, `update`, `remove`, `rollback`, `enable`, `disable` or `trust`. A request names a package
with `source` or with a `reference` (and optional `version`), never both.

### Package sources

A `source` is one of:

| `source.kind` | Fields |
| --- | --- |
| `local` | `path` |
| `repository` | `repository`, `revision`, `subdirectory?`; `revision` is a 40-hex commit or a branch or tag name, resolved when the plan is made and locked as the commit (an offline install needs a commit) |
| `package` | `index`, `id`, `version`; `version` is empty (newest unblocked release), exact or `^x.y.z` |
| `npm` | `package`, `version?`, `registry?` (default from the user's npmrc, else `https://registry.npmjs.org`; `https` or loopback `http` only), `integrity?` (a sha512 SRI pin) |

### Package references

A `reference` is the same choice as one string, shared by the `/mods` directory and the `omd` CLI:

| Reference | Meaning |
| --- | --- |
| `ID[@VERSION]` | A release from the curated index |
| `npm:NAME[@VERSION]` | An npm package; scoped names work (`npm:@author/omd-mod@1.2.3`) |
| `git+URL[#REF[:DIRECTORY]]` | A Git repository; `REF` defaults to `HEAD`; `git+file:///path` and a local path work |
| a folder | A local directory (absolute in the directory; `./`, `../`, `~/` or absolute in the CLI) |

Local package files reached through a symlinked directory outside the package are refused (`package_path_escape`).

## npm packages

### Version and tarball checks

npm resolution reads the registry metadata and picks the exact version: empty is `dist-tags.latest`; otherwise an
exact version or `^x.y.z`.

The tarball must match the registry's sha512 `dist.integrity` and is extracted safely:

| Tarball rule | Limit |
| --- | --- |
| Entry types | Regular files only; symlinks, hardlinks and path escapes are rejected |
| Tarball size | At most 4 MiB |
| Unpacked size | At most 16 MiB |
| Entries | At most 1024 |

### Package contents

- Its `package.json` `name` and `version` must match the request.
- `dependencies` must be empty: ship runtime code as the entrypoint and its imported assets (`peerDependencies` and
  `devDependencies` on `@oh-my-diff/mod-api` are fine).
- The package must publish `mod.json` (same version as `package.json`), the entrypoint, the assets and the lifecycle
  scripts.
- npm `scripts` such as `preinstall` and `postinstall` never run. Only the manifest's OMD `lifecycle` scripts run,
  sandboxed and only with an exact grant.

The lock records the exact version and the tarball SRI, and an offline install reuses the content-addressed cache.

### Registries, tokens and proxies

Without `registry`, the host follows the user's npmrc (`$NPM_CONFIG_USERCONFIG` or `~/.npmrc`) like npm and pnpm:
`@scope:registry=`, then `registry=`, then the public registry.

- A `//host/path/:_authToken=` entry (with `${ENV}` expansion) authenticates requests under that prefix. The token
  reaches curl on stdin and never appears in arguments, the lock or the security log.
- Proxy variables (`HTTPS_PROXY`, `NO_PROXY` and lower-case forms) pass through.

## Package indexes

The store's `package-index.json` is the default curated index. An index file is bounded JSON with schema 1:

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
        "integrity": "SHA256_FROM_OMD_MOD_INSPECT",
        "description": "What this release adds",
        "support": "Where to get help"
      },
      {
        "version": "1.2.2",
        "source": { "kind": "npm", "package": "@author/example", "version": "1.2.2" },
        "integrity": "SHA256_FROM_OMD_MOD_INSPECT",
        "blocked": "Reason this release can't be selected"
      }
    ]
  }
}
```

`blocked` (a reason string) makes a release unselectable: planning it fails with `package_version_blocked: REASON`,
and `packages.index` lists it with that reason.

### Index resolution

Resolution selects the highest unblocked exact or caret-compatible semantic version and then checks the index
integrity against the manifest, entrypoint, and every declared lifecycle script.

- Each dependency needs its own exact trust entry.
- Index files do not grant capabilities or script execution.

## Managed package manifests

A managed package manifest must declare `license` and `provenance`; the scaffold emits both with placeholders to
change.

### `provenance.source` for Git installs

- For a Git install, `provenance.source` must equal the repository URL exactly, without the `git+` prefix or
  `#REF:DIRECTORY` suffix. For example, use `https://github.com/author/repo` for
  `git+https://github.com/author/repo#v1.2.3:mod`.
- For a local source such as `git+file:///absolute/repo#REF:mod`, use the repository's canonical absolute filesystem
  path, without `git+`, `file://`, the revision or the mod subdirectory; resolve symlinks first.
- Commit that manifest at the selected Git revision. A mismatch is refused with `repository_provenance_mismatch`.

### Package `description`

An optional `description` of 1–160 printable characters says what the mod adds; `packages.list` and the `/mods`
screen show it.

## Enablement, rollback and history

### Enablement on install and update

**Installing never enables a package.** An update keeps a package on only if it was on and its grant, authority
scopes and origin are unchanged; otherwise it is off until enabled.

`package-plan` shows per package:

| Field | Meaning |
| --- | --- |
| `authority {from, to}` | Exposure text plus the `os_access`, `approves`, `http_access`, `fs_access`, `mcp_servers`, `policy`, `peer_access` and `autonomy` scopes |
| `grant {from, to}` | The grant change |
| `renewed_approval` | True for a new install or a changed grant, authority or origin |
| `state_version {from, to, migration_required, handler_required}` | The state version change |

### Rollback and cleanup

Package rollback repoints the selection at the immutable store cache, so returning to editable local development is a
fresh local install of the rolled-back source.

Successful local package updates retain eight rollback history entries. After commit, the package manager removes
local snapshots evicted from that history when no installed package, retained history, selection or managed
deployment references them.

- Cleanup leaves editable sources and remote package caches alone; uninstall retains its cache.
- This is best-effort cleanup of history evictions, not a store-wide size limit: abandoned previews, older orphaned
  snapshots, interrupted cleanup and deletion failures can retain extra files.

## Protection, recovery and the security log

`omd-mod`'s protection and recovery commands work without any control mod. Quarantine keeps the package's data, cache
and sources, so unblocking and enabling restores it.

`security-events` prints `security-events.jsonl`, bounded to 64 KiB (the oldest half is dropped) and redacted: sources
lose credentials and query strings. Its events:

- `install`, `update`, `uninstall`, `rollback`, `enable`, `disable`, `quarantine`, `unblock`, `revoke`, `trust`,
  `lifecycle`
- `package_refused` (with an error code and the stripped source)
- `load_denied` (a selection rejected at reload)

### What the checks don't guarantee

Permissions a user deliberately grants (`os` unsandboxed, network, `approve`, secrets) still run with that authority.
Scanning, integrity checks, signatures and directory inclusion do not make a mod safe, and a trusted service provider
acts with its own authority for any caller.

## Publish a mod to npm

`omd-mod-author package .` (`pnpm run package`) writes the checked directory `dist/ID-VERSION` with a JavaScript build,
source map and digest report. It doesn't produce a tarball, so check the npm tarball with `pnpm pack`.

1. In `package.json` remove `"private": true` (the scaffold's publish guard) and set the scoped `name` (for example
   `@author/omd-mod`) and a `version` equal to `mod.json`'s; set `license` and `provenance` in `mod.json`.
2. Keep `files` listing `mod.json` and the entrypoint (the scaffold starts with both) and add every declared asset and
   lifecycle script.
3. Keep `dependencies` empty: ship runtime code as the entrypoint and its imported assets, and keep
   `@oh-my-diff/mod-api` a `peerDependency` or `devDependency`.
4. Run `pnpm check`, `pnpm test`, then `pnpm pack`. The tarball must stay under 4 MiB and 1024 entries and list only
   regular files. Inspect it with `tar -tzf *.tgz`.
5. Run `pnpm publish --access public`.
6. Share `npm:@author/omd-mod@1.2.3`; users run `omd install` with it or paste it into `/mods` under Add from source.
   Catalog inclusion isn't needed.

## Offline scenarios

A `mod.test.json` file uses schema 1 and runs a mod with no external work.

### Scenario file fields

| Field | Meaning |
| --- | --- |
| `virtual_time_ms` | Fixes `Date.now()` and zero-argument `new Date()` inside every callback |
| `host_operations` | An ordered result/error queue for each approved host operation |
| `settings` | A map from mod ID to that mod's explicit settings; the author commands apply it through `omd-mod settings` before the run, so configured behaviour is testable offline |
| `packages` | Additional trusted packages, enabling provider/consumer and conflict fixtures without shared globals or ambient authority |
| `tiers` | Maps loaded mod IDs to `prepend` or `append` and runs them as administrator-managed packages in that tier for the scenario only, so a test sees the managed interceptor order and that its answers can't skip a managed required guard |
| `environment` | Nonsecret names mapped to string values (see [Offline environment](#offline-environment)) |

- Any unmocked call fails before external work, and every result records `paid_requests: 0`.
- `expect` is deep equality of the step's whole value, not a subset (`offline_expectation_failed`). A render `intercept`
  result includes `trace[].location` (`index.ts:75:7`), so an exact expectation breaks when lines move: test
  interceptors in a `*.test.ts` file ([TypeScript tests](authoring.md#typescript-tests)).
- A store-level `omd-mod test STORE SCENARIO` uses the store's own settings instead of `settings`.
- A mod that fails to activate reports its retained cause, so a missing service provider, denied capability or source
  error names itself instead of only asking for a reload.

### What steps can do

Every step has a `type`:

| `type` | Meaning |
| --- | --- |
| `invoke` | Calls one mod's tool, command or hook by `mod`, `event` and `name` with `payload` |
| `event` | Dispatches `event` with `payload` to every mod that handles it |
| `tool_outcome`, `agent` | Dispatches a `tool_result` or `agent` lifecycle event |
| `advance_time` | Moves virtual time forward by `ms`, running due timers |
| `wait_until` | Repeats a `check` step as time advances until it equals `until` |
| `reload`, `status` | Reloads the mods at a safe boundary; returns the host's status |
| `state` | Returns (or with `value`, first writes) a mod's persisted `api.state` |
| `tool_exposure` | Returns the tool names the mods expose for a `payload` ledger |
| `terminal_mount`, `terminal_interact` | Draws a mod's terminal view; sends it a `key` or a `component` interaction |
| `component` | Steps one `api.component` module instance |
| `client_attach`, `client_detach` | Adds or removes an external client |
| `intercept` | Runs an interceptor chain for `surface`, answering `next` from `core` |

Steps can:

- advance virtual time;
- invoke tools or commands;
- dispatch ordinary events, interceptor chains (an `intercept` step answers `next` from its `core` replies), tool
  outcomes and agent lifecycle;
- reload at a safe boundary;
- mount a terminal view, and interact with a mounted key or component ID. Component interaction activates buttons,
  inputs, and selectors with an optional `value`; copy actions return without touching the system clipboard.

A step can carry `expect`, `expect_error`, or `cancelled`, and `thread_id` to run in that thread when its payload names
none. Thread-scoped state, timers and component events follow it; the `THREAD` argument of `omd-mod test` binds every
step and takes precedence. In a TypeScript test, pass `threadId` in a step's options.

### Offline environment

`environment` maps nonsecret names to string values (4096 bytes at most) that `environment.read` answers in place of a
`host_operations` queue, so a scenario never reads the host's environment.

- An unlisted name is `{set: false}`.
- A secret-like name (`*KEY*`, `*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `AWS_*`, ...) fails the scenario with
  `offline_environment_secret_name`.

### `state` step

```json
{"type": "state", "mod": ID, "value"?: VALUE, "thread_id"?: ID}
```

Returns that mod's persisted `api.state` from the scenario's store, so `expect` can check it after any step. With
`value` it first writes that state (the mod needs `store`, and the usual state limits apply), seeding a test without a
setup command.

### `component` step

```json
{"type": "component", "mod": ID, "module": NAME, "instance"?: NAME, "props"?: VALUE, "columns"?: 80, "rows"?: 0, "events"?: [...]}
```

Steps one instance of the mod's `api.component` module at the scenario's virtual time, delivering the `key` and
`pointer` events and every due tick, and returns `{tree, post, next_ms}`.

- The instance mounts on its first step and keeps its state until the scenario ends, so `advance_time` steps drive
  `every` ticks.
- The module gets no host authority and its tree is validated as for a terminal.
- `omd-mod test` and `mod_host_check --scenarios` run it like any other step.

### `wait_until` step

```json
{"type": "wait_until", "check": STEP, "until": VALUE, "every_ms": 1000, "max_ms": N}
```

Runs `check`, and while its value differs from `until` advances virtual time by `every_ms` and checks again (at most
256 checks). It returns `{waited_ms, value}` or fails with `offline_wait_timeout` at `max_ms`.

### Pointer and client steps

- A `terminal_interact` `key` runs the view's `keybindings` entry, else the first `key_contexts` binding for that key
  (offline steps have no focus).
- `terminal_interact` also takes `pointer: {column, row, half?, action, button?}` with `component`. The mounting mod
  receives `component_event {kind: 'pointer'}` with `origin: 'user'`, only for a `box`, `image` or `raster` mounted
  with `pointer: true` (`offline_terminal_component_not_pointer`). Adding `client: ID` delivers it as that attached
  client's event (`client`, no `origin`).
- `client_attach {name, renderer?, viewport?, focused?}` adds an external client as `client-1`, `client-2`, ... and
  `client_detach {id}` removes it (`offline_client_not_attached`).
- A mounted `terminal` payload carries the roster as `clients` unless it sets its own.

These steps run the mod's callbacks on fixture data; they are not terminal or client rendering evidence.

### Task-scoped tools and `tool_exposure`

`task_scoped: true` on `api.tool` and the `tool_exposure` event (host feature `task_tool_exposure_v1`) expose optional tools per task.

- Before each sampling step, the event receives the host `ledger`, thread ID, and only the current mod's optional tool
  names. It returns `{enable: [...]}` for a subset of those names.
- A missing or failed decision exposes none of that mod's optional tools; an invalid or foreign name disables the mod
  with a visible error.
- Ordinary registered tools and every native tool keep their existing exposure. A tool still executes through native
  permission, cancellation, accounting, and workflow gates.
- Context contributors can attach a bounded subordinate fragment for the same task without replacing base
  instructions.
- In an offline scenario, `{"type":"tool_exposure", "payload": {...ledger...}}` records the exact names registered for
  that step.
