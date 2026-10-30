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
  '': ['src/', 'docs/', 'README.md', 'a.txt', '.env'],
  src: ['lib/', 'main.ts', 'logo.png', 'a10.ts', 'a2.ts'],
  'src/lib': ['util.ts'],
  docs: ['guide.md', 'my notes.md'],
};
const FILES = { 'README.md': '# Hello\n', 'a.txt': 'a\n', 'src/main.ts': 'const x = 1;\r\nexport default x;\r\n', 'src/lib/util.ts': 'export {};\n', 'docs/guide.md': 'Guide\n', 'docs/my notes.md': 'Notes\n' };
const OTHER = { '': ['other/', 'zeta.md'], other: [] };

function run(event, payload, { state = null, name, world = {} } = {}) {
  const calls = [];
  const tree = world.tree ?? TREE;
  const files = world.files ?? FILES;
  const host = ({ operation, arguments: args }) => {
    calls.push({ operation, arguments: args });
    if (operation === 'session.info') return { thread_id: world.thread ?? 't1', cwd: world.cwd ?? world.root ?? ROOT, root: world.root ?? ROOT };
    if (operation === 'workspace.list') {
      const dir = args.path === '.' ? '' : args.path;
      if (!tree[dir]) throw new Error(`workspace_not_found: ${dir}`);
      const names = tree[dir].slice(0, args.max_entries);
      const entries = names.map(item => ({ path: dir ? `${dir}/${item.replace(/\/$/, '')}` : item.replace(/\/$/, ''), kind: item.endsWith('/') ? 'dir' : 'file', size: 1, mtime_ms: 1 }));
      return { entries, truncated: names.length < tree[dir].length };
    }
    if (operation === 'workspace.stat') {
      const stat = path => (files[path] !== undefined ? { kind: 'file', size: files[path].length, mtime_ms: 1 } : tree[path] ? { kind: 'dir', size: 0, mtime_ms: 1 } : null);
      return { files: Object.fromEntries(args.paths.map(path => [path, stat(path)])) };
    }
    if (operation === 'workspace.read') return { files: Object.fromEntries(args.paths.map(path => [path, files[path] === undefined ? null : { text: files[path], sha256: 'x' }])) };
    if (operation === 'workspace.watch') return { watch_id: world.watch ?? 'w1' };
    if (operation === 'mods.service') {
      if (args.name === 'omd.frecency') return { paths: ['src/lib/util.ts', 'docs/guide.md'] };
      return args.method === 'panels' ? { panels: [{ id: 'files' }] } : { registered: 'files' };
    }
    if (operation === 'events.publish') return { delivered: 1, dropped: 0 };
    if (operation === 'events.schedule') return { scheduled: true };
    if (operation === 'terminal.prompt') return world.answer === undefined ? { status: 'declined' } : { status: 'accepted', ...world.answer };
    if (operation === 'composer.read') return { text: '', cursor: 0, selection: null, revision: 1, attachments: [], suggestion: null };
    if (operation === 'composer.write') return { text: args.edit.text, cursor: 0, revision: 2 };
    if (operation === 'terminal.open') {
      if (world.noEditor && args.editor) throw new Error('terminal_editor_unconfigured');
      return { opened: true };
    }
    if (operation === 'exec.run') {
      if (world.missing?.includes(args.program)) throw new Error(`exec_program_not_found: ${args.program}`);
      return { exit_code: 0, stdout: world.stdout ?? '', stderr: '' };
    }
    if (operation === 'terminal.blit') return { frame: 1, queued: 0, frame_ms: 1 };
    throw new Error(`unexpected host operation ${operation}`);
  };
  const request = {
    source, filename: fileURLToPath(new URL('index.ts', mod)), entrypoint: 'index.ts', api: manifest.api, capabilities: manifest.capabilities,
    state, settings: {}, event, name, payload, hook_budget_ms: 10000,
  };
  const output = callback(request, host);
  if (output.error) throw new Error(output.error);
  return { value: output.value, state: output.state ?? state, calls };
}
const started = world => run('start', null, { world }).state;
const key = (state, name, world) => run('command', `key ${name}`, { state, name: 'files', world });
const keys = (state, names, world) => names.reduce((now, name) => key(now, name, world).state, state);
const draw = (state, { rows = 40, cwd = ROOT, sites } = {}) => {
  const client = { columns: 160, rows, ...(sites ? { sites: { 'omd_files/main': sites } } : {}) };
  return run('terminal', { event: 'redraw', ledger: { thread_id: 't1', cwd, cost: null }, client }, { state }).value;
};
const site = (state, options) => draw(state, options).sites['omd_files/main'].components;
const box = (state, options) => site(state, options).find(node => node.id === 'omd_files_columns');
const columns = (state, options) => box(state, options).children.map(column => column.children[0]);
const text = node => node.lines.map(line => line.map(span => span.text).join('')).join('\n').replace(/(\n )+$/, '');
const status = (state, options) => site(state, options).at(-1).spans[0].text;
const ran = calls => calls.filter(call => call.operation === 'exec.run').map(call => call.arguments);

