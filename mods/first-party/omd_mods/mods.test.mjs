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
    try {
      receipts.push({ call: output.host_call, value: host(output.host_call) });
    } catch (error) {
      if (host === unexpected) throw error;
      receipts.push({ call: output.host_call, error: error.message });
    }
  }
}

const item = (id, extra = {}) => ({ id, kind: 'mod', version: '1.0.0', description: `${id} description`, scope: 'user', path: `/mods/${id}`, source: 'selection',
  installed: true, enabled: false, effective: false, pending: null, failed: null, api: '0.2.0-experimental.5', compatible: true, grants: ['commands'], conflicts: [], settings_schema: null, settings: {}, ...extra });

test('/mods groups friendly rows, toggles with the list action and applies only host-previewed actions', () => {
  const calls = [];
  const host = call => {
    calls.push(call);
    if (call.operation === 'packages.list') return { generation: 7, reload_error: null, packages: [
      item('omd_lsp_sync', { source: 'local', enabled: true, effective: true }), item('omd_advisor', { enabled: true, pending: 'reload' }),
      item('omd_workflow', { settings_schema: { type: 'object', properties: { greeting: { type: 'boolean', default: true }, density: { type: 'string', enum: ['full', 'compact'], default: 'full' } } }, settings: { greeting: true, density: 'full' } }),
      item('omd_preview', { failed: 'callback_timeout: notes' })]
      .map(entry => call.arguments ? Object.fromEntries(call.arguments.fields.map(field => [field, entry[field]])) : entry) };
    if (call.operation === 'packages.preview') return { action: 'update', id: 'omd_lsp_sync', changes: { packages: [{ id: 'omd_lsp_sync', version: { from: '1.0.0', to: '1.1.0' } }] }, grants_added: ['exec'], conflicts: [] };
    if (call.operation === 'settings.write') return { settings: call.arguments.values };
    return { status: 'applied', generation: 8 };
  };
  const command = (payload, ui_state) => run({ event: 'command', name: 'mods', payload, ui_state }, host).ui_state;
  const view = ui_state => run({ event: 'terminal', ui_state, payload: { event: 'idle', ledger: null } }).value.sites.dialog.components[1];
  const opened = run({ event: 'command', name: 'mods', payload: '' }, host);
  assert.equal(opened.state, null, 'opening does not change durable state');
  let state = opened.ui_state;
  assert.ok(state.packages.every(entry => !('path' in entry) && !('settings' in entry) && !('grants' in entry)), 'the listing keeps only the fields it shows');
  const dialog = view(state);
  assert.deepEqual(opened.value.terminal.sites.dialog.components[1], dialog);
  assert.equal(dialog.title, 'Mods');
  assert.deepEqual(dialog.children[0].spans.map(span => span.text), ['Mods', '  1 of 4 on']);
  const list = dialog.children.find(child => child.type === 'list');
  assert.deepEqual(list.action, { command: 'omd_mods:mods', args: 'toggle' });
  assert.deepEqual(list.rows.map(row => row.spans.slice(0, 3).map(span => span.text).join('')),
    ['Failed 1', '✕ Preview failed', 'On 2', '◇ Advisor starting', '◆ Lsp Sync on', 'Off 1', '○ Workflow off']);
  assert.ok(list.rows.every(row => !row.label.includes('omd_') && !row.spans.slice(0, 3).some(span => span.text.includes('omd_'))));
  assert.equal(dialog.children.at(-1).text, '↑↓ move · space toggle · tab more · esc close');

  state = command('toggle user:omd_advisor', state);
  assert.deepEqual(calls.find(call => call.operation === 'packages.apply').arguments, { action: 'disable', id: 'omd_advisor', scope: 'user', expected_generation: 7 });
  assert.equal(state.notice, 'Advisor is off from your next message.');
  state = command('toggle user:omd_workflow', state);
  assert.equal(state.notice, 'Workflow is on. Its commands work now; the rest starts with your next message.');
  command('toggle group:On', state);
  assert.equal(calls.filter(call => call.operation === 'packages.apply').length, 2);

  state = command('filter work', state);
  assert.deepEqual(view(state).children.find(child => child.type === 'list').rows.map(row => row.value), ['group:Off', 'user:omd_workflow']);
  state = command('details user:omd_workflow', { ...state, filter: '' });
  const page = view(state);
  assert.equal(page.title, 'Workflow');
  assert.deepEqual(page.children.filter(child => child.id.startsWith('omd_mods_setting_')).map(child => [child.label, child.value]), [['greeting', 'true'], ['density', 'full']]);
  state = command('set user:omd_workflow greeting false', state);
  assert.deepEqual(calls.find(call => call.operation === 'settings.write').arguments, { id: 'omd_workflow', values: { greeting: false } });
  assert.equal(state.notice, 'Workflow: greeting saved');
  state = command('back', state);
  assert.equal(state.details, null);

  state = command('update user:omd_lsp_sync', state);
  assert.deepEqual(state.review.grants, ['exec']);
  state = command('apply', state);
  assert.deepEqual(calls.filter(call => call.operation === 'packages.apply').at(-1).arguments, { action: 'update', id: 'omd_lsp_sync', scope: 'user', expected_generation: 7 });
  const escaped = run({ event: 'component_event', ui_state: { ...state, directory: true, query: 'git' }, payload: { component: 'omd_mods_list', kind: 'input', events: [{ key: 'Esc', text: null }] } });
  assert.deepEqual([escaped.ui_state.open, escaped.ui_state.directory, escaped.ui_state.query], [false, false, ''], 'closing forgets the directory search');
  assert.ok(view({ ...state, review: { request: { action: 'install' }, label: 'Install Git', changes: {}, grants: Array(12).fill('fs.write') } }).children
    .find(child => child.id === 'omd_mods_review').text.split('\n').every(text => text.length <= 52), 'review text wraps for narrow terminals');
  const reopened = run({ event: 'terminal', payload: { event: 'startup', ledger: null, presentation: { thread_id: null, phase: 'resumed' } } });
  assert.deepEqual([reopened.value, reopened.ui_state], [null, null]);
  const typed = run({ event: 'command', name: 'mods', payload: 'update omd_lsp_sync', ui_state: command('close', state) }, host);
  assert.equal(typed.ui_state.open, false);
  assert.equal(typed.value.display, 'update Lsp Sync: omd_lsp_sync 1.0.0 → 1.1.0 · new permissions: exec\nRun /mods apply or /mods cancel');
});

