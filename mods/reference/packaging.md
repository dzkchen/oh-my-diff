# Packaging

Use it when you plan, install, update, roll back, protect or inspect packages, from the shell with `omd-mod` or
from a mod with `packages.*`. For the author-side commands, see [Authoring](authoring.md). To publish a mod to npm
or Git step by step, see [Publish a mod](https://github.com/dzkchen/oh-my-diff/blob/main/docs/mod-authors/publish-a-mod.md).

## Package commands

This section covers the package commands for install, update and remove; trust, credentials and runner; and selection,
policy and protection.

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
| [`omd-mod credentials STORE`](credentials.md#omd-mod-credentials) | List credential profiles (id, label, kind, provider, origin, status) without secret material |
| `omd-mod credentials STORE add-secret MOD_ID LABEL ORIGIN` | Store stdin as a secret owned by `MOD_ID` (replacing that mod's same-label secret) and print the profile |
| `omd-mod authorize-runner STORE` | With the [authority broker](protected-authority.md) deployed, grant the `omd-runner` beside this `omd-mod` as the store's runner (the installer runs it after each update); without the broker it does nothing |
| [`omd-mod trust-program STORE MOD_ID PROGRAM`](authority-grants.md#os_access-manifest-field) | Pin an unsandboxed program for a mod ahead of time, for headless runs; MOD_ID must be an active mod whose `os_access` lists the program |
| `omd-mod trust-all STORE PACKAGES_JSON` | Trust several exact packages (`[{path, sha256, capabilities, scope?}]`) in one configuration write, so a store protected by the authority broker asks once |
| `omd-mod broker-grants-import STORE [SNAPSHOT_JSON]` | Without a snapshot, capture the exact current configuration. With that unchanged snapshot, protect existing valid selections without changing capabilities, secret grants, expiry, settings or activation; report stale selections as skipped. Also grants the `omd-runner` beside this `omd-mod` as the runner; imports no package-source provenance. |

### Selection, policy and protection

| Command | Result |
| --- | --- |
| `omd-mod selection-status STORE` | Show managed, project and user selections, precedence, administrator refusals, source errors, and each setting's origin without running mod code |
| `omd-mod package-sync STORE [--offline\|--rollback]` | Deploy the [administrator policy](administrator-policy.md)'s packages unattended, or reactivate the previous generation |
| `omd-mod policy show\|clear\|rollback`, `policy check\|set FILE`, `policy explain STORE [PROJECT_DIR]` | Print, validate, store (administrator) or explain the [administrator policy](administrator-policy.md#inspecting-managed-state) |
| `omd-mod package-enable STORE ID` | Re-enable an unchanged trusted package at the next turn boundary, retaining settings and state |
| `omd-mod package-disable STORE ID` | Disable a managed package without deleting source, state, or cache |
| `omd-mod package-quarantine STORE ID REASON` | Disable the package and block its installed version and integrity; enable, reinstall and rollback of it are refused while data, cache and sources stay |
| `omd-mod package-unblock STORE ID` | Lift the blocks; the package stays disabled |
| `omd-mod revoke STORE MOD_ID_OR_PACKAGE` | Disable the mod and drop its grant (capabilities and secret environment cleared) |
| `omd-mod security-events STORE` | Print the store's redacted security log |

## Package requests

This section covers the native `package-plan` and `package-apply` requests, `packages.preview` and `packages.apply`,
package sources and package references.

### Native `package-plan` and `package-apply` requests

For native `package-plan` and `package-apply`, `REQUEST_JSON` is:

```ts
{action?, source, index?, scope?, offline?, trust, settings?}
```

| Field | Meaning |
| --- | --- |
| `action` | `install` (the default) or `update` |
| `trust` | `{packages: {ID: {capabilities, lifecycle?, dependencies?, secret_environment?}}}`: each package needs its exact capability and lifecycle grants, and dependencies need explicit trust too |
| `index` | An index file to resolve `package` sources from; the store's `package-index.json` when omitted |
| `scope` | The selection scope, `user` when omitted |
| `offline` | `true` for an offline install, `false` when omitted |
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

This section covers version and tarball checks, package contents, and registries, tokens and proxies.

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

## Codex configuration (`codex_config_v1`)

A manifest's `codex_config` turns on Codex features the package depends on, for every lead thread the session
starts, resumes or forks while the package is active: `{"codex_config": {"tools.update_plan.enabled": true}}`.

- Keys come from a closed host allowlist (`tools.update_plan.enabled`, `tool_output_token_limit.raise`) and must be
  `true`.
- `tool_output_token_limit.raise` sets the thread's `tool_output_token_limit` to at least 65,536 tokens (about 256 KiB),
  keeping a larger configured value. `exec_command` and `write_stdin` still default to 10,000 tokens unless the call
  sets a larger `max_output_tokens`, which a `tool` interceptor can do. It makes no output smaller or safer: the
  package must budget model-visible outputs itself, or every long output reaches the model whole.
- The package must list `codex_config_v1` in `required_features`.
- Anything else fails inspection with `invalid_codex_config`.

The host recomputes the keys whenever it reloads the active packages (at the next turn boundary after a change), so
a package enabled mid-session applies to lead threads started after that reload; threads that already exist keep
their configuration. It overrides an explicit `false` in the user's config for those threads and writes nothing to
`config.toml`.

Install, update and trust previews and `omd-mod status` list a package's `codex_config` with its other authority.

## Package controls (`package_controls_v1`)

`packages.list`, `packages.index`, `packages.preview`, `packages.apply` and `packages.reload` (`package_controls_v1`)
install, update, remove, roll back, enable and disable packages from local directories, Git repositories, curated index
releases and npm packages (sources and references are listed under [Package sources](#package-sources) and
[Package references](#package-references)); `index` resolves dependencies. A request names its package with `source` or
with a `reference` string and an optional `version`.

### `packages.list`

`packages.list` reports every store selection: managed packages and trusted `omd-mod` selections (`source:
'selection'`, which enable, disable and `trust` but do not update).

- `source` is also `npm` for npm packages.
- `blocked` is the quarantine reason or `null`.
- `packages.list {fields}` keeps only the named keys of each package, so a listing view can skip schemas, settings
  and grants it does not show.
- `packages.list` reports each mod's `settings` and `settings_schema`.
- `required` marks a selection the installer keeps on: `/mods` and `/omd` don't turn it off, `omd mods disable`
  still does.

### `packages.index`

`packages.index {index?, query?, cursor?, limit?}` is read-only and returns:

```ts
{index, packages: [{id, latest, description, support, versions: [{version, blocked}], installed}], total, cursor}
```

It reads the named index (the store's `package-index.json` by default), filtered by `query`, one page of `limit`
entries (1-200, default 200) in id order. `total` counts every match; pass the returned `cursor` to read the next
page, and it is `null` on the last one. Paging requires `package_index_paging_v1`. It fails with
`package_index_unavailable` when no index exists.

### Package state fields

- `effective`, `pending: 'reload'` and `failed` describe the serving session, so a change shows as pending until
  that session's next safe boundary, and a removed mod stays listed with `installed: false` until it stops.
- `reload_error` names a rejected change while the previous mods keep running.

### `packages.apply`, `packages.preview` and `packages.reload`

`apply` and `reload` run from user contexts. The `trust` action re-approves an edited selection's current source and
capabilities and keeps it enabled.

- `apply` shows a native confirmation naming every new grant, dependencies as `id:capability`, and applies exactly
  the confirmed plan or refuses if the package, lock or selection changed.
- Installing never enables a package; see [Enablement on install and update](#enablement-on-install-and-update).
- The preview lists per package `authority {from, to}`, `grant {from, to}` and `renewed_approval`.
- Once a confirmed package mutation starts, it returns its definitive result even if its writes reload or disable
  the calling mod. Queued calls still reject cancellation, changed source, originating generation or client
  context.
- An update resolves dependencies through the index the package came from and previews the capabilities it adds.
- `packages.reload` makes every enabled selection revalidate at the next safe boundary, retrying failed mods.

## Enablement, rollback and history

This section covers enablement on install and update, and rollback and cleanup.

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
  `lifecycle`, `lifecycle_failed` (an uninstall script failed), `managed_deploy`, `managed_sync_refused`
- `package_refused` (with an error code and the stripped source)
- `load_denied` (a selection rejected at reload)

### What the checks don't guarantee

Permissions a user deliberately grants (`os` unsandboxed, network, `approve`, secrets) still run with that authority.
Scanning, integrity checks, signatures and directory inclusion do not make a mod safe, and a trusted service provider
acts with its own authority for any caller.
