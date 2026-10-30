import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { callback } from '../../../tests/mod_runner.mjs';

const mod = new URL('./', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('mod.json', mod), 'utf8'));
const source = readFileSync(new URL('index.ts', mod), 'utf8');
const defaults = Object.fromEntries(Object.entries(manifest.settings_schema.properties).map(([name, schema]) => [name, schema.default]));
const SITE = 'omd_yazi/main';
const ID = 'omd_yazi_terminal';

function run(event, payload, { state = null, settings = {}, name, world = {} } = {}) {
  const calls = [];
  const host = ({ operation, arguments: args }) => {
    calls.push({ operation, arguments: args });
    switch (operation) {
      case 'session.info': return { thread_id: 't1', root: '/repo', cwd: '/repo/app' };
      case 'terminal.pty':
        if (args.action === 'start') {
          if (world.missing) throw new Error('exec_program_unavailable');
          return world.declined ? { status: 'declined' } : { session: 'yazi', running: true };
        }
        if (args.action === 'read') return { text: '', running: !world.ended, exit_code: null };
        return { stopped: true };
      case 'mods.service':
        if (world.noWorkspace) throw new Error('optional_service_unavailable');
        return args.method === 'register' ? { registered: 'yazi' } : { removed: true };
      case 'composer.read': return { text: '', cursor: 0, selection: null, revision: 7, attachments: [], suggestion: null };
      case 'composer.write': return { applied: true };
      case 'terminal.pane': return { applied: true };
      default: throw new Error(`unexpected host operation ${operation}`);
    }
  };
  const request = { source, filename: fileURLToPath(new URL('index.ts', mod)), entrypoint: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, state, settings: { ...defaults, placement: 'full', ...settings }, settings_file: { path: '/store/settings/omd_yazi.json', status: 'missing', error: null }, event, name, payload, hook_budget_ms: 10000 };
  const output = callback(request, host);
  if (output.error) throw new Error(output.error);
  return { value: output.value, state: output.state ?? state, calls };
}

const command = (args, options) => run('command', args, { ...options, name: 'yazi' });
const exit = (state, files) => run('component_event', { thread_id: 't1', origin: 'user', component: ID, kind: 'exit', session: 'yazi', exit_code: 0, files }, { state });
const draw = (state, rows = 40, settings = {}) => run('terminal', { event: 'redraw', ledger: { thread_id: 't1', cwd: '/repo', cost: null }, client: { columns: 120, rows } }, { state, settings }).value;
const ops = (result, operation) => result.calls.filter(call => call.operation === operation).map(call => call.arguments);
const running = { running: true, panel: false, dir: null };
const idle = { running: false, panel: false, dir: null };

test('a missing yazi shows the install hint and starts nothing', () => {
  const result = command('', { world: { missing: true } });
  assert.match(result.value.display, /^Cannot run yazi\. Install it with brew install yazi/);
  assert.equal(result.state, null);
});

test('start runs yazi unsandboxed with the chooser and cwd files in the session directory', () => {
  const result = command('');
  assert.deepEqual(ops(result, 'exec.run'), []);
  assert.deepEqual(ops(result, 'terminal.pty'), [{
    action: 'start', session: 'yazi', program: 'yazi', cwd: '/repo/app', sandbox: 'none',
    argv: ['/repo/app', '--chooser-file={dir}/chosen', '--cwd-file={dir}/cwd'], files: { chosen: '', cwd: '' },
  }]);
  assert.deepEqual(ops(result, 'terminal.pane'), [{ action: 'focus', id: ID }]);
  assert.deepEqual(result.state, { running: true, panel: false, dir: null });
  assert.equal(command('', { world: { declined: true } }).state, null);
});

