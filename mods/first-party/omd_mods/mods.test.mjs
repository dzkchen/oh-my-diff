import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const runner = readFileSync(new URL('../../../runtime/omd/src/mods/runner.mjs', import.meta.url), 'utf8');
const surface = { events: { terminal: 'terminal' }, replacements: [], middleware: [], state: 'store', contracts: 'contracts' };
const unexpected = call => { throw new Error(`unexpected host call ${call.operation}`); };

function run(input, host = unexpected) {
  const receipts = [];
  for (;;) {
    const request = { source, filename: 'index.ts', api: '0.2.0-experimental.5', capabilities: ['commands', 'packages', 'store', 'terminal'],
      settings: {}, state: null, surface, hook_budget_ms: 2000, receipts, ...input };
    const output = JSON.parse(spawnSync(process.execPath, ['--no-warnings', '--experimental-vm-modules', '--input-type=module', '--eval', runner],
      { input: JSON.stringify(request), encoding: 'utf8', timeout: 5000 }).stdout);
    if (output.error) throw new Error(output.error);
    if (!output.host_call) return output;
    receipts.push({ call: output.host_call, value: host(output.host_call) });
  }
}

const item = (id, extra = {}) => ({ id, kind: 'mod', version: '1.0.0', description: `${id} description`, scope: 'user', path: `/mods/${id}`, source: 'selection',
  installed: true, enabled: false, effective: false, pending: null, failed: null, api: '0.2.0-experimental.5', compatible: true, grants: ['commands'], conflicts: [], ...extra });

test('/mods lists session states and applies only host-previewed actions', () => {
  const calls = [];
  const host = call => {
    calls.push(call);
    if (call.operation === 'packages.list') return { generation: 7, reload_error: null,
      packages: [item('omd_lsp_sync', { source: 'local', enabled: true, effective: true }), item('omd_git', { enabled: true, pending: 'reload' })] };
    if (call.operation === 'packages.preview') return { action: 'update', id: 'omd_lsp_sync', changes: { packages: [{ id: 'omd_lsp_sync', version: { from: '1.0.0', to: '1.1.0' } }] }, grants_added: ['exec'], conflicts: [] };
    return { status: 'applied', generation: 8 };
  };
  const command = (payload, state) => run({ event: 'command', name: 'mods', payload, state }, host).state;
  let state = command('', null);
  const dialog = run({ event: 'terminal', state, payload: { event: 'idle', ledger: null } }).value.sites.dialog.components[1];
  assert.deepEqual(dialog.children.find(child => child.type === 'list').rows.map(row => row.spans.map(span => span.text).join('')),
    ['~ omd_git  1.0.0 · user · starts at the next turn', '● omd_lsp_sync  1.0.0 · user · active']);
  assert.deepEqual(dialog.children.filter(child => child.id === 'omd_mods_description' || child.id === 'omd_mods_disable').map(child => child.text), ['Disable', 'omd_git description']);

  state = command('disable omd_git', state);
  assert.deepEqual(calls.find(call => call.operation === 'packages.apply').arguments, { action: 'disable', id: 'omd_git', scope: 'user', expected_generation: 7 });
  assert.equal(state.notice, 'disable omd_git applied; it takes effect at the next turn');

  state = command('update user:omd_lsp_sync', state);
  assert.deepEqual([state.review.grants, calls.filter(call => call.operation === 'packages.apply').length], [['exec'], 1]);
  state = command('apply', state);
  assert.deepEqual(calls.filter(call => call.operation === 'packages.apply').at(-1).arguments,
    { action: 'update', id: 'omd_lsp_sync', scope: 'user', expected_generation: 7 });
  assert.equal(state.review, null);
  const reopened = run({ event: 'terminal', state, payload: { event: 'startup', ledger: null, presentation: { thread_id: null, phase: 'resumed' } } });
  assert.deepEqual([reopened.value, reopened.state.open], [null, false]);
  const closed = command('close', state);
  const typed = run({ event: 'command', name: 'mods', payload: 'update omd_lsp_sync', state: closed }, host);
  assert.equal(typed.state.open, false);
  assert.equal(typed.value.display, 'Review update omd_lsp_sync · omd_lsp_sync 1.0.0 → 1.1.0 · new capabilities: exec\nRun /mods apply or /mods cancel');
});

test('the first-run card is profile-aware and never repeats once a session has started', () => {
  const terminal = (phase, profile, state = null) => run({ event: 'terminal', state, payload: { event: 'start', ledger: null, presentation: { thread_id: null, phase },
    identity: { codex_version: '0.159.1', install_profile: profile, mode: 'omd', mods: { installed: 2, enabled: 2, active: 2 } } } });
  const card = output => output.value.sites.welcome.components.slice(1).map(line => line.text).join('\n');
  assert.match(card(terminal('fresh', 'platform_only')), /^OMD Core[^]*2 of 2 mods active[^]*omd-mod-author create/);
  assert.match(card(terminal('fresh', 'full')), /^OMD\+[^]*omd-package activate direct/);
  const started = terminal('started', 'full');
  assert.equal(started.value, null);
  assert.equal(terminal('fresh', 'full', started.state).value, null);
});
