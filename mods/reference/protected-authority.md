# Protected authority (macOS)

Use it when you deploy or reason about the macOS authority broker: what it protects, how changes are
authenticated, where its trust boundary ends, and how it is pinned, reset and removed. For what a user sees, see
[Trust and permissions](https://github.com/dzkchen/oh-my-diff/blob/main/docs/trust-and-permissions.md).

Without the broker, credential profiles, the trusted grant set, the task ledger and contract state are files in the
mod store, so any process running as the user can read or change them, including an explicitly unsandboxed child,
and `status.authority` reports `unprotected (same-user)`. Agent commands that Codex runs in its sandbox can't reach
the mod store, workspace leases, `host.json` protected paths or secret files; commands it runs without one (approved
escalations, allow rules, full access, an external sandbox) can.

## The broker

`omd-package broker install` (sudo) deploys an OS-separated broker: a LaunchDaemon running as the hidden `_omdbroker`
account owns `/Library/Application Support/OhMyDiff/broker` (mode 0700) and answers on
`/var/run/dev.ohmydiff.broker.sock` only to peers whose kernel audit token resolves to a hardened-runtime binary whose
code directory hash root has pinned. The broker asks the kernel for the running peer's signing status and code directory
hash, never reading the executable, so binaries installed under a private home folder verify too. It also installs a
root LaunchDaemon, `omd-broker power`, that answers only the broker's account on
`/var/run/dev.ohmydiff.broker.power.sock` and does one thing: set `SleepDisabled` for
[power holds](sessions-and-turns.md#power-holds-power_hold_v1) and put the previous value back when the last hold ends,
the broker exits or it restarts after a crash, then sleep the Mac if its lid is closed.

## What the broker protects

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

## Authenticating changes

Changing grants or enrolled credentials makes the broker ask the logged-in user to authenticate in a system dialog
(right `dev.ohmydiff.broker.grant`). Without a GUI login session, for example over SSH, OMD asks for the macOS
login password in the TUI or terminal instead, and the broker checks it against the connecting user's own account.

- Mods can't produce that prompt: their prompts always name the asking mod.
- Each change carries a single-use broker challenge bound to its digest and a generation check, so a stale writer
  is refused.
- Broker policy values need an administrator (`dev.ohmydiff.broker.policy`).

## Trust boundary and limits of the broker

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

## Broker pinning, reset and uninstall

- Installs, upgrades and rollbacks of signed releases pin their binaries (one sudo prompt), and `omd-package broker
  pin` re-pins by hand.
- `omd-package broker reset` clears grants and anchors but keeps credentials.
- `omd-package broker uninstall` removes the daemon, account, rights and all broker state, returning to same-user
  mode.
