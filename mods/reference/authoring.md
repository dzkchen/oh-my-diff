# Authoring

Use it when you look up an author command, the TypeScript test helpers, the `mod.test.json` format, JSX
compilation, multi-file packages, diagnostics or the cost report. For the step-by-step author loop, see
[Write your first mod](https://github.com/dzkchen/oh-my-diff/blob/main/docs/mod-authors/first-mod.md). For packaging and publishing, see
[Packaging](packaging.md).

## Author commands

| Command | Result |
| --- | --- |
| `omd-mod-author create DIR [ID]` | Minimal typed package with pnpm scripts and offline tests |
| `omd-mod-author example DIR NAME` | Copy one named author example into a new project |
| `omd-mod-author examples DIR` | Every public author example |
| `pnpm check` | Syntax validation, plus strict validation against this exact SDK when TypeScript is installed; prints `check: ok` when it passes |
| `pnpm test` | Engine-owned scenario execution with no provider requests, then (once TypeScript is installed) the `pnpm check` type check, which fails the run before the report prints, then every `*.test.ts` and `*.test.mjs` beside `mod.test.json` under `node --test` (see [TypeScript tests](#typescript-tests)) |
| `pnpm run run` | Runs the same deterministic scenario and prints the full trace |
| `pnpm debug` | Runs an intentional failure and retains its mapped source location |
| `pnpm run package` | Produces a checked package directory, JavaScript debug build, source map, and digest report |
| `omd-mod-author cost DIR [COMMAND [ARGS_JSON]] [--runs N]` | Activation, first render, callback time, runner count and runner footprint of one package (see [Cost report](#cost-report)) |
| `pnpm watch STORE` | Re-inspects reviewed local source, approves the edited digest, queues reload, and copies the store's declarations into `.omd/` (see [Watch and reload](#watch-and-reload)) |
| `omd-mod-author report STORE` | Declared-versus-used capabilities, services, operations, and environment |
| `omd-mod-author events STORE` | Composition order, scope precedence, events, replacements, and conflicts |
| `omd-mod-author diagnostics STORE [OUTPUT]` | Reproducible JSON bundle with paths, settings, environment, and credentials removed |
| `omd-mod-author explain DENIAL` | Cause, safe remedy, and the authority boundary for a denial |

### Author toolchain

- The `omd-mod` binary is part of the OMD engine. Set `OMD_MOD_BIN` only when a development build is not already on
  `PATH`.
- Set `OMD_MOD_NODE` to the supported Node 24.x executable, 24.18 or later. [Support](https://github.com/dzkchen/oh-my-diff/blob/main/docs/support.md) lists
  the supported versions.
- pnpm is the package manager. The repository also publishes equivalent `mise run mods:*` tasks without making pnpm a
  mise tool.

## Generated declarations

A store also generates declarations for the running host:

- `active-host.d.ts` describes the running host.
- `installed-contracts.d.ts` describes the service contracts available to consumers.
- `tool-types.d.ts` appears once a session has listed its tools ([Typed tool declarations](#typed-tool-declarations)).

## Typed tool declarations

A running host stores the lead thread's tool inventory (`tools.list`) in its store. `omd-mod declarations STORE`
renders it as `tool-types.d.ts`: a module augmentation of the empty `ToolArguments` interface, keyed by tool name.

Each tool's type is converted from its original JSON schema:

- Supported keywords: `type`, `properties`, `required`, `items`, `enum`, `anyOf`, `additionalProperties`.
- Anything else is `Json`; a freeform tool is `string`.

`omd-mod-author watch` copies the file into `.omd/` beside `active-host.d.ts` and `installed-contracts.d.ts`. The
scaffold's `tsconfig.json` already includes `.omd/*.d.ts`.

Once `ToolArguments` lists tools, the `tool` interceptor input and `tools.invoke`/`tools.check` arguments are exactly
one of those tools with its own argument type, so a tool the snapshot lacks needs a cast. Scenario runs use a
throwaway store, so they leave an existing `.omd/tool-types.d.ts` alone.

### How current the declarations are

The declarations are as current as the last turn that built the thread's tools:

- MCP servers connected later, and tools a `tool_specs` interceptor hid, appear as the host last listed them.
- A mod's runtime check of the call is the host's `tool_arguments_invalid` validation, not these types.

## TypeScript tests

`pnpm test` runs `mod.test.json` and then every `*.test.ts` and `*.test.mjs` next to it with `node --test`:

- Assertions are `node:assert` (built into Node, no extra dependency or framework).
- Test files are plain TypeScript under Node's type stripping.
- `@oh-my-diff/mod-api/testing` builds and runs scenarios for them. It needs `omd-mod` like `pnpm test` and sends no
  provider request.

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TerminalView } from '@oh-my-diff/mod-api';
import { advance, clock, environment, find, invoke, key, mount, packages, pointer, runScenario, storeMock, tiers, waitUntil } from '@oh-my-diff/mod-api/testing';

test('panel opens', () => {
  const trace = runScenario('.', clock(1000), environment({ MODE: 'ci' }), storeMock({ get: [null] }), packages('../policy'), tiers({ append: ['policy'] }), {
    steps: [mount('panel'), key('panel', 'F2', { expect: { action: { command: 'panel:open', args: '' }, result: 'opened' } })],
  });
  assert.ok(find(trace.steps[0].value as TerminalView, 'open'));
});
```

A step's `value` is typed as `Json | undefined`, so cast it to `TerminalView` before passing it to `find` or `text`.
For a walkthrough, see [Test a mod](https://github.com/dzkchen/oh-my-diff/blob/main/docs/mod-authors/test-a-mod.md).

### Scenario fields

| Helper | Sets |
| --- | --- |
| `clock(ms)` | `virtual_time_ms` |
| `environment(values)` | The environment |
| `settings(id, values)` | A mod's settings |
| `hostOperations({op: [{result} \| {error}]})` | Mocked host operation replies |
| `storeMock({get, put, delete})` | Ordered `store.*` replies, `null` for a missing key |
| `packages(...paths)` | Extra packages (a policy package, a user package), trusted in that order before the project |
| `tiers({prepend, append})` | Mod IDs run as [administrator-managed](administrator-policy.md) packages in that tier, so a test sees the composed order and the managed guard rule; an `intercept` step's trace shows the order |

- `scenario(...parts)` merges parts: queues and packages append, settings and tiers merge, and the last value of any
  other field wins.
- `runScenario(directory, ...parts)` runs the project and returns the engine trace.
- `calls(trace, operation)` lists the trace's host calls.

### Mocked host operations

Mock operation names, arguments and results derive from `HostOperations`.

- Each reply can include `arguments` for exact JSON matching and `optional: true` for a call that may be absent.
- Reply queues are ordered per operation. An optional reply with different expected arguments can be skipped to reach
  the next reply.
- Fixture records must contain exactly one of `result` or `error`.
- An explicit queue for a timer or environment operation replaces its virtual implementation; exhausted queues never
  fall back to simulated behavior.

Required replies must be consumed. Unexpected calls, argument mismatches and unused required replies fail the
scenario. Unexpected-call and argument-mismatch failures remain scenario failures even when the mod catches the
operation error.

### Mock validation

- Every normal mock validates request and result shapes. Shared pure validators also check store keys,
  values and revision syntax, environment inputs and timer inputs.
- Malformed result fixtures fail before the scenario runs unless explicitly marked unsafe.
- Authority, declarations, persistence, revision conflicts, quotas, filesystem resolution and process/network state
  require real-host boundary tests; a valid mock cannot prove those behaviors.

### Negative tests

- `unsafeHostOperations({op: [{result, unsafe: {result: true}}]})` deliberately bypasses result validation.
  `unsafe.arguments` separately bypasses request validation. Neither grants runtime authority, and unknown operations
  still fail in the engine.
- `unsafeStep({...})` bypasses the SDK's discriminated step type to test malformed scenario input.

### Scenario steps

- Time and events: `invoke(mod, event, name, payload)`, `emit(event, payload)`, `advance(ms)`,
  `waitUntil(check, until, {everyMs, maxMs})`, `reload()`, `state(mod, {value})` (reads, or first writes, `api.state`).
- Views and input: `mount(mod)`, `key(mod, name)`, `activate(mod, component)`, `input(mod, component, value)`,
  `select(mod, component, value)`, `pointer(mod, component, {column, row, action})` (with `{client}` for an attached
  client's event), `component(mod, module, {instance, props, columns, rows, events})` (steps an `api.component` module).
- Clients: `attach(name, {renderer})`, `detach(id)`.
- Interceptors: `intercept(surface, payload, {core: [coreValue(v) | coreError(e)]})`.

Step options:

- The last argument takes `expect`, `expectError` and `cancelled`.
- Interactions and `mount` also take `payload`, the `terminal` event input (default `{event: 'draw', ledger: null}`).

### View queries and interceptor assertions

View queries over a mounted view's value: `find(view, id | fields | fn)`, `findAll` and `text(view)`.

Interceptor assertions over an `intercept` step's value:

| Assertion | Passes when |
| --- | --- |
| `assertWrapped` | The mod called `next` and the chain reached the core |
| `assertShortCircuit` | The mod answered, so the core never ran |
| `assertFailure(chain, mod, /reason/)` | Its link failed with that reason: skipped, kept, caught or rejected |

### What tests don't prove

Mounting and interacting run the mod's `terminal` event and callbacks on fixture data. They show what a mod returns
and how it reacts, not how a terminal or an attached client draws or delivers it. A supported-client claim needs the
client conformance harness (`scripts/client_acceptance.py`) or a real terminal check.

## Offline scenarios

A `mod.test.json` file uses schema 1 and runs a mod with no external work.
[Test a mod](https://github.com/dzkchen/oh-my-diff/blob/main/docs/mod-authors/test-a-mod.md) shows a complete file and maps each field and step to its TypeScript
helper.

### Scenario file fields

| Field | Meaning |
| --- | --- |
| `virtual_time_ms` | Fixes `Date.now()` and zero-argument `new Date()` inside every callback |
| `host_operations` | An ordered result/error queue for each approved host operation |
| `settings` | A map from mod ID to that mod's explicit settings; the author commands apply it through `omd-mod settings` before the run, so configured behavior is testable offline |
| `packages` | Additional trusted packages, enabling provider/consumer and conflict fixtures without shared globals or ambient authority |
| `tiers` | Maps loaded mod IDs to `prepend` or `append` and runs them as administrator-managed packages in that tier for the scenario only, so a test sees the managed interceptor order and that its answers can't skip a managed required guard |
| `environment` | Nonsecret names mapped to string values (see [Offline environment](#offline-environment)) |

- Any unmocked call fails before external work, and every result records `paid_requests: 0`.
- `expect` is deep equality of the step's whole value, not a subset (`offline_expectation_failed`). A render `intercept`
  result includes `trace[].location` (`index.ts:75:7`), so an exact expectation breaks when lines move: test
  interceptors in a `*.test.ts` file ([TypeScript tests](#typescript-tests)).
- A store-level `omd-mod test STORE SCENARIO` uses the store's own settings instead of `settings`.
- A mod that fails to activate reports its retained cause, so a missing service provider, denied capability or source
  error names itself instead of only asking for a reload.

### What steps can do

Every step has a `type`:

| `type` | Meaning |
| --- | --- |
| `invoke` | Calls one mod's tool, command or hook by `mod`, `event` and `name` with `payload` |
| `event` | Dispatches `event` with `payload` to every mod that handles it |
| `tool_outcome`, `agent` | Dispatches a `tool_result` or `agent` lifecycle event |
| `advance_time` | Moves virtual time forward by `ms`, running due timers |
| `wait_until` | Repeats a `check` step as time advances until it equals `until` |
| `reload`, `status` | Reloads the mods at a safe boundary; returns the host's status |
| `state` | Returns (or with `value`, first writes) a mod's persisted `api.state` |
| `tool_exposure` | Returns the tool names the mods expose for a `payload` ledger |
| `terminal_mount`, `terminal_interact` | Draws a mod's terminal view; sends it a `key` or a `component` interaction |
| `component` | Steps one `api.component` module instance |
| `client_attach`, `client_detach` | Adds or removes an external client |
| `intercept` | Runs an interceptor chain for `surface`, answering `next` from `core` |

Steps can:

- advance virtual time;
- invoke tools or commands;
- dispatch ordinary events, interceptor chains (an `intercept` step answers `next` from its `core` replies), tool
  outcomes and agent lifecycle;
- reload at a safe boundary;
- mount a terminal view, and interact with a mounted key or component ID. Component interaction activates buttons,
  inputs, and selectors with an optional `value`; copy actions return without touching the system clipboard.

A step can carry `expect`, `expect_error`, or `cancelled`, and `thread_id` to run in that thread when its payload names
none. Thread-scoped state, timers and component events follow it; the `THREAD` argument of `omd-mod test` binds every
step and takes precedence. In a TypeScript test, pass `threadId` in a step's options.

### Offline environment

`environment` maps nonsecret names to string values (4096 bytes at most) that `environment.read` answers in place of a
`host_operations` queue, so a scenario never reads the host's environment.

- An unlisted name is `{set: false}`.
- A secret-like name (`*KEY*`, `*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `AWS_*`, ...) fails the scenario with
  `offline_environment_secret_name`.

### `state` step

```text
{"type": "state", "mod": ID, "value"?: VALUE, "thread_id"?: ID}
```

Returns that mod's persisted `api.state` from the scenario's store, so `expect` can check it after any step. With
`value` it first writes that state (the mod needs `store`, and the usual state limits apply), seeding a test without a
setup command.

### `component` step

```text
{"type": "component", "mod": ID, "module": NAME, "instance"?: NAME, "props"?: VALUE, "columns"?: 80, "rows"?: 0, "events"?: [...]}
```

Steps one instance of the mod's `api.component` module at the scenario's virtual time, delivering the `key` and
`pointer` events and every due tick, and returns `{tree, post, next_ms}`.

- The instance mounts on its first step and keeps its state until the scenario ends, so `advance_time` steps drive
  `every` ticks.
- The module gets no host authority and its tree is validated as for a terminal.
- `omd-mod test` and `mod_host_check --scenarios` run it like any other step.

### `wait_until` step

```text
{"type": "wait_until", "check": STEP, "until": VALUE, "every_ms": 1000, "max_ms": N}
```

Runs `check`, and while its value differs from `until` advances virtual time by `every_ms` and checks again (at most
256 checks). It returns `{waited_ms, value}` or fails with `offline_wait_timeout` at `max_ms`.

### Pointer and client steps

- A `terminal_interact` `key` runs the view's `keybindings` entry, else the first `key_contexts` binding for that key
  (offline steps have no focus).
- `terminal_interact` also takes `pointer: {column, row, half?, action, button?}` with `component`. The mounting mod
  receives `component_event {kind: 'pointer'}` with `origin: 'user'`, only for a `box`, `image` or `raster` mounted
  with `pointer: true` (`offline_terminal_component_not_pointer`). Adding `client: ID` delivers it as that attached
  client's event (`client`, no `origin`).
- `client_attach {name, renderer?, viewport?, focused?}` adds an external client as `client-1`, `client-2`, ... and
  `client_detach {id}` removes it (`offline_client_not_attached`).
- A mounted `terminal` payload carries the roster as `clients` unless it sets its own.

These steps run the mod's callbacks on fixture data; they are not terminal or client rendering evidence.

## Watch and reload

The author loop with `watch` is shown step by step in
[Run and debug a mod](https://github.com/dzkchen/oh-my-diff/blob/main/docs/mod-authors/run-and-debug.md).

### Interactive watch

While a mod is written, `omd-mod-author watch DIR STORE` (or `pnpm watch STORE`):

1. Inspects the directory.
2. Approves its current digest in `STORE` as the user would with `omd-mod trust`.
3. Queues a reload of that store's host and refreshes `.omd/`.

Saving an entry point, asset or lifecycle file reloads again after 100 ms, and reports a half-written file instead of
stopping. A running session picks the reload up at its next turn boundary; `/omd` reloads at once while no turn runs,
and also disables or resets a mod.

**Because `watch` approves what it watches, point it only at a scratch store** (`omd-mod init STORE`) that holds
no other trusted mods, and run it only on code you wrote or reviewed. To try the mod in a real store, review the
digest and approve it there yourself with `/omd` or `omd-mod trust`. Code an agent wrote is never trusted
automatically.

### Watching an installed package

For a local package installed with `omd install`, watch updates it through the package preview/apply path, preserving
its scope, settings, grants and enabled or disabled choice.

- It refuses a plan that changes any installed package's scope, including a shared dependency, as well as changed
  grants, authority or state versions. The refusal leaves the package lock and selections unchanged; review those
  changes separately before watching again.
- An installed Git or npm package, or a rollback pointing at cached source, needs a fresh local install of the
  editable directory before watch can update it.

### Noninteractive watch and CI

- `omd-mod-author watch DIR STORE --once` does one inspect, approve and reload and exits, which suits a build step
  against a scratch store.
- `omd-mod-author test DIR` (or `pnpm test`) is the CI check. It needs no store, since it builds a throwaway store for
  every run. It fails (`no_tests`) when the project has neither `mod.test.json` nor a `*.test.ts` or `*.test.mjs`
  file.

Neither starts a provider request.

## JSX/TSX

Writing terminal components as JSX is optional and author-side only. For an example, see
[Write terminal components in JSX](https://github.com/dzkchen/oh-my-diff/blob/main/docs/mod-authors/jsx.md).

### Entry point compilation

When a project has `index.tsx`, `omd-mod-author` (check, test, run, debug, package, and each watch reload) compiles it
with the project's own TypeScript into a self-contained `index.ts`. It inlines the small JSX factory, so the host still
sees one module with no value imports.

- The project needs `typescript` installed (`pnpm add -D typescript@5.9.3`); without it the command fails with
  `jsx_requires_typescript`.
- Edit `index.tsx` and treat `index.ts` as generated output. A hand-written `index.ts` beside `index.tsx` is never
  overwritten and fails with `jsx_entrypoint_conflict`.
- The scaffolded `tsconfig.json` sets `jsx: "react-jsx"`, `jsxImportSource: "@oh-my-diff/mod-api"` and
  `allowImportingTsExtensions`; `check` type-checks `index.tsx` itself.

### `.tsx` assets

A `.tsx` file in any subdirectory is an asset source too (skipping `node_modules`, `dist` and dot directories):

- Each compiles to the `.ts` file beside it with the same rules and its own inlined factory.
- A relative import of `./row.tsx` becomes `./row.ts` in the output.
- List the compiled name in `mod.json` `assets` (`"row.ts"`). The host accepts only `.ts`, `.mjs` and `.json` assets,
  and `package` ships only the compiled files, never the `.tsx`.
- The 512 KiB package file limit applies to each compiled file.
- A hand-written `.ts` beside a `.tsx` fails with `jsx_entrypoint_conflict`.

### Elements and children

Each `TerminalComponent` kind is an intrinsic element (`<box>`, `<line>`, `<text>`, ...) with the component's fields
as props.

| Element | Children become |
| --- | --- |
| `box`, `pane`, `dialog` | `children` |
| `text`, `button`, `markdown`, `code` | `text` (string and number children) |
| `line` | `spans` (string and span children) |

- Function components returning a component work.
- The factory is pure object construction with no Node or DOM authority and grants no capability.
- Unsupported elements and props fail at compile time through the types. A dynamic unknown tag fails with
  `jsx_unsupported_element`; children on a kind that takes none fail with `jsx_children_unsupported`.
- Fragments are not supported.

## Multi-file packages

A package spans several files by importing its declared assets with relative specifiers:
`import { draw } from './draw.ts'`, `'./lib/util.mjs'`, or a `'./table.json'` default export.

- The runner links them in the callback's context, so they share module state for that callback.
- Anything else, including value imports of the SDK and any dynamic `import()`, fails with `unsupported_import`.
- Imported code counts toward the source-use report like the entrypoint; assets that are only read (for example
  scripts passed to `exec.run`) do not.
- Declare the required features `package_text_assets_v1` for assets and `package_imports_v1` for relative imports;
  `mod_host_check.py --static` fails a package that omits them.

## Diagnostics and source maps

Where a callback failed and what the source uses.

### Stacks and source maps

The engine strips TypeScript types in place, so callback stacks report the authored line and column as
`<package>/<file>:line:col`. `omd-mod-author package` also writes a `.js` file and `.js.map` source map beside every
`.ts` file it ships.

Only erasable syntax loads: `enum`, namespaces with values and constructor parameter properties fail with
`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`, and `pnpm check` reports them before packaging.

Status retains a bounded per-mod log containing event, handler, generation, outcome, and elapsed microseconds plus
aggregate timing. It never adds mod-side filesystem or process access.

### Source-use report

The source-use report is derived from registrations and literal host/service calls. It compares declared
capabilities, service imports/exports, and admitted environment access with what the source uses:

- Undeclared use is rejected.
- Unused grants are reported. A declared `network` grant counts as used when `exec.run`, `process.start` or
  `terminal.pty` source passes a `unix_sockets` or `network` option outside comments and strings.

Diagnostics explain how to narrow or explicitly approve authority, but tooling cannot grant permissions by itself.

## Cost report

Experimental (added after 1.0.0).

`omd-mod-author cost DIR` installs the package alone in a scratch store and measures it in the real host, `--runs` times
(1-100, default 10), each run starting as a launch does: no warm runners and no inspection shared from an earlier host.
Name one of the package's commands, with an optional JSON payload, to time its callbacks too.

| Field | Meaning |
| --- | --- |
| `activation_ms` | Opening a host with the package: runner start, inspection, registration checks |
| `first_render_ms` | The first `terminal` render after activation; absent without a `terminal` handler |
| `fresh_callback_ms`, `reused_callback_ms` | The named command's first and second run after activation |
| `runners` | Runners the package keeps after the last run, idle spares excluded |
| `runner_peak_footprint_bytes` | Sum of those runners' peak physical memory |

Each timing reports `first`, `p50` and `p95` in milliseconds. `first` includes the cold code cache
(`<store>/cache/code`, safe to delete) and, for a newly written engine, the operating system's first-launch check, so
compare `p50` between versions of a package. The numbers are host-side and exclude the terminal's draw. The scratch
store has no Git checkout or session thread, so a command that writes `checkout` or `thread` state fails there, and a
package that requires another fails activation.
