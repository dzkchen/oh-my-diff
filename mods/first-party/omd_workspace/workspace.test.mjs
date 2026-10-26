import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { callback } from '../../../tests/mod_runner.mjs';

const mod = new URL('./', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('mod.json', mod), 'utf8'));
const source = readFileSync(new URL('index.ts', mod), 'utf8');

const status = (prefix = '') => [` M ${prefix}src/a.ts`, `?? ${prefix}new file.txt`, `R  ${prefix}b.ts`, `${prefix}a.ts`].join('\0') + '\0';
const git = (state, argv) => {
  const args = argv.slice(2);
  if (args[0] === 'rev-parse') return { exit_code: state.notGit ? 128 : 0, stdout: state.prefix ?? '' };
  if (args[0] === 'status') return { exit_code: 0, stdout: status(state.prefix) };
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
    if (operation === 'terminal.pty') return world.declined ? { status: 'declined' } : { session: 'shell', running: true };
    throw new Error(`unexpected host operation ${operation}`);
  };
  const request = { source, filename: fileURLToPath(new URL('index.ts', mod)), entrypoint: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, state, settings, settings_file: { path: '/store/settings/omd_workspace.json', status: 'missing', error: null }, event, name, payload, hook_budget_ms: 10000 };
  const output = callback(request, host);
  if (output.error) throw new Error(output.error);
  return { value: output.value, state: output.state ?? state, calls };
}

const draw = (state, { columns = 120, rows = 40, settings } = {}) =>
  run('terminal', { event: 'redraw', ledger: { thread_id: 't1', cwd: '/repo', cost: null }, client: { columns, rows } }, { state, settings }).value;
const command = (args, state, options) => run('command', args, { ...options, state, name: 'workspace' });
const emit = (state, payload, options) => run('component_event', { thread_id: 't1', origin: 'user', ...payload }, { ...options, state });
const service = (method, input, state) => run('service', input, { state, name: `omd.workspace.${method}` });
const leaf = (name, title = '') => ({ content: `site:${name}`, title });
const chat = { split: 'vertical', ratio: [5, 1], children: [{ content: 'transcript', title: 'Chat' }, { content: 'composer' }] };
const CHANGES = 'omd_workspace/changes';
const SHELL = 'omd_workspace/terminal';
const dock = (active = 0, tabs = [['1 Changes', CHANGES], ['2 Shell', SHELL]]) => ({ tabs: tabs.map(([title, site]) => ({ title, node: leaf(site) })), active });
const stack = { layout: { mode: 'stack' } };
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
  const left = { layout: { side: 'left', ratio: [1, 3], panels: ['terminal', 'changes'], portrait: 100 } };
  const swapped = dock(0, [['1 Shell', SHELL], ['2 Changes', CHANGES]]);
  assert.deepEqual(draw(null, { settings: left }).layout, { split: 'horizontal', ratio: [25, 75], children: [swapped, chat] });
  assert.deepEqual(draw(null, { columns: 99, settings: left }).layout, { split: 'vertical', ratio: [25, 75], children: [swapped, chat] });
});

test('stack mode keeps numbered split panels beside the chat and in a row when narrow', () => {
  const side = [leaf(CHANGES, '1 Changes'), leaf(SHELL, '2 Shell')];
  assert.deepEqual(draw(null, { settings: stack }).layout, { split: 'horizontal', ratio: [67, 33], children: [chat, { split: 'vertical', children: side }] });
  assert.deepEqual(draw(null, { columns: 83, settings: stack }).layout, { split: 'vertical', ratio: [67, 33], children: [chat, { split: 'horizontal', children: side }] });
  const one = draw(null, { settings: { layout: { mode: 'stack', side: 'left', panels: ['terminal'] } } }).layout;
  assert.deepEqual(one, { split: 'horizontal', ratio: [33, 67], children: [leaf(SHELL, '1 Shell'), chat] });
});

test('half and full screen modes act on the whole dock and keep a compact chat below in full', () => {
  const mode = (target, level) => ({ mode: { target, level } });
  assert.deepEqual(draw(mode('dock', 'half')).layout, { split: 'horizontal', ratio: [50, 50], children: [chat, dock()] });
  assert.deepEqual(draw(mode('changes', 'half')).layout, draw(mode('dock', 'half')).layout);
  assert.deepEqual(draw(mode('dock', 'full'), { rows: 30 }).layout, { split: 'vertical', ratio: [22, 8], children: [dock(), chat] });
  assert.deepEqual(draw(mode('chat', 'half')).layout.ratio, [75, 25]);
  const full = draw(mode('chat', 'full'));
  assert.deepEqual(full.layout, chat);
  assert.equal(full.key_contexts, undefined);

  const settings = stack;
  assert.deepEqual(draw(mode('changes', 'half'), { settings }).layout, { split: 'horizontal', ratio: [50, 50], children: [chat, leaf(CHANGES, '1 Changes')] });
  assert.deepEqual(draw(mode('changes', 'full'), { rows: 30, settings }).layout, { split: 'vertical', ratio: [22, 8], children: [leaf(CHANGES, '1 Changes'), chat] });
  const panel = draw(mode('changes', 'half'), { settings }).key_contexts;
  assert.deepEqual(Object.keys(panel[0].keys).filter(key => /^\d$/.test(key)).sort(), ['0', '1']);
});

