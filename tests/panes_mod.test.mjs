import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const runner = readFileSync(new URL('../runtime/omd/src/mods/runner.mjs', import.meta.url), 'utf8');
const mod = new URL('../mods/first-party/omd_panes/', import.meta.url);
const source = readFileSync(new URL('index.ts', mod), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('mod.json', mod), 'utf8'));
const surface = { events: { terminal: 'terminal', channel: 'events', start: 'lifecycle', resume: 'lifecycle', workspace_change: 'fs.read', component_event: 'terminal' },
  replacements: [], middleware: [], state: 'store', contracts: 'contracts' };
const sha = data => createHash('sha256').update(data).digest('hex');

function fixture(launch = '') {
  const repository = realpathSync(mkdtempSync(join(tmpdir(), 'omd-panes-')));
  const git = (...argv) => spawnSync('git', argv, { cwd: repository, encoding: 'utf8' });
  git('init', '-q');
  mkdirSync(join(repository, 'src/deep'), { recursive: true });
  writeFileSync(join(repository, '.gitignore'), 'build/\n');
  writeFileSync(join(repository, 'src/app.ts'), 'export const value = 1;\n');
  writeFileSync(join(repository, 'src/deep/util.ts'), 'export function util() {}\n');
  writeFileSync(join(repository, 'file10.txt'), 'ten\n');
  writeFileSync(join(repository, 'file2.txt'), 'two\n');
  git('add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base');
  writeFileSync(join(repository, 'src/app.ts'), 'export const value = 2;\n');
  writeFileSync(join(repository, 'notes.md'), '# new\n');
  mkdirSync(join(repository, 'build'));
  writeFileSync(join(repository, 'build/out.js'), '');
  const root = join(repository, launch);
  const store = new Map();
  const backups = new Map();
  const answers = [];
  const calls = [];
  const kind = path => {
    const full = join(root, path);
    if (!existsSync(full)) return null;
    const stat = lstatSync(full);
    return { kind: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'dir' : 'file', size: stat.size, mtime_ms: 0, ...(stat.isFile() ? { sha256: sha(readFileSync(full)) } : {}) };
  };
  const walk = (dir, recursive) => readdirSync(join(root, dir), { withFileTypes: true }).filter(entry => entry.name !== '.git')
    .flatMap(entry => {
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      return [{ path, ...kind(path) }, ...(recursive && entry.isDirectory() ? walk(path, true) : [])];
    });
  const host = (operation, args) => {
    calls.push({ operation, args });
    switch (operation) {
      case 'store.get': return store.get(`${args.scope}:${args.key}`) ?? null;
      case 'store.put': {
        const current = store.get(`${args.scope}:${args.key}`);
        assert.equal(args.expected_revision, current?.revision ?? null);
        store.set(`${args.scope}:${args.key}`, { value: args.value, revision: (current?.revision ?? 0) + 1, provenance: { thread_id: 'thread-1' } });
        return { revision: (current?.revision ?? 0) + 1 };
      }
      case 'exec.run': {
        const run = spawnSync(args.program, args.argv ?? [], { cwd: root, input: args.stdin, encoding: 'utf8' });
        return { exit_code: run.status, stdout: run.stdout, stderr: run.stderr, stdout_sha256: sha(run.stdout), stdout_preview_truncated: false };
      }
      case 'workspace.list': return { entries: walk(args.path ?? '', args.recursive), truncated: false };
      case 'workspace.stat': return { files: Object.fromEntries(args.paths.map(path => [path, kind(path)])) };
      case 'workspace.transaction': {
        for (const [path, expected] of Object.entries(args.expected)) assert.equal(kind(path)?.sha256 ?? null, expected, `stale ${path}`);
        const reference = { reference: `backup-${backups.size}`, sha256: '0' };
        if (args.backup) backups.set(reference.reference, Object.fromEntries(Object.keys(args.expected).map(path => [path, readFileSync(join(root, path))])));
        for (const { old, new: next } of args.renames ?? []) renameSync(join(root, old), join(root, next));
        for (const [path, text] of Object.entries(args.writes ?? {})) writeFileSync(join(root, path), text);
        for (const path of args.deletes ?? []) rmSync(join(root, path));
        return { files: {}, backup: args.backup ? reference : null };
      }
      case 'workspace.restore':
        for (const [path, data] of Object.entries(backups.get(args.backup.reference))) writeFileSync(join(root, path), data);
        return { files: {} };
      case 'terminal.prompt': return args.kind === 'text' ? { status: 'accepted', value: answers.shift() } : { status: 'accepted' };
      case 'terminal.pty': return args.action === 'start' ? { session: args.session, running: true } : { stopped: true };
      case 'app.request': return { files: walk('', true).filter(entry => entry.kind === 'file' && entry.path.includes(args.params.query.split(' ').at(-1))).map(entry => ({ path: entry.path })) };
      default: return { delivered: 1, dropped: 0 };
    }
  };
  const invoke = (state, event, payload, name) => {
    const receipts = [];
    for (;;) {
      const request = { source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, state, settings: { git: true, lsp: true }, event, name, payload, receipts, surface, hook_budget_ms: 10000 };
      const output = JSON.parse(spawnSync(process.execPath, ['--no-warnings', '--experimental-vm-modules', '--input-type=module', '--eval', runner],
        { input: JSON.stringify(request), encoding: 'utf8', timeout: 20000 }).stdout);
      if (output.error) throw new Error(output.error);
      if (!output.host_call) return { value: output.value, state: output.state };
      receipts.push({ call: output.host_call, value: host(output.host_call.operation, output.host_call.arguments) });
    }
  };
  let state = null;
  const command = (name, text) => {
    const result = invoke(state, 'command', text, name);
    state = result.state;
    return result.value;
  };
  const view = () => invoke(state, 'terminal', { event: 'redraw', ledger: null }).value;
  const service = (name, input) => {
    const result = invoke(state, 'service', input, name);
    state = result.state;
    return result.value;
  };
  return { repository, store, answers, calls, command, view, service, event: (event, payload) => { state = invoke(state, event, payload).state; }, state: () => state };
}

