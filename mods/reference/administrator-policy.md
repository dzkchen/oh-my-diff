# Administrator policy and managed deployment

Use it when an organization restricts which mods run, pins and deploys packages with `package-sync`, or recovers
from a managed failure. The policy file and its refusals work on macOS and Linux; storing the policy in the broker
needs [protected authority](protected-authority.md).

An organization restricts and deploys mods through one administrator policy. OMD reads it from the broker (key
`mods`) when the broker is deployed and holds one, otherwise from the root-owned file `/Library/Application
Support/OhMyDiff/policy.json` (`/etc/oh-my-diff/policy.json` on Linux).

## Installing and replacing the policy

- With the broker, `omd-mod policy set FILE` stores the policy in the broker and needs an administrator
  (`dev.ohmydiff.broker.policy`); `policy rollback` swaps it with the value it replaced and `policy clear` removes
  it.
- Without the broker, `omd-package policy install FILE` (sudo) checks the policy and writes the file (mode 0644,
  keeping the replaced one), `policy rollback` swaps them back and `policy remove` deletes it.
- A policy file or folder that isn't owned by root or is writable by anyone else fails with
  `managed_policy_untrusted` and no mod loads until it is fixed.

OMD never contacts a vendor for policy and there is no remote disable: restrictions are an organization's own
decision, made on the machine.

## Policy file example

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

## Policy controls and refusals

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

## Package-source provenance

Package-source provenance binds the package ID, path and content hash in the broker's protected grants.

- Only a verified online package install records it; editable locks, offline cache claims and broker grant import
  cannot establish origin.
- Under source or sideload restrictions, user packages without this evidence stay unloaded, including file-policy
  deployments without a broker.
- Git verification reads fresh fetched objects with isolated configuration; cached URL rewrites, replacement refs
  and editable cached objects cannot certify origin.
- Reinstall from a verified source with the broker deployed to establish evidence.
- Managed packages use the administrator's pins directly.

## Managed `packages` entries

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

## Deploying with `omd-mod package-sync`

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

## Managed load behavior

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

## Inspecting managed state

- `omd-mod policy show` prints the effective policy and its origin.
- `policy check FILE` validates one.
- `policy explain STORE [PROJECT_DIR]` lists the account, each target and whether it is deployed, the deployment
  generation, and every selection with its scope, tier, effective state, refusal and the origin of each setting
  (`managed`, `user` or `default`).
- `status.managed` and `selection-status` report the same; `status.managed.unserved` lists the targets failing
  closed and why, and an unreadable deployment record appears as `managed_error` instead of failing the view.

## Recovery

Recovery stays local and offline. `/omd`, `omd-package mod disable` and `omd-mod reset STORE mods.json` recover
user and project mods; managed packages keep running while the policy lists them. Running the upstream `codex`
recovers from every customization.

When a managed package fails, its required interceptors fail closed (`intercept_required_failed`) until an
administrator changes or rolls back the policy. An administrator's required `model_send` policy does not cover web
search, which final-request policies never see. `omd-mod reset STORE managed.json` then `package-sync` repairs an
unreadable deployment record, and until that sync the policy's targets fail closed as above.
