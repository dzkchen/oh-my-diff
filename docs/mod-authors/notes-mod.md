# Build a notes mod

This tutorial builds `notes`, a mod that keeps short notes. The model saves them with a tool, you clear them with a
command, and a line above the prompt shows how many are saved. Along the way you use tools, saved state, settings and
drawing in the terminal.

## Before you begin

Finish [Write your first mod](first-mod.md) first. This tutorial uses the same tools and the same scratch-store
setup.

Steps 1 to 5 run offline. Step 6 is optional and needs `codex` signed in to a model, because the model calls the
mod's tool.

## 1. Create the project

```sh
omd-mod-author create ./notes notes
cd notes
```

The scaffold is the `/hello` mod from the first tutorial. The next steps replace its code, manifest and test.

## 2. Write the code

Replace `index.ts` with:

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

`activate` runs once when the mod loads and registers everything:

- `api.tool` adds the tools `add` and `list`. The model sees them as `mod_notes_add` and `mod_notes_list`.
- `api.state` stores one JSON value for the mod. It survives restarts.
- `api.settings` contains the user's settings, here `max_notes`.
- `api.command` adds `/notes:clear`.
- The `terminal` handler returns what to draw. `above_composer` is the area above the prompt. With `mode: 'wrap'`,
  your components go around what other mods draw there, and `slot` marks where their content goes.

Return a refusal as a value, such as `{ error: 'empty note' }`. A thrown error counts as a failure, and five
failures in a row turn the mod off at the [fault limit](../../mods/reference/host-model.md#fault-limit).

## 3. Declare permissions and settings

Replace `mod.json` with:

```json
{
  "schema": 1,
  "id": "notes",
  "version": "0.1.0",
  "api": "1.0.0",
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

`capabilities` lists every permission the code uses: `tools` for `api.tool`, `commands` for `api.command`, `store`
for `api.state` and `terminal` for the `terminal` handler. A call without its capability fails with
`capability_denied`.

`settings_schema` describes the settings a user can change. Each property may have only `type`, `enum`, `default`,
`title`, `description` and, on a `string` property without `enum`, `choices: "routes"`.

Run the checks:

```sh
pnpm check
```

It prints `check: ok`.

## 4. Test it offline

Delete the scaffold's failing test, because it calls `/hello`, which no longer exists:

```sh
rm debug.test.json
```

Replace `mod.test.json` with:

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

The test sets `max_notes` to 2, adds three notes and checks that only the last two are kept. Run it:

```sh
pnpm test
```

It exits with status 0 and prints each step's value, starting with:

```json
"value": {
  "saved": "one",
  "count": 1
}
```

If a step fails, the report names the step and the line in `index.ts`.

## 5. Try it against a scratch store

Load the mod into a new scratch store once, without watching:

```sh
omd-mod init /tmp/notes-store
pnpm watch /tmp/notes-store --once
```

Run the command against the store, without `codex`:

```sh
omd-mod command /tmp/notes-store notes clear null
```

The last argument, `null`, is the command's input as JSON.

It prints:

```json
{
  "display": "Notes cleared"
}
```

## 6. See it in `codex` (optional)

Start `codex` on the scratch store without the offline flags, as in
[Run it in a scratch store](run-and-debug.md#run-it-in-a-scratch-store), and sign in if it asks:

```sh
OMD_MODE=omd OMD_MOD_STORE=/tmp/notes-store ~/.local/share/oh-my-diff/current/prefix/artifacts/codex
```

The line `0 saved` shows above the prompt. Ask the model to save a note, for example "Save a note: buy milk". It
finds `mod_notes_add` through tool search, and the line changes to `1 saved`. Type `/notes:clear` to empty the list.

## Next steps

- [Change the saved state's shape](migrate-state.md) without losing notes.
- [Test a mod](test-a-mod.md) with TypeScript tests that check what the mod draws.
- [Run and debug a mod](run-and-debug.md): status, reports and the cost of a mod.
- [Install, share and update a mod](publish-a-mod.md).
- The [capabilities reference](../../mods/reference/capabilities.md) lists every permission.