test('panes split, focus, move, resize and persist a valid layout per thread', () => {
  const { repository, store, command, view, event, state } = fixture();
  try {
    assert.equal(view().layout, undefined);
    assert.equal(view().keybindings['Alt+e'].command, 'omd_panes:tree');
    command('pane', 'split right shell');
    command('pane', 'split down diff');
    command('pane', 'focus left');
    assert.equal(state().layout.active, 'chat');
    command('pane', 'split right run npm test');
    assert.deepEqual(view().layout, { split: 'horizontal', ratio: [25, 25, 50], children: [
      { split: 'vertical', ratio: [5, 1], children: [{ content: 'transcript' }, { content: 'composer' }] },
      { content: 'site:omd_panes/p3-shell' },
      { split: 'vertical', ratio: [50, 50], children: [{ content: 'site:omd_panes/p1-shell' }, { content: 'site:omd_panes/p2-diff' }] }] });
    assert.deepEqual(state().layout.panes.p3.argv, ['npm', 'test']);
    assert.match(view().sites['omd_panes/p2-diff'].components[1].unified, /-export const value = 1;\n\+export const value = 2;/);
    command('pane', 'move right');
    command('pane', 'grow width');
    assert.deepEqual(state().layout.root.children.map(child => typeof child === 'string' ? child : child.children), ['chat', 'p1', ['p3', 'p2']]);
    assert.deepEqual(state().layout.root.ratio, [25, 15, 60]);
    event('component_event', { component: 'r.2', kind: 'resize', ratio: [70, 30] });
    assert.deepEqual(state().layout.root.children[2].ratio, [70, 30]);
    assert.deepEqual(store.get('thread:layout').value, state().layout);
    for (let index = 0; index < 8; index++) command('pane', 'split down @p3');
    assert.equal(command('pane', 'split right @p3').display, 'the layout allows at most 12 panes nested 4 deep, and each mod panel once');
    assert.equal(command('pane', 'close @chat').display, 'The conversation pane stays open; close the other panes instead');
    command('pane', 'reset');
    assert.equal(view().layout, undefined);
    store.set('thread:layout', { value: { root: { split: 'horizontal', ratio: [50, 50], children: ['chat', 'p9'] }, panes: { chat: { kind: 'chat' }, p9: { kind: 'site', site: 'sidebar' } }, active: 'p9', next: 10 }, revision: 7 });
    event('resume', { thread_id: 'thread-1', last_turn: null, restarted: true });
    assert.deepEqual(view().layout.children[1], { content: 'site:sidebar' });
    assert.equal(state().revision, 7);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test('tabs hold pane layouts beside the conversation and follow keys, clicks and the cockpit preset', () => {
  const { repository, command, view, service, event, state } = fixture();
  try {
    command('pane', 'tab new');
    assert.deepEqual(view().layout, { split: 'horizontal', ratio: [50, 50], children: [
      { split: 'vertical', ratio: [5, 1], children: [{ content: 'transcript' }, { content: 'composer' }] },
      { tabs: [{ title: 'Shell .', node: { content: 'site:omd_panes/p1-shell' } }], active: 0 }] });
    command('pane', 'tab new diff');
    command('pane', 'split down diff src');
    command('pane', 'tab rename review');
    assert.deepEqual(view().layout.children[1].tabs.map(tab => tab.title), ['Shell .', 'review']);
    assert.deepEqual(service('omd.panes.tabs', null), { titles: ['Shell .', 'review'], active: 1 });
    command('pane', 'tab 1');
    assert.equal(state().layout.active, 'p1');
    assert.equal(view().layout.children[1].active, 0);
    assert.ok(Object.keys(view().keybindings).length <= 12);
    event('component_event', { component: 'r.1', kind: 'select', index: 1 });
    assert.equal(state().layout.active, 'p2');
    command('pane', 'focus left');
    assert.equal(state().layout.active, 'chat');
    command('pane', 'move right');
    assert.equal(state().layout.root.children[0], 'chat');
    command('pane', 'tab close');
    assert.deepEqual(view().layout.children[1], { tabs: [{ title: 'Shell .', node: { content: 'site:omd_panes/p1-shell' } }], active: 0 });
    command('pane', 'tab close');
    assert.equal(view().layout, undefined);
    service('omd.panes.cockpit', null);
    assert.deepEqual(view().layout.children.map(child => child.content ?? child.tabs?.map(tab => `${tab.title}:${tab.node.content}`) ?? 'chat'),
      ['site:omd_layout/sessions', 'chat', ['Status:site:sidebar', 'Files:site:omd_panes/p3-tree', 'Diff:site:omd_panes/p4-diff']]);
    command('tree', 'select src/app.ts');
    assert.deepEqual(service('omd.panes.find', { query: 'VALUE', regex: false, case: false }).views, [{ path: 'src/app.ts', matches: 1 }]);
    const viewer = Object.entries(view().sites).find(([name]) => name.endsWith('-viewer'))[1].components;
    assert.deepEqual(viewer[1].find, { query: 'VALUE', regex: false, case: false });
    assert.match(viewer[2].text, /1 matches for VALUE/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test('file tree Git markers follow a subdirectory launch', () => {
  const { repository, command, view } = fixture('src');
  try {
    command('tree', '');
    assert.deepEqual(view().sites['omd_panes/p1-tree'].components[2].rows.map(row => row.spans.map(span => `${span.text}|${span.tone ?? 'normal'}`).join('')), ['▸ deep/|normal', '  app.ts|attention M|attention']);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test('file tree shows Git state, opens files and changes them through confirmed transactions', () => {
  const { repository, answers, calls, command, view, state } = fixture();
  try {
    command('tree', '');
    const rows = () => view().sites['omd_panes/p1-tree'].components[2].rows.map(row => row.spans.map(span => `${span.text}|${span.tone ?? 'normal'}`).join(''));
    assert.deepEqual(rows(), ['▸ build/|muted', '▸ src/|attention M|attention', '  .gitignore|normal', '  file2.txt|normal', '  file10.txt|normal', '  notes.md|accent U|accent']);
    command('tree', 'select src');
    assert.deepEqual(rows().slice(1, 4), ['▾ src/|attention M|attention', '  ▸ deep/|normal', '    app.ts|attention M|attention']);
    command('tree', 'select src/app.ts');
    const viewer = view().sites['omd_panes/p2-viewer'].components;
    assert.deepEqual(viewer[1].lines, [[{ text: '1 ', tone: 'muted' }, { text: 'export const value = 2;' }]]);
    command('view', 'line @p2 1');
    const lsp = view().sites['omd_panes/p2-viewer'].components.find(component => component.id === 'omd_panes_p2_lsp');
    assert.deepEqual(lsp.options.slice(0, 3).map(option => option.value), ['definition src/app.ts:1:14', 'references src/app.ts:1:14', 'hover src/app.ts:1:14']);
    const tree = view().sites['omd_panes/p1-tree'].components;
    assert.equal(tree.find(component => component.id === 'omd_panes_p1_git').action.command, 'omd_git:act');
    command('tree', 'find util');
    assert.deepEqual(state().find, ['src/deep/util.ts']);
    command('tree', 'find');

    answers.push('moved');
    command('file', 'rename src/deep');
    assert.equal(readFileSync(join(repository, 'src/moved/util.ts'), 'utf8'), 'export function util() {}\n');
    assert.equal(existsSync(join(repository, 'src/deep')), false);
    const transaction = calls.filter(call => call.operation === 'workspace.transaction').at(-1).args;
    assert.deepEqual(transaction.renames, [{ old: 'src/deep/util.ts', new: 'src/moved/util.ts' }]);
    answers.push('fresh.txt');
    command('file', 'new_file src');
    assert.equal(readFileSync(join(repository, 'src/fresh.txt'), 'utf8'), '');
    command('file', 'delete src/moved');
    assert.equal(existsSync(join(repository, 'src/moved')), false);
    command('file', 'undo src');
    assert.equal(readFileSync(join(repository, 'src/moved/util.ts'), 'utf8'), 'export function util() {}\n');
    assert.equal(calls.filter(call => call.operation === 'terminal.prompt' && call.args.kind === 'confirm').length, 3);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});
