import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runnerSync } from '../../../tests/mod_runner.mjs';

const root = new URL('./', import.meta.url);
const source = readFileSync(new URL('index.ts', root), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('mod.json', root), 'utf8'));
const run = (event, payload, state) => {
  const result = runnerSync({ source, filename: 'index.ts', api: manifest.api,
    capabilities: manifest.capabilities, settings: {}, state, hook_budget_ms: 2000, event, payload });
  assert.ifError(result.error);
  assert.ok(!result.host_call);
  return result;
};
const inspect = input => {
  const output = runnerSync({ source, filename: 'index.ts', api: manifest.api, settings: {}, state: null, event: 'inspect', capabilities: [], ...input });
  assert.equal(output.error, undefined, output.error);
  return output;
};

test('inspector stays closed after startup or its owned Escape without claiming other dialogs', () => {
  const open = { open: true, contract: 'none', limits: 'kept' };
  const startup = run('terminal', { event: 'startup' }, open);
  assert.equal(startup.state.open, false);
  assert.equal(startup.state.limits, 'kept');
  assert.equal(startup.value, null);
  const escaped = run('component_event', { component: 'omd_inspector_dialog', kind: 'close', origin: 'user' }, open);
  assert.equal(escaped.state.open, false);
  assert.equal(run('terminal', { event: 'idle' }, escaped.state).value, null);
  assert.equal(run('component_event', { component: 'another_dialog', kind: 'close', origin: 'user' }, open).state.open, true);
});

test('inspector opens from live host status and fails visibly when status is unavailable', () => {
  const capabilities = ['agents', 'commands', 'contracts', 'store', 'terminal', 'events'];
  const receipts = [
    { call: { operation: 'task.status', arguments: null }, value: { ledger: { thread_id: 'thread-1', cost: { settled_task_charge_microusd: 2_000_000 } }, limits: { turns: 4 }, worker_limits: { active: 1 } } },
    { call: { operation: 'contract.status', arguments: null }, value: { status: 'active', active: { id: 'review', version: 2, assurance: 'local' } } },
  ];
  const published = [{ call: { operation: 'events.publish', arguments: { channel: 'refresh', data: null } }, value: { delivered: 1, dropped: 0 } }];
  const opened = inspect({ capabilities, event: 'command', name: 'inspect', payload: '', receipts: published });
  assert.equal(opened.state.open, true);
  const refresh = { publisher: 'omd_inspector', channel: 'omd_inspector/refresh', data: null, correlation: null, sequence: 1, dropped: 0 };
  const refreshed = inspect({ capabilities, event: 'channel', state: opened.state, payload: refresh, receipts });
  const identity = { codex_version: '0.157.0', install_profile: 'full', mode: 'omd', mods: { installed: 7, enabled: 6, active: 5 } };
  const view = inspect({ capabilities, event: 'terminal', state: refreshed.state, payload: { event: 'idle', identity, ledger: null } });
  const children = view.value.sites.dialog.components[0].children;
  assert.match(JSON.stringify(children), /review@2/);
  assert.match(JSON.stringify(children), /5 active/);
  assert.match(JSON.stringify(children), /\$2\.00 paid API/);
  assert.ok(children.every(child => !String(child.text ?? '').includes('{')));
  const closed = inspect({ capabilities, event: 'command', name: 'inspect', payload: 'close', state: refreshed.state });
  assert.equal(inspect({ capabilities, event: 'terminal', state: closed.state, payload: { event: 'idle', identity, ledger: null } }).value, null);
  const failed = inspect({ capabilities, event: 'channel', state: opened.state, payload: refresh, receipts: [
    { call: receipts[0].call, error: 'unavailable' },
    { call: receipts[1].call, error: 'unavailable' },
  ] });
  assert.match(failed.state.error, /unavailable/);
});
