import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { callback } from '../../../tests/mod_runner.mjs';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('./mod.json', import.meta.url), 'utf8'));

function run(event, payload, state, answers = {}, name = '') {
  const calls = [];
  const reply = callback({ source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, state, settings: {}, event, name, payload }, call => {
    calls.push(call.operation);
    if (call.operation in answers) return answers[call.operation](call.arguments);
    throw new Error(`${call.operation}_unavailable`);
  });
  assert.equal(reply.error, undefined, reply.error);
  return { ...reply, calls };
}
const texts = patch => Object.fromEntries(patch.sites.dialog.components[0].children.filter(item => item.type === 'text').map(item => [item.label, item.text]));

test('/inspect opens the dialog and asks its own channel for live status', () => {
  const opened = run('command', '', null, { 'events.publish': args => { assert.deepEqual(args, { channel: 'refresh', data: null }); return null; } }, 'inspect');
  assert.equal(opened.value, null);
  assert.equal(opened.state.open, true);
  const refreshed = run('channel', { channel: 'omd_inspector/refresh', data: null }, opened.state, {
    'task.status': () => ({ ledger: { thread_id: 'thread-1', cost: { settled_task_charge_microusd: 1_250_000 } }, limits: { max_turns: 5 }, worker_limits: null }),
    'contract.status': () => ({ status: 'active', active: { id: 'omd_workflow\u0007', version: 2, assurance: 'checked' } }),
  });
  const shown = texts(run('terminal', { identity: { mode: 'omd', install_profile: 'full', mods: { active: 3, enabled: 4, installed: 5 } }, ledger: null }, refreshed.state).value);
  assert.equal(shown.Session, 'thread-1');
  assert.equal(shown.Contract, 'omd_workflow?@2 (checked)');
  assert.equal(shown['Task limits'], 'max turns 5');
  assert.equal(shown['Worker limits'], 'unavailable');
  assert.equal(shown.Cost, '$1.25 paid API');
  assert.equal(shown.Mods, '3 active · 4 enabled · 5 installed');
  assert.equal(shown.Status, undefined);
});

test('missing live status is reported, and close or resume hides the dialog', () => {
  const failed = run('channel', { channel: 'omd_inspector/refresh', data: null }, { open: true });
  assert.equal(texts(run('terminal', { identity: undefined, ledger: null }, failed.state).value).Status, 'Live task and contract status are unavailable');
  assert.equal(run('command', 'close', failed.state, {}, 'inspect').state.open, false);
  assert.equal(run('resume', {}, failed.state).state.open, false);
  assert.equal(run('terminal', { identity: undefined, ledger: null }, { open: false }).value, null);
});