test('modes cycle with next and previous and clear on normal', () => {
  let state = command('mode next changes').state;
  assert.deepEqual(state.mode, { target: 'changes', level: 'half' });
  state = command('mode next changes', state).state;
  assert.equal(state.mode.level, 'full');
  assert.equal(command('mode previous changes', state).state.mode.level, 'half');
  assert.equal(command('mode next changes', state).state.mode, null);
  assert.equal(command('mode half', null).state.mode.target, 'chat');
  assert.deepEqual(command('mode full dock', null).state.mode, { target: 'dock', level: 'full' });
  assert.equal(command('mode full dock', null, { settings: stack }).value.display, 'Unknown panel dock');
  assert.equal(draw({ mode: { target: 'gone', level: 'full' } }, { settings: stack }).layout.split, 'horizontal');
  assert.equal(command('mode half missing', null).value.display, 'Unknown panel missing');
});

test('dock keys pick tabs by number, switch them with brackets, resize and change the screen mode', () => {
  const [general, ...own] = draw(null).key_contexts;
  assert.deepEqual(general.when, { focus: 'site' });
  const run = args => ({ command: 'workspace', args });
  assert.deepEqual(general.keys['2'], { action: run('tab 2'), label: 'Show Shell' });
  assert.equal(general.keys['3'], undefined);
  assert.deepEqual(['0', 'h', 'Left', 'l', 'Right', 'Tab', '?'].map(key => general.keys[key].action),
    [{ region: 'chat' }, { region: 'left' }, { region: 'left' }, { region: 'right' }, { region: 'right' }, { region: 'next' }, { help: true }]);
  assert.deepEqual(['[', ']', '+', '_', '=', '-'].map(key => general.keys[key].action),
    [run('tab previous'), run('tab next'), run('mode next dock'), run('mode previous dock'), run('grow'), run('shrink')]);
  assert.match(general.keys['='].label, /drag/);
  assert.deepEqual(own, []);

  const keybinding = { panel_1: 'a', help: '<disabled>', main: 'nope', grow: 'Ctrl+g', next: 'Esc', left: 'Alt+Q', right: 'Ctrl+c', bogus: 'x' };
  const [custom] = draw(null, { settings: { keybinding } }).key_contexts;
  assert.equal(custom.keys.a.label, 'Show Changes');
  assert.deepEqual([custom.keys['1'], custom.keys['?'], custom.keys['=']], [undefined, undefined, undefined]);
  assert.deepEqual(custom.keys['Ctrl+g'].action, run('grow'));
  assert.equal(custom.keys['0'].label, 'Main view');
  assert.equal(custom.keys.Tab.label, 'Next panel');
  assert.deepEqual([custom.keys.Left.action, custom.keys.Right.action], [{ region: 'left' }, { region: 'right' }]);
});

test('stack mode keys focus regions by number and keep screen mode and tab keys per panel', () => {
  const settings = stack;
  let state = service('register', { id: 'git', title: 'Git', site: 'omd_git/a', tabs: [{ title: 'A', site: 'omd_git/a' }, { title: 'B', site: 'omd_git/b' }] }, null).state;
  const [general, ...own] = draw(state, { settings }).key_contexts;
  assert.deepEqual(general.keys['3'], { action: { region: 3 }, label: 'Focus Git' });
  assert.equal(general.keys['['], undefined);
  assert.deepEqual(own.map(context => context.when.focus), [[CHANGES], [SHELL], ['omd_git/a', 'omd_git/b']]);
  assert.deepEqual(own[0].keys['+'].action, { command: 'workspace', args: 'mode next changes' });
  assert.deepEqual(own[2].keys['['].action, { command: 'workspace', args: 'tab previous git' });
  const [, changes] = draw(state, { settings: { ...settings, keybinding: { mode_next: 'Ctrl+n' } } }).key_contexts;
  assert.deepEqual(Object.keys(changes.keys), ['Ctrl+n', '_']);
});

