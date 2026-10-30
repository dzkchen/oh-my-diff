import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { callback } from '../../../tests/mod_runner.mjs';

const mod = new URL('./', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('mod.json', mod), 'utf8'));
const source = readFileSync(new URL('index.ts', mod), 'utf8');
const assets = Object.fromEntries(manifest.assets.map(name => [name, { text: readFileSync(new URL(name, mod), 'utf8'), sha256: '0'.repeat(64) }]));

const status = (prefix = '') => [` M ${prefix}src/a.ts`, `?? ${prefix}new file.txt`, `R  ${prefix}b.ts`, `${prefix}a.ts`].join('\0') + '\0';
const defaults = Object.fromEntries(Object.entries(manifest.settings_schema.properties).map(([name, schema]) => [name, schema.default]));
const git = (state, argv) => {
  const args = argv.slice(2);
  if (args[0] === 'rev-parse') return { exit_code: state.notGit ? 128 : 0, stdout: state.prefix ?? '' };
  if (args[0] === 'status') return { exit_code: 0, stdout: state.paths ? state.paths.map(path => ` M ${path}`).join('\0') + '\0' : status(state.prefix) };
  const path = args.at(-1);
  if (args.includes('--no-index')) return { exit_code: 1, stdout: `diff --git a/${path} b/${path}\n+new\n` };
  if (state.unborn && args.includes('HEAD')) return { exit_code: 128, stdout: '', stderr: 'fatal: bad revision' };
  return { exit_code: 0, stdout: state.diff ?? `diff --git a/${path} b/${path}\n-old\n+new\n` };
};

function run(event, payload, { state = null, settings = {}, name, world = {} } = {}) {
  const calls = [];
  const host = ({ operation, arguments: args }) => {
    calls.push({ operation, arguments: args });
    if (operation === 'exec.run') return { stderr: '', ...git(world, args.argv) };
    if (operation === 'session.info') return { thread_id: 't1' };
    if (operation === 'terminal.pty') {
      if (world.declined) return { status: 'declined' };
      if (world.full) throw new Error('pty_session_exists_or_limit');
      return args.action === 'read' ? { text: '', running: !world.exited, exit_code: null } : { session: args.session, running: true };
    }
    if (operation === 'terminal.notice') return {};
    throw new Error(`unexpected host operation ${operation}`);
  };
  const request = { source, filename: fileURLToPath(new URL('index.ts', mod)), entrypoint: 'index.ts', assets, api: manifest.api, capabilities: manifest.capabilities, state, settings: { ...defaults, ...settings }, settings_file: { path: '/store/settings/omd_workspace.json', status: 'missing', error: null }, event, name, payload, hook_budget_ms: 10000 };
  const output = callback(request, host);
  if (output.error) throw new Error(output.error);
  return { value: output.value, state: output.state ?? state, calls };
}

const draw = (state, { columns = 120, rows = 40, settings } = {}) =>
  run('terminal', { event: 'redraw', ledger: { thread_id: 't1', cwd: '/repo', cost: null }, client: { columns, rows } }, { state, settings }).value;
const command = (args, state, options) => run('command', args, { ...options, state, name: 'workspace' });
const emit = (state, payload, options) => run('component_event', { thread_id: 't1', origin: 'user', ...payload }, { ...options, state });
const service = (method, input, state, options) => run('service', input, { ...options, state, name: `omd.workspace.${method}` });
const leaf = (name, title = '', border = 'rounded') => ({ content: `site:${name}`, title, style: { border } });
const chat = { split: 'vertical', ratio: [5, 1], children: [{ content: 'transcript', title: 'Chat' }, { content: 'composer' }] };
const CHANGES = 'omd_workspace/changes';
const SHELL = 'omd_workspace/terminal';
const dock = (active = 0, tabs = [['1 Changes', CHANGES], ['2 Shell', SHELL]]) => ({ tabs: tabs.map(([title, site]) => ({ title, node: leaf(site, title) })), active });
const stack = { layout: 'stack' };
const register = (state, id, tabs = 0, order) => service('register', {
  id, title: id, site: `${id}/main`, ...(order === undefined ? {} : { order }),
  ...(tabs ? { tabs: Array.from({ length: tabs }, (_, index) => ({ title: `t${index}`, site: `${id}/t${index}` })) } : {}),
}, state).state;
const keysOf = contexts => contexts.reduce((total, context) => total + Object.keys(context.keys).length, 0);
const cells = node => node.tabs ? node.tabs.reduce((total, tab) => total + cells(tab.node), 0) : node.children ? node.children.reduce((total, child) => total + cells(child), 0) : 1;
const depth = node => 1 + Math.max(0, ...(node.tabs ?? []).map(tab => depth(tab.node)), ...(node.children ?? []).map(depth));

test('the panels are titled tabs of one dock right of the chat, and a band below it when narrow', () => {
  assert.deepEqual(draw(null).layout, { split: 'horizontal', ratio: [67, 33], children: [chat, dock()] });
  assert.deepEqual(draw(null, { columns: 83 }).layout, { split: 'vertical', ratio: [67, 33], children: [chat, dock()] });
  assert.equal(draw(null, { columns: 84 }).layout.split, 'horizontal');
  const left = { side: 'left', dock_size: 25, panels: 'terminal, changes', narrow_below: 100 };
  const swapped = dock(0, [['1 Shell', SHELL], ['2 Changes', CHANGES]]);
  assert.deepEqual(draw(null, { settings: left }).layout, { split: 'horizontal', ratio: [25, 75], children: [swapped, chat] });
  assert.deepEqual(draw(null, { columns: 99, settings: left }).layout, { split: 'vertical', ratio: [25, 75], children: [swapped, chat] });
});

test('stack mode keeps numbered split panels beside the chat and in a row when narrow', () => {
  const side = [leaf(CHANGES, '1 Changes'), leaf(SHELL, '2 Shell')];
  assert.deepEqual(draw(null, { settings: stack }).layout, { split: 'horizontal', ratio: [67, 33], children: [chat, { split: 'vertical', children: side }] });
  assert.deepEqual(draw(null, { columns: 83, settings: stack }).layout, { split: 'vertical', ratio: [67, 33], children: [chat, { split: 'horizontal', children: side }] });
  const one = draw(null, { settings: { layout: 'stack', side: 'left', panels: 'terminal' } }).layout;
  assert.deepEqual(one, { split: 'horizontal', ratio: [33, 67], children: [leaf(SHELL, '1 Shell'), chat] });
});

