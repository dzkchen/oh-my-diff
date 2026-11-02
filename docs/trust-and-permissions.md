# Trust and permissions

Read this before you turn on a mod. It says what a mod that's on can do, what the [sandbox](#the-sandbox) stops, and
what you agree to when you grant a mod more.

## Installing doesn't turn a mod on

Installing a mod puts it on disk. Turning it on lets it run, starting with your next message. Both steps show the
mod's source, license and the permissions it asks for, and ask you before going on. In `/mods` this summary is the
trust dialog. `omd install` and `omd mods enable` show the same summary in the shell. Trusting a mod means you accept
this exact content with those permissions.

OMD reviews the mods in its curated directory: its first-party mods and its ports, mods adapted from Claude Code
mods. It doesn't review mods from other sources. It shows their permissions and asks before you turn them on.

Trust is bound to a digest (a hash) of the mod's files and the permissions it declares. If either changes, the mod
stops until you trust it again:

- A mod installed from a folder stops after any edit to the folder, even whitespace. Review it again with
  `omd mods update ID`.
- Mods from the curated directory are pinned to a commit and a hash, and OMD refuses a download that differs
  (`package_integrity_failure`).

## What a mod can do

Each permission a mod asks for is a capability: a name in the mod's manifest (`mod.json`), such as `fs.read`. A
capability allows one group of host calls, the requests a mod makes to OMD to read a file, run a program or draw on
screen (see the [glossary](../mods/reference/glossary.md#trust-and-authority)). A mod can make only the host calls
that its capabilities allow and that you trusted. Anything else fails with `capability_denied`. Most capabilities
stay inside Codex's own limits, for example:

- `fs.read` and `fs.write` read and change files in the
  [workspace](../mods/reference/glossary.md#mods-and-the-host), the repository the session works in.
- `exec` runs programs in the session's sandbox, the same one Codex uses for the agent's commands.
- `terminal` draws status lines, panels and dialogs.
- `tools` adds tools the model can call.

The [capabilities reference](../mods/reference/capabilities.md) lists every capability and what it allows.

A mod never calls another mod directly or shares its state. Mods exchange data only through the host, by calling a
service another mod provides with `api.services.call`, or by publishing and subscribing to channel events. A
service provider keeps its own grants and storage. The reference describes
[service dispatch](../mods/reference/host-model.md#service-dispatch-service_dispatch_v1) and
[channels](../mods/reference/events-and-lifecycle.md#channels-and-timers-events_v1).

Codex and the host control the sandbox, approvals and credentials. A mod gets more access only through the authority
grants below.

## The sandbox

Mod code runs outside the `codex` process, in `omd-runner`, OMD's mod runner, which embeds the V8 JavaScript
engine:

- Each mod package gets its own runner processes, never shared with another package.
- Each runner runs under a macOS sandbox profile that denies by default. The runner may start only itself, can't write
  files and has no network.
- V8 runs with a 64 MiB heap, and string evaluation (`eval`) and WebAssembly code generation are off. The host kills a
  runner that uses more than 512 MiB.
- A callback is one call from the host into a mod's code. Every callback except a render hook runs in a fresh
  context, so one call can't leave state behind for the next
  ([callback lifetime](../mods/reference/host-model.md#callback-lifetime)).

Everything a mod does outside its runner, such as reading a workspace file, running a program or drawing a panel, goes
through host calls. The host checks every call against the mod's capabilities and records it. A callback may make up
to 512 host calls, with 1 MiB of arguments and results in total. A mod whose callbacks fail five times in a row is
turned off ([fault limit](../mods/reference/host-model.md#fault-limit)). If a runner crashes, Codex keeps running.
The [limits reference](../mods/reference/limits.md) has every limit.

Programs a mod runs with `exec` use the session's sandbox, so they're limited the way the agent's commands are.

## Authority grants

Some capabilities let a mod act with your own authority, outside the sandbox. These are authority grants, and the
trust dialog says what each one exposes:

| Grant | Lets the mod |
| --- | --- |
| `os` | Run the programs its manifest lists without the sandbox, as your user |
| `approve` | Approve the agent's commands, patches or network requests for you, within a declared scope |
| `http` | Make network requests to the origins its manifest lists |
| `fs.external` | Read and write folders outside the workspace that its manifest lists |
| `mcp` | Connect to the MCP servers (tool servers) its manifest lists |
| `power` | Keep the Mac awake |

The manifest declares each grant's scope, such as which programs or origins. Your trust covers exactly that scope,
so a mod that widens it needs a new trust. The [capabilities reference](../mods/reference/capabilities.md) lists every
grant.

A mod you allow to run programs outside the sandbox can do anything your user account can. A mod allowed to use the
network or approve actions can do so without asking you each time. OMD works this way by design, so turn on only
mods you trust.

## Limit or take back a grant

You can narrow what a mod is trusted with, or take it back later:

- Trust a mod for one project instead of for you: install it with `--scope project`.
- Make grants expire: trust the mod with `omd-mod trust` and `--expires`, as below.
- Take everything back at once: `omd mods revoke ID` turns the mod off and drops its grants. Turning it on again needs
  a new trust.

To trust a mod for one day, use `omd-mod`, the low-level tool that works on a mod store directly
([commands](commands.md#omd-mod)). Print the mod's digest, trust it with an expiry in seconds, then turn it on.
`PACKAGE` is the mod's folder, `SHA256` is the `sha256` value that `inspect` prints, and `CAPABILITIES_CSV` is the
capabilities to grant, comma-separated, such as `fs.read,terminal`. `STORE` is your install profile's mod store
([store paths](commands.md#omd-mod)).

```sh
omd-mod inspect PACKAGE
omd-mod trust STORE PACKAGE SHA256 CAPABILITIES_CSV --expires 86400
omd-mod enable STORE PACKAGE
```

An expired or revoked grant stops the mod's unsandboxed programs and turns its approvals back into questions for you.

## Protect credentials with the authority broker

Without extra setup, mod credentials, the trusted grants and other mod state are files in your mod store, so any
program running as your user can read or change them. On macOS you can protect them with the authority broker.
Install it with `omd-package`, the tool that manages your install profile and the mods it came with. The command
needs `sudo`:

```sh
omd-package broker install
```

The broker runs as a separate system account and stores credentials and secrets. The host then accepts only the
grants the broker confirms, and changing a grant asks you to authenticate in a system dialog.

The broker doesn't protect against an administrator or root, or against files your user can already read, such as
`~/.codex/auth.json`. The [protected authority reference](../mods/reference/protected-authority.md) describes it in
full.

Organizations can also install an administrator policy that controls which mods may run. The
[administrator policy reference](../mods/reference/administrator-policy.md) describes it.

## See also

- [Manage mods](manage-mods.md)
- [Plugins](../plugins/README.md#turn-on-a-component), to trust the mod component a Codex plugin contains
- [Troubleshooting](troubleshooting.md), to turn off a misbehaving mod
- [Security policy](../SECURITY.md)
