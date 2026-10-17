# Agent mod guide

For coding agents building an Oh My Diff (OMD) mod. Follow it top to bottom. Everything here is for mod API
`0.2.0-experimental.5`, Codex `0.163.0`, Apple Silicon macOS and Node 24.18 or a later 24.x. The API is
experimental: check `api` in a mod's `mod.json` against this version before reusing older code.

Ground rules:

- Use only what [`api.d.ts`](../mods/api.d.ts) and the [API reference](../mods/REFERENCE.md) document.
- Never trust, enable or install a mod in the user's real store without asking. Work in a scratch store.
- Tests are offline. Don't make paid model calls to test a mod.

## 1. Pick the right kind of extension

| The user wants | Build |
| --- | --- |
| A procedure the model follows | A skill (`SKILL.md`) |
| A reaction to an event, such as a finished turn | A Codex hook |
| Tools or services Codex can call | A plugin, optionally with an MCP server |
| To change how `codex` itself behaves or looks: commands, screens, requests, tool calls | A mod |
| Several of these together | A plugin that bundles skills and a `mod/` component ([step 9](#9-bundle-a-mod-in-a-plugin)) |

See [Mods, plugins and hooks](../mods/REFERENCE.md#mods-plugins-and-hooks) for what a mod can't replace.

## 2. Check the tools

```sh
command -v omd-mod-author omd-mod omd
node --version                  # v24.18 or later 24.x
pnpm --version
```

If `omd-mod-author` is missing, OMD isn't installed: see [Install](install.md).

From a source checkout instead of an install, run the author CLI from the repository and point it at an
`omd-mod` binary from a release archive:

```sh
pnpm --dir mods install
export OMD_MOD_BIN=/absolute/path/to/omd-mod
omd-mod-author() { node /absolute/path/to/checkout/mods/author/cli.mjs "$@"; }
```

Run these in the same shell as the later steps. Use the `omd` binary from the same archive in step 7. Node prints
an `ExperimentalWarning` for `stripTypeScriptTypes` on each command; it's harmless.

## 3. Create the mod

```sh
omd-mod-author create ./notes notes
cd notes
```

The ID is lowercase letters, digits and `_`, up to 24 characters. This writes:

| File | Purpose |
| --- | --- |
| `mod.json` | Manifest: ID, version, API, permissions |
| `index.ts` | Code. `export default function activate(api)` registers everything. |
| `mod.test.json` | Offline scenario run by `pnpm test` |
| `debug.test.json` | A failing scenario that shows how errors look |
| `package.json`, `tsconfig.json` | Scripts and the local SDK |

Add TypeScript once so `pnpm check` checks types:

```sh
pnpm add -D typescript@5.9.3
```

To start from a bigger working mod, copy one: `omd-mod-author example ./release_check release_check` (or
`examples ./examples` for all 15). `release_check` shows tools, a command, stream interception and a list view;
`reactive_dashboard` shows reactive state and a terminal view.

## 4. Write the code

This mod keeps notes. The model adds them with a tool, the user clears them with `/notes:clear`, and a line above
the prompt shows the count.

`index.ts`:

```ts
import type { Json, ModAPI, TerminalPatch } from '@oh-my-diff/mod-api';

type Notes = string[];

export default function activate(api: ModAPI) {
  const notes = (): Notes => (Array.isArray(api.state.get()) ? (api.state.get() as Notes) : []);
  const limit = Math.max(1, Math.floor(Number(api.settings.max_notes ?? 20)));

  api.tool({
    name: 'add', label: 'Add note', description: 'Save a short note for the user.',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
  }, (input): Json => {
    const text = String((input as { text?: unknown }).text ?? '').trim();
    if (!text) return { error: 'empty note' };
    const next = [...notes(), text].slice(-limit);
    api.state.set(next);
    return { saved: text, count: next.length };
  });

  api.tool({
    name: 'list', label: 'List notes', description: 'List the saved notes.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  }, () => ({ notes: notes() }));

  api.command('clear', () => {
    api.state.set([]);
    return { display: 'Notes cleared' };
  }, { description: 'Delete every saved note' });

  api.on('terminal', (): TerminalPatch => ({
    sites: { above_composer: { mode: 'wrap', components: [
      { type: 'slot' },
      { type: 'text', id: 'notes_count', label: 'Notes', text: `${notes().length} saved`, tone: 'muted' },
    ] } },
  }));
}
```

`mod.json` lists every permission the code uses. A host call or registration without its capability fails with
`capability_denied`:

```json
{
  "schema": 1,
  "id": "notes",
  "version": "0.1.0",
  "api": "0.2.0-experimental.5",
  "state_version": 1,
  "description": "Notes the model can save, shown above the prompt",
  "license": "MIT",
  "provenance": { "maintainer": "Your name", "source": "https://github.com/you/notes" },
  "capabilities": ["tools", "commands", "store", "terminal"],
  "settings_schema": {
    "type": "object",
    "properties": { "max_notes": { "type": "number", "default": 20 } },
    "additionalProperties": false
  }
}
```

The code reads settings from `api.settings`. A setting property may have only `type` (`boolean`, `number`,
`string`, `array`, `object` or `null`), `enum` and `default`; `integer`, `minimum` and similar keys are refused.

Where to look things up:

| To | Read |
| --- | --- |
| Pick capabilities | [Capabilities](../mods/REFERENCE.md#capabilities) |
| Add commands and settings | [Commands and configuration](../mods/REFERENCE.md#commands-and-configuration-command_config_middleware_v1), [registration rules](../mods/REFERENCE.md#registration-view-and-callback-rules) |
| Observe or change events, tool calls and model requests | [Lifecycle events](../mods/REFERENCE.md#lifecycle-events-and-classic-hooks-lifecycle_events_v1), [continuation middleware](../mods/REFERENCE.md#continuation-middleware-continuation_middleware_v1-tool_continuation_v2), [model requests](../mods/REFERENCE.md#model-requests-and-streams-model_turn_interception_v1) |
| Keep state | [Durable data](../mods/REFERENCE.md#durable-data-store-and-evidence), [reactive state](../mods/REFERENCE.md#reactive-state-reactive_state_v1) |
| Draw on screen | [Terminal surface](../mods/REFERENCE.md#terminal-surface-terminal_surface_v1-terminal_media_v1-terminal_prompt_v1-terminal_pty_v1), [render hooks](../mods/REFERENCE.md#render-hooks-render_hooks_v1) |
| Route models and run agents | [Routes](../mods/REFERENCE.md#routes), [agents](../mods/REFERENCE.md#agents), [one-shot model calls](../mods/REFERENCE.md#one-shot-model-calls-and-forks-model_complete_v2) |
| Read and write files | [Workspace reads and transactions](../mods/REFERENCE.md#workspace-reads-transactions-and-write-observation) |
| Run persistent code cells | [Code mode kernels](../mods/REFERENCE.md#code-mode-kernels) |
| Combine with other mods | [Composition and safety](../mods/REFERENCE.md#composition-and-safety) |
| Stay within limits | [Host limits](../mods/REFERENCE.md#host-limits) |

Rules that trip agents up:

- No `import` statements except types from `@oh-my-diff/mod-api`; the whole mod is one entrypoint of at most 64 KiB.
- Don't write `process.` outside a string, or `window.` or `document.` anywhere. Node and browser globals aren't
  there, and the source check refuses them.
- Name host operations literally: `api.host.call('store.get', …)`, not a variable.
- No `Date.now()` in host call arguments; the host replays callbacks.
- Return refusals as values, such as `{ error: '…' }`. Five uncaught failures in a row turn the mod off.

## 5. Test it offline

Replace `mod.test.json`:

```json
{
  "schema": 1,
  "settings": { "notes": { "max_notes": 2 } },
  "steps": [
    { "type": "invoke", "mod": "notes", "event": "tool", "name": "add", "payload": { "text": "one" },
      "expect": { "saved": "one", "count": 1 } },
    { "type": "invoke", "mod": "notes", "event": "tool", "name": "add", "payload": { "text": "two" },
      "expect": { "saved": "two", "count": 2 } },
    { "type": "invoke", "mod": "notes", "event": "tool", "name": "add", "payload": { "text": "three" },
      "expect": { "saved": "three", "count": 2 } },
    { "type": "invoke", "mod": "notes", "event": "tool", "name": "list", "payload": {},
      "expect": { "notes": ["two", "three"] } },
    { "type": "invoke", "mod": "notes", "event": "command", "name": "clear", "payload": null,
      "expect": { "display": "Notes cleared" } }
  ]
}
```

```sh
pnpm check       # syntax and types
pnpm test        # mod.test.json, plus any *.test.ts or *.test.mjs files
pnpm run run     # the same scenario, printing each step
pnpm debug       # debug.test.json: shows how a failing step is reported
```

`settings` sets each mod's settings for the scenario. A host call the scenario doesn't mock fails the test. Mock
one with `host_operations`, an ordered list of results per operation; see
[Offline scenarios](../mods/REFERENCE.md#offline-scenarios) and
[TypeScript tests](../mods/REFERENCE.md#typescript-tests).

## 6. Run it in `codex`

Use a scratch store so the user's real mods are untouched:

```sh
omd-mod init /tmp/notes-store "$(mise which node)"
pnpm watch /tmp/notes-store --once
```

`watch` inspects, trusts and turns on the mod in that store, queues a reload for a running `codex`, and copies type
declarations into `.omd/`. Drop `--once` to reload on every save. `node` must be a real Node binary, not a
version-manager shim.

Try a command or the test scenario against the store, without `codex`:

```sh
omd-mod command /tmp/notes-store notes clear null      # {"display": "Notes cleared"}
omd-mod test /tmp/notes-store mod.test.json
```

Then the user starts `codex` on that store and tries it:

```sh
OMD_MODE=omd OMD_MOD_STORE=/tmp/notes-store OMD_NODE="$(mise which node)" ~/.local/share/oh-my-diff/current/prefix/artifacts/codex
```

To see what the host did:

```sh
omd-mod status /tmp/notes-store        # each mod's state and negotiated features
omd-mod-author report /tmp/notes-store # recent callbacks, failures and denials
omd-mod-author explain 'capability_denied: exec'
```

## 7. Install, update and remove

Ask the user before installing into their real store. Install, enable, update and remove show the mod's
permissions and ask `Proceed? [y/N]`; disable doesn't ask. Run from the folder that contains `notes/`:

```sh
pnpm --dir notes run package # writes notes/dist/notes-0.1.0/
omd install ./notes          # installs it, still off
omd mods enable notes        # turns it on from the next message
omd mods update notes        # after changing the code
omd mods disable notes       # off, data kept
omd mods remove notes
```

To rehearse on a scratch store first, add `--store /tmp/install-store` to each command (use a different store from
step 6, where `watch` already turned the mod on). In a non-interactive shell, `--yes` answers the prompt; pass it
only after the user agrees. `omd install --scope project ./notes` installs it for the current project only; it
overrides the same mod installed for the user.

## 8. Recover

| Problem | Fix |
| --- | --- |
| The mod breaks `codex` | `omd mods disable notes` from any shell, or `/omd` inside `codex` |
| `codex` won't start with mods | `omd-package activate direct`, then `omd-package activate full` once fixed |
| Bad state after a change | Bump `state_version` and add a `migrate` handler ([compatibility](../mods/COMPATIBILITY.md#state-changes)) |
| A denial you don't understand | `omd-mod-author explain 'DENIAL TEXT'` |

More repairs are in [Install and manage mods](manage-mods.md#when-a-mod-misbehaves).

## 9. Bundle a mod in a plugin

A plugin can ship skills and a mod together. [`omd-anchored-edit`](../plugins/bundled/oh-my-diff/plugins/omd-anchored-edit)
is a complete example:

```text
omd-anchored-edit/
  .codex-plugin/plugin.json    # the Codex plugin; "skills": "./skills/"
  .codex-plugin/omd.json       # {"schema": 1, "component": "mod", "sha256": "…"}
  skills/omd-anchored-edit/SKILL.md
  mod/mod.json
  mod/index.ts                 # tools: read, search, edit
```

Installing the plugin doesn't run its mod. The user turns the mod on separately:

```sh
omd-package plugins
codex plugin add omd-anchored-edit@oh-my-diff
omd-mod plugin-component PLUGIN_ROOT              # prints the component path
omd-mod inspect COMPONENT_PATH                    # prints its sha256
omd-mod trust STORE COMPONENT_PATH SHA256 tools,fs.read,fs.write,exec
omd-mod enable STORE COMPONENT_PATH
```

See [Plugin components](../mods/REFERENCE.md#plugin-components-and-shell-commands).

## 10. Share it

Follow [Share it](write-a-mod.md#5-share-it) and [Publish a mod to npm](../mods/REFERENCE.md#publish-a-mod-to-npm),
with `notes` in place of `my_mod`. Publishing is public: ask the user first.

## What is supported

- **Installed and on:** the default OMD+ mods in [the collection](collection.md).
- **Installed, off until turned on:** the opt-in OMD+ mods and the three plugins.
- **Experimental:** the whole mod API until `1.0.0`, and in particular the `workspace` and `process`
  capabilities, raster and `terminal.blit` frames, and `omd/*` external-client methods.
- **Not supported:** anything not in `api.d.ts`, calling another mod directly, and Linux or Intel macOS.