test('half and full screen modes act on the whole dock and keep a compact chat below in full', () => {
  const mode = (target, level) => ({ mode: { target, level } });
  assert.deepEqual(draw(mode('dock', 'half')).layout, { split: 'horizontal', ratio: [50, 50], children: [chat, dock()] });
  assert.deepEqual(draw(mode('changes', 'half')).layout, draw(mode('dock', 'half')).layout);
  assert.deepEqual(draw(mode('dock', 'full'), { rows: 30 }).layout, { split: 'vertical', ratio: [73, 27], children: [dock(), chat] });
  assert.deepEqual(draw(mode('dock', 'full'), { rows: 200 }).layout.ratio, [96, 4]);
  assert.deepEqual(draw(mode('dock', 'full'), { rows: 4 }).layout.ratio, [1, 99]);
  assert.deepEqual(draw(mode('chat', 'half')).layout.ratio, [75, 25]);
  const grown = command('grow').state;
  assert.deepEqual([draw({ ...grown, ...mode('dock', 'half') }).layout.ratio, draw({ ...grown, ...mode('chat', 'half') }).layout.ratio], [[50, 50], [75, 25]]);
  const full = draw(mode('chat', 'full'));
  assert.deepEqual(full.layout, chat);
  assert.equal(full.key_contexts, undefined);

  assert.deepEqual(draw(mode('changes', 'half'), { settings: stack }).layout, { split: 'horizontal', ratio: [50, 50], children: [chat, leaf(CHANGES, '1 Changes')] });
  assert.deepEqual(draw(mode('changes', 'full'), { rows: 30, settings: stack }).layout, { split: 'vertical', ratio: [73, 27], children: [leaf(CHANGES, '1 Changes'), chat] });
  const panel = draw(mode('changes', 'half'), { settings: stack }).key_contexts.at(-1);
  assert.deepEqual(Object.keys(panel.keys).filter(key => /^\d$/.test(key)).sort(), ['0', '1']);
});

test('modes cycle with next and previous, act on any panel and clear on normal', () => {
  let state = command('mode next changes').state;
  assert.deepEqual(state.mode, { target: 'changes', level: 'half' });
  state = command('mode next changes', state).state;
  assert.equal(state.mode.level, 'full');
  assert.equal(command('mode previous changes', state).state.mode.level, 'half');
  assert.equal(command('mode next changes', state).state.mode, null);
  assert.equal(command('mode half', null).state.mode.target, 'chat');
  assert.deepEqual(command('mode full dock', null, { settings: stack }).state.mode, { target: 'dock', level: 'full' });
  assert.equal(draw({ mode: { target: 'gone', level: 'full' } }, { settings: stack }).layout.split, 'vertical');
  assert.equal(command('mode half missing', null).value.display, 'Unknown panel missing');
  const corner = command('layout corner').state;
  assert.deepEqual(draw({ ...corner, mode: { target: 'terminal', level: 'full' } }).layout, { split: 'vertical', ratio: [80, 20], children: [leaf(SHELL, '2 Shell'), chat] });
  assert.deepEqual(draw({ ...corner, mode: { target: 'changes', level: 'half' } }).layout, { split: 'horizontal', ratio: [50, 50], children: [chat, leaf(CHANGES, '1 Changes')] });
});

test('keys show or focus panels by number, move between regions, resize and change screen modes', () => {
  const contexts = draw(null).key_contexts;
  const general = contexts.at(-1);
  const run = args => ({ command: 'workspace', args });
  assert.deepEqual(general.when, { focus: 'site' });
  assert.deepEqual(general.keys['2'], { action: run('tab 2'), label: 'Show Shell' });
  assert.equal(general.keys['3'], undefined);
  assert.deepEqual(['0', 'h', 'Left', 'l', 'Right', 'k', 'Up', 'j', 'Down', '?'].map(key => general.keys[key].action), [
    { region: 'chat' }, { region: 'left' }, { region: 'left' }, { region: 'right' }, { region: 'right' },
    { region: 'up' }, { region: 'up' }, { region: 'down' }, { region: 'down' }, { help: true },
  ]);
  assert.deepEqual(['[', ']', '=', '-'].map(key => general.keys[key].action), [run('tab previous'), run('tab next'), run('grow'), run('shrink')]);
  assert.deepEqual(contexts.slice(0, -1).map(context => [context.when.focus, context.keys['+'].action]), [[[CHANGES], run('mode next changes')], [[SHELL], run('mode next terminal')]]);

  const keys = { key_panel_1: 'a', key_help: '<disabled>', key_main: 'nope', key_grow: 'Ctrl+g', key_left_alt: 'Esc', key_left: 'Alt+Q', key_right: 'Ctrl+c', key_shrink: '' };
  const custom = draw(null, { settings: keys }).key_contexts.at(-1);
  assert.equal(custom.keys.a.label, 'Show Changes');
  assert.deepEqual([custom.keys['1'], custom.keys['?'], custom.keys['=']], [undefined, undefined, undefined]);
  assert.deepEqual(custom.keys['Ctrl+g'].action, run('grow'));
  assert.equal(custom.keys['0'].label, 'Main view');
  assert.deepEqual([custom.keys.Left.action, custom.keys.h.action, custom.keys.Right.action, custom.keys.Esc], [{ region: 'left' }, { region: 'left' }, { region: 'right' }, undefined]);

  const corner = draw(command('layout corner').state).key_contexts.at(-1);
  assert.deepEqual(corner.keys['2'], { action: { region: SHELL }, label: 'Focus Shell' });
  assert.equal(corner.keys['['], undefined);
});

