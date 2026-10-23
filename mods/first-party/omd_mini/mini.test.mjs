import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { callback } from '../../../tests/mod_runner.mjs';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('./mod.json', import.meta.url), 'utf8'));
const thread = '019a0000-0000-7000-8000-000000000001';
const launch = '0123456789abcdef';
const ledger = (cost = null) => ({ thread_id: thread, cwd: '/repo', cost });

function session(env, current = thread, turns = 1, model = undefined) {
  const store = {};
  const calls = [];
  let state = null;
  const invoke = (event, payload = null, name = '', time = 1790000000000) => {
    const request = { source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, state, settings: {}, event, name, payload, virtual_time_ms: time };
    const output = callback(request, ({ operation, arguments: args }) => {
      calls.push({ operation, args });
      const key = `${args?.scope ?? 'repository'}:${args?.key}`;
      let value = null;
      if (operation === 'environment.read') value = { values: Object.fromEntries(args.names.map(name => { const line = env.split('\n').find(item => item.startsWith(`${name}=`)); return [name, line ? { set: true, value: line.slice(name.length + 1) } : { set: false, value: null }]; })) };
      if (operation === 'store.get') value = store[key] ?? null;
      if (operation === 'store.put') { store[key] = { value: args.value, revision: (store[key]?.revision ?? 0) + 1, provenance: { thread_id: thread } }; value = { revision: store[key].revision }; }
      if (operation === 'store.delete') { value = { deleted: key in store }; delete store[key]; }
      if (operation === 'continuation.next') value = { result: { tree: [{ type: 'native' }] }, trace: [] };
      if (operation === 'app.request' && args.method === 'thread/read') value = { thread: { id: args.params.threadId, model: model ?? null } };
      if (operation === 'session.info') value = { thread_id: current, root: '/repo', cwd: '/repo', codex_version: '0.164.0', model: 'gpt-6-astra', provider: 'openai', route: null, turns_started: turns };
      return value;
    });
    if (output.error) throw new Error(output.error);
    state = output.state;
    return output.value;
  };
  return { invoke, store, calls };
}

const notify = (method, params, threadId = thread) => ({ method, params, thread_id: threadId, coalesced: 0, dropped: 0 });

test('outside an omd mini launch the mod stays inert and points to the launcher', () => {
  const { invoke, calls } = session('PATH=/usr/bin\n');
  invoke('start', {});
  assert.deepEqual(calls.map(call => call.operation), ['environment.read']);
  assert.equal(invoke('terminal', { event: 'turn_end', ledger: ledger() }), null);
  invoke('app_notification', notify('thread/settings/updated', { threadId: thread, threadSettings: { model: 'x' } }));
  assert.equal(calls.length, 1);
  assert.equal(invoke('command', '', 'switch').display, `This session was not started by \`omd mini\`. Quit, then run \`omd mini resume ${thread}\`.`);
});

test('the status line names the effective thread model', () => {
  const { invoke } = session(`OH_MY_DIFF_PRESENTATION=mini\nOH_MY_DIFF_LAUNCH=${launch}.0\n`, thread, 0, 'gpt-6-luna');
  invoke('start', {});
  assert.deepEqual(invoke('terminal', { event: 'start', ledger: ledger() }), { status: ['gpt-6-luna'] });
});

