import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { callback } from '../../../tests/mod_runner.mjs';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('./mod.json', import.meta.url), 'utf8'));
const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

function run(event, payload, state, { settings = {}, now = NOW, answer = () => ({}) } = {}) {
  const calls = [];
  const output = callback({ source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, settings, state, event, payload,
    virtual_time_ms: now, hook_budget_ms: 2000 }, call => {
    calls.push(call);
    if (call.operation === 'session.info') return { thread_id: 'lead', root: '/repo', cwd: '/repo', codex_version: '0.165.0', model: 'gpt-6.1-sol', provider: 'openai', route: null, turns_started: 1 };
    if (call.operation === 'events.schedule') return call.arguments;
    if (call.operation === 'events.cancel') return { cancelled: true };
    const value = answer(call);
    if (value instanceof Error) throw value;
    return value;
  });
  assert.equal(output.error, undefined, output.error);
  return { state: output.state, calls: calls.filter(call => call.operation !== 'session.info').map(({ operation, arguments: args }) => [operation, args]) };
}

const response = (patch = {}) => ({
  request_id: 'r1', attempt: 1, ledger_request: 1, scope: { thread_id: 'lead', agent_id: null, kind: 'main' }, route: 'codex', provider: 'openai', credential: 'api-key',
  requested_model: 'gpt-6.1-sol', served_model: 'gpt-6.1-sol', status: 'completed', stop_reason: 'end_turn', output: { text: '', tool_calls: [] },
  usage: { input_tokens: 150_000, input_tokens_details: { cached_tokens: 140_000 }, output_tokens: 2_000 }, cache: { read_tokens: 140_000, write_tokens: null },
  cost: { microusd: null, basis: 'unsettled' }, context_window: 272_000, timing: { started_at_ms: NOW, first_event_ms: 300, duration_ms: 2_000 },
  synthetic: null, error: null, ...patch,
});

test('auto uses cache evidence and refreshes the interval on reads without inventing an unknown-provider lifetime', () => {
  const armed = run('model_response', response(), null);
  assert.deepEqual(armed.calls, [['events.schedule', { key: 'idle', delay_ms: 27 * MINUTE }]]);
  const refreshed = run('model_response', response({ request_id: 'r2', timing: { started_at_ms: NOW + 20 * MINUTE, first_event_ms: 100, duration_ms: 1000 } }), armed.state, { now: NOW + 20 * MINUTE });
  assert.equal(refreshed.state.at, NOW + 20 * MINUTE);
  assert.deepEqual(run('timer', { key: 'idle' }, refreshed.state, { now: NOW + 27 * MINUTE }).calls, [['events.schedule', { key: 'idle', delay_ms: 20 * MINUTE }]]);

  for (const cache of [{ read_tokens: 0, write_tokens: 0 }, { read_tokens: null, write_tokens: null }]) {
    const cold = run('model_response', response({ cache }), armed.state);
    assert.equal(cold.state.ttl, 0);
    assert.deepEqual(cold.calls, [['events.cancel', { key: 'idle' }]]);
    assert.equal(run('model_response', response({ cache }), null, { settings: { cache_ttl_minutes: '10' } }).state.ttl, 10 * MINUTE);
  }
  assert.equal(run('model_response', response({ cache: { read_tokens: 0, write_tokens: 150_000 } }), null).state.ttl, 30 * MINUTE);
  assert.equal(run('model_response', response({ provider: 'ollama' }), armed.state, { settings: { cache_ttl_minutes: '10' } }).state.ttl, 0);
});

test('reported lifetimes persist only on reads from the same provider, route, credential and model', () => {
  const written = response({ provider: 'claude', route: 'claude', credential: 'account-a', requested_model: 'sonnet', served_model: 'sonnet',
    cache: { read_tokens: 0, write_tokens: 150_000 }, usage: { input_tokens: 150_000, omd_cache_ttl_seconds: 3600 } });
  const previous = run('model_response', written, null).state;
  assert.equal(previous.ttl, 60 * MINUTE);
  const read = { ...written, cache: { read_tokens: 150_000, write_tokens: 0 }, usage: { input_tokens: 150_000 } };
  assert.equal(run('model_response', read, previous).state.ttl, 60 * MINUTE);
  for (const patch of [{ provider: 'custom' }, { route: 'other' }, { credential: 'account-b' }, { requested_model: 'opus' }, { served_model: 'opus' }, { cache: { read_tokens: 0, write_tokens: 150_000 } }]) {
    assert.equal(run('model_response', { ...read, ...patch }, previous).state.ttl, 0, JSON.stringify(patch));
  }
  assert.equal(run('model_response', response(), previous).state.ttl, 30 * MINUTE);
  assert.equal(run('model_response', written, null, { settings: { cache_ttl_minutes: '10' } }).state.ttl, 10 * MINUTE);
  for (const value of [null, 0, -1, '3600']) {
    assert.equal(run('model_response', { ...written, usage: { input_tokens: 150_000, omd_cache_ttl_seconds: value } }, null).state.ttl, 0);
  }
});

