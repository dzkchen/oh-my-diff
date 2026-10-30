# Trust and permissions

What a mod can do once you turn it on, what the sandbox stops, and what you agree to when you grant a mod more. This
is the one place OMD's docs explain trust; other pages link here.

## Installing doesn't turn a mod on

Installing a mod puts it on disk. Turning it on lets it run, from your next message. Each step shows the source, the
license and the permissions the mod asks for, and asks you first. In `/mods` this is the trust dialog; `omd install`
and `omd mods enable` show the same summary in the shell. Trusting a mod means you accept this exact content with
those permissions.

Trust is bound to a digest of the mod's files and the permissions it declares. If either changes, the mod stops until
you trust it again:

- A mod installed from a folder stops after any edit to the folder, even whitespace. Review it again with
  `omd mods update ID`.
- Curated mods are pinned to a commit and a hash, and OMD refuses a download that differs
  (`package_integrity_failure`).

OMD reviews the first-party mods and ports in its curated directory. It doesn't review mods from other sources: it
shows their permissions and asks before you turn them on.

## What a mod can do

A mod can only make the host calls its manifest lists as capabilities and you trusted. Anything else fails with
`capability_denied`. Most capabilities stay inside Codex's own limits, for example:

- `fs.read` and `fs.write` read and change files in the workspace.
- `exec` runs programs in the session's sandbox, the same one Codex uses for the agent's commands.
- `terminal` draws status lines, panels and dialogs.
- `tools` adds tools the model can call.

A mod never calls another mod directly or shares its state. Mods talk only through the host: a mod calls a service
another mod provides with `api.services.call`
([service dispatch](../mods/reference/host-model.md#service-dispatch-service_dispatch_v1)), and it can publish and
subscribe to channel events ([channels](../mods/reference/events-and-lifecycle.md#channels-and-timers-events_v1)).
The provider keeps its own grants and storage. Codex and the host keep the sandbox, approvals and
credentials; a mod gets more only through the authority grants below. The
[capabilities reference](../mods/reference/capabilities.md) lists every capability and what it grants.

## The sandbox

Mod code runs in separate `omd-runner` processes under a macOS sandbox profile. A runner can't write files, use the
network or start other programs. Everything it does outside the runner goes through host calls, which the host checks
against the mod's capabilities.

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
| `mcp` | Connect to the MCP servers its manifest lists |
| `power` | Keep the Mac awake |

The manifest declares each grant's scope, and trust binds it, so a wider scope needs a new trust. The
[capabilities reference](../mods/reference/capabilities.md) lists every grant.

A mod you allow to run programs outside the sandbox can do anything your user account can. A mod allowed to use the
network or approve actions really can. That's by design, so only turn on mods you trust.

## Limit or take back a grant

- Trust a mod for one project instead of for you: install it with `--scope project`.
- Make grants expire: `omd-mod trust ... --expires SECONDS`.
- Take everything back at once: `omd mods revoke ID` turns the mod off and drops its grants. Turning it on again needs
  a new trust.

An expired or revoked grant stops the mod's unsandboxed programs and turns its approvals back into questions for you.

## Mod components in plugins

Three of the OMD+ plugins contain a mod component. Adding the plugin with `codex plugin add` doesn't run it: you
inspect, trust and enable the component separately, and removing the plugin doesn't disable a component you trusted.
[Plugins](../plugins/README.md) has the steps.

## Protect credentials with the authority broker

Without extra setup, mod credentials, the trusted grants and other mod state are files in your mod store, so any
program running as your user can read or change them. On macOS, `omd-package broker install` (needs `sudo`) deploys an
OS-separated broker. It runs as a separate system account, holds credentials and secrets, and makes the host accept
only the grants it confirms. Changing a grant asks you to authenticate in a system dialog. The broker doesn't protect
against an administrator or root, or against files your user can already read, such as `~/.codex/auth.json`. The
[protected authority reference](../mods/reference/protected-authority.md) describes it in full.

Organizations can also install an administrator policy that controls which mods may run; see the
[administrator policy reference](../mods/reference/administrator-policy.md).

## See also

- [Manage mods](manage-mods.md)
- [Troubleshooting](troubleshooting.md), to turn off a misbehaving mod
- [Security policy](../SECURITY.md)