test('a registered panel with tabs nests in the dock and every key and layout limit holds with six panels', () => {
  let state = null;
  for (const id of ['git', 'files', 'agents', 'notes']) state = register(state, id, 2);
  const { key_contexts: contexts, layout } = draw(state);
  const titles = layout.children[1].tabs.map(tab => tab.title);
  assert.deepEqual(titles, ['1 Changes', '2 Shell', '3 git', '4 files', '5 agents', '6 notes']);
  assert.deepEqual(layout.children[1].tabs[2].node, { tabs: [{ title: 't0', node: leaf('git/t0') }, { title: 't1', node: leaf('git/t1') }], active: 0 });
  assert.ok(cells(layout) <= 12 && depth(layout) <= 4);

  for (const id of ['a', 'b', 'c', 'd', 'e']) state = register(state, id, 1);
  const six = draw(state, { settings: { layout: { panels: ['a', 'b', 'c', 'd', 'e', 'terminal', 'git'] } } });
  assert.equal(six.layout.children[1].tabs.length, 6);
  assert.ok(cells(six.layout) <= 12 && depth(six.layout) <= 4);
  assert.ok(six.key_contexts.length <= 8 && keysOf(six.key_contexts) <= 32);
  assert.deepEqual(six.key_contexts[1].keys['{'].action, { command: 'workspace', args: 'tab previous a' });

  const stacked = draw(state, { settings: { layout: { mode: 'stack', panels: ['git', 'files', 'agents', 'changes', 'terminal'] } } });
  assert.equal(stacked.layout.children[1].children.length, 4);
  assert.ok(cells(stacked.layout) <= 12 && depth(stacked.layout) <= 4);
  assert.ok(stacked.key_contexts.length <= 8 && keysOf(stacked.key_contexts) <= 32);
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
  assert.deepEqual(draw(state, { settings: { layout: { panels: ['git', 'git', 'missing'] } } }).layout.children[1], dock(0, [['1 Git 2', 'omd_git/status']]));
  for (const bad of [
    { ...panel, id: 'terminal' }, { ...panel, id: 'dock' }, { ...panel, id: 'Bad Id' }, { ...panel, site: 'nomod' }, { ...panel, title: '' },
    { ...panel, title: 'x'.repeat(31) }, { ...panel, title: 'a\u001b[31m' }, { ...panel, id: 'other', site: 'x/y', tabs: [{ title: 't\n', site: 'x/y' }] },
    { ...panel, id: 'other', site: 'omd_workspace/changes' }, { ...panel, id: 'other', tabs: [] },
    { ...panel, id: 'other', site: 'x/y', tabs: [{ title: 't', site: 'x/y' }, { title: 'u', site: 'x/y' }] },
  ]) assert.ok(service('register', bad, state).value.error, JSON.stringify(bad));
  assert.deepEqual(service('unregister', { id: 'git' }, state).value, { removed: true });
  assert.deepEqual(service('unregister', { id: 'git' }, service('unregister', { id: 'git' }, state).state).value, { removed: false });
});

test('dragged sizes and clicked tabs persist and survive a panel order change', () => {
  let state = service('register', { id: 'git', title: 'Git', site: 'omd_git/a', tabs: [{ title: 'Status', site: 'omd_git/a' }, { title: 'Log', site: 'omd_git/b' }] }, null).state;
  state = emit(state, { kind: 'resize', component: 'r', ratio: [80, 20] }).state;
  state = emit(state, { kind: 'select', component: 'r.1', index: 2 }).state;
  state = emit(state, { kind: 'select', component: 'r.1.2', index: 1 }).state;
  const layout = draw(state).layout;
  assert.deepEqual(layout.ratio, [80, 20]);
  assert.equal(layout.children[1].active, 2);
  assert.equal(layout.children[1].tabs[2].node.active, 1);
  const reordered = draw(state, { settings: { layout: { panels: ['git', 'changes'] } } }).layout;
  assert.equal(reordered.children[1].active, 0);
  assert.equal(reordered.children[1].tabs[0].node.active, 1);
  assert.equal(emit(state, { kind: 'select', component: 'r.1', index: 9 }).state.dock, 'git');
  assert.deepEqual(draw(state, { settings: { layout: { side: 'left' } } }).layout.ratio, [20, 80]);
  assert.equal(emit(state, { kind: 'select', component: 'r.0', index: 0 }, { settings: { layout: { side: 'left' } } }).state.dock, 'changes');

  let stacked = emit(state, { kind: 'resize', component: 'r.1', ratio: [20, 30, 50] }, { settings: stack }).state;
  stacked = emit(stacked, { kind: 'select', component: 'r.1.2', index: 0 }, { settings: stack }).state;
  assert.deepEqual(draw(stacked, { settings: stack }).layout.children[1].ratio, [20, 30, 50]);
  assert.equal(stacked.tabs.git, 0);
  const reset = command('reset', stacked).state;
  assert.deepEqual([reset.share, reset.stack, reset.tabs, reset.dock], [null, {}, {}, null]);
});

