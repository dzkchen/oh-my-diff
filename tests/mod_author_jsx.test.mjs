import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const mods = resolve(dirname(fileURLToPath(import.meta.url)), '../mods');
const cli = join(mods, 'author/cli.mjs');

function project(source, { typescript = true, typecheck = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'omd-jsx-'));
  mkdirSync(join(directory, 'node_modules/@oh-my-diff'), { recursive: true });
  if (typescript) symlinkSync(join(mods, 'node_modules/typescript'), join(directory, 'node_modules/typescript'));
  if (typecheck) {
    mkdirSync(join(directory, 'node_modules/.bin'));
    symlinkSync(join(mods, 'node_modules/.bin/tsc'), join(directory, 'node_modules/.bin/tsc'));
    symlinkSync(mods, join(directory, 'node_modules/@oh-my-diff/mod-api'));
    writeFileSync(join(directory, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true, jsx: 'react-jsx', jsxImportSource: '@oh-my-diff/mod-api', types: [] },
      include: ['index.ts', 'index.tsx'],
    }));
  }
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(join(directory, 'index.tsx'), source);
  return directory;
}

function check(directory) {
  const result = spawnSync(process.execPath, ['--no-warnings', cli, 'check', directory], { encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout}${result.output}` };
}

async function evaluate(directory) {
  const compiled = join(directory, 'compiled.mjs');
  writeFileSync(compiled, stripTypeScriptTypes(readFileSync(join(directory, 'index.ts'), 'utf8')));
  return import(compiled);
}

async function withProject(source, options, body) {
  const directory = project(source, options);
  try {
    await body(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('index.tsx compiles to a self-contained index.ts that builds the component tree', () => withProject(`
const Row = ({ name }: { name: string }) => <line id={name} label={name}>{name}: {{ text: 'ok', bold: true }}</line>;
export const tree = (
  <box id="root" label="Root">
    <text id="t" label="t">Count {3}</text>
    <Row name="a" />
    {false && <slot />}
    <button id="b" label="b" action={{ command: 'go' }} text="Go" />
  </box>
);
`, {}, async directory => {
  const result = check(directory);
  assert.equal(result.status, 0, result.output);
  assert.doesNotMatch(readFileSync(join(directory, 'index.ts'), 'utf8'), /^import /m);
  const { tree } = await evaluate(directory);
  assert.deepEqual(tree, {
    type: 'box', id: 'root', label: 'Root',
    children: [
      { type: 'text', id: 't', label: 't', text: 'Count 3' },
      { type: 'line', id: 'a', label: 'a', spans: [{ text: 'a' }, { text: ': ' }, { text: 'ok', bold: true }] },
      { type: 'button', id: 'b', label: 'b', action: { command: 'go' }, text: 'Go' },
    ],
  });
}));

test('unknown elements and children on childless kinds fail at evaluation', async () => {
  for (const [source, message] of [
    ['const Tag = "blink" as any; export const tree = <Tag />;', 'jsx_unsupported_element: blink'],
    ['export const tree = <slot>{"hi" as any}</slot>;', 'jsx_children_unsupported: slot'],
  ]) {
    await withProject(source, {}, async directory => {
      assert.equal(check(directory).status, 0);
      await assert.rejects(evaluate(directory), { message });
    });
  }
});

test('fragments are rejected and typescript is required', async () => {
  await withProject('export const tree = <><slot /></>;', {}, directory => {
    assert.match(check(directory).output, /jsx_unsupported_element: fragment/);
  });
  await withProject('export const tree = <slot />;', { typescript: false }, directory => {
    assert.match(check(directory).output, /jsx_requires_typescript: pnpm add -D typescript@5\.9\.3/);
  });
});

test('types reject unsupported elements and props in index.tsx', async () => {
  await withProject('export const tree = <blink id="x" label="x" />;', { typecheck: true }, directory => {
    const result = check(directory);
    assert.notEqual(result.status, 0);
    assert.match(result.output, /index\.tsx.*'blink' does not exist/);
  });
  await withProject('export const tree = <text id="x" label="x" text="a">b</text>;', { typecheck: true }, directory => {
    assert.match(check(directory).output, /index\.tsx.*TS2322/);
  });
});

test('the runtime accepts every component kind declared by the API', () => {
  const api = readFileSync(join(mods, 'api.d.ts'), 'utf8');
  const union = api.slice(api.indexOf('export type TerminalComponent ='), api.indexOf('export type TerminalRange'));
  const kinds = [...union.matchAll(/\{ type: '(\w+)'/g)].map(match => match[1]);
  assert.ok(kinds.length >= 16);
  return import(join(mods, 'author/jsx-runtime.mjs')).then(({ jsx }) => {
    for (const kind of kinds) assert.equal(jsx(kind, {}).type, kind);
  });
});
