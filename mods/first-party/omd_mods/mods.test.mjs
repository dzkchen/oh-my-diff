import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { runnerSync } from '../../../tests/mod_runner.mjs';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const runner = readFileSync(new URL('../../../runtime/omd/src/mods/runner.mjs', import.meta.url), 'utf8');
const surface = { events: { terminal: 'terminal', component_event: 'terminal' }, replacements: [], middleware: [], state: 'store', contracts: 'contracts' };
const unexpected = call => { throw new Error(`unexpected host call ${call.operation}`); };

function run(input, host = unexpected) {
  const receipts = [];
  for (;;) {
    const request = { source, filename: 'index.ts', api: '0.2.0-experimental.5', capabilities: ['commands', 'packages', 'store', 'terminal'],
      settings: {}, state: null, surface, hook_budget_ms: 2000, receipts, ...input };
    const output = JSON.parse(runnerSync(request).stdout);
    if (output.error) throw new Error(output.error);
    if (!output.host_call) return output;
    receipts.push({ call: output.host_call, value: host(output.host_call) });
  }
}

const item = (id, extra = {}) => ({ id, kind: 'mod', version: '1.0.0', description: `${id} description`, scope: 'user', path: `/mods/${id}`, source: 'selection',
  installed: true, enabled: false, effective: false, pending: null, failed: null, api: '0.2.0-experimental.5', compatible: true, grants: ['commands'], conflicts: [], settings_schema: null, settings: {}, ...extra });

test('/mods groups friendly rows, toggles with the list action and applies only host-previewed actions', () => {
  const calls = [];
  const host = call => {
    calls.push(call);
    if (call.operation === 'packages.list') return { generation: 7, reload_error: null, packages: [
      item('omd_lsp_sync', { source: 'local', enabled: true, effective: true }), item('omd_git', { enabled: true, pending: 'reload' }),
      item('omd_theme', { settings_schema: { type: 'object', properties: { greeting: { type: 'boolean', default: true }, density: { type: 'string', enum: ['full', 'compact'], default: 'full' } } }, settings: { greeting: true, density: 'full' } }),
      item('omd_notes', { failed: 'callback_timeout: notes' })] };
    if (call.operation === 'packages.preview') return { action: 'update', id: 'omd_lsp_sync', changes: { packages: [{ id: 'omd_lsp_sync', version: { from: '1.0.0', to: '1.1.0' } }] }, grants_added: ['exec'], conflicts: [] };
    if (call.operation === 'settings.write') return { settings: call.arguments.values };
    return { status: 'applied', generation: 8 };
  };
  const command = (payload, state) => run({ event: 'command', name: 'mods', payload, state }, host).state;
  const view = state => run({ event: 'terminal', state, payload: { event: 'idle', ledger: null } }).value.sites.dialog.components[1];
  let state = command('', null);
  const dialog = view(state);
  assert.equal(dialog.title, 'Mods');
  assert.deepEqual(dialog.children[0].spans.map(span => span.text), ['Mods', '  1 of 4 on']);
  const list = dialog.children.find(child => child.type === 'list');
  assert.deepEqual(list.action, { command: 'omd_mods:mods', args: 'toggle' });
  assert.deepEqual(list.rows.map(row => row.spans.slice(0, 3).map(span => span.text).join('')),
    ['Failed 1', '✕ Notes failed', 'On 2', '◇ Git starting', '◆ Lsp Sync on', 'Off 1', '○ Theme off']);
  assert.ok(list.rows.every(row => !row.label.includes('omd_') && !row.spans.slice(0, 3).some(span => span.text.includes('omd_'))));
  assert.equal(dialog.children.at(-1).text, '↑↓ move · space toggle · tab more · esc close');

  state = command('toggle user:omd_git', state);
  assert.deepEqual(calls.find(call => call.operation === 'packages.apply').arguments, { action: 'disable', id: 'omd_git', scope: 'user', expected_generation: 7 });
  assert.equal(state.notice, 'Git is off from your next message.');
  state = command('toggle user:omd_theme', state);
  assert.equal(state.notice, 'Theme is on. Its commands work now; the rest starts with your next message.');
  command('toggle group:On', state);
  assert.equal(calls.filter(call => call.operation === 'packages.apply').length, 2);

  state = command('filter the', state);
  assert.deepEqual(view(state).children.find(child => child.type === 'list').rows.map(row => row.value), ['group:Off', 'user:omd_theme']);
  state = command('details user:omd_theme', { ...state, filter: '' });
  const page = view(state);
  assert.equal(page.title, 'Theme');
  assert.deepEqual(page.children.filter(child => child.id.startsWith('omd_mods_setting_')).map(child => [child.label, child.value]), [['greeting', 'true'], ['density', 'full']]);
  state = command('set user:omd_theme greeting false', state);
  assert.deepEqual(calls.find(call => call.operation === 'settings.write').arguments, { id: 'omd_theme', values: { greeting: false } });
  assert.equal(state.notice, 'Theme: greeting saved');
  state = command('back', state);
  assert.equal(state.details, null);

  state = command('update user:omd_lsp_sync', state);
  assert.deepEqual(state.review.grants, ['exec']);
  state = command('apply', state);
  assert.deepEqual(calls.filter(call => call.operation === 'packages.apply').at(-1).arguments, { action: 'update', id: 'omd_lsp_sync', scope: 'user', expected_generation: 7 });
  const escaped = run({ event: 'component_event', state, payload: { component: 'omd_mods_list', kind: 'input', events: [{ key: 'Esc', text: null }] } });
  assert.equal(escaped.state.open, false);
  const reopened = run({ event: 'terminal', state, payload: { event: 'startup', ledger: null, presentation: { thread_id: null, phase: 'resumed' } } });
  assert.deepEqual([reopened.value, reopened.state.open], [null, false]);
  const typed = run({ event: 'command', name: 'mods', payload: 'update omd_lsp_sync', state: command('close', state) }, host);
  assert.equal(typed.state.open, false);
  assert.equal(typed.value.display, 'update Lsp Sync: omd_lsp_sync 1.0.0 → 1.1.0 · new permissions: exec\nRun /mods apply or /mods cancel');
});

test('the first-run card is plain, profile-aware and never repeats once a session has started', () => {
  const terminal = (phase, profile, state = null) => run({ event: 'terminal', state, payload: { event: 'start', ledger: null, presentation: { thread_id: null, phase },
    identity: { codex_version: '0.160.1', install_profile: profile, mode: 'omd', mods: { installed: 3, enabled: 2, active: 2, failed: 1 } } } });
  const card = output => output.value.sites.welcome.components.slice(1).map(line => line.text).join('\n');
  assert.match(card(terminal('fresh', 'platform_only')), /^Oh My Diff Core[^]*2 of 3 mods on, 1 failed[^]*omd-mod-author create/);
  const full = card(terminal('fresh', 'full'));
  assert.match(full, /^Oh My Diff: most mods start off/);
  assert.doesNotMatch(full, /omd-package|activate direct/);
  assert.ok(full.split('\n').every(text => text.length <= 56));
  const started = terminal('started', 'full');
  assert.equal(started.value, null);
  assert.equal(terminal('fresh', 'full', started.state).value, null);
});
