# Protected authority (macOS)

Use it when you deploy or reason about the macOS authority broker: what it protects, how changes are
authenticated, where its trust boundary ends, and how it is pinned, reset and removed. For what a user sees, see
[Trust and permissions](https://github.com/dzkchen/oh-my-diff/blob/main/docs/trust-and-permissions.md).

Host behavior outside the mod API. macOS only: the broker is a LaunchDaemon.

## The broker

`omd-package broker install` (sudo) deploys an OS-separated broker as two LaunchDaemons:

| Daemon | Runs as | Socket | Answers |
| --- | --- | --- | --- |
| The broker | The hidden `_omdbroker` account, which owns `/Library/Application Support/OhMyDiff/broker` (mode 0700) | `/var/run/dev.ohmydiff.broker.sock` | Pinned hardened-runtime binaries (see below) |
| `omd-broker power` | root | `/var/run/dev.ohmydiff.broker.power.sock` | Only the broker's account |

The broker answers a peer only when the peer's kernel audit token resolves to a hardened-runtime binary whose code
directory hash root has pinned. The broker asks the kernel for the running peer's signing status and code directory hash
and never reads the executable, so binaries installed under a private home folder verify too.

`omd-broker power` does one thing: it sets `SleepDisabled` for
[power holds](sessions-and-turns.md#power-holds-power_hold_v1). It restores the previous value when the last hold
ends, when the broker exits, or when `omd-broker power` restarts after a crash. It then sleeps the Mac if the lid is
closed.

## Without the broker

Without the broker, credential profiles, the trusted grant set, the task ledger and contract state are files in the
mod store. Any process running as the user can read or change them, including an explicitly unsandboxed child, and
`status.authority` reports `unprotected (same-user)`.

Agent commands that Codex runs in its sandbox can't reach the mod store, workspace leases, `host.json` protected
paths or secret files. Commands Codex runs without its sandbox (approved escalations, allow rules, full access, an
external sandbox) can reach them.

## What the broker protects

While the root-owned daemon plist exists, `status.authority` reports `protected (OS-separated broker)` and the host
protects credentials, the runner, grants and the ledger as below. When the broker can't be reached, the host fails
closed with `authority_broker_unavailable`: mods stay inactive and the session continues without them.

### Credentials and secrets

The broker stores credential profiles, secrets and sign-in tokens; enrollment never writes them to the user's disk.
A mod's own secrets do leave the broker: `sidecars.start` places them in the sidecar's environment
(`OMD_SECRETS`), so a same-user process can read them as described in
[Trust boundary and limits of the broker](#trust-boundary-and-limits-of-the-broker).

### Runner grants

Mod callbacks run only under the `omd-runner` beside the host executable whose path and digest the broker stores as
a runner grant.

- Only `omd-mod init`, `omd-mod authorize-runner STORE` (the installer runs it after each update) and broker grant
  import grant a runner; trusting or installing packages never does.
- A runner that doesn't match fails with `runner_unverified`, and `runner_changed` when the binary changes after
  verification. A missing runner fails with `runner_unavailable`, with no fallback to another program.
- The compiled-module cache in `<store>/cache/code` contains only V8 bytecode. While the broker or an administrator
  policy pins trust, the runner ignores the cache and compiles the trusted package source. Otherwise the runner uses
  the cache. That adds no authority, because a process that can write the store can already change trust through
  `mods.json`.

### Selection grants

The host accepts a mod selection only when the broker has the same grant (path, digest, capabilities, scope and
secret environment), otherwise `grant_not_brokered`. Enabling, disabling and settings changes don't touch the grant.

- `trust`, `trust-all`, exact broker grant import and package installs or updates add grants, and only for the
  selections they change, so an entry another process adds to `mods.json` is never granted by an unrelated change.
- Removing a selection revokes its grant without authorization.
- A running mod whose grant disappears is unloaded at the next reload, and all mods unload while the broker can't be
  reached.
- The host re-reads grants when `mods.json` changes and at most every 2 s otherwise.

### Ledger and contract anchors

The broker anchors every task-ledger record and contract-state write. The host refuses a ledger or contract state
that differs from its anchor, including a deleted one (`evidence_anchor_mismatch`,
`contract_state_anchor_mismatch`).

- State that was never anchored (created before `broker install` or after `broker reset`) is anchored as found when
  it is next opened.
- A record is written before it is anchored, and a record whose anchor fails is removed.

## Authenticating changes

Changing grants or enrolled credentials makes the broker ask the logged-in user to authenticate in a system dialog
(right `dev.ohmydiff.broker.grant`). Without a GUI login session, for example over SSH, OMD asks for the macOS
login password in the TUI or terminal instead, and the broker checks it against the connecting user's own account.

- Mods can't produce that prompt: their prompts always name the asking mod.
- Each change includes a single-use broker challenge bound to its digest and a generation check, so a stale writer
  is refused.
- Broker policy values need an administrator (`dev.ohmydiff.broker.policy`).

## Trust boundary and limits of the broker

The trust boundary is the OS plus the pinned binaries. Broker install and pin accept only the helper and binaries
listed in a release manifest signed by the Oh My Diff release key. Later privileged steps run from a root-owned copy
of the broker tooling. As a result, a locally built or replaced binary can't be pinned.

The broker doesn't protect against an administrator or root. With the broker deployed, a process running as the same
user can and can't do the following:

| Asset | A same-user process can | It can't |
| --- | --- | --- |
| Grants | Edit `mods.json`, and remove a selection, which revokes its grant | Add or widen a grant without the broker's authentication dialog (the host rejects it with `grant_not_brokered`) |
| Credential tokens | Use enrolled credentials against their enrolled origins, through OMD or a sidecar's gateway path | Read a token, or send it to another origin |
| Mod secrets (`OMD_SECRETS`) | Read a mod's secrets by editing its service grant in the user-writable `host.json`, because the secrets are placed in the sidecar's environment | Read them through an OMD API; OMD offers no secrets-read API |
| Ledger and contract state | Edit or delete the files | Make the host accept them: a record that differs from its anchor is refused |
| The runner | Replace the `omd-runner` binary | Run mod callbacks under it (`runner_changed`) |
| Files and the TUI | Read every user-readable file (for example `~/.codex/auth.json` or other secret files) and drive OMD interactively | Skip the authentication dialog, which still appears for each change |

## Broker pinning, reset and uninstall

- Installs, upgrades and rollbacks of signed releases pin their binaries (one sudo prompt), and `omd-package broker
  pin` re-pins by hand.
- `omd-package broker reset` clears grants and anchors but keeps credentials.
- `omd-package broker uninstall` removes the daemon, account, rights and all broker state, returning to same-user
  mode.