test('three columns list the parent, the current directory and a preview, naturally sorted with dotfiles hidden', () => {
  const state = started();
  const [parent, current, preview] = columns(state);
  assert.equal(text(parent), 'empty');
  assert.equal(text(current), '▶ docs/\n  src/\n  a.txt\n  README.md');
  assert.equal(text(preview), '  guide.md\n  my notes.md');
  const inSrc = keys(state, ['j', 'l']);
  const [up, here, code] = columns(inSrc);
  assert.equal(text(up), '  docs/\n▶ src/\n  a.txt\n  README.md');
  assert.equal(text(here), '▶ lib/\n  a2.ts\n  a10.ts\n  logo.png\n  main.ts');
  assert.equal(code.type, 'document');
  const file = keys(inSrc, ['G']);
  const [, , highlighted] = columns(file);
  assert.deepEqual([highlighted.type, highlighted.language, highlighted.text.trimEnd(), highlighted.start], ['code', 'ts', 'const x = 1;\nexport default x;', 0]);
  const scrolled = columns(key(file, 'J').state)[2];
  assert.deepEqual([scrolled.text.trimEnd(), scrolled.start], ['const x = 1;\nexport default x;', 2]);
  assert.match(text(columns(key(state, '.').state)[1]), /\.env/);
});

test('the layout follows the site area the host reports, and falls back to the terminal size', () => {
  const state = started();
  assert.ok(columns(state, { rows: 80 }).every(node => (node.height ?? 1) <= 40));
  const sized = box(state, { sites: { columns: 120, rows: 30 } });
  assert.deepEqual(sized.children.map(column => [column.id, column.children[0].height]), [['omd_files_parent_column', 27], ['omd_files_current_column', 27], ['omd_files_preview_column', 27]]);
  const narrow = box(state, { sites: { columns: 50, rows: 20 } });
  assert.deepEqual(narrow.children.map(column => column.id), ['omd_files_current_column', 'omd_files_preview_column']);
});

