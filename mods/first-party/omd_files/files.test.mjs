import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { callback } from '../../../tests/mod_runner.mjs';

const mod = new URL('./', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('mod.json', mod), 'utf8'));
const source = readFileSync(new URL('index.ts', mod), 'utf8');
const ROOT = '/repo';
const TREE = {
  '': ['src/', 'docs/', 'README.md', '.env'],
  src: ['lib/', 'main.ts', 'logo.png', 'a10.ts', 'a2.ts'],
  'src/lib': ['util.ts'],
  docs: ['guide.md'],
};
const FILES = { 'README.md': '# Hello\n', 'src/main.ts': 'const x = 1;\nexport default x;\n', 'src/lib/util.ts': 'export {};\n', 'docs/guide.md': 'Guide\n' };

function run(event, payload, { state = null, name, world = {} } = {}) {
  const calls = [];
  const host = ({ operation, arguments: args }) => {
    calls.push({ operation, arguments: args });
    if (operation === 'session.info') return { thread_id: 't1', cwd: world.cwd ?? ROOT, root: ROOT };
    if (operation === 'workspace.list') {
      const dir = args.path === '.' ? '' : args.path;
      const names = TREE[dir] ?? [];
      return { entries: names.map(item => ({ path: dir ? `${dir}/${item.replace(/\/$/, '')}` : item.replace(/\/$/, ''), kind: item.endsWith('/') ? 'dir' : 'file', size: 1, mtime_ms: 1 })), truncated: false };
    }
    if (operation === 'workspace.stat') return { files: Object.fromEntries(args.paths.map(path => [path, FILES[path] !== undefined ? { kind: 'file', size: FILES[path].length, mtime_ms: 1 } : TREE[path] ? { kind: 'dir', size: 0, mtime_ms: 1 } : null])) };
    if (operation === 'workspace.read') return { files: Object.fromEntries(args.paths.map(path => [path, FILES[path] === undefined ? null : { text: FILES[path], sha256: 'x' }])) };
    if (operation === 'workspace.watch') return { watch_id: 'w1' };
    if (operation === 'mods.service') {
      if (args.name === 'omd.frecency') return { paths: ['src/lib/util.ts', 'docs/guide.md'] };
      return args.method === 'panels' ? { panels: [{ id: 'files' }] } : { registered: 'files' };
    }
    if (operation === 'events.publish') return { delivered: 1, dropped: 0 };
    if (operation === 'events.schedule') return { scheduled: true };
    if (operation === 'terminal.prompt') return world.answer === undefined ? { status: 'declined' } : { status: 'accepted', ...world.answer };
    if (operation === 'composer.read') return { text: '', cursor: 0, selection: null, revision: 1, attachments: [], suggestion: null };
    if (operation === 'composer.write') return { text: args.edit.text, cursor: 0, revision: 2 };
    if (operation === 'terminal.open') return world.noEditor && args.editor ? (() => { throw new Error('terminal_editor_unconfigured'); })() : { opened: true };
    if (operation === 'exec.run') return { exit_code: 0, stdout: world.stdout ?? '', stderr: '' };
    if (operation === 'terminal.blit') return { frame: 1, queued: 0, frame_ms: 1 };
    throw new Error(`unexpected host operation ${operation}`);
  };
  const request = { source, filename: fileURLToPath(new URL('index.ts', mod)), entrypoint: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, state, settings: {}, event, name, payload, hook_budget_ms: 10000 };
  const output = callback(request, host);
  if (output.error) throw new Error(output.error);
  return { value: output.value, state: output.state ?? state, calls };
}
const started = world => run('start', null, { world }).state;
const key = (state, name, world) => run('command', `key ${name}`, { state, name: 'files', world });
const keys = (state, names, world) => names.reduce((now, name) => key(now, name, world).state, state);
const draw = (state, rows = 40) => run('terminal', { event: 'redraw', ledger: null, client: { columns: 160, rows } }, { state }).value;
const site = state => draw(state).sites['omd_files/main'].components;
const columns = state => site(state).find(node => node.id === 'omd_files_columns').children.map(column => column.children[0]);
const text = node => node.lines.map(line => line.map(span => span.text).join('')).join('\n').replace(/(\n )+$/, '');

test('three columns list the parent, the current directory and a preview, dotfiles hidden', () => {
  const state = started();
  const [parent, current, preview] = columns(state);
  assert.ok(draw(state, 80).sites['omd_files/main'].components[0].children.every(column => (column.children[0].height ?? 1) <= 40));
  assert.equal(text(parent), 'empty');
  assert.equal(text(current), '▶ docs/\n  src/\n  README.md');
  assert.equal(text(preview), '  guide.md');
  const inSrc = keys(state, ['j', 'l']);
  const [up, here, code] = columns(inSrc);
  assert.equal(text(up), '  docs/\n▶ src/\n  README.md');
  assert.equal(text(here), '▶ lib/\n  a10.ts\n  a2.ts\n  logo.png\n  main.ts');
  assert.equal(code.type, 'document');
  const file = keys(inSrc, ['G']);
  const [, , highlighted] = columns(file);
  assert.deepEqual([highlighted.type, highlighted.language, highlighted.text.trimEnd(), highlighted.start], ['code', 'ts', 'const x = 1;\nexport default x;', 0]);
  const scrolled = columns(key(file, 'J').state)[2];
  assert.deepEqual([scrolled.text.trimEnd(), scrolled.start], ['const x = 1;\nexport default x;', 2]);
  const dotted = key(state, '.').state;
  assert.match(text(columns(dotted)[1]), /\.env/);
});

