import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runnerSync } from './mod_runner.mjs';

const root = new URL('../mods/first-party/omd_inspector/', import.meta.url);
const source = readFileSync(new URL('index.ts', root), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('mod.json', root), 'utf8'));
const surface = { events: { terminal: 'terminal', component_event: 'terminal', channel: 'events' },
  replacements: [], middleware: [], state: 'store', contracts: 'contracts' };
const run = (event, payload, state) => {
  const result = JSON.parse(runnerSync({ source, filename: 'index.ts', api: manifest.api,
    capabilities: manifest.capabilities, settings: {}, state, surface, hook_budget_ms: 2000,
    receipts: [], event, payload }).stdout);
  assert.ifError(result.error);
  assert.ok(!result.host_call);
  return result;
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
