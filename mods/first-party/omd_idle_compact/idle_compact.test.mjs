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
    if (call.operation === 'session.info') return { thread_id: 'lead', root: '/repo', cwd: '/repo', codex_version: '0.163.0', model: 'gpt-6.1-sol', provider: 'openai', route: null, turns_started: 1 };
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
  request_id: 'r1', attempt: 1, ledger_request: 1, scope: { thread_id: 'lead', agent_id: null, kind: 'main' }, route: 'codex', provider: 'openai', credential: 'chatgpt',
  requested_model: 'gpt-6.1-sol', served_model: 'gpt-6.1-sol', status: 'completed', stop_reason: 'end_turn', output: { text: '', tool_calls: [] },
  usage: { input_tokens: 150_000, input_tokens_details: { cached_tokens: 140_000 }, output_tokens: 2_000 }, cache: { read_tokens: 140_000, write_tokens: null },
  cost: { microusd: 0, basis: 'included_subscription' }, context_window: 272_000, timing: { started_at_ms: NOW, first_event_ms: 300, duration_ms: 2_000 },
  synthetic: null, error: null, ...patch,
});
const compact = ['app.request', { method: 'thread/compact/start', params: { threadId: 'lead' } }];

test('a large main response arms the timer at 90% of the model, provider-reported or configured cache TTL', () => {
  assert.deepEqual(run('model_response', response(), null).calls, [['events.schedule', { key: 'idle', delay_ms: 27 * MINUTE }]]);
  const claude = response({ provider: 'omd_claude_cli', usage: { input_tokens: 150_000, output_tokens: 10, omd_cache_ttl_seconds: 3600 } });
  assert.deepEqual(run('model_response', claude, null).calls, [['events.schedule', { key: 'idle', delay_ms: 54 * MINUTE }]]);
  const written = run('model_response', claude, null).state;
  const read = response({ provider: 'omd_claude_cli', usage: { input_tokens: 150_000, output_tokens: 10 } });
  assert.deepEqual(run('model_response', read, written).calls, [['events.schedule', { key: 'idle', delay_ms: 54 * MINUTE }]]);
  assert.deepEqual(run('model_response', claude, null, { settings: { cache_ttl_minutes: 10 } }).calls, [['events.schedule', { key: 'idle', delay_ms: 9 * MINUTE }]]);
  assert.deepEqual(run('model_response', response(), null, { settings: { cache_ttl_minutes: 3000 } }).calls, [['events.schedule', { key: 'idle', delay_ms: 24 * 60 * MINUTE }]]);
  for (const patch of [{ provider: 'ollama' }, { usage: { input_tokens: 20_000, output_tokens: 100 } }]) {
    assert.deepEqual(run('model_response', response(patch), null).calls, [['events.cancel', { key: 'idle' }]]);
  }
  assert.deepEqual(run('model_response', response({ provider: 'ollama' }), null, { settings: { cache_ttl_minutes: 10 } }).calls, [['events.cancel', { key: 'idle' }]],
    'a configured TTL does not compact a local provider');
  for (const patch of [{ scope: { thread_id: 'child', agent_id: 'a1', kind: 'subagent' } }, { status: 'failed' }]) assert.deepEqual(run('model_response', response(patch), null).calls, []);
});

test('the timer compacts an idle thread or one waiting on the user, never a running tool', () => {
  const armed = run('model_response', response(), null).state;
  const fire = (state, now = NOW + 27 * MINUTE) => run('timer', { key: 'idle' }, state, { now });
  assert.deepEqual(fire(armed, NOW + 20 * MINUTE).calls, [['events.schedule', { key: 'idle', delay_ms: 7 * MINUTE }]]);
  assert.deepEqual(fire(armed).calls, [compact]);
  assert.equal(fire(armed).state.requested, 'idle');
  assert.deepEqual(fire(armed, NOW + 31 * MINUTE).calls, [], 'an expired cache is not compacted');
  for (const error of ['client_context_changed', 'client_surface_context_changed']) {
    const elsewhere = run('timer', { key: 'idle' }, armed, { now: NOW + 27 * MINUTE, answer: call => call.operation === 'app.request' ? new Error(error) : {} });
    assert.deepEqual(elsewhere.calls, [compact, ['events.schedule', { key: 'idle', delay_ms: 15_000 }]], 'another thread in view retries');
    assert.equal(elsewhere.state.requested, null);
  }
  const refused = run('timer', { key: 'idle' }, armed, { now: NOW + 27 * MINUTE, answer: call => call.operation === 'app.request' ? new Error('app_request_refused') : {} });
  assert.deepEqual(refused.calls, [compact], 'a final refusal is not retried');

  const running = run('turn_start', { turn_id: 't2' }, armed).state;
  assert.deepEqual(fire(running).calls, []);
  const foreign = run('app_server_request', { method: 'item/commandExecution/requestApproval', request_id: 9, phase: 'requested', params: { threadId: 'child' }, resolution: null }, running).state;
  assert.deepEqual(fire(foreign).calls, [], "another thread's approval does not make this running turn look idle");
  const asked = run('app_server_request', { method: 'item/tool/requestUserInput', request_id: 7, phase: 'requested', params: {}, resolution: null }, running).state;
  assert.deepEqual(fire(asked).calls, [compact]);
  assert.equal(fire(asked).state.requested, 'question');
  const answered = run('app_server_request', { method: 'item/tool/requestUserInput', request_id: 7, phase: 'resolved', params: null, resolution: null }, asked).state;
  assert.deepEqual(fire(answered).calls, []);
  assert.deepEqual(run('turn_end', { turn_id: 't2', outcome: 'aborted' }, answered, { now: NOW + 28 * MINUTE }).calls, [['events.schedule', { key: 'idle', delay_ms: 1000 }]]);
  assert.deepEqual(run('turn_end', { turn_id: 't2', outcome: 'aborted' }, answered, { now: NOW + 31 * MINUTE }).calls, []);
});

test('a finished compaction posts the notice, disarms and ignores the compaction request itself', () => {
  const armed = run('model_response', response(), null).state;
  const approval = run('app_server_request', { method: 'item/commandExecution/requestApproval', request_id: 'x', phase: 'requested', params: {}, resolution: null },
    run('turn_start', { turn_id: 't2' }, armed).state).state;
  const requested = run('timer', { key: 'idle' }, approval, { now: NOW + 27 * MINUTE }).state;
  const done = run('compaction_end', { turn_id: 't3', trigger: 'manual', outcome: 'compacted', by: null, provider_call: true }, requested, { now: NOW + 28 * MINUTE });
  assert.deepEqual(done.calls, [['events.cancel', { key: 'idle' }],
    ['terminal.notice', { text: 'Compacted while idle, before the prompt cache expired. The pending approval was cancelled.', kind: 'info', placement: 'transcript' }]]);
  const summarizing = response({ timing: { started_at_ms: NOW + 27 * MINUTE, first_event_ms: 300, duration_ms: 30_000 } });
  assert.deepEqual(run('model_response', summarizing, done.state).calls, []);
  const manual = run('compaction_end', { turn_id: 't4', trigger: 'manual', outcome: 'compacted', by: null, provider_call: true }, done.state);
  assert.deepEqual(manual.calls, [['events.cancel', { key: 'idle' }]]);
});