test('h returns to the parent with the old directory selected, and gg and G jump', () => {
  const back = keys(started(), ['j', 'l', 'h']);
  assert.equal(text(columns(back)[1]), '  docs/\n▶ src/\n  README.md');
  const bottom = key(back, 'G').state;
  assert.match(text(columns(bottom)[1]), /▶ README\.md$/);
  const once = key(bottom, 'g').state;
  assert.match(text(columns(once)[1]), /▶ README\.md$/);
  assert.match(site(once).at(-1).spans[0].text, /^g…/);
  assert.match(text(columns(key(once, 'g').state)[1]), /^▶ docs\//);
  assert.match(text(columns(keys(once, ['j', 'g']))[1]), /▶ README\.md$/);
});

test('tabs open with t, switch by number and brackets, close with q, and bind digits only while there are several', () => {
  const state = started();
  assert.equal(draw(state).key_contexts[0].keys['1'], undefined);
  const two = keys(state, ['t', 'j', 'l']);
  const view = draw(two);
  assert.deepEqual(view.key_contexts[0].when, { focus: 'omd_files/main' });
  assert.ok(view.key_contexts[0].keys['2'] && !view.key_contexts[0].keys['3']);
  assert.ok(Object.keys(view.key_contexts[0].keys).length <= 32);
  assert.match(view.sites['omd_files/main'].components[0].spans.map(span => span.text).join(''), /^1 \/ {2}2 src {2}$/);
  assert.deepEqual(site(two)[1].children.map(column => [column.title, column.style.border]), [['/', 'rounded'], ['/src', 'thick'], ['lib', 'rounded']]);
  assert.match(text(columns(key(two, '1').state)[1]), /^▶ docs\//);
  assert.match(text(columns(key(two, '[').state)[1]), /^▶ docs\//);
  const closed = key(two, 'q').state;
  assert.equal(draw(closed).key_contexts[0].keys['2'], undefined);
});

test('find selects matches, z jumps to a frecency-ranked file and @ mentions it from the working directory', () => {
  const found = key(keys(started(), ['j', 'l']), '/', { answer: { value: 'A' } });
  assert.match(site(found.state).at(-1).spans[0].text, /No match for A/);
  const lower = key(keys(started(), ['j', 'l']), '/', { answer: { value: 'a' } }).state;
  assert.match(text(columns(lower)[1]), /▶ a10\.ts/);
  assert.match(text(columns(key(lower, 'n').state)[1]), /▶ a2\.ts/);
  const prompted = key(started(), 'z', { answer: { values: ['src/lib/util.ts'] } });
  const choice = prompted.calls.find(call => call.operation === 'terminal.prompt').arguments;
  assert.deepEqual(choice.options.map(option => option.value), ['src/lib/util.ts', 'docs/guide.md']);
  assert.equal(text(columns(prompted.state)[1]), '▶ util.ts');
  const typed = key(started(), 'z', { answer: { values: ['guide'], other: true } }).state;
  assert.equal(text(columns(typed)[1]), '▶ guide.md');
  const mention = key(prompted.state, '@', { cwd: `${ROOT}/src` });
  assert.equal(mention.calls.find(call => call.operation === 'composer.write').arguments.edit.text, '@lib/util.ts ');
});

test('rename moves inside the workspace, delete asks first, and images go to a raster through a timer', () => {
  const inSrc = keys(started(), ['j', 'l', 'G']);
  const renamed = key(inSrc, 'r', { answer: { value: 'lib/main.ts' } });
  const move = renamed.calls.find(call => call.operation === 'exec.run');
  assert.deepEqual([move.arguments.write, ...move.arguments.argv.slice(-2)], [true, 'src/main.ts', 'src/lib/main.ts']);
  assert.ok(!key(inSrc, 'r', { answer: { value: '../x' } }).calls.some(call => call.operation === 'exec.run'));
  assert.ok(!key(inSrc, 'd').calls.some(call => call.operation === 'exec.run'));
  const removed = key(inSrc, 'd', { answer: {} });
  assert.deepEqual(removed.calls.find(call => call.operation === 'exec.run').arguments.argv.slice(-1), ['src/main.ts']);
  const image = key(inSrc, 'k');
  assert.deepEqual(image.calls.find(call => call.operation === 'events.publish').arguments, { channel: 'blit', data: 'src/logo.png' });
  assert.equal(columns(image.state)[2].type, 'raster');
  const timer = run('timer', { key: 'blit' }, { state: image.state, world: { stdout: 'AAAA\n' } });
  assert.deepEqual(timer.calls.find(call => call.operation === 'terminal.blit').arguments, { key: 'omd_files_image', image: { media_type: 'image/jpeg', base64: 'AAAA' } });
});
