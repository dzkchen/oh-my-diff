# Mod API reference

This reference matches `@oh-my-diff/mod-api` and host API `1.0.0` and Codex `0.163.0`.
`omd-mod status` reports the host version as `omd` (`1.0.0` in OMD `1.0.0`). Only this API version loads. [`api.d.ts`](../api.d.ts) is the complete typed surface.

[`REFERENCE.md`](../REFERENCE.md) has every page below in one file, for agents and search.

## Generated declarations

A store also generates declarations for the running host:

- `active-host.d.ts` describes the running host.
- `installed-contracts.d.ts` describes the service contracts available to consumers.
- `tool-types.d.ts` appears once a session has listed its tools ([Typed tool declarations](authoring.md#typed-tool-declarations)).

## Stability

API `1.0.0` is stable. [The conformance registry](../conformance/contract.json) marks each public operation, event,
capability, interceptor, component, render site, view field, classic hook and author command as frozen or
experimental:

- Frozen entries keep their shape through `2027-10-19`; a breaking change needs a major version and a migration note.
- Experimental ones may change in any release.
- A frozen entry's `experimental_fields` (fields added after 1.0.0, such as the `workspace.watch` `key`) are
  experimental too.

Version and support rules are in [COMPATIBILITY.md](../COMPATIBILITY.md).

Examples of experimental surfaces (the conformance registry, `mods/conformance/contract.json`, is authoritative):

- Raster frame streaming: `terminal.blit`, the `raster` component, `process_raster_v1` and `raster_pixels_v1`.
- Component modules (`api.component`, `component_modules_v1`) and `component_post`.
- The `composer_key` and `mention` interceptors, `completion_tokens_v1` and `history_persist`.
- `sessions.read` with the `sessions_tools` capability, and the `below_composer` site.
- `api.uiState` and command views.
- `routes.write` (`route_write_v1`), added after 1.0.0.

Not provided: closure-based client modules, vendor kill switches, raw secret access, hosted mobile or desktop clients,
rich children inside buttons (a button uses its typed `text`), audio, telemetry and pane drag.

## Contents

| Page | Covers |
| --- | --- |
| [Overview](overview.md) | Mods versus skills, hooks and plugins; what mods can't replace; host lifetime; the transport budget |
| [Capabilities and authority grants](capabilities.md) | Every capability, authority grants, structured access, admission policy |
| [Commands, files and data](exec-files-and-data.md) | `exec.run`, workspace reads and writes, `store.*`, reactive state |
| [Models and routing](models.md) | Routes, the ledger, model requests and streams, request policy, one-shot model calls |
| [Agents, contracts and sessions](agents-and-sessions.md) | Contracts, agents, peers, autonomous turns, submissions, lifecycle events |
| [App bridge, approvals and tools](tools-and-middleware.md) | The app-server bridge, approvals, continuation middleware, tool output, dynamic tools |
| [Processes, kernels and events](processes-and-events.md) | Framed processes, code-mode kernels, adapters, channels and watches |
| [Credentials and threads](credentials-and-threads.md) | Credentials, secrets, the thread store and turn activity |
| [History and compaction](history.md) | Model-bound history, history rewriting, compaction interception |
| [Commands, configuration and composer](commands-and-composer.md) | Commands, configuration, completion, composer drafts, `@` mentions |
| [Terminal UI](terminal-ui.md) | Render hooks, startup presentation, the terminal surface, terminal identity |
| [External clients](external-clients.md) | The `omd-client/1` protocol |
| [Packages, limits and registration rules](packages-and-limits.md) | Binary evidence, package controls, host limits, registration and callback rules |
| [Authoring](authoring.md) | Author commands, typed tools, TypeScript tests, watch, JSX, diagnostics |
| [Packaging, publishing and offline scenarios](packaging.md) | Package commands and sources, npm publishing, `mod.test.json` |
| [Composition and safety](safety.md) | How mods combine, protected authority, administrator policy |
| [Plugin components and shell commands](plugin-components.md) | Plugin components |
