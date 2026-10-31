# Write terminal components in JSX

How to write a mod's terminal components as JSX in `.tsx` files instead of plain objects. JSX is optional and
exists only on the author side: `omd-mod-author` compiles it to plain TypeScript, so the host sees the same component
objects either way. For every rule and error, see [JSX/TSX](../../mods/reference/authoring.md#jsxtsx) in the
authoring reference.

## Before you begin

Create a mod named `tally`. Its scaffold includes TypeScript, which compiles the JSX:

```sh
omd-mod-author create ./tally tally
cd tally
rm mod.test.json debug.test.json
```

The `rm` removes the scaffold's tests, which call `/hello`, a command this page replaces.
[See what it builds](#see-what-it-builds) writes a new `mod.test.json`. Without TypeScript, commands fail with
`jsx_requires_typescript`. The scaffold's `tsconfig.json` already has the JSX settings.

## Write the entry point as `index.tsx`

1. Delete `index.ts` and write `index.tsx` instead. This mod counts with `/tally:add` and shows the count above the
   prompt:

   ```tsx
   import type { ModAPI, TerminalPatch } from '@oh-my-diff/mod-api';

   const Count = ({ count }: { count: number }) => (
     <line id="tally_line" label="Tally">
       {'Tally: '}
       {{ text: String(count), bold: true }}
     </line>
   );

   export default function activate(api: ModAPI) {
     const count = (): number => Number(api.state.get() ?? 0);

     api.command('add', () => {
       api.state.set(count() + 1);
       return { display: `Tally ${count()}` };
     }, { description: 'Add one to the tally' });

     api.on('terminal', (): TerminalPatch => ({
       sites: { above_composer: { mode: 'wrap', components: [<slot />, <Count count={count()} />] } },
     }));
   }
   ```

   In `mod.json`, set `capabilities` to `["commands", "store", "terminal"]`.

2. Run the checks:

   ```sh
   pnpm check
   ```

   It compiles `index.tsx` into `index.ts`, type-checks `index.tsx` and prints `check: ok`.

Every author command (`check`, `test`, `run`, `debug`, `package` and each `watch` reload) compiles `index.tsx` first.
Treat `index.ts` as generated output and edit only `index.tsx`. A hand-written `index.ts` next to `index.tsx` is
never overwritten; the command fails with `jsx_entrypoint_conflict`.

## See what it builds

A `terminal_mount` step shows the components the JSX produced. Save this as `mod.test.json` and run `pnpm test`:

```json
{
  "schema": 1,
  "steps": [
    { "type": "invoke", "mod": "tally", "event": "command", "name": "add", "payload": null,
      "expect": { "display": "Tally 1" } },
    { "type": "terminal_mount", "mod": "tally" }
  ]
}
```

In the `pnpm test` output, the `line` element is a plain component, with its children turned into `spans`:

```json
{
  "type": "line",
  "id": "tally_line",
  "label": "Tally",
  "spans": [
    { "text": "Tally: " },
    { "text": "1", "bold": true }
  ]
}
```

Each element's props are the component's fields. The
[elements and children](../../mods/reference/authoring.md#elements-and-children) rules list which field each
element's children fill and which JSX forms aren't supported.

## Split components into `.tsx` assets

Any other `.tsx` file in the project compiles to the `.ts` file next to it. To use one:

1. Import it as `./row.tsx`. The compiled output imports `./row.ts`.
2. List the compiled name in `mod.json` `assets` (`"row.ts"`). The host loads only `.ts`, `.mjs` and `.json`
   assets.
3. Add `package_text_assets_v1` and `package_imports_v1` to `compatibility.required_features` in `mod.json`.

`pnpm run package` ships only the compiled files, never the `.tsx`.

## See also

- [Component types](../../mods/reference/layout-and-styling.md#component-types): every component type and its fields
- [Test a mod](test-a-mod.md#check-what-a-mod-draws): check a view with `find` and `text`
