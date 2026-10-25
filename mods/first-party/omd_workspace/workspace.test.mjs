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
const leaf = name => ({ content: `site:${name}` });
const chat = { split: 'vertical', ratio: [5, 1], children: [{ content: 'transcript' }, { content: 'composer' }] };
const side = [leaf('omd_workspace/terminal'), leaf('omd_workspace/changes')];

test('side panels sit left of the chat and stack above it in portrait', () => {
  assert.deepEqual(draw(null).layout, { split: 'horizontal', ratio: [33, 67], children: [{ split: 'vertical', children: side }, chat] });
  assert.deepEqual(draw(null, { columns: 83 }).layout, { split: 'vertical', ratio: [40, 60], children: [{ split: 'horizontal', children: side }, chat] });
  assert.equal(draw(null, { columns: 84 }).layout.split, 'horizontal');
  const configured = draw(null, { settings: { layout: { side: 'right', ratio: [1, 3], panels: ['changes', 'terminal'], portrait: 100 } } }).layout;
  assert.deepEqual(configured, { split: 'horizontal', ratio: [75, 25], children: [chat, { split: 'vertical', children: [side[1], side[0]] }] });
});

test('half and full screen modes give a panel or the chat the screen but keep the chat usable', () => {
  const mode = (target, level) => ({ mode: { target, level } });
  assert.deepEqual(draw(mode('changes', 'half')).layout, { split: 'horizontal', ratio: [50, 50], children: [side[1], chat] });
  assert.deepEqual(draw(mode('changes', 'full'), { rows: 30 }).layout, { split: 'vertical', ratio: [22, 8], children: [side[1], chat] });
  assert.deepEqual(draw(mode('terminal', 'half'), { columns: 70 }).layout.split, 'vertical');
  assert.deepEqual(draw(mode('chat', 'half')).layout.ratio, [25, 75]);
  const full = draw(mode('chat', 'full'));
  assert.deepEqual(full.layout, chat);
  assert.equal(full.key_contexts, undefined);
  const panel = draw(mode('changes', 'half')).key_contexts;
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
  assert.equal(command('mode half missing', null).value.display, 'Unknown panel missing');
});

test('region keys exist only for drawn panels and every override is honoured, ignored or disabled', () => {
  const [general, ...own] = draw(null).key_contexts;
  assert.deepEqual(general.when, { focus: 'site' });
  assert.deepEqual(general.keys['2'], { action: { region: 2 }, label: 'Focus Changes' });
  assert.equal(general.keys['3'], undefined);
  assert.deepEqual(general.keys['0'].action, { region: 'chat' });
  assert.deepEqual([general.keys.h.action, general.keys.Left.action, general.keys.l.action, general.keys.Right.action, general.keys.Tab.action, general.keys['?'].action],
    [{ region: 'left' }, { region: 'left' }, { region: 'right' }, { region: 'right' }, { region: 'next' }, { help: true }]);
  assert.deepEqual(own.map(context => context.when.focus), [['omd_workspace/terminal'], ['omd_workspace/changes']]);
  assert.deepEqual(own[1].keys['+'].action, { command: 'workspace', args: 'mode next changes' });
  assert.equal(own[1].keys['['], undefined);

  const keybinding = { panel_1: 'a', help: '<disabled>', main: 'nope', mode_next: 'Ctrl+n', next: 'Esc', left: 'Alt+Q', right: 'Ctrl+c', bogus: 'x' };
  const [custom, panelContext] = draw(null, { settings: { keybinding } }).key_contexts;
  assert.equal(custom.keys.a.label, 'Focus Terminal');
  assert.equal(custom.keys['1'], undefined);
  assert.equal(custom.keys['?'], undefined);
  assert.equal(custom.keys['0'].label, 'Main view');
  assert.equal(custom.keys.Tab.label, 'Next panel');
  assert.deepEqual([custom.keys.Left.action, custom.keys.Right.action], [{ region: 'left' }, { region: 'right' }]);
  assert.deepEqual(Object.keys(panelContext.keys), ['Ctrl+n', '_']);
});

test('key contexts never exceed 8 contexts and 32 keys with four tabbed panels', () => {
  const tabs = ['a', 'b'].map(name => ({ title: name, site: `other/${name}` }));
  let state = null;
  for (const id of ['git', 'files', 'agents']) state = service('register', { id, title: id, site: `${id}/main`, tabs: tabs.map(tab => ({ ...tab, site: `${id}/${tab.title}` })) }, state).state;
  const { key_contexts: contexts, layout } = draw(state, { settings: { layout: { panels: ['git', 'files', 'agents', 'changes', 'terminal'] } } });
  assert.equal(contexts.length, 5);
  assert.ok(contexts.reduce((total, context) => total + Object.keys(context.keys).length, 0) <= 32);
  assert.deepEqual(contexts.slice(1).map(context => Object.keys(context.keys).length), [4, 4, 4, 2]);
  assert.equal(layout.children[0].children.length, 4);
  const cells = node => node.tabs ? node.tabs.reduce((total, tab) => total + cells(tab.node), 0) : node.children ? node.children.reduce((total, child) => total + cells(child), 0) : 1;
  assert.ok(cells(layout) + 1 <= 12);
});

