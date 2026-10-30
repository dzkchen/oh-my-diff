import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { callback } from '../../../tests/mod_runner.mjs';

const mod = new URL('./', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('mod.json', mod), 'utf8'));
const source = readFileSync(new URL('index.ts', mod), 'utf8');
const defaults = Object.fromEntries(Object.entries(manifest.settings_schema.properties).map(([name, schema]) => [name, schema.default]));
const SITE = 'omd_lazygit/main';
const ID = 'omd_lazygit_terminal';

function run(event, payload, { state = null, settings = {}, name, world = {} } = {}) {
  const calls = [];
  const host = ({ operation, arguments: args }) => {
    calls.push({ operation, arguments: args });
    switch (operation) {
      case 'session.info': return { thread_id: 't1', root: '/repo', cwd: '/repo/app' };
      case 'exec.run':
        if (world.missing) throw new Error('exec_program_unavailable');
        if (world.failed) throw new Error(world.failed);
        if (world.untrusted) throw new Error('exec_program_declined');
        if (args.program === '/bin/test') return { exit_code: world.noConfig ? 1 : 0, stdout: '', stderr: '' };
        return { exit_code: world.noDir ? 1 : 0, stdout: '/home/me/.config/lazygit\n', stderr: '' };
      case 'terminal.pty':
        if (args.action === 'start') {
          if (world.gone) throw new Error('exec_program_unavailable');
          return world.declined ? { status: 'declined' } : { session: 'lazygit', running: true };
        }
        if (args.action === 'read') return { text: '', running: !world.ended, exit_code: null };
        return { stopped: true };
      case 'mods.service':
        if (world.noWorkspace) throw new Error('optional_service_unavailable');
        if (args.method === 'panels') return { panels: world.docked ? [{ id: 'lazygit' }] : [] };
        if (args.method === 'mode') return world.off ? { error: 'the workspace is off' } : { mode: args.input };
        return args.method === 'register' ? { registered: 'lazygit' } : { removed: true };
      case 'composer.read': return { text: '', cursor: 0, selection: null, revision: 7, attachments: [], suggestion: null };
      case 'composer.write': return { applied: true };
      case 'terminal.open': return { opened: true };
      case 'terminal.pane': return { applied: true };
      case 'terminal.notice': return { shown: true };
      default: throw new Error(`unexpected host operation ${operation}`);
    }
  };
  const request = { source, filename: fileURLToPath(new URL('index.ts', mod)), entrypoint: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, state, settings: { ...defaults, placement: 'full', ...settings }, settings_file: { path: '/store/settings/omd_lazygit.json', status: 'missing', error: null }, event, name, payload, hook_budget_ms: 10000 };
  const output = callback(request, host);
  if (output.error) throw new Error(output.error);
  return { value: output.value, state: output.state ?? state, calls };
}

const command = (args, options) => run('command', args, { ...options, name: 'lazygit' });
const emit = (state, payload, options) => run('component_event', { thread_id: 't1', origin: 'user', component: ID, ...payload }, { ...options, state });
const draw = (state, rows = 40, settings = {}, world = {}) => run('terminal', { event: 'redraw', ledger: { thread_id: 't1', cwd: '/repo', cost: null }, client: { columns: 120, rows } }, { state, settings, world }).value;
const ops = (result, operation) => result.calls.filter(call => call.operation === operation).map(call => call.arguments);
const notify = (state, text, options) => emit(state, { kind: 'notify', text }, options);
const running = { running: true, panel: false };

test('a missing lazygit shows the install hint and starts nothing', () => {
  const result = command('', { world: { missing: true } });
  assert.match(result.value.display, /^Cannot run lazygit\. Install it with brew install lazygit/);
  assert.deepEqual(ops(result, 'terminal.pty'), []);
  assert.equal(result.state, null);
  assert.match(command('', { world: { gone: true } }).value.display, /^Cannot run lazygit\. Install it/);
  assert.equal(command('', { world: { failed: 'client_context_changed' } }).value.display, 'lazygit did not start: client_context_changed');
});