test('stack mode keys focus panels by site and keep screen mode and tab keys per panel', () => {
  const state = service('register', { id: 'git', title: 'Git', site: 'omd_git/a', tabs: [{ title: 'A', site: 'omd_git/a' }, { title: 'B', site: 'omd_git/b' }] }, null).state;
  const contexts = draw(state, { settings: stack }).key_contexts;
  const general = contexts.at(-1);
  const own = contexts.slice(0, -1);
  assert.deepEqual(general.keys['3'], { action: { region: 'omd_git/a' }, label: 'Focus Git' });
  assert.deepEqual(draw({ ...state, tabs: { git: 1 } }, { settings: stack }).key_contexts.at(-1).keys['3'].action, { region: 'omd_git/b' });
  assert.equal(general.keys['['], undefined);
  assert.deepEqual(own.map(context => context.when.focus), [[CHANGES], [SHELL], ['omd_git/a', 'omd_git/b']]);
  assert.deepEqual(own[0].keys['+'].action, { command: 'workspace', args: 'mode next changes' });
  assert.deepEqual(own[2].keys['{'].action, { command: 'workspace', args: 'tab previous git' });
  const [changes] = draw(state, { settings: { ...stack, key_mode_next: 'Ctrl+n' } }).key_contexts;
  assert.deepEqual(Object.keys(changes.keys), ['Ctrl+n', '_']);
});

test('a registered panel with tabs nests in the dock and every key and layout limit holds with six panels', () => {
  let state = null;
  for (const id of ['git', 'files', 'agents', 'notes']) state = register(state, id, 2);
  const { key_contexts: contexts, layout } = draw(state);
  const titles = layout.children[1].tabs.map(tab => tab.title);
  assert.deepEqual(titles, ['1 Changes', '2 Shell', '3 git', '4 files', '5 agents', '6 notes']);
  assert.deepEqual(layout.children[1].tabs[2].node, { tabs: [{ title: 't0', node: leaf('git/t0', '3 git') }, { title: 't1', node: leaf('git/t1', '3 git') }], active: 0 });
  assert.ok(cells(layout) <= 12 && depth(layout) <= 6);

  for (const id of ['a', 'b', 'c', 'd', 'e']) state = register(state, id, 1);
  const six = draw(state, { settings: { panels: 'a, b, c, d, e, terminal, git' } });
  assert.equal(six.layout.children[1].tabs.length, 6);
  assert.ok(cells(six.layout) <= 12 && depth(six.layout) <= 6);
  assert.ok(six.key_contexts.length <= 8 && keysOf(six.key_contexts) <= 32);
  assert.deepEqual(six.key_contexts[0].keys['{'].action, { command: 'workspace', args: 'tab previous a' });
  state = register(state, 'f', 1);
  for (const [panels, columns, region] of [['a, b, c, d, e, f', 120, 'Left'], ['a, b, c, d, e, f', 60, 'Up'], ['a, b, c, d, e, terminal', 120, 'Right']]) {
    const tabbed = draw({ ...state, threads: { t1: { sessions: ['shell'] } } }, { columns, settings: { panels } }).key_contexts;
    assert.ok(tabbed.length <= 8 && keysOf(tabbed) <= 32, `${panels} at ${columns} columns`);
    assert.deepEqual(tabbed.at(-1).keys[region].action, { region: region.toLowerCase() });
  }

  for (const id of ['x', 'y', 'z']) state = register(state, id, 4);
  state = register(state, 'w');
  const capped = draw(state, { settings: { panels: 'x, y, z, w' } }).layout.children[1].tabs;
  assert.deepEqual(capped.map(tab => tab.title), ['1 x', '2 y', '3 w']);

  const stacked = draw(state, { settings: { layout: 'stack', panels: 'git files agents changes terminal' } });
  assert.equal(stacked.layout.children[1].children.length, 4);
  assert.ok(cells(stacked.layout) <= 12 && depth(stacked.layout) <= 6);
  assert.ok(stacked.key_contexts.length <= 8 && keysOf(stacked.key_contexts) <= 32);
});

test('other mods set the screen mode on a shown panel, and unregistering that panel clears it', () => {
  const state = service('register', { id: 'lazygit', title: 'Lazygit', site: 'omd_lazygit/main', show: true }, null).state;
  const full = service('mode', { level: 'full', target: 'lazygit' }, state);
  assert.deepEqual(full.value, { mode: { target: 'lazygit', level: 'full' } });
  assert.deepEqual(draw(full.state, { rows: 40 }).layout.children.map(node => node.tabs?.map(tab => tab.title) ?? node.children?.length), [['1 Changes', '2 Shell', '3 Lazygit'], 2]);
  assert.equal(service('mode', { level: 'normal', target: 'lazygit' }, full.state).state.mode, null);
  assert.equal(service('mode', { level: 'half' }, null).state.mode.target, 'chat');
  for (const bad of [{ level: 'big', target: 'lazygit' }, { level: 'full', target: 'missing' }, { level: 'full', target: 7 }]) assert.ok(service('mode', bad, state).value.error, JSON.stringify(bad));
  assert.equal(service('mode', { level: 'full', target: 'lazygit' }, { ...state, off: true }).value.error, 'the workspace is off');
  assert.equal(service('unregister', { id: 'lazygit' }, full.state).state.mode, null);
  const other = service('mode', { level: 'full', target: 'changes' }, full.state).state;
  assert.deepEqual(service('unregister', { id: 'lazygit' }, other).state.mode, { target: 'changes', level: 'full' });
});

test('while the workspace is off other mods cannot register and see no panels', () => {
  const off = command('off', null).state;
  assert.equal(service('register', { id: 'lazygit', title: 'Lazygit', site: 'omd_lazygit/main' }, off).value.error, 'the workspace is off');
  assert.deepEqual(service('panels', null, off).value, { panels: [] });
  assert.deepEqual(service('panels', null, command('on', off).state).value.panels.map(item => item.id), ['changes', 'terminal']);
});