test('h returns to the parent with the old directory selected, and gg and G jump', () => {
  const back = keys(started(), ['j', 'l', 'h']);
  assert.equal(text(columns(back)[1]), '  docs/\n▶ src/\n  a.txt\n  README.md');
  const bottom = key(back, 'G').state;
  assert.match(text(columns(bottom)[1]), /▶ README\.md$/);
  const once = key(bottom, 'g').state;
  assert.match(text(columns(once)[1]), /▶ README\.md$/);
  assert.match(status(once), /^g…/);
  assert.match(text(columns(key(once, 'g').state)[1]), /^▶ docs\//);
  assert.match(text(columns(keys(once, ['j', 'g']))[1]), /▶ README\.md$/);
});

test('the thread state lists on start and resume, and draws and acts only for the session root', () => {
  assert.equal(text(columns(run('resume', { thread_id: 't1', last_turn: null, restarted: false }).state)[1]), '▶ docs/\n  src/\n  a.txt\n  README.md');
  const state = started();
  assert.equal(draw(state, { cwd: '/other' }), null);
  assert.equal(text(columns(state, { cwd: `${ROOT}/src` })[1]), '▶ docs/\n  src/\n  a.txt\n  README.md');
  const moved = run('thread_settings', { cwd: { before: ROOT, after: '/other' } }, { state, world: { root: '/other', tree: OTHER, files: {} } }).state;
  assert.equal(text(columns(moved, { cwd: '/other' })[1]), '▶ other/\n  zeta.md');
  const other = key(state, 'j', { root: '/other', tree: OTHER, files: {} }).state;
  assert.equal(text(columns(other, { cwd: '/other' })[1]), '  other/\n▶ zeta.md');
});

test('mods_changed re-registers without listing again while the watch is kept, and lists once it was replaced', () => {
  const state = started();
  const lists = calls => calls.filter(call => call.operation === 'workspace.list');
  const same = run('mods_changed', { active: ['omd_files', 'omd_workspace'] }, { state });
  assert.ok(same.calls.some(call => call.operation === 'mods.service' && call.arguments.method === 'register'));
  assert.deepEqual(lists(same.calls), []);
  assert.ok(lists(run('mods_changed', { active: ['omd_files', 'omd_workspace'] }, { state, world: { watch: 'w2' } }).calls).length);
});

test('the listing refreshes at the end of a turn, and a deleted directory climbs to the nearest parent that exists', () => {
  const inLib = keys(started(), ['j', 'l', 'l']);
  assert.equal(text(columns(inLib)[1]), '▶ util.ts');
  const grown = { ...TREE, 'src/lib': ['util.ts', 'new.ts'] };
  const turned = run('turn_end', null, { state: inLib, world: { tree: grown } }).state;
  assert.equal(text(columns(turned)[1]), '  new.ts\n▶ util.ts');
  const gone = { ...TREE, src: ['main.ts'] };
  delete gone['src/lib'];
  const changed = run('workspace_change', { changes: [{ path: 'src/lib', kind: 'delete' }], status: 'ok' }, { state: inLib, world: { tree: gone } }).state;
  assert.equal(columns(changed)[1].label, 'src');
});

test('tabs open with t and switch by number, brackets and q, and a tab whose directory is gone opens its nearest parent', () => {
  const state = started();
  const none = key(state, '2');
  assert.match(status(none.state), /^No tab 2: t opens one/);
  const two = keys(state, ['t', 'j', 'l', 'l']);
  const view = draw(two);
  assert.deepEqual(view.key_contexts[0].when, { focus: 'omd_files/main' });
  assert.ok(view.key_contexts[0].keys['9'] && view.key_contexts[0].keys[']']);
  assert.ok(Object.keys(view.key_contexts[0].keys).length <= 32);
  assert.match(view.sites['omd_files/main'].components[0].spans.map(span => span.text).join(''), /^1 \/ {2}2 lib {2}$/);
  assert.match(text(columns(key(two, '1').state)[1]), /^▶ docs\//);
  assert.match(text(columns(key(two, '[').state)[1]), /^▶ docs\//);
  const back = key(two, '1').state;
  const gone = { ...TREE, src: ['main.ts'] };
  delete gone['src/lib'];
  const climbed = key(back, '2', { tree: gone }).state;
  assert.equal(columns(climbed)[1].label, 'src');
  assert.equal(text(columns(climbed)[1]), '▶ main.ts');
  const lost = key(back, '2', { tree: { '': [] } }).state;
  assert.equal(columns(lost)[1].label, '/');
  const closed = key(two, 'q').state;
  assert.equal(draw(closed).key_contexts[0].keys[']'], undefined);
  assert.match(text(columns(closed)[1]), /^▶ docs\//);
});

test('/files go accepts a path, . and nothing', () => {
  const inSrc = keys(started(), ['j', 'l']);
  for (const path of ['.', './', '']) {
    const gone = run('command', `go ${path}`, { state: inSrc, name: 'files' }).state;
    assert.deepEqual([columns(gone)[1].label, box(gone).children[1].title], ['/', '/']);
  }
  const deep = run('command', 'go ./src/lib/', { state: started(), name: 'files' }).state;
  assert.equal(columns(deep)[1].label, 'src/lib');
});

test('find selects matches, z jumps to a frecency-ranked file and @ mentions it, quoted when it has spaces', () => {
  const inSrc = keys(started(), ['j', 'l']);
  assert.match(status(key(inSrc, '/', { answer: { value: 'A' } }).state), /No match for A/);
  const lower = key(inSrc, '/', { answer: { value: 'a' } }).state;
  assert.match(text(columns(lower)[1]), /▶ a2\.ts/);
  assert.match(text(columns(key(lower, 'n').state)[1]), /▶ a10\.ts/);
  assert.match(text(columns(key(lower, 'N').state)[1]), /▶ main\.ts/);
  assert.ok(!run('start', null).calls.some(call => call.arguments?.name === 'omd.frecency'));
  const prompted = key(started(), 'z', { answer: { values: ['src/lib/util.ts'] } });
  assert.equal(text(columns(prompted.state)[1]), '▶ util.ts');
  const typed = key(started(), 'z', { answer: { values: ['guide'], other: true } }).state;
  assert.equal(text(columns(typed)[1]), '▶ guide.md\n  my notes.md');
  const write = result => result.calls.find(call => call.operation === 'composer.write').arguments.edit.text;
  assert.equal(write(key(prompted.state, '@', { cwd: `${ROOT}/src` })), '@lib/util.ts ');
  assert.equal(write(key(keys(started(), ['l', 'j']), '@')), '@"docs/my notes.md" ');
});

test('d moves to the Trash with the first command that runs, D deletes for good, both after a confirm', () => {
  const inSrc = keys(started(), ['j', 'l', 'G']);
  assert.deepEqual(ran(key(inSrc, 'd').calls), []);
  const trashed = key(inSrc, 'd', { answer: {}, missing: ['/usr/bin/trash'] });
  const prompt = trashed.calls.find(call => call.operation === 'terminal.prompt').arguments;
  assert.match(prompt.message, /^Move src\/main\.ts to the Trash\?/);
  assert.deepEqual(ran(trashed.calls).map(args => [args.program, args.argv.at(-1), args.sandbox]), [['/usr/bin/trash', '/repo/src/main.ts', 'none'], ['trash', '/repo/src/main.ts', 'none']]);
  assert.match(status(trashed.state), /Moved main\.ts to the Trash/);
  const stuck = key(inSrc, 'd', { answer: {}, missing: ['/usr/bin/trash', 'trash', 'osascript'] });
  assert.match(status(stuck.state), /D deletes permanently/);
  const removed = key(inSrc, 'D', { answer: {} });
  assert.match(removed.calls.find(call => call.operation === 'terminal.prompt').arguments.message, /cannot be undone/);
  assert.deepEqual(ran(removed.calls).map(args => [args.program, args.write, args.argv.at(-1)]), [['sh', true, 'src/main.ts']]);
});

test('rename moves inside the workspace, keeps a renamed directory selected, refuses an existing target and allows a case-only rename', () => {
  const inSrc = keys(started(), ['j', 'l', 'G']);
  const moved = ran(key(inSrc, 'r', { answer: { value: 'lib/main.ts' } }).calls);
  assert.deepEqual(moved.map(args => [args.write, ...args.argv.slice(-2)]), [[true, 'src/main.ts', 'src/lib/main.ts']]);
  assert.deepEqual(ran(key(inSrc, 'r', { answer: { value: '../x' } }).calls), []);
  const taken = key(inSrc, 'r', { answer: { value: 'lib/util.ts' } });
  assert.deepEqual(ran(taken.calls), []);
  assert.match(status(taken.state), /^src\/lib\/util\.ts already exists/);
  const renamed = key(keys(started(), ['j', 'l']), 'r', { answer: { value: 'helpers' }, tree: { ...TREE, src: ['helpers/', 'main.ts'] } }).state;
  assert.deepEqual([columns(renamed)[1].label, text(columns(renamed)[1])], ['src', '▶ helpers/\n  main.ts']);
  const files = { ...FILES, 'src/Main.ts': FILES['src/main.ts'] };
  const cased = ran(key(inSrc, 'r', { answer: { value: 'Main.ts' }, files }).calls);
  assert.deepEqual(cased.map(args => args.argv.slice(-2)), [['src/main.ts', 'src/Main.ts']]);
});

test('images go to a raster through a timer, from a private temporary file', () => {
  const image = key(keys(started(), ['j', 'l', 'G']), 'k');
  assert.deepEqual(image.calls.find(call => call.operation === 'events.publish').arguments, { channel: 'blit', data: 'src/logo.png' });
  assert.equal(columns(image.state)[2].type, 'raster');
  const timer = run('timer', { key: 'blit' }, { state: image.state, world: { stdout: 'AAAA\n' } });
  assert.deepEqual(timer.calls.find(call => call.operation === 'terminal.blit').arguments, { key: 'omd_files_image', image: { media_type: 'image/jpeg', base64: 'AAAA' } });
});

test('the saved state stays within 64 KiB for long listings and previews', () => {
  const long = index => `${'n'.repeat(90)}${index}.md`;
  const names = Array.from({ length: 1_000 }, (_, index) => long(index));
  const tree = { '': ['big/', ...names.slice(0, 400)], big: ['a-quoted.txt', ...names] };
  const files = { 'big/a-quoted.txt': Array.from({ length: 400 }, () => '"\\"\\'.repeat(60)).join('\n') };
  let state = started({ tree, files });
  state = keys(state, ['l', 't', 't', 't', 't', 't', 't', 't', 't'], { tree, files });
  const bytes = Buffer.byteLength(JSON.stringify(state));
  assert.ok(bytes <= 65_536, `${bytes} bytes`);
  assert.equal(columns(state)[2].type, 'code');
  assert.match(status(state), /^1\/\d+\+ /);
});