test('grow and shrink resize the panels in steps, leave a screen mode and persist until reset', () => {
  let state = command('grow').state;
  assert.equal(state.share, 38);
  assert.deepEqual(draw(state).layout.ratio, [62, 38]);
  state = command('shrink', command('shrink', state).state).state;
  assert.equal(state.share, 28);
  for (let index = 0; index < 20; index += 1) state = command('shrink', state).state;
  assert.equal(state.share, 15);
  assert.equal(command('grow', command('mode half dock', state).state).state.share, 55);
  assert.equal(command('grow', command('mode half dock', state).state).state.mode, null);
  assert.equal(command('grow', null).value, null);
  assert.equal(command('reset', state).state.share, null);
});

test('tab commands pick dock tabs and cycle a tabbed panel', () => {
  let state = service('register', { id: 'git', title: 'Git', site: 'omd_git/a', tabs: [{ title: 'A', site: 'omd_git/a' }, { title: 'B', site: 'omd_git/b' }] }, null).state;
  assert.equal(command('tab 3', state).state.dock, 'git');
  assert.equal(command('tab previous', state).state.dock, 'git');
  assert.equal(command('tab next', command('tab 3', state).state).state.dock, 'changes');
  assert.match(command('tab 4', state).value.display, /^Usage: \/workspace tab 1-3/);
  state = command('tab previous git', state).state;
  assert.equal(state.tabs.git, 1);
  assert.equal(command('tab next git', state).state.tabs.git, 0);
  assert.match(command('tab next changes', state).value.display, /^Usage: \/workspace tab next\|previous PANEL/);
  assert.match(command('tab next', state, { settings: stack }).value.display, /^Usage: \/workspace tab next\|previous PANEL/);
});

test('turning the workspace off draws nothing and on brings it back', () => {
  assert.equal(command('off', null).value.display, 'Workspace off');
  const off = command('off', null).state;
  assert.equal(draw(off), null);
  assert.ok(draw(command('on', off).state).layout);
  assert.match(command('', null).value.display, /^Workspace is on \(tabs\)\. Panels: 1 Changes, 2 Shell\./);
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

  const again = emit(untracked.state, { kind: 'focus', component: 'omd_workspace_changes' }, { world });
  assert.equal(again.calls.filter(call => call.arguments?.argv?.[1] === 'diff').length, 1);
  assert.equal(run('turn_end', { turn_id: 'x', outcome: 'completed' }, { state: null, world }).state.threads.t1.changes.total, 3);
  assert.equal(command('refresh', null, { world: { notGit: true } }).state.threads.t1.changes.error, 'Not a Git repository');
});

test('a large diff is cut to fit one view', () => {
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
});

test('the start button opens the shell, and a declined start keeps the button', () => {
  const button = state => draw(state).sites['omd_workspace/terminal'].components.find(component => component.type === 'button');
  assert.equal(button(null).action.args, 'start');
  assert.deepEqual(emit(null, { kind: 'focus', component: 'omd_workspace_start' }).calls, []);
  const declined = command('start', null, { world: { declined: true } });
  assert.equal(declined.value.display, 'Shell start declined');
  assert.equal(button(declined.state).id, 'omd_workspace_start');
  const started = command('start', declined.state);
  assert.deepEqual(started.calls.filter(call => call.operation === 'terminal.pty').map(call => call.arguments), [{ action: 'start', session: 'shell' }]);
  assert.equal(draw(started.state).sites['omd_workspace/terminal'].components.at(-1).session, 'shell');
  assert.equal(button(started.state), undefined);
  assert.deepEqual(draw(started.state).key_contexts[1], { when: { focus: [SHELL] }, keys: { Enter: { action: { focus: 'omd_workspace_shell' }, label: 'Type in the shell' } } });
  assert.equal(draw(declined.state).key_contexts.length, 1);
});

test('config shows the settings file, the effective keys and layout, and the ignored keys', () => {
  const settings = { keybinding: { main: 'nope', help: '<disabled>' }, layout: { side: 'left', mode: 'stack' } };
  const text = command('config', null, { settings }).value.display;
  assert.match(text, /^Settings file: \S+ \((missing|loaded|invalid)/);
  assert.match(text, /"help":"<disabled>"/);
  assert.match(text, /"mode":"stack","panels":\["changes","terminal"\],"side":"left"/);
  assert.match(text, /Ignored: main: invalid key "nope"/);
  assert.match(text, /Example file:\n\{/);
});