test('start runs lazygit unsandboxed in the session directory with the user config and the injected one', () => {
  const result = command('');
  assert.deepEqual(ops(result, 'exec.run'), [
    { program: 'lazygit', argv: ['-cd'], sandbox: 'none', timeout_ms: 5000 },
    { program: '/bin/test', argv: ['-f', '/home/me/.config/lazygit/config.yml'], timeout_ms: 5000 },
  ]);
  const fresh = command('', { world: { noConfig: true } });
  assert.deepEqual(ops(fresh, 'terminal.pty')[0].argv, ['-p', '/repo/app', '--use-config-file', '{dir}/omd.yml']);
  const [start] = ops(result, 'terminal.pty');
  assert.deepEqual({ ...start, files: Object.keys(start.files) }, {
    action: 'start', session: 'lazygit', program: 'lazygit', cwd: '/repo/app', sandbox: 'none',
    argv: ['-p', '/repo/app', '--use-config-file', '/home/me/.config/lazygit/config.yml,{dir}/omd.yml'], files: ['omd.yml'],
  });
  const { os } = JSON.parse(start.files['omd.yml']);
  assert.deepEqual(Object.keys(os).sort(), ['edit', 'editAtLine', 'editInTerminal', 'openDirInEditor']);
  assert.equal(os.editInTerminal, false);
  assert.match(os.edit, /^f=\{\{filename\}\};.*omd-edit:/);
  assert.match(os.editAtLine, /\{\{line\}\}/);
  assert.match(os.openDirInEditor, /^f=\{\{dir\}\};/);
  assert.deepEqual(ops(result, 'terminal.pane'), [{ action: 'focus', id: ID }]);
  assert.deepEqual(result.state, { running: true, panel: true });
  assert.match(result.value.display, /^lazygit started/);
});

test('a path argument is the repository, and an unknown config directory leaves the injected file alone', () => {
  const [relative] = ops(command('../other'), 'terminal.pty');
  assert.deepEqual([relative.cwd, relative.argv.slice(0, 2)], ['/repo/app/../other', ['-p', '/repo/app/../other']]);
  const [absolute] = ops(command('/work/repo', { world: { noDir: true } }), 'terminal.pty');
  assert.deepEqual([absolute.cwd, absolute.argv], ['/work/repo', ['-p', '/work/repo', '--use-config-file', '{dir}/omd.yml']]);
});

test('a declined start keeps nothing running', () => {
  const result = command('', { world: { declined: true } });
  assert.equal(result.value.display, 'lazygit start declined');
  assert.equal(result.state, null);
  const untrusted = command('', { world: { untrusted: true } });
  assert.deepEqual([untrusted.value.display, ops(untrusted, 'terminal.pty')], ['lazygit start declined', []]);
});

test('full placement gives lazygit the screen above a compact chat, and the terminal autofocuses', () => {
  assert.equal(draw(null), null);
  const view = draw(running);
  assert.deepEqual(view.sites[SITE].components, [{ type: 'terminal', id: ID, label: 'lazygit', session: 'lazygit', autofocus: true }]);
  assert.deepEqual(view.layout.children, [{ content: `site:${SITE}`, title: '', style: { border: 'none', padding: 0 } }, { split: 'vertical', ratio: [2, 3], children: [{ content: 'transcript' }, { content: 'composer' }] }]);
  assert.ok(view.layout.ratio[0] > view.layout.ratio[1]);
});

test('panel is the default placement; it registers a workspace panel shown in the dock and draws only its site', () => {
  assert.equal(defaults.placement, 'panel');
  const result = command('', { settings: { placement: 'panel' } });
  assert.deepEqual(ops(result, 'mods.service'), [{ name: 'omd.workspace', method: 'register', input: { id: 'lazygit', title: 'Lazygit', site: SITE, show: true } }]);
  assert.deepEqual(result.state, { running: true, panel: true });
  const view = draw(result.state);
  assert.equal(view.layout, undefined);
  assert.equal(view.sites[SITE].components[0].autofocus, true);
  const fallback = command('', { settings: { placement: 'panel' }, world: { noWorkspace: true } });
  assert.deepEqual(fallback.state, { running: true, panel: false });
  assert.deepEqual(draw(null, 40, { placement: 'panel' }, { docked: true }).sites[SITE].components.map(item => item.type), ['text']);
  assert.equal(draw(null, 40, { placement: 'panel' }), null);
  assert.equal(draw(null, 40, { placement: 'panel' }, { noWorkspace: true }), null);
});

test('--stop closes a running lazygit and says so when none runs', () => {
  const stopped = command('--stop', { state: { running: true, panel: true } });
  assert.equal(stopped.value.display, 'lazygit stopped');
  assert.deepEqual(ops(stopped, 'terminal.pty'), [{ action: 'stop', session: 'lazygit' }]);
  assert.deepEqual(ops(stopped, 'mods.service').map(call => call.method), ['unregister']);
  assert.deepEqual(stopped.state, { running: false, panel: false });
  assert.equal(command('--stop').value.display, 'lazygit is not running');
});

