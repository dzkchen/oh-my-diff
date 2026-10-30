# Composition and safety

How mods share the single-threaded runtime and compose with each other, how the macOS authority broker protects
credentials and grants, and how an administrator policy restricts and deploys mods. Read it when you reason about
ordering, hook skips, protected authority or managed deployment.

## Runtime waits and hook skips

The mod runtime is single-threaded and never runs re-entrantly. Request and stream hooks wait up to 2 s while
another request or stream hook holds the runtime.

When a non-hook callback holds it, such as a tool waiting for the agent it spawned, a mod-spawned agent's request
and every response stream proceed at once without hooks; other requests wait up to 2 s first.

- Each skip is recorded as `intercept_skipped` with the surface and reason (`mod_callback_in_flight` or
  `mod_runtime_busy`).
- A skipped or unsubscribed stream runs without stream hooks for the rest of that response.
- The middleware log records only selections, transformations and fallbacks, and stops growing at 8 MiB.
- These skips apply to `api.middleware` hooks. Interceptors hold the runtime only while a handler starts or
  settles, never while `next` waits, and follow the required/optional waits of [continuation
  middleware](tools-and-middleware.md#continuation-middleware-continuation_middleware_v1-tool_continuation_v2).

## Service dispatch (`service_dispatch_v1`)

`service_dispatch_v1` keeps a service provider's own capability grants, source identity, storage namespace and
host-operation provenance when a consumer calls it.

- A nested call shares the initiating callback's cancellation, 512-call and 5 s execution budgets.
- Recursive providers and chains beyond eight callback frames fail closed.
- Standalone invocations without a provider-aware host dispatcher refuse that provider's host operation.
- Offline `host_calls` records the actual mod caller for every mocked operation.

## Callback budgets and the clock

The host answers each host call, including `next` and `time.sleep`, inside the running callback, so a callback runs
once and makes at most 512 host calls. Offline runners without an interactive host replay the callback once per
host call instead.

`Date.now()` and `new Date()` return the callback's start time, advanced only by each `time.sleep`'s `slept_ms`,
including in a state-conflict retry.

- `hook_budget_ms` bounds the callback's own JavaScript time.
- A separate 5 s total bounds the callback's JavaScript time plus its waits on terminal operations that need no
  user answer. Exceeding it fails the callback with `callback_execution_budget`.
- Confirmations and prompts may wait longer, and other host operations keep their own timeouts.

## Composition order

Dependencies run before consumers and remaining mods use lexical ID order. Managed scope shadows project scope,
which shadows user scope, without inheriting its state or grants. Observers compose in that order; interceptors
follow the [interceptor order](tools-and-middleware.md#interceptor-order).

Exclusive replacements, contract IDs, service providers, and namespaced tools fail closed when contested. Native
permissions, credentials, accounting, cancellation, evidence, workflow enforcement, and provider authorization
remain outside the mod API.

## Terminal patch composition (`ui_composition_v1`)

Every mod's `terminal` patch composes in the same order (`ui_composition_v1`):

- Sites wrap or replace. A wrap encloses the site's replacement whichever composes first. A site's `overlay` is not
  claimed, so the last patch that sets one wins. Only mod `owner` replaces or wraps its `owner/name` site; any other
  mod's patch for it is refused and reported as a conflict. Native sites keep the rules above.
- Presentation fields merge.
- Exclusive fields (layout, panels, header, footer, placeholder, replaced sites, keys, glyphs and the status
  budget) go to the first claimant. Each later claim is reported in `omd-mod status` under `terminal.conflicts` as
  `{field, owner, rejected, origin}`.
- A patch that breaks the composed view's limits is dropped whole.

## Reuse of `terminal` patches

The host reuses a mod's last `terminal` patch without a callback while its settings, durable state, UI state and
the `terminal` event input are unchanged.

- A patch from a callback that read the clock (`Date.now()` or `new Date()`) is reused for at most one second, so
  elapsed times and countdowns stay current on the next redraw.
- A command's `{terminal}` result likewise stands for at most one second; after that the next view update runs the
  `terminal` handler.

## Protected authority (macOS)

Without the broker, credential profiles, the trusted grant set, the task ledger and contract state are files in the
mod store, so any process running as the user can read or change them, including an explicitly unsandboxed child,
and `status.authority` reports `unprotected (same-user)`. Agent commands that Codex runs in its sandbox can't reach
the mod store, workspace leases, `host.json` protected paths or secret files; commands it runs without one (approved
escalations, allow rules, full access, an external sandbox) can.

### The broker

`omd-package broker install` (sudo) deploys an OS-separated broker: a LaunchDaemon running as the hidden
`_omdbroker` account owns `/Library/Application Support/OhMyDiff/broker` (mode 0700) and answers on
`/var/run/dev.ohmydiff.broker.sock` only to peers whose kernel audit token resolves to a hardened-runtime binary
whose code directory hash root has pinned. The broker asks the kernel for the running peer's signing status and
code directory hash, never reading the executable, so binaries installed under a private home folder verify too.
It also installs a root LaunchDaemon, `omd-broker power`, that answers only the broker's account on
`/var/run/dev.ohmydiff.broker.power.sock` and does one thing: set `SleepDisabled` for [power holds](agents-and-sessions.md#power-holds-power_hold_v1)
and put the previous value back when the last hold ends, the broker exits or it restarts after a crash, then sleep
the Mac if its lid is closed.

### What the broker protects

While the root-owned daemon plist exists, `status.authority` reports `protected (OS-separated broker)` and the
host:

- keeps credential profiles, secrets and sign-in tokens in the broker (enrollment never writes them to the user's
  disk);
- runs mod callbacks only under the `omd-runner` beside the host executable whose path and digest the broker holds
  as a runner grant (`runner_unverified` otherwise, `runner_changed` when the binary changes after verification).
  Only `omd-mod init`, `omd-mod authorize-runner STORE` (the installer runs it after each update) and broker grant
  import grant a runner; trusting or installing packages never does. A missing runner fails with
  `runner_unavailable`, with no fallback to another program. The compiled-module cache in `<store>/cache/code` holds
  only V8 bytecode and is not used while the broker or an administrator policy pins trust: the runner always compiles
  the trusted package source, so the cache never supplies code text. Without the broker, a process that can write
  the store can already change trust through `mods.json`, so the cache adds no authority there;
- accepts a mod selection only when the broker holds the same grant (path, digest, capabilities, scope and secret
  environment), otherwise `grant_not_brokered`; enabling, disabling and settings changes don't touch the grant.
  `trust`, `trust-all`, exact broker grant import and package installs or updates add grants, and only for the
  selections they change, so an entry another process adds to `mods.json` is never granted by an unrelated change.
  Removing a selection revokes its grant without authorization. A running mod whose grant disappears is unloaded at
  the next reload, and all mods unload while the broker can't be reached. The host re-reads grants when `mods.json`
  changes and at most every 2 s otherwise;
- anchors every task-ledger record and contract-state write in the broker and refuses a ledger or contract state
  that differs from its anchor (`evidence_anchor_mismatch`, `contract_state_anchor_mismatch`), including a deleted
  one. State that was never anchored (created before `broker install` or after `broker reset`) is anchored as found
  when it is next opened. A record is written before it is anchored, and a record whose anchor fails is removed;
- fails closed with `authority_broker_unavailable` when the broker can't be reached; mods stay inactive and the
  session continues without them.

### Authenticating changes

Changing grants or enrolled credentials makes the broker ask the logged-in user to authenticate in a system dialog
(right `dev.ohmydiff.broker.grant`). Without a GUI login session, for example over SSH, OMD asks for the macOS
login password in the TUI or terminal instead, and the broker checks it against the connecting user's own account.

- Mods can't produce that prompt: their prompts always name the asking mod.
- Each change carries a single-use broker challenge bound to its digest and a generation check, so a stale writer
  is refused.
- Broker policy values need an administrator (`dev.ohmydiff.broker.policy`).

### Trust boundary and limits of the broker

The trust boundary is the OS plus the pinned binaries. Broker install and pin accept only the helper and binaries
listed in a release manifest signed by the Oh My Diff release key, and later privileged steps run from a root-owned
copy of the broker tooling, so a locally built or replaced binary can't be pinned.

The broker doesn't protect against an administrator or root. Same-user processes can still:

- read every user-readable file (for example `~/.codex/auth.json` or other secret files);
- edit the mod store (the host then rejects what the broker doesn't confirm);
- drive OMD interactively, in which case the authentication dialog still appears;
- use enrolled credentials against their enrolled origins through OMD or a sidecar's gateway path.

Credential tokens leave OMD only toward their enrolled origin, but a mod's own secrets (`OMD_SECRETS`) are placed
in its sidecar's environment, and service grants in `host.json` are user-writable, so a same-user process that
edits a grant can read those secrets. OMD offers no secrets-read API.

### Broker pinning, reset and uninstall

- Installs, upgrades and rollbacks of signed releases pin their binaries (one sudo prompt), and `omd-package broker
  pin` re-pins by hand.
- `omd-package broker reset` clears grants and anchors but keeps credentials.
- `omd-package broker uninstall` removes the daemon, account, rights and all broker state, returning to same-user
  mode.

## Administrator policy and managed deployment

An organization restricts and deploys mods through one administrator policy. OMD reads it from the broker (key
`mods`) when the broker is deployed and holds one, otherwise from the root-owned file `/Library/Application
Support/OhMyDiff/policy.json` (`/etc/oh-my-diff/policy.json` on Linux).

### Installing and replacing the policy

- With the broker, `omd-mod policy set FILE` stores the policy in the broker and needs an administrator
  (`dev.ohmydiff.broker.policy`); `policy rollback` swaps it with the value it replaced and `policy clear` removes
  it.
- Without the broker, `omd-package policy install FILE` (sudo) checks the policy and writes the file (mode 0644,
  keeping the replaced one), `policy rollback` swaps them back and `policy remove` deletes it.
- A policy file or folder that isn't owned by root or is writable by anyone else fails with
  `managed_policy_untrusted` and no mod loads until it is fixed.

OMD never contacts a vendor for policy and there is no remote disable: restrictions are an organization's own
decision, made on the machine.

### Policy file example

```json
{"schema": 1,
 "managed_only": false, "sideload": true, "updates": "user",
 "sources": ["/Library/OhMyDiff/packages/", "npm:https://npm.example.com/@corp/"],
 "deny": ["old_tool"], "capabilities": ["commands", "interception", "store"],
 "index": {"sha256": "…", "locations": ["/Volumes/mirror/index.json", "/Library/OhMyDiff/index.json"]},
 "registry": "https://npm.example.com",
 "packages": [
  {"id": "corp_guard", "source": "corp_guard@2.0.0", "sha256": "…", "capabilities": ["interception"],
   "tier": "append", "settings": {"mode": "strict"}, "percent": 20},
  {"id": "corp_guard", "source": "/Library/OhMyDiff/packages/corp_guard", "sha256": "…",
   "capabilities": ["interception"], "tier": "append",
   "mirrors": ["git+https://git.example.com/guard.git#0123…"]}]}
```

### Policy controls and refusals

The controls apply to user and project selections; packages the policy lists are never refused by them:

| Field | Refusal |
| --- | --- |
| `deny` | `managed_denied`: the mod IDs are revoked. |
| `managed_only` | `managed_only`: only managed packages load. |
| `capabilities` | `managed_capability_denied`: a capability outside the list, for example `approve.override`, is withheld from every unmanaged mod. |
| `sideload: false` | `managed_sideload_denied`: user packages need broker-protected install provenance, and `trust` refuses. |
| `sources` | `managed_source_denied`: installs and loads need an allowed source namespace: a folder path, `git+URL`, `index:PATH#ID` or `npm:REGISTRY/NAME`. Matching requires an exact reference or a `/` or `#` boundary; traversal segments are refused. Loads without protected provenance report `managed_source_unverified`. |
| `updates: "managed"` | `managed_updates_denied`: users can't update or roll back installed packages. |

These refusals apply at every reload, so revoking takes effect immediately, and `/omd` lists them. Approval floors
stay in Codex's managed requirements, which `approve.override` never overrides; the capability list withholds
approval authority itself.

### Package-source provenance

Package-source provenance binds the package ID, path and content hash in the broker's protected grants.

- Only a verified online package install records it; editable locks, offline cache claims and broker grant import
  cannot establish origin.
- Under source or sideload restrictions, user packages without this evidence stay unloaded, including file-policy
  deployments without a broker.
- Git verification reads fresh fetched objects with isolated configuration; cached URL rewrites, replacement refs
  and editable cached objects cannot certify origin.
- Reinstall from a verified source with the broker deployed to establish evidence.
- Managed packages use the administrator's pins directly.

### Managed `packages` entries

Each `packages` entry pins a package's exact content (`sha256`) and its grant (`capabilities`, `dependencies`,
`secret_environment`); the policy is the grant, so a managed package needs no broker grant or user prompt. A policy
can't grant install scripts.

| Entry field | Meaning |
| --- | --- |
| `users` | Lists account names. |
| `percent` | `percent` (1–100) admits a stable share of accounts per package ID. |
| `projects` | Lists folders the session's repository must be inside, compared after resolving symlinks. |
| `tier` | Places the package's interceptors: `prepend` outside every other mod, `append` inside. |

- For each ID the first entry that applies is the target and later entries are fallbacks, so a rollout lists the
  new content first and the current content after it.
- Managed selections take precedence over project and user ones (`shadowed_by_managed_scope`), and `/omd` and
  `omd-mod disable` refuse them (`managed_by_policy`).
- Only the policy grants the managed scope and tiers: a `mods.json` selection that claims either is refused
  (`unsupported_scope`).
- A handler that answers without `next`, other than with a deny, is invalid when a required interceptor of a
  managed package sits beneath it, so other mods can skip optional transforms but never a managed guard.

### Deploying with `omd-mod package-sync`

`omd-mod package-sync STORE` deploys the policy unattended for the account that owns the store, typically from the
organization's own launch agent or configuration tool after it installs the policy; it takes no confirmation.

Every applicable entry, across projects, comes from the content-addressed package cache, otherwise from its
`source` and then each mirror in order, through the normal package resolver:

- `ID@VERSION` uses the first `index` location whose bytes match its sha256.
- `npm:` sources without a registry use `registry` and the user's own `.npmrc` tokens (the policy carries no
  secrets).

These are refused:

- content that differs from the pin (`managed_integrity_mismatch`);
- dependencies the policy doesn't list;
- packages with lifecycle scripts (`managed_lifecycle_requires_approval`, installed interactively instead).

Only when every entry verifies does sync record a new generation in `STORE/managed.json`; otherwise it fails with
`managed_sync_incomplete` and the previous generation stays active. `--offline` uses the cache and local sources
only, and `--rollback` makes the previous generation active again.

### Managed load behavior

- At load, a target that is deployed runs; otherwise a deployed fallback keeps running and `managed_pending_sync`
  is reported.
- Dependencies and their versions are read from hash-verified package manifests, never from editable deployment
  metadata. The dependencies of a running entry load with it under their own policy entry, even when that entry
  doesn't target the account or project.
- Content the policy no longer lists never runs, so removing an entry or changing its pin revokes it at once and an
  administrator's `policy rollback` with an unchanged cache restores the previous generation offline.
- A target with nothing running (not deployed yet, a reset or unreadable `managed.json`, stale content or a package
  that never inspected) fails every interception surface its policy `capabilities` reach closed with
  `intercept_required_failed: ID: REASON` until `package-sync` deploys it, so tool calls stay blocked between
  installing a policy and its first sync; a broken `mods.json` then drops only user and project mods.
- Managed reloads reject broken selections individually so a user mod cannot prevent policy updates.
- If authority cannot be read or authenticated, interception fails closed until authority recovers.
- Generated type-file errors appear in `reload_error` and do not prevent host startup or policy enforcement.

### Inspecting managed state

- `omd-mod policy show` prints the effective policy and its origin.
- `policy check FILE` validates one.
- `policy explain STORE [PROJECT_DIR]` lists the account, each target and whether it is deployed, the deployment
  generation, and every selection with its scope, tier, effective state, refusal and the origin of each setting
  (`managed`, `user` or `default`).
- `status.managed` and `selection-status` report the same; `status.managed.unserved` lists the targets failing
  closed and why, and an unreadable deployment record appears as `managed_error` instead of failing the view.

### Recovery

Recovery stays local and offline. `/omd`, `omd-package mod disable` and `omd-mod reset STORE mods.json` recover
user and project mods; managed packages keep running while the policy lists them. Running the upstream `codex`
recovers from every customization.

When a managed package fails, its required interceptors fail closed (`intercept_required_failed`) until an
administrator changes or rolls back the policy. An administrator's required `model_send` policy does not cover web
search, which final-request policies never see. `omd-mod reset STORE managed.json` then `package-sync` repairs an
unreadable deployment record, and until that sync the policy's targets fail closed as above.