test('yazi starts in the remembered directory only while it is inside the session root', () => {
  const start = (args, dir) => ops(command(args, { state: { ...idle, dir } }), 'terminal.pty')[0].argv[0];
  assert.equal(start('', '/repo/src'), '/repo/src');
  assert.equal(start('', '/elsewhere'), '/repo/app');
  assert.equal(start('docs', '/repo/src'), '/repo/app/docs');
  assert.equal(start('/repo/lib', '/repo/src'), '/repo/lib');
  assert.equal(command('', { state: { ...idle, dir: '/repo/src' } }).state.dir, '/repo/src');
});

test('panel is the default placement; it registers a workspace panel shown in the dock and draws only its site, full placement the screen', () => {
  assert.equal(defaults.placement, 'panel');
  const panel = command('', { settings: { placement: 'panel' } });
  assert.deepEqual(ops(panel, 'mods.service'), [{ name: 'omd.workspace', method: 'register', input: { id: 'yazi', title: 'Yazi', site: SITE, show: true } }]);
  assert.deepEqual(panel.state, { running: true, panel: true, dir: null });
  assert.equal(draw(panel.state).layout, undefined);
  assert.deepEqual(command('', { settings: { placement: 'panel' }, world: { noWorkspace: true } }).state.panel, false);
  assert.equal(draw(null), null);
  assert.deepEqual(draw(null, 40, { placement: 'panel' }).sites[SITE].components.map(item => item.type), ['text']);
  const view = draw(running);
  assert.deepEqual(view.sites[SITE].components, [{ type: 'terminal', id: ID, label: 'yazi', session: 'yazi', autofocus: true }]);
  assert.equal(view.layout.children[0].content, `site:${SITE}`);
});

test('running again only refocuses, and a session that ended starts anew', () => {
  const again = command('', { state: running });
  assert.equal(again.value.display, 'yazi is running');
  assert.deepEqual(ops(again, 'terminal.pty').map(call => call.action), ['read']);
  assert.deepEqual(ops(command('', { state: running, world: { ended: true } }), 'terminal.pty').map(call => call.action), ['read', 'stop', 'start']);
  const stopped = command('--stop', { state: { ...running, dir: '/repo/src' } });
  assert.deepEqual([stopped.value.display, stopped.state], ['yazi stopped', { running: false, panel: false, dir: '/repo/src' }]);
  assert.equal(command('--stop').value.display, 'yazi is not running');
});

test('exit inserts the chosen files as mentions, remembers the directory, and closes', () => {
  const result = exit(running, { chosen: '/repo/src/a.ts\n/repo/my file.md\n/other/b.ts\n/repo/../etc/passwd\n/repo/q"x.ts\n', cwd: '/repo/src\n' });
  assert.deepEqual(ops(result, 'composer.write'), [{ revision: 7, edit: { kind: 'insert', text: '@src/a.ts @"my file.md" @"q\\"x.ts" ' } }]);
  assert.deepEqual(ops(result, 'terminal.pty'), [{ action: 'stop', session: 'yazi' }]);
  assert.deepEqual(result.state, { running: false, panel: false, dir: '/repo/src' });
  assert.equal(draw(result.state), null);
});

test('exit keeps the old directory when the new one is outside the root, caps mentions and skips empty choices', () => {
  const kept = exit({ ...running, dir: '/repo/old' }, { chosen: '', cwd: '/tmp/x' });
  assert.deepEqual(kept.state, { running: false, panel: false, dir: '/repo/old' });
  assert.deepEqual(ops(kept, 'composer.write'), []);
  assert.deepEqual(ops(kept, 'composer.read'), []);
  const many = exit(running, { chosen: Array.from({ length: 20 }, (_, index) => `/repo/f${index}.ts`).join('\n') });
  assert.equal(ops(many, 'composer.write')[0].edit.text.trim().split(' ').length, 16);
});

test('exit unregisters a workspace panel', () => {
  const panel = exit({ running: true, panel: true, dir: null }, {});
  assert.deepEqual(ops(panel, 'mods.service'), [{ name: 'omd.workspace', method: 'unregister', input: { id: 'yazi' } }]);
  assert.deepEqual(panel.state, { running: false, panel: false, dir: null });
});