test('running again only refocuses, and a session that ended starts anew', () => {
  const again = command('', { state: running });
  assert.equal(again.value.display, 'lazygit is running');
  assert.deepEqual(ops(again, 'terminal.pane'), [{ action: 'focus', id: ID }]);
  assert.deepEqual(ops(again, 'terminal.pty').map(call => call.action), ['read']);
  const restarted = command('', { state: running, world: { ended: true } });
  assert.deepEqual(ops(restarted, 'terminal.pty').map(call => call.action), ['read', 'stop', 'start']);
  assert.match(restarted.value.display, /^lazygit started/);
});

test('an edit notification opens the file in the editor at its line', () => {
  const at = notify(running, 'omd-edit:/repo/src/a.ts:12');
  assert.deepEqual(ops(at, 'terminal.open'), [{ path: 'src/a.ts', editor: true, line: 12 }]);
  assert.deepEqual(ops(notify(running, 'omd-edit:/repo/src/a.ts:'), 'terminal.open'), [{ path: 'src/a.ts', editor: true }]);
  assert.deepEqual(ops(notify(running, 'omd-edit:/repo/dir: name:3'), 'terminal.open'), [{ path: 'dir: name', editor: true, line: 3 }]);
  assert.deepEqual(ops(emit(running, { kind: 'notify', text: 'hello' }), 'terminal.open'), []);
  const outside = notify(running, 'omd-edit:/etc/passwd:1');
  assert.deepEqual(ops(outside, 'terminal.open'), []);
  assert.match(ops(outside, 'terminal.notice')[0].text, /^\/etc\/passwd is outside/);
  const escaped = notify(running, 'omd-edit:/repo/../etc/passwd:1');
  assert.deepEqual(ops(escaped, 'terminal.open'), []);
});

test('with edit set to composer an edit inserts an @path mention at the cursor', () => {
  const settings = { edit: 'composer' };
  const plain = notify(running, 'omd-edit:/repo/src/a.ts:12', { settings });
  assert.deepEqual(ops(plain, 'composer.write'), [{ revision: 7, edit: { kind: 'insert', text: '@src/a.ts ' } }]);
  assert.deepEqual(ops(plain, 'terminal.open'), []);
  const spaced = notify(running, 'omd-edit:/repo/my file.ts:', { settings });
  assert.equal(ops(spaced, 'composer.write')[0].edit.text, '@"my file.ts" ');
});

test('exit stops the session, unregisters the panel and clears the state', () => {
  const full = emit(running, { kind: 'exit', session: 'lazygit', exit_code: 0, files: {} });
  assert.deepEqual(ops(full, 'terminal.pty'), [{ action: 'stop', session: 'lazygit' }]);
  assert.deepEqual(ops(full, 'mods.service'), []);
  assert.deepEqual(full.state, { running: false, panel: false });
  assert.equal(draw(full.state), null);
  const panel = emit({ running: true, panel: true }, { kind: 'exit', session: 'lazygit', exit_code: 1, files: {} });
  assert.deepEqual(ops(panel, 'mods.service'), [{ name: 'omd.workspace', method: 'unregister', input: { id: 'lazygit' } }]);
  assert.deepEqual(panel.state, { running: false, panel: false });
  assert.deepEqual(ops(panel, 'terminal.notice'), [{ text: 'lazygit exited with 1', kind: 'warning' }]);
  assert.deepEqual(ops(full, 'terminal.notice'), []);
  const ended = emit(running, { kind: 'exit', session: 'lazygit', exit_code: null });
  assert.deepEqual([ended.state, ops(ended, 'terminal.notice')], [{ running: false, panel: false }, []]);
});

test('full placement asks the workspace for its full screen mode, and falls back to its own layout when the workspace is off', () => {
  const docked = command('');
  assert.deepEqual(ops(docked, 'mods.service'), [
    { name: 'omd.workspace', method: 'register', input: { id: 'lazygit', title: 'Lazygit', site: SITE, show: true } },
    { name: 'omd.workspace', method: 'mode', input: { level: 'full', target: 'lazygit' } },
  ]);
  assert.deepEqual(docked.state, { running: true, panel: true });
  assert.equal(docked.value.display, 'lazygit started (Ctrl+] leaves it)');
  assert.equal(draw(docked.state).layout, undefined);
  const off = command('', { world: { off: true } });
  assert.deepEqual(ops(off, 'mods.service').map(call => call.method), ['register', 'mode', 'unregister']);
  assert.deepEqual(off.state, { running: true, panel: false });
});