test('other mods register, replace and unregister panels, which join the dock after the built-ins by order', () => {
  const panel = { id: 'git', title: 'Git', site: 'omd_git/status', order: 500 };
  let state = service('register', panel, null).state;
  state = service('register', { id: 'files', title: 'Files', site: 'omd_files/tree', order: 5 }, state).state;
  assert.deepEqual(service('panels', null, state).value.panels.map(item => item.id), ['changes', 'terminal', 'files', 'git']);
  assert.deepEqual(draw(state).layout.children[1].tabs.map(tab => [tab.title, tab.node.content]),
    [['1 Changes', 'site:omd_workspace/changes'], ['2 Shell', 'site:omd_workspace/terminal'], ['3 Files', 'site:omd_files/tree'], ['4 Git', 'site:omd_git/status']]);
  state = service('register', { ...panel, title: 'Git 2', order: 1 }, state).state;
  assert.deepEqual(service('panels', null, state).value.panels.map(item => [item.id, item.title]),
    [['changes', 'Changes'], ['terminal', 'Shell'], ['git', 'Git 2'], ['files', 'Files']]);
  assert.deepEqual(draw(state, { settings: { panels: 'git,git,missing' } }).layout.children[1], dock(0, [['1 Git 2', 'omd_git/status']]));
  for (const bad of [
    { ...panel, id: 'terminal' }, { ...panel, id: 'dock' }, { ...panel, id: 'Bad Id' }, { ...panel, site: 'nomod' }, { ...panel, title: '' },
    { ...panel, title: 'x'.repeat(31) }, { ...panel, title: 'a\u001b[31m' }, { ...panel, id: 'other', site: 'x/y', tabs: [{ title: 't\n', site: 'x/y' }] },
    { ...panel, id: 'other', site: 'omd_workspace/changes' }, { ...panel, id: 'other', tabs: [] },
    { ...panel, id: 'other', site: 'x/y', tabs: [{ title: 't', site: 'x/y' }, { title: 'u', site: 'x/y' }] },
  ]) assert.ok(service('register', bad, state).value.error, JSON.stringify(bad));
  assert.deepEqual(service('unregister', { id: 'git' }, state).value, { removed: true });
  assert.deepEqual(service('unregister', { id: 'git' }, service('unregister', { id: 'git' }, state).state).value, { removed: false });
  const shown = service('register', { id: 'lazygit', title: 'Lazygit', site: 'omd_lazygit/main', show: true }, state).state;
  assert.equal(shown.recent[0], 'lazygit');
  assert.notEqual(service('register', { id: 'yazi', title: 'Yazi', site: 'omd_yazi/main' }, shown).state.recent[0], 'yazi');
});

test('dragged sizes and clicked tabs follow the panels, not their paths', () => {
  let state = service('register', { id: 'git', title: 'Git', site: 'omd_git/a', tabs: [{ title: 'Status', site: 'omd_git/a' }, { title: 'Log', site: 'omd_git/b' }] }, null).state;
  state = emit(state, { kind: 'resize', component: 'r', ratio: [80, 20] }).state;
  state = emit(state, { kind: 'select', component: 'r.1', index: 2 }).state;
  state = emit(state, { kind: 'select', component: 'r.1.2', index: 1 }).state;
  const layout = draw(state).layout;
  assert.deepEqual(layout.ratio, [80, 20]);
  assert.equal(layout.children[1].active, 2);
  assert.equal(layout.children[1].tabs[2].node.active, 1);
  const reordered = draw(state, { settings: { panels: 'git, changes, terminal' } }).layout;
  assert.deepEqual([reordered.ratio, reordered.children[1].active, reordered.children[1].tabs[0].node.active], [[80, 20], 0, 1]);
  assert.deepEqual(emit(state, { kind: 'select', component: 'r.1', index: 9 }).state.recent, ['git']);
  const left = emit(null, { kind: 'resize', component: 'r', ratio: [30, 70] }, { settings: { side: 'left' } }).state;
  assert.deepEqual([draw(left, { settings: { side: 'left' } }).layout.ratio, draw(left).layout.ratio], [[30, 70], [67, 33]]);
  assert.equal(emit({ mode: { target: 'chat', level: 'half' } }, { kind: 'resize', component: 'r', ratio: [10, 90] }).state.ratios, undefined);

  let stacked = emit(state, { kind: 'resize', component: 'r.1', ratio: [20, 30, 50] }, { settings: stack }).state;
  stacked = emit(stacked, { kind: 'select', component: 'r.1.2', index: 0 }, { settings: stack }).state;
  assert.deepEqual(draw(stacked, { settings: stack }).layout.children[1].ratio, [20, 30, 50]);
  assert.equal(stacked.tabs.git, 0);
  const reset = command('reset', stacked).state;
  assert.deepEqual([reset.arranged, reset.ratios, reset.tabs, reset.recent, reset.mode], [null, {}, {}, [], null]);
});

test('grow and shrink resize the panels beside the chat in steps, leave a screen mode and persist until reset', () => {
  let state = command('grow').state;
  assert.deepEqual(draw(state).layout.ratio, [62, 38]);
  state = command('shrink', command('shrink', state).state).state;
  assert.deepEqual(draw(state).layout.ratio, [72, 28]);
  for (let index = 0; index < 20; index += 1) state = command('shrink', state).state;
  assert.deepEqual(draw(state).layout.ratio, [85, 15]);
  const grown = command('grow', command('mode half dock', state).state).state;
  assert.deepEqual([draw(grown).layout.ratio, grown.mode], [[80, 20], null]);
  assert.equal(command('grow', null).value, null);
  assert.deepEqual(command('reset', state).state.ratios, {});
  const wide = emit(null, { kind: 'resize', component: 'r', ratio: [5, 95] }).state;
  assert.deepEqual([command('grow', wide), command('shrink', wide)].map(result => draw(result.state).layout.ratio), [[5, 95], [10, 90]]);
  assert.deepEqual(draw(command('grow', command('layout corner').state).state).layout.ratio, [50, 50]);
});

