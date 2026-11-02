# Use a host integration from a mod

A host integration is a program that runs `codex` inside it, such as herdr or Neovim. This page shows how a mod
finds one and talks to it. The integration announces itself through environment variables (`HERDR_ENV`,
`HERDR_PANE_ID`, `HERDR_BIN_PATH`, `HERDR_SOCKET_PATH`, `NVIM`). A mod reads those variables, then runs the
integration's binary and reaches its socket through the ordinary `exec` grants. There is no separate discovery API.

## Before you begin

- A mod you can build and test, as in [Write your first mod](first-mod.md).
- The [`exec.run` reference](../../mods/reference/running-commands.md) and the
  [`exec_environment` names](../../mods/reference/authority-grants.md#exec_environment-names) rules.

## Declare the variables

In `mod.json`, list the integration's non-secret variables in `exec_environment` and ask for `exec`. Add
`unix_sockets` (experimental) if the integration uses a socket:

```json
{
  "exec_environment": ["HERDR_ENV", "HERDR_BIN_PATH", "HERDR_SOCKET_PATH"],
  "capabilities": ["exec", "unix_sockets"]
}
```

## Read the variables

`environment.read` (experimental) returns the listed values and starts no process. Treat a missing or malformed
value as "no integration" and leave the feature off:

```ts
const read = api.host.tryCall('environment.read', { names: ['HERDR_BIN_PATH', 'HERDR_SOCKET_PATH'] });
const bin = read.ok ? read.value.values.HERDR_BIN_PATH?.value : null;
if (!bin || !bin.startsWith('/')) return;
```

Inherited values are untrusted. Use them only as the steps below describe.

## Run the binary and pass the socket

1. Run the binary named by the variable as an absolute `program`. The host canonicalizes, hashes and sandboxes it.
   Pass the socket variable by name in `unix_sockets`; the mod never supplies the path:

   ```ts
   const run = api.host.call('exec.run', { program: bin, argv: ['COMMAND'], unix_sockets: ['HERDR_SOCKET_PATH'] });
   ```

   Replace `COMMAND` with the integration's own command line.

2. Save `run.program.sha256` and pass it as `sha256` on later calls, so a changed binary fails with
   `exec_program_changed` instead of running.

The host checks each socket value. It must be an absolute, canonical path, outside the repository, to an existing
socket that the current user owns. Otherwise the call fails with `exec_socket_unavailable`. Passing a socket adds no
IP network access.

## See also

- [Running commands](../../mods/reference/running-commands.md#unix_sockets) for `unix_sockets` and the other
  `exec.run` arguments.
- [Capabilities](../../mods/reference/capabilities.md) for what `exec` and `unix_sockets` allow.