test('a mini session shows one status line of model, context and limits', () => {
  const { invoke } = session(`OH_MY_DIFF_PRESENTATION=mini\nOH_MY_DIFF_LAUNCH=${launch}.0\n`);
  invoke('start', {});
  assert.deepEqual(invoke('terminal', { event: 'start', ledger: ledger() }), { status: ['gpt-6-astra'] });
  invoke('app_notification', notify('thread/tokenUsage/updated', { threadId: thread, tokenUsage: { last: { totalTokens: 88000 }, modelContextWindow: 258000 } }));
  invoke('app_notification', notify('thread/tokenUsage/updated', { threadId: 'child', tokenUsage: { last: { totalTokens: 1000 }, modelContextWindow: 258000 } }, 'child'));
  invoke('app_notification', notify('account/rateLimits/updated', { rateLimits: { primary: { usedPercent: 23, windowDurationMins: 300 } } }, null));
  invoke('app_notification', notify('account/rateLimits/updated', { rateLimits: { limitId: 'claude', primary: { usedPercent: 99, windowDurationMins: 300 } } }, null));
  assert.deepEqual(invoke('terminal', { event: 'turn_end', ledger: ledger() }).status, ['gpt-6-astra', 'ctx 34%', '5h 23%']);
  invoke('app_notification', notify('account/rateLimits/updated', { rateLimits: { primary: { usedPercent: 30, windowDurationMins: 10080 } } }, null));
  assert.deepEqual(invoke('terminal', { event: 'turn_end', ledger: ledger() }).status, ['gpt-6-astra', 'ctx 34%', '7d 30%']);
  invoke('app_notification', notify('thread/settings/updated', { threadId: thread, threadSettings: { model: 'gpt-6-luna' } }));
  invoke('app_notification', notify('thread/settings/updated', { threadId: 'child', threadSettings: { model: 'gpt-6-sol' } }, 'child'));
  assert.deepEqual(invoke('terminal', { event: 'turn_end', ledger: ledger({ settled_task_charge_microusd: 120000 }) }).status, ['gpt-6-luna', 'ctx 34%', '$0.12']);
});

test('switching records a request for this launch run, refuses mid-turn and can be cancelled', () => {
  const { invoke, store, calls } = session(`OH_MY_DIFF_PRESENTATION=mini\nOH_MY_DIFF_LAUNCH=${launch}.2\n`);
  store[`user:switch_${launch}`] = { value: { run: 1, target: 'mini', thread }, revision: 4, provenance: { thread_id: thread } };
  invoke('resume', { thread_id: thread, last_turn: null, restarted: false });
  assert.equal(store[`user:switch_${launch}`], undefined);
  invoke('turn_start', { turn_id: 't1' });
  assert.match(invoke('command', '', 'switch').display, /^A turn is running/);
  invoke('turn_end', { turn_id: 't1', outcome: 'aborted' });
  assert.match(invoke('command', '', 'switch').display, /reopens this session in the full interface/);
  assert.deepEqual(store[`user:switch_${launch}`].value, { run: 2, target: 'full', thread });
  invoke('start', null);
  assert.deepEqual(store[`user:switch_${launch}`].value, { run: 2, target: 'full', thread });
  assert.match(invoke('command', '', 'switch').display, /^Switch cancelled/);
  assert.equal(store[`user:switch_${launch}`], undefined);
  assert.ok(calls.every(call => call.operation !== 'exec.run'));
});

test('a full session started by the launcher switches back to mini', () => {
  const { invoke, store } = session(`OH_MY_DIFF_PRESENTATION=full\nOH_MY_DIFF_LAUNCH=${launch}.1\n`);
  invoke('resume', { thread_id: thread, last_turn: null, restarted: false });
  assert.equal(invoke('terminal', { event: 'resume', ledger: ledger() }), null);
  invoke('command', '', 'switch');
  assert.deepEqual(store[`user:switch_${launch}`].value, { run: 1, target: 'mini', thread });
});

test('switching before the first message asks for one unless the thread was resumed', () => {
  const fresh = session(`OH_MY_DIFF_PRESENTATION=mini\nOH_MY_DIFF_LAUNCH=${launch}.0\n`, thread, 0);
  fresh.invoke('start', {});
  assert.match(fresh.invoke('command', '', 'switch').display, /^This session has no thread/);
  const resumed = session(`OH_MY_DIFF_PRESENTATION=mini\nOH_MY_DIFF_LAUNCH=${launch}.0\n`, thread, 0);
  resumed.invoke('resume', { thread_id: thread, last_turn: null, restarted: false });
  assert.match(resumed.invoke('command', '', 'switch').display, /reopens this session in the full interface/);
});