test('other mods register, replace and unregister panels through the service', () => {
  const panel = { id: 'git', title: 'Git', site: 'omd_git/status', order: 500 };
  let state = service('register', panel, null).state;
  state = service('register', { id: 'files', title: 'Files', site: 'omd_files/tree', order: 5 }, state).state;
  assert.deepEqual(service('panels', null, state).value.panels.map(item => item.id), ['terminal', 'changes', 'files', 'git']);
  assert.deepEqual(draw(state).layout.children[0].children.map(node => node.content),
    ['site:omd_workspace/terminal', 'site:omd_workspace/changes', 'site:omd_files/tree', 'site:omd_git/status']);
  state = service('register', { ...panel, title: 'Git 2', order: 1 }, state).state;
  assert.deepEqual(service('panels', null, state).value.panels.map(item => [item.id, item.title]),
    [['terminal', 'Terminal'], ['changes', 'Changes'], ['git', 'Git 2'], ['files', 'Files']]);
  assert.deepEqual(draw(state, { settings: { layout: { panels: ['git', 'git', 'missing'] } } }).layout.children[0], leaf('omd_git/status'));
  for (const bad of [
    { ...panel, id: 'terminal' }, { ...panel, id: 'Bad Id' }, { ...panel, site: 'nomod' }, { ...panel, title: '' },
    { ...panel, id: 'other', site: 'omd_workspace/changes' }, { ...panel, id: 'other', tabs: [] },
    { ...panel, id: 'other', site: 'x/y', tabs: [{ title: 't', site: 'x/y' }, { title: 'u', site: 'x/y' }] },
  ]) assert.ok(service('register', bad, state).value.error, JSON.stringify(bad));
  assert.deepEqual(service('unregister', { id: 'git' }, state).value, { removed: true });
  assert.deepEqual(service('unregister', { id: 'git' }, service('unregister', { id: 'git' }, state).state).value, { removed: false });
});

test('dragged sizes and chosen tabs persist per panel and survive a panel order change', () => {
  let state = service('register', { id: 'git', title: 'Git', site: 'omd_git/a', tabs: [{ title: 'Status', site: 'omd_git/a' }, { title: 'Log', site: 'omd_git/b' }] }, null).state;
  state = emit(state, { kind: 'resize', component: 'r', ratio: [20, 80] }).state;
  state = emit(state, { kind: 'resize', component: 'r.0', ratio: [20, 30, 50] }).state;
  state = emit(state, { kind: 'select', component: 'r.0.2', index: 1 }).state;
  state = emit(state, { kind: 'resize', component: 'r.0', ratio: [50, 50] }).state;
  const layout = draw(state).layout;
  assert.deepEqual(layout.ratio, [20, 80]);
  assert.deepEqual(layout.children[0].ratio, [20, 30, 50]);
  assert.equal(layout.children[0].children[2].active, 1);
  const reordered = draw(state, { settings: { layout: { panels: ['terminal', 'git', 'changes'] } } }).layout;
  assert.equal(reordered.children[0].ratio, undefined);
  assert.equal(reordered.children[0].children[1].active, 1);
  assert.equal(emit(state, { kind: 'select', component: 'r.0.2', index: 9 }).state.tabs.git, 1);
  assert.deepEqual(draw(state, { settings: { layout: { side: 'right' } } }).layout.ratio, [80, 20]);
  const reset = command('reset', state).state;
  assert.deepEqual([reset.share, reset.stack, reset.tabs], [null, {}, {}]);
});

test('tab commands cycle a tabbed panel and refuse one without tabs', () => {
  let state = service('register', { id: 'git', title: 'Git', site: 'omd_git/a', tabs: [{ title: 'A', site: 'omd_git/a' }, { title: 'B', site: 'omd_git/b' }] }, null).state;
  state = command('tab previous git', state).state;
  assert.equal(state.tabs.git, 1);
  assert.equal(command('tab next git', state).state.tabs.git, 0);
  assert.match(command('tab next changes', state).value.display, /^Usage: \/workspace tab/);
  const keys = draw(state).key_contexts.find(context => context.when.focus.includes('omd_git/a')).keys;
  assert.deepEqual(keys['['].action, { command: 'workspace', args: 'tab previous git' });
  assert.deepEqual(keys[']'].action, { command: 'workspace', args: 'tab next git' });
});

test('turning the workspace off draws nothing and on brings it back', () => {
  assert.equal(command('off', null).value.display, 'Workspace off');
  const off = command('off', null).state;
  assert.equal(draw(off), null);
  assert.ok(draw(command('on', off).state).layout);
  assert.match(command('', null).value.display, /^Workspace is on\. Panels: 1 Terminal, 2 Changes\./);
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
  assert.deepEqual(draw(started.state).key_contexts[1].keys.Enter.action, { focus: 'omd_workspace_shell' });
  assert.equal(draw(declined.state).key_contexts[1].keys.Enter, undefined);
});

test('config shows the settings file, the effective keys and layout, and the ignored keys', () => {
  const settings = { keybinding: { main: 'nope', help: '<disabled>' }, layout: { side: 'right' } };
  const text = command('config', null, { settings }).value.display;
  assert.match(text, /^Settings file: \S+ \((missing|loaded|invalid)/);
  assert.match(text, /"help":"<disabled>"/);
  assert.match(text, /"side":"right"/);
  assert.match(text, /Ignored: main: invalid key "nope"/);
  assert.match(text, /Example file:\n\{/);
});