test('tab commands show panels in tabs and cycle a tabbed panel', () => {
  let state = service('register', { id: 'git', title: 'Git', site: 'omd_git/a', tabs: [{ title: 'A', site: 'omd_git/a' }, { title: 'B', site: 'omd_git/b' }] }, null).state;
  assert.deepEqual(command('tab 3', state).state.recent, ['git']);
  assert.deepEqual(command('tab previous', state).state.recent, ['git']);
  assert.equal(command('tab next', command('tab 3', state).state).state.recent[0], 'changes');
  assert.match(command('tab 4', state).value.display, /^Usage: \/workspace tab 1-3/);
  state = command('tab previous git', state).state;
  assert.equal(state.tabs.git, 1);
  assert.equal(command('tab next git', state).state.tabs.git, 0);
  assert.match(command('tab next changes', state).value.display, /^Usage: \/workspace tab next\|previous PANEL/);
  assert.equal(command('tab next', state, { settings: stack }).value.display, 'No panels are in tabs');
  const two = { arrangement: { split: 'horizontal', children: ['chat', { tabs: ['changes', 'terminal'] }, { tabs: ['git', 'files'] }] } };
  const groups = register(register(null, 'git'), 'files');
  const focused = draw({ ...groups, recent: ['files'] }, { settings: two }).key_contexts.find(context => context.when.focus.includes(CHANGES));
  assert.deepEqual([focused.keys['['].action, focused.keys[']'].action], [{ command: 'workspace', args: 'tab 2' }, { command: 'workspace', args: 'tab 2' }]);
});

test('turning the workspace off draws nothing and on brings it back', () => {
  assert.equal(command('off', null).value.display, 'Workspace off');
  const off = command('off', null).state;
  assert.equal(draw(off), null);
  assert.deepEqual(Object.keys(command('off', { share: 40, stack: {}, dock: 'changes' }).state).sort(), Object.keys(off).sort());
  assert.ok(draw(command('on', off).state).layout);
  assert.match(command('', null).value.display, /^Workspace is on \(dock\)\. Panels: 1 Changes, 2 Shell \(terminal\)\./);
  assert.match(command('', null).value.display, /\? lists the keys/);
  assert.doesNotMatch(command('', null, { settings: { key_help: '<disabled>' } }).value.display, /lists the keys/);
  assert.match(command('toString', null).value.display, /^Workspace is on/);
  assert.match(command('', command('layout grid').state).value.display, /^Workspace is on \(grid, set by you\)/);
  assert.match(command('', null, { settings: { arrangement: { split: 'diagonal' } } }).value.display, /\nArrangement setting ignored: a node is/);
});