test('persistent subscription caching disarms auto compaction while explicit intervals still apply', () => {
  const apiState = run('model_response', response(), null).state;
  const subscription = response({ credential: 'chatgpt', cost: { microusd: null, basis: 'included_subscription' } });
  const skipped = run('model_response', subscription, apiState);
  assert.equal(skipped.state.ttl, 0);
  assert.deepEqual(skipped.calls, [['events.cancel', { key: 'idle' }]]);
  assert.deepEqual(run('timer', { key: 'idle' }, skipped.state, { now: NOW + 27 * MINUTE }).calls, []);
  assert.equal(run('model_response', subscription, null, { settings: { cache_ttl_minutes: '10' } }).state.ttl, 10 * MINUTE);
  const plain = response({ route: 'session', credential: null, cost: { microusd: null, basis: 'unpriced' } });
  assert.equal(run('model_response', plain, apiState).state.ttl, 0, 'plain signed-in sessions do not carry an included-subscription cost label');
  assert.equal(run('model_response', plain, null, { settings: { cache_ttl_minutes: '30' } }).state.ttl, 30 * MINUTE);
});

test('a 12-hour API estimate preserves its expiry on reads and refreshes only the 30-minute coverage', () => {
  const settings = { cache_ttl_minutes: '720' };
  const written = run('model_response', response({ cache: { read_tokens: 0, write_tokens: 150_000 } }), null, { settings });
  assert.equal(written.state.expires, NOW + 720 * MINUTE);
  assert.deepEqual(written.calls, [['events.schedule', { key: 'idle', delay_ms: 648 * MINUTE }]]);
  const readAt = (minutes, state) => run('model_response', response({ timing: { started_at_ms: NOW + minutes * MINUTE, first_event_ms: 100, duration_ms: 1000 } }), state, { settings, now: NOW + minutes * MINUTE });
  assert.equal(readAt(360, null).state.expires, NOW + 390 * MINUTE, 'an existing cache with no observed write gets only the known read refresh');
  const middle = readAt(360, written.state);
  assert.equal(middle.state.expires, NOW + 720 * MINUTE);
  const late = readAt(705, middle.state);
  assert.equal(late.state.expires, NOW + 735 * MINUTE);
  const cold = run('model_response', response({ cache: { read_tokens: 0, write_tokens: 150_000 }, timing: { started_at_ms: NOW + 800 * MINUTE, first_event_ms: 100, duration_ms: 1000 } }), late.state, { settings, now: NOW + 800 * MINUTE });
  assert.equal(cold.state.expires, NOW + 1520 * MINUTE);
});

test('small, failed, synthetic and worker responses cannot arm compaction, and manual compaction cancels it', () => {
  assert.deepEqual(run('model_response', response({ usage: { input_tokens: 1000, output_tokens: 10 } }), null).calls, [['events.cancel', { key: 'idle' }]]);
  for (const patch of [{ status: 'failed' }, { status: 'cancelled' }, { synthetic: 'fixture' }, { scope: { thread_id: 'child', agent_id: 'worker', kind: 'subagent' } }]) {
    assert.deepEqual(run('model_response', response(patch), null).calls, []);
  }
  const state = run('model_response', response(), null).state;
  const compacted = run('compaction_end', { outcome: 'compacted' }, state, { now: NOW + MINUTE });
  assert.deepEqual(compacted.calls, [['events.cancel', { key: 'idle' }]]);
  assert.equal(compacted.state.tokens, 0);
  assert.deepEqual(run('model_response', response(), compacted.state, { now: NOW + 2 * MINUTE }).calls, []);
});
const compact = ['app.request', { method: 'thread/compact/start', params: { threadId: 'lead' } }];

test('the timer compacts an idle thread or one waiting on the user, never a running tool', () => {
  const armed = run('model_response', response(), null).state;
  const fire = (state, now = NOW + 27 * MINUTE) => run('timer', { key: 'idle' }, state, { now });
  assert.deepEqual(fire(armed, NOW + 20 * MINUTE).calls, [['events.schedule', { key: 'idle', delay_ms: 7 * MINUTE }]]);
  assert.deepEqual(fire(armed).calls, [compact]);
  assert.deepEqual(fire(armed, NOW + 31 * MINUTE).calls, [], 'an expired cache is not compacted');
  const elsewhere = run('timer', { key: 'idle' }, armed, { now: NOW + 27 * MINUTE, answer: call => call.operation === 'app.request' ? new Error('client_context_changed') : {} });
  assert.deepEqual(elsewhere.calls, [compact, ['events.schedule', { key: 'idle', delay_ms: 15_000 }]], 'another thread in view retries');
  assert.equal(elsewhere.state.requested, null);
  const refused = run('timer', { key: 'idle' }, armed, { now: NOW + 27 * MINUTE, answer: call => call.operation === 'app.request' ? new Error('app_request_refused') : {} });
  assert.deepEqual(refused.calls, [compact], 'a final refusal is not retried');

  const running = run('turn_start', { turn_id: 't2' }, armed).state;
  assert.deepEqual(fire(running).calls, []);
  const foreign = run('app_server_request', { method: 'item/commandExecution/requestApproval', request_id: 9, phase: 'requested', params: { threadId: 'child' }, resolution: null }, running).state;
  assert.deepEqual(fire(foreign).calls, [], "another thread's approval does not make this running turn look idle");
  const asked = run('app_server_request', { method: 'item/tool/requestUserInput', request_id: 7, phase: 'requested', params: {}, resolution: null }, running).state;
  assert.deepEqual(fire(asked).calls, [compact]);
  const answered = run('app_server_request', { method: 'item/tool/requestUserInput', request_id: 7, phase: 'resolved', params: null, resolution: null }, asked).state;
  assert.deepEqual(fire(answered).calls, []);
  assert.deepEqual(run('turn_end', { turn_id: 't2', outcome: 'aborted' }, answered, { now: NOW + 28 * MINUTE }).calls, [['events.schedule', { key: 'idle', delay_ms: 1000 }]]);
});