test('the directory searches the catalog, installs a picked version or a typed source in the chosen scope and survives a missing catalog', () => {
  const calls = [];
  let catalog = true;
  const entry = { id: 'omd_preview', latest: '1.2.0', description: 'Session notes', support: 'maintained', installed: null,
    versions: [{ version: '1.3.0', blocked: 'leaks tokens' }, { version: '1.2.0', blocked: null }, { version: '1.1.0', blocked: null }] };
  const host = call => {
    calls.push(call);
    if (call.operation === 'packages.list') return { generation: 3, reload_error: null, packages: [item('omd_advisor', { source: 'npm', blocked: 'exfiltrates tokens' })] };
    if (call.operation === 'packages.index') {
      if (!catalog) throw new Error('package_index_unavailable: install from npm:, git+ or a folder instead');
      return { index: '/store/package-index.json', packages: call.arguments.query === 'zzz' ? [] : [entry] };
    }
    if (call.operation === 'packages.preview') return { action: 'install', id: 'omd_preview', changes: { packages: [{ id: 'omd_preview', version: { from: null, to: '1.1.0' } }] }, grants_added: ['commands'] };
    return { status: 'applied', generation: 4 };
  };
  const command = (payload, ui_state) => run({ event: 'command', name: 'mods', payload, ui_state }, host).ui_state;
  const view = ui_state => run({ event: 'terminal', ui_state, payload: { event: 'idle', ledger: null } }).value.sites.dialog.components[1];
  let state = command('', null);
  assert.equal(view(state).children.find(child => child.type === 'list').rows[1].spans[2].text, ' quarantined');
  assert.ok(view(state).children.some(child => child.id === 'omd_mods_directory'));
  state = command('directory', state);
  let dialog = view(state);
  assert.equal(dialog.title, 'Mod directory');
  assert.deepEqual(dialog.children.find(child => child.id === 'omd_mods_catalog').rows.map(row => row.value), ['omd_preview']);
  state = command('search zzz', state);
  assert.equal(view(state).children.find(child => child.id === 'omd_mods_catalog_empty').text, 'No directory mod matches "zzz"');
  state = command('search notes', state);
  state = command('pick omd_preview', state);
  dialog = view(state);
  assert.deepEqual(dialog.children.find(child => child.id === 'omd_mods_version').options.map(option => option.value), ['1.2.0', '1.1.0']);
  assert.equal(dialog.children.find(child => child.id === 'omd_mods_blocked').text, '1.3.0: leaks tokens');
  state = command('version 1.1.0', command('scope project', state));
  state = command('get', state);
  assert.deepEqual(calls.findLast(call => call.operation === 'packages.preview').arguments, { action: 'install', reference: 'omd_preview@1.1.0', scope: 'project', expected_generation: 3 });
  state = command('apply', state);
  assert.deepEqual(calls.findLast(call => call.operation === 'packages.apply').arguments, { action: 'install', id: 'omd_preview', reference: 'omd_preview@1.1.0', scope: 'project', expected_generation: 3 });
  assert.equal(state.notice, 'Install Preview 1.1.0 (project) installed and off; turn it on to use it');
  assert.equal(calls.at(-1).operation, 'packages.index', 'the directory refreshes after an install');

  catalog = false;
  state = command('directory', state);
  assert.match(view(state).children.find(child => child.id === 'omd_mods_catalog_error').text.replace(/\n/g, ' '), /directory is unavailable[^]*npm, Git or a folder below/);
  state = command('install npm:@author/omd-notes@2.0.0', state);
  assert.deepEqual(calls.findLast(call => call.operation === 'packages.preview').arguments, { action: 'install', reference: 'npm:@author/omd-notes@2.0.0', scope: 'project', expected_generation: 3 });
  assert.match(command('install', state).notice, /npm:NAME@VERSION/);
});

test('the first-run card is plain, profile-aware and never repeats once a session has started', () => {
  const terminal = (phase, profile, state = null) => run({ event: 'terminal', state, payload: { event: 'start', ledger: null, presentation: { thread_id: null, phase },
    identity: { codex_version: '0.162.0', install_profile: profile, mode: 'omd', mods: { installed: 3, enabled: 2, active: 2, failed: 1 } } } });
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