test('changes lists files relative to the directory and loads the diff of the selected one', () => {
  const world = { prefix: 'app/' };
  const refreshed = command('refresh', null, { world });
  assert.deepEqual(refreshed.calls.map(call => call.arguments?.argv?.slice(2, 4)).filter(Boolean), [['rev-parse', '--show-prefix'], ['status', '--porcelain=v1']]);
  const { files, total } = refreshed.state.threads.t1.changes;
  assert.equal(total, 3);
  assert.deepEqual(files.map(file => file.code), [' M', '??', 'R ']);
  const list = draw(refreshed.state).sites['omd_workspace/changes'].components.find(component => component.type === 'list');
  assert.deepEqual(list.rows.map(row => row.value), files.map(file => file.path));
  assert.deepEqual(list.action, { command: 'workspace', args: 'diff' });

  const tracked = command(`diff ${files[0].path}`, refreshed.state, { world });
  assert.deepEqual(tracked.calls.at(-1).arguments.argv.slice(1), ['diff', '--no-ext-diff', '--no-textconv', '--no-color', 'HEAD', '--', files[0].path]);
  const unborn = command(`diff ${files[0].path}`, refreshed.state, { world: { ...world, unborn: true } });
  assert.deepEqual(unborn.calls.at(-1).arguments.argv.slice(5, 7), ['--cached', '--']);
  assert.match(unborn.state.threads.t1.changes.diff, /^diff --git/);
  const untracked = command(`diff ${files[1].path}`, tracked.state, { world });
  assert.deepEqual(untracked.calls.at(-1).arguments.argv.slice(1, 8), ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-index', '--', '/dev/null']);
  const components = draw(untracked.state).sites['omd_workspace/changes'].components;
  assert.match(components.find(component => component.type === 'diff').unified, /^diff --git/);
  assert.match(command('diff nothing', untracked.state, { world }).value.display, /not in the changes list/);

  assert.deepEqual(emit(untracked.state, { kind: 'focus', component: 'omd_workspace_refresh' }, { world }).calls, []);
  assert.equal(emit(null, { kind: 'focus', component: 'omd_workspace_refresh' }, { world }).state.threads.t1.changes.total, 3);
  const again = emit(untracked.state, { kind: 'focus', component: 'omd_workspace_changes' }, { world });
  assert.equal(again.calls.filter(call => call.arguments?.argv?.[1] === 'diff').length, 1);
  assert.equal(run('turn_end', { turn_id: 'x', outcome: 'completed' }, { state: null, world }).state.threads.t1.changes.total, 3);
  assert.equal(command('refresh', null, { world: { notGit: true } }).state.threads.t1.changes.error, 'Not a Git repository');
});

test('a large diff and a long list of long paths are cut to fit one view', () => {
  const lines = Array.from({ length: 5000 }, (_, index) => `+line ${index} ${'x'.repeat(40)}`);
  const world = { diff: lines.join('\n') };
  let state = command('refresh', null, { world }).state;
  state = command(`diff ${state.threads.t1.changes.files[0].path}`, state, { world }).state;
  const { diff } = state.threads.t1.changes;
  assert.ok(diff.split('\n').length <= 1000);
  assert.ok(new TextEncoder().encode(JSON.stringify(diff)).length < 49152);
  assert.ok(new TextEncoder().encode(JSON.stringify(draw(state))).length < 65536);
  for (const thread of ['t2', 't3', 't4', 't5', 't6', 't7']) {
    state = run('command', `diff ${state.threads.t1.changes.files[0].path}`, { state: { ...state, threads: { ...state.threads, [thread]: state.threads.t1 } }, name: 'workspace', world }).state;
  }
  assert.ok(new TextEncoder().encode(JSON.stringify(state)).length <= 120_000);
  const paths = Array.from({ length: 60 }, (_, index) => `${(index % 2 ? '"' : 'dd').repeat(96)}${String(index).padStart(3, '0')}.ts`);
  const long = { paths, diff: world.diff };
  state = command('refresh', null, { world: long }).state;
  state = command(`diff ${paths[0]}`, state, { world: long }).state;
  assert.equal(state.threads.t1.changes.files.length, 50);
  assert.ok(new TextEncoder().encode(JSON.stringify(draw(state))).length < 65536);
});

test('a shell that has ended brings the start button back when its panel gets focus', () => {
  const started = command('start').state;
  const focus = { kind: 'focus', component: 'omd_workspace_shell' };
  assert.deepEqual(emit(started, focus).state.threads.t1.sessions, ['shell']);
  const ended = emit(started, focus, { world: { exited: true } });
  assert.deepEqual(ended.calls.map(call => call.arguments), [{ action: 'read', session: 'shell' }]);
  assert.deepEqual(ended.state.threads.t1.sessions, []);
  assert.equal(draw(ended.state).sites[SHELL].components.at(-1).id, 'omd_workspace_start');
});

test('the start button opens the shell with the configured access, and a declined or refused start keeps the button', () => {
  const button = state => draw(state).sites[SHELL].components.find(component => component.type === 'button');
  assert.equal(button(null).action.args, 'start');
  assert.deepEqual(emit(null, { kind: 'focus', component: 'omd_workspace_start' }).calls, []);
  const declined = command('start', null, { world: { declined: true } });
  assert.equal(declined.value.display, 'Shell start declined');
  assert.equal(button(declined.state).id, 'omd_workspace_start');
  assert.match(command('start', null, { world: { full: true } }).value.display, /^Shell is already running, or the terminal limit is reached \(each mod runs at most pty_panes_per_mod terminals/);
  const started = command('start', declined.state);
  assert.deepEqual(started.calls.filter(call => call.operation === 'terminal.pty').map(call => call.arguments), [{ action: 'start', session: 'shell' }]);
  assert.equal(draw(started.state).sites[SHELL].components.at(-1).session, 'shell');
  assert.equal(button(started.state), undefined);
  assert.deepEqual(draw(started.state).key_contexts[1].keys.Enter, { action: { focus: 'omd_workspace_shell' }, label: 'Type in Shell' });
  assert.equal(draw(declined.state).key_contexts[1].keys.Enter, undefined);
  const open = command('start', null, { settings: { shell_write: true, shell_network: 'loopback' } }).calls.at(-1).arguments;
  assert.deepEqual(open, { action: 'start', session: 'shell', write: true, network: 'loopback' });
});

test('terminal panels from settings start their program sandboxed with the access they ask for', () => {
  const settings = { terminals: [{ id: 'snake', title: 'Snake', argv: ['node', 'demo/snake.mjs'], network: 'loopback' }, { id: 'bad' }, { id: 'terminal', title: 'Dup', argv: ['sh'] }] };
  const site = 'omd_workspace/run_snake';
  assert.deepEqual(draw(null, { settings }).layout.children[1].tabs.map(tab => tab.title), ['1 Changes', '2 Shell', '3 Snake']);
  assert.deepEqual(draw(null, { settings }).sites[site].components.at(-1).action, { command: 'workspace', args: 'start snake' });
  const started = command('start snake', null, { settings });
  assert.deepEqual(started.calls.at(-1).arguments, { action: 'start', session: 'run_snake', program: 'node', argv: ['demo/snake.mjs'], network: 'loopback' });
  assert.deepEqual(draw(started.state, { settings }).sites[site].components, [{ type: 'terminal', id: 'omd_workspace_run_snake', label: 'Snake', session: 'run_snake' }]);
  assert.match(command('start nope', null, { settings }).value.display, /^Usage: \/workspace start \[terminal\|snake\]/);
  const long = { terminals: [{ id: 'long', title: 'Long', argv: ['node', '-e', `${'é'.repeat(300)}`] }] };
  assert.ok(new TextEncoder().encode(draw(null, { settings: long }).sites['omd_workspace/run_long'].components[0].label).length <= 128);
  const text = command('config', null, { settings }).value.display;
  assert.match(text, /Terminals: snake\. Terminal limit: each mod runs/);
  assert.equal(text.match(/Ignored: terminals\[\d\]/g).length, 2);
  assert.equal(service('register', { id: 'snake', title: 'S', site: 'x/y' }, null, { settings }).value.error, 'invalid id');

  const id = 'a'.repeat(24);
  const edge = { terminals: [{ id, title: 'Long id', argv: ['sh', '-c', ''] }, { id: 'big', title: 'Big', argv: ['sh', 'x'.repeat(8193)] }] };
  assert.ok(draw(null, { settings: edge }).sites[`omd_workspace/run_${id}`].components.every(component => component.id.length <= 48));
  assert.equal(command('config', null, { settings: edge }).value.display.match(/Ignored: terminals\[1\]/g).length, 1);
  const shadow = register(null, 'snake');
  assert.deepEqual(draw(shadow, { settings }).layout.children[1].tabs.map(tab => tab.title), ['1 Changes', '2 Shell', '3 Snake']);
  assert.match(command('config', shadow, { settings }).value.display, /Ignored: registered panel snake: a terminal has that id/);
});

test('config shows the settings file, the effective keys and layout, and the ignored keys', () => {
  const settings = { key_main: 'nope', key_help: '<disabled>', side: 'left', layout: 'stack', border: 'double', dock_size: 90, panels: 'terminal, nothing' };
  const text = command('config', null, { settings }).value.display;
  assert.match(text, /^Settings file: \S+ \((missing|loaded|invalid)/);
  assert.match(text, /"key_help":"<disabled>"/);
  assert.match(text, /"layout":"stack","panels":"terminal","side":"left","dock_size":85,"narrow_below":84,"border":"double"/);
  assert.match(text, /Ignored: key_main: invalid key "nope"/);
  assert.match(text, /Ignored: panels: unknown panel nothing/);
  assert.match(text, /Example file:\n\{/);
});

test('presets arrange the chat and panels, mirror for the left side and stack when narrow', () => {
  const corner = { split: 'horizontal', ratio: [55, 45], children: [{ split: 'vertical', ratio: [65, 35], children: [chat, leaf(CHANGES, '1 Changes')] }, leaf(SHELL, '2 Shell')] };
  assert.deepEqual(draw(null, { settings: { layout: 'corner' } }).layout, corner);
  assert.deepEqual(JSON.stringify(draw(null, { settings: { border: 'plain', layout: 'stack' } }).layout).match(/"border":"\w+"/g), ['"border":"plain"', '"border":"plain"']);
  assert.deepEqual(draw(null, { settings: { layout: 'corner', side: 'left' } }).layout, { split: 'horizontal', ratio: [45, 55], children: [leaf(SHELL, '2 Shell'), corner.children[0]] });
  assert.deepEqual(draw(null, { columns: 83, settings: { layout: 'corner' } }).layout, { ...corner, split: 'vertical' });
  assert.deepEqual(draw(null, { settings: { layout: 'columns' } }).layout, { split: 'horizontal', children: [chat, leaf(CHANGES, '1 Changes'), leaf(SHELL, '2 Shell')] });
  assert.deepEqual(draw(null, { settings: { layout: 'grid' } }).layout, { split: 'vertical', children: [{ split: 'horizontal', children: [chat, leaf(CHANGES, '1 Changes')] }, leaf(SHELL, '2 Shell')] });
  const three = register(null, 'git');
  assert.deepEqual(draw(three, { settings: { layout: 'corner' } }).layout.children[1], dock(0, [['2 Shell', SHELL], ['3 git', 'git/main']]));
  const grid = draw(register(three, 'files'), { columns: 83, settings: { layout: 'grid' } }).layout;
  assert.deepEqual([grid.split, grid.children[0].split, grid.children[1].split], ['vertical', 'vertical', 'horizontal']);
  let six = null;
  for (const id of ['a', 'b', 'c', 'd']) six = register(six, id, 2);
  for (const layout of ['dock', 'stack', 'columns', 'grid', 'corner']) {
    const drawn = draw(six, { settings: { layout } });
    assert.ok(cells(drawn.layout) <= 12 && depth(drawn.layout) <= 6, layout);
    assert.ok(drawn.key_contexts.length <= 8 && keysOf(drawn.key_contexts) <= 32, layout);
    assert.deepEqual(drawn.layout, draw(command(`layout ${layout}`, six).state).layout, layout);
  }
});

test('move and swap rearrange panels by id, and a refused change keeps the arrangement and says why', () => {
  const arrangement = state => service('arrangement', {}, state).value;
  assert.deepEqual(arrangement(null), { tree: { split: 'horizontal', ratio: [67, 33], children: ['chat', { tabs: ['changes', 'terminal'] }] }, by: 'settings', preset: 'dock' });
  let state = command('move terminal down').state;
  assert.deepEqual(draw(state).layout, { split: 'horizontal', ratio: [67, 33], children: [chat, { split: 'vertical', children: [leaf(CHANGES, '1 Changes'), leaf(SHELL, '2 Shell')] }] });
  state = command('move terminal left', state).state;
  assert.deepEqual(arrangement(state).tree, { split: 'horizontal', children: ['chat', 'terminal', 'changes'] });
  state = command('move terminal left', state).state;
  assert.deepEqual(arrangement(state).tree.children, ['terminal', 'chat', 'changes']);
  const edge = command('move terminal left', state);
  assert.deepEqual([edge.value.display, edge.state], ['terminal is already at the left edge', state]);
  state = command('swap chat changes', state).state;
  assert.deepEqual(arrangement(state).tree.children, ['terminal', 'changes', 'chat']);
  state = command('move changes tab', state).state;
  assert.deepEqual(arrangement(state), { tree: { split: 'horizontal', children: [{ tabs: ['terminal', 'changes'] }, 'chat'] }, by: 'user' });
  assert.equal(command('swap chat changes', state).value.display, 'the chat cannot go into tabs');
  assert.equal(command('move changes tab', state).value.display, 'changes is already in tabs');
  assert.deepEqual(arrangement(command('move changes down', state).state).tree, { split: 'horizontal', children: [{ split: 'vertical', children: ['terminal', 'changes'] }, 'chat'] });
  assert.deepEqual(service('arrangement', {}, command('move Shell down').state).value, service('arrangement', {}, command('move 2 down').state).value);
  assert.match(command('move chat left', state).value.display, /^Usage: \/workspace move/);
  assert.match(command('swap nope chat', state).value.display, /^Usage: \/workspace swap/);
});

test('layouts switch by preset, save and load by name, and reset returns to the settings default', () => {
  let state = command('layout corner').state;
  assert.deepEqual(state.arranged, { by: 'user', preset: 'corner' });
  state = command('layout save mine', state).state;
  const corner = draw(state).layout;
  state = command('layout dock', state).state;
  assert.equal(draw(state).layout.children[1].tabs.length, 2);
  const loaded = command('layout load mine', state);
  assert.equal(loaded.value.display, 'Layout: mine');
  assert.deepEqual(draw(loaded.state).layout, corner);
  assert.match(command('layout load other', state).value.display, /^Usage: .*Saved: mine$/);
  assert.deepEqual(command('layout delete mine', state).state.saved, {});
  let full = state;
  for (const name of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) full = command(`layout save ${name}`, full).state;
  assert.match(command('layout save h', full).value.display, /^At most 8 saved layouts/);
  assert.match(command('layout save constructor', full).value.display, /^At most 8 saved layouts/);
  assert.match(command('layout delete constructor', state).value.display, /^Usage:/);
  const reset = command('reset', loaded.state).state;
  assert.deepEqual([reset.arranged, Object.keys(reset.saved)], [null, ['mine']]);
  assert.deepEqual(draw(reset).layout, draw(null).layout);
});

test('the arrangement setting replaces the preset, and an invalid tree is ignored and named in config', () => {
  const arrangement = { split: 'vertical', ratio: [30, 70], children: ['terminal', 'chat'] };
  assert.deepEqual(draw(null, { settings: { arrangement } }).layout, { split: 'vertical', children: [leaf(SHELL, '2 Shell'), leaf(CHANGES, '1 Changes'), chat] });
  assert.deepEqual(draw(null, { settings: { arrangement, panels: 'terminal' } }).layout, { split: 'vertical', ratio: [30, 70], children: [leaf(SHELL, '1 Shell'), chat] });
  for (const [bad, reason] of [
    [{ split: 'diagonal', children: ['chat', 'terminal'] }, 'a node is'], [{ split: 'vertical', children: ['terminal', 'changes'] }, 'the arrangement needs "chat" once'],
    [{ tabs: ['chat'] }, 'the chat cannot go into tabs'], [{ split: 'vertical', children: ['chat', 'chat'] }, 'chat appears twice'],
    [{ split: 'vertical', ratio: [0, 1], children: ['chat', 'terminal'] }, 'ratio needs'],
  ]) {
    assert.ok(command('config', null, { settings: { arrangement: bad } }).value.display.includes(`Ignored: arrangement: ${reason}`), reason);
    assert.deepEqual(draw(null, { settings: { arrangement: bad } }).layout, draw(null).layout, reason);
  }
});

test('other mods place their panels and arrange the workspace until the user changes it', () => {
  const git = { id: 'git', title: 'Git', site: 'omd_git/main' };
  let state = service('register', { ...git, placement: { beside: 'chat', edge: 'bottom', share: 30 } }, null).state;
  assert.deepEqual(draw(state).layout, { split: 'horizontal', ratio: [67, 33], children: [{ split: 'vertical', ratio: [70, 30], children: [chat, leaf('omd_git/main', '3 Git')] }, dock()] });
  for (const placement of [{ beside: 'chat', edge: 'middle' }, { beside: 'git', edge: 'left' }, { beside: 'chat', edge: 'top', share: 99 }, { edge: 'top' }]) {
    assert.ok(service('register', { ...git, placement }, state).value.error, JSON.stringify(placement));
  }
  assert.deepEqual(service('panels', null, state).value.panels.at(-1).placement, { beside: 'chat', edge: 'bottom', share: 30 });
  const lost = service('register', { id: 'files', title: 'Files', site: 'omd_files/main', placement: { beside: 'nobody', edge: 'left' } }, state).state;
  assert.deepEqual(draw(lost).layout.children[1].tabs.map(tab => tab.title), ['1 Changes', '2 Shell', '4 Files']);

  const tree = { split: 'horizontal', children: [{ split: 'vertical', children: ['chat', 'git'] }, 'terminal'] };
  const arranged = service('arrange', { tree }, state);
  assert.deepEqual(arranged.value, { arranged: true });
  assert.deepEqual(service('arrangement', {}, arranged.state).value, { tree: { split: 'horizontal', children: [{ split: 'vertical', children: ['chat', 'git'] }, 'terminal', 'changes'] }, by: 'mod' });
  assert.match(service('arrange', { tree: { split: 'horizontal', children: ['terminal', 'git'] } }, state).value.error, /needs "chat" once/);
  const user = command('move changes up', arranged.state).state;
  assert.equal(user.arranged.by, 'user');
  assert.match(service('arrange', { tree }, user).value.error, /^the user arranged the workspace/);
  assert.deepEqual(service('arrange', { tree }, command('reset', user).state).value, { arranged: true });

  let six = null;
  for (const id of ['a', 'b', 'c', 'd']) six = register(six, id);
  const nest = (inner, [id, ...rest], split = 'horizontal') => (id ? nest({ split, children: [inner, id] }, rest, split === 'horizontal' ? 'vertical' : 'horizontal') : inner);
  assert.match(service('arrange', { tree: nest('chat', ['changes', 'terminal', 'a', 'b', 'c', 'd']) }, six).value.error, /^nested 8 levels deep/);
  assert.deepEqual(service('arrange', { tree: nest('chat', ['changes', 'terminal', 'a', 'b']) }, six).value, { arranged: true });
  assert.deepEqual(service('arrange', { tree: 'chat' }, null).value, { arranged: true });
  const settled = { arrangement: { split: 'vertical', children: ['chat', 'terminal'] } };
  assert.match(service('arrange', { tree }, null, { settings: settled }).value.error, /^the user arranged/);
  assert.match(service('arrange', { tree: nest('chat', Array.from({ length: 9 }, (_, index) => `p${index}`)) }, null).value.error, /^a tree nests at most 8 levels/);
  const stacked = draw(six, { settings: stack }).layout.children[1];
  assert.deepEqual([stacked.children.length, stacked.children[3].tabs.map(tab => tab.title)], [4, ['4 b', '5 c', '6 d']]);
});

test('a dock drop moves the dragged panel beside or into tabs with its target, and a refused drop keeps the arrangement', () => {
  const drop = (state, component, target, edge) => emit(state, { kind: 'dock', component, content: 'site:x/y', target, edge });
  let state = drop(null, 'r.1.1', 'r.0', 'bottom').state;
  assert.deepEqual(draw(state).layout, { split: 'horizontal', ratio: [67, 33], children: [{ split: 'vertical', children: [chat, leaf(SHELL, '2 Shell')] }, leaf(CHANGES, '1 Changes')] });
  state = drop(state, 'r.1', 'r.0.1', 'center').state;
  assert.deepEqual(service('arrangement', {}, state).value.tree, { split: 'vertical', children: ['chat', { tabs: ['terminal', 'changes'] }] });
  const refused = drop(state, 'r.1.0', 'r.0', 'center');
  assert.deepEqual(refused.state, state);
  assert.deepEqual(refused.calls.at(-1), { operation: 'terminal.notice', arguments: { text: 'Workspace: the chat cannot hold tabs', kind: 'warning', placement: 'toast' } });
  assert.deepEqual(drop(state, 'r.0', 'r.1.0', 'left').state, state);
  assert.deepEqual(drop(state, 'r.1.1', 'r.1.1', 'left').calls.at(-1).arguments.text, 'Workspace: a panel cannot move beside itself');
  const narrow = emit(null, { kind: 'dock', component: 'r.1.1', content: `site:${SHELL}`, target: 'r.1.0', edge: 'left', columns: 60, rows: 30 }, { settings: stack }).state;
  assert.deepEqual(service('arrangement', {}, narrow, { settings: stack }).value.tree, { split: 'vertical', ratio: [67, 33], children: ['chat', { split: 'horizontal', children: ['terminal', 'changes'] }] });
});
