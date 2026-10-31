# Test a mod

How to test a mod offline, with a `mod.test.json` scenario, a TypeScript test, or both. Tests never call a model
and never touch your mod store: each run builds a throwaway store. For every field and helper, see
[offline scenarios](../../mods/reference/authoring.md#offline-scenarios) and
[TypeScript tests](../../mods/reference/authoring.md#typescript-tests) in the reference.

## Before you begin

You need a mod project made with `omd-mod-author create`, such as the one from
[Write your first mod](first-mod.md), with TypeScript added:

```sh
pnpm add -D typescript@5.9.3
```

The examples below use a mod with the id `my_mod`, and the [notes mod](notes-mod.md) from the second tutorial.

## Run the tests

From the mod's folder:

```sh
pnpm test
```

`pnpm test` runs, in order:

1. The `mod.test.json` scenario.
2. The type check, when TypeScript is in the project. A type error fails the run here, before the trace prints.
3. The scenario's trace, printed as JSON.
4. Every `*.test.ts` and `*.test.mjs` file next to `mod.test.json`, under `node --test`.

The type check runs only when the project has a `mod.test.json`. With only `*.test.ts` files, run `pnpm check` as
well.

Exit status 0 means everything passed. A failing step prints its error with the line in `index.ts`. The scaffold's
`run` script (`pnpm run run`) runs the same scenario and prints the full trace.

In CI, run `pnpm test`, or `omd-mod-author test DIR` without pnpm scripts. It needs no store, and it fails with
`no_tests` when the project has neither `mod.test.json` nor a test file.

## Write a scenario file

A scenario is a list of steps. Each step calls the mod and may compare the result with `expect`:

```json
{
  "schema": 1,
  "settings": { "notes": { "max_notes": 2 } },
  "steps": [
    { "type": "invoke", "mod": "notes", "event": "tool", "name": "add", "payload": { "text": "one" },
      "expect": { "saved": "one", "count": 1 } },
    { "type": "invoke", "mod": "notes", "event": "command", "name": "clear", "payload": null,
      "expect": { "display": "Notes cleared" } }
  ]
}
```

- `expect` compares the step's whole value, not a subset. A mismatch fails with `offline_expectation_failed`.
- `expect_error` expects the step to fail with that error.
- `settings` sets each mod's settings for the run.

## Mock host calls

A [host call](../../mods/reference/glossary.md#mods-and-the-host) the scenario doesn't mock fails the test. Mock it
with `host_operations`, an ordered list of replies per operation. Each reply has exactly one of `result` or `error`.
Take a mod with `commands` and `store` capabilities whose `index.ts` reads a saved greeting:

```ts
import type { ModAPI } from '@oh-my-diff/mod-api';

export default function activate(api: ModAPI) {
  api.command('greeting', () => {
    const saved = api.host.call('store.get', { key: 'greeting' });
    return { display: saved ? String(saved.value) : 'No greeting saved' };
  }, { description: 'Show the saved greeting' });
}
```

This scenario answers its first `store.get` with no value and its second with `Hi`. Save it as `mod.test.json` in
place of the scaffold's, which still calls `/hello`. `pnpm test` runs `mod.test.json` first and stops at its first
failure, before any `*.test.ts` file runs.

```json
{
  "schema": 1,
  "host_operations": {
    "store.get": [
      { "result": null },
      { "result": { "value": "Hi", "revision": 1, "provenance": { "mod": "my_mod", "source_sha256": "0000000000000000000000000000000000000000000000000000000000000000", "thread_id": null, "origin": "cli", "at": 0 } } }
    ]
  },
  "steps": [
    { "type": "invoke", "mod": "my_mod", "event": "command", "name": "greeting", "payload": null,
      "expect": { "display": "No greeting saved" } },
    { "type": "invoke", "mod": "my_mod", "event": "command", "name": "greeting", "payload": null,
      "expect": { "display": "Hi" } }
  ]
}
```

Every required reply must be used. An unexpected call, an argument mismatch or an unused reply fails the scenario.

## Write a TypeScript test

A TypeScript test builds the same scenario with helpers from `@oh-my-diff/mod-api/testing` and checks the trace with
`node:assert`. Save it next to `mod.test.json` with a `.test.ts` name, for example `greeting.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calls, invoke, runScenario, storeMock } from '@oh-my-diff/mod-api/testing';

test('shows the saved greeting', () => {
  const trace = runScenario('.', storeMock({ get: [null, 'Hi'] }), {
    steps: [
      invoke('my_mod', 'command', 'greeting', null, { expect: { display: 'No greeting saved' } }),
      invoke('my_mod', 'command', 'greeting', null, { expect: { display: 'Hi' } }),
    ],
  });
  assert.equal(calls(trace, 'store.get').length, 2);
});
```

`storeMock` writes the `store.get` replies for you, so this test is shorter than the JSON above.

The authoring reference lists the helper for each [scenario field](../../mods/reference/authoring.md#scenario-helpers)
and [step](../../mods/reference/authoring.md#scenario-steps).

Use a TypeScript test when you need more than equality:

- Check part of a value, such as text in a view, with `find`, `findAll` and `text`.
- Count host calls with `calls`.
- Check an interceptor chain with `assertWrapped`, `assertShortCircuit` and `assertFailure`.
- Test interceptors here rather than in JSON: an `intercept` result includes source locations such as
  `index.ts:75:7`, so an exact JSON expectation breaks when lines move.

### Check what a mod draws

`mount` draws the mod's view. This test for the [notes mod](notes-mod.md) seeds its state, adds a note and reads the
line it draws:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TerminalView } from '@oh-my-diff/mod-api';
import { invoke, mount, runScenario, settings, state, text } from '@oh-my-diff/mod-api/testing';

test('the count line shows the saved notes', () => {
  const trace = runScenario('.', settings('notes', { max_notes: 2 }), {
    steps: [
      state('notes', { value: ['one'] }),
      invoke('notes', 'tool', 'add', { text: 'two' }, { expect: { saved: 'two', count: 2 } }),
      mount('notes'),
    ],
  });
  assert.match(text(trace.steps[2].value as TerminalView), /2 saved/);
});
```

A step's `value` is typed as JSON, so cast it to `TerminalView` before passing it to `text` or `find`.

## Know what tests don't prove

Tests run the mod's callbacks on fixture data. They show what a mod returns, not how a terminal draws it. A mock
also can't prove permissions, persistence, quotas or file and network behavior. Check those against a
[scratch store](run-and-debug.md#run-it-in-a-scratch-store) or in `codex`.

## See also

- [Run and debug a mod](run-and-debug.md)
- [Authoring reference](../../mods/reference/authoring.md): mocked host operations, unsafe mocks for negative tests
