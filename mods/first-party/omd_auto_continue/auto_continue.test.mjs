import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { callback } from '../../../tests/mod_runner.mjs';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('./mod.json', import.meta.url), 'utf8'));
const NOW = 1_800_000_000_000;

function run(event, payload, state, { settings = {}, now = NOW, answer = () => ({}) } = {}) {
  const calls = [];
  const output = callback({ source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, settings, state, event, payload,
    virtual_time_ms: now, hook_budget_ms: 2000 }, call => {
    calls.push([call.operation, call.arguments]);
    const value = answer(call);
    if (value instanceof Error) throw value;
    return call.operation === 'events.schedule' ? call.arguments : value;
  });
  assert.equal(output.error, undefined, output.error);
  return { state: output.state, calls };
}

const request = (method, request_id, params = {}) => ({ method, request_id, phase: 'requested', params, resolution: null });
const hop = data => ({ publisher: 'omd_auto_continue', channel: 'omd_auto_continue/request', data, correlation: null, sequence: 1, dropped: 0 });

test('a request hops to the channel, arms the deadline and is answered without authority when it expires', () => {
  const tui = run('app_server_request', request('item/tool/requestUserInput', 7, { questions: [{ id: 'scope' }, { id: 'name' }] }), null);
  const published = tui.calls.find(([operation]) => operation === 'events.publish')[1];
  assert.deepEqual(published, { channel: 'request', data: { request_id: 7, phase: 'requested', kind: 'question', questions: ['scope', 'name'] } });
  assert.equal(tui.calls.find(([operation]) => operation === 'terminal.notice')[1].placement, 'toast');

  let state = run('channel', hop(published.data), null).state;
  state = run('channel', hop({ request_id: 'a', phase: 'requested', kind: 'approval', questions: [] }), state, { now: NOW + 30_000 }).state;
  assert.deepEqual(run('channel', hop({ request_id: 'b', phase: 'requested', kind: 'approval', questions: [] }), state, { now: NOW + 60_000 }).calls,
    [['events.schedule', { key: 'deadline', delay_ms: 60_000 }]]);

  const fired = run('timer', { key: 'deadline' }, state, { now: NOW + 120_000 });
  const answers = fired.calls.filter(([operation]) => operation === 'app.respond').map(([, args]) => args);
  const ANSWER = { answers: ['No answer within the time limit (the user may be away). Proceed with your best judgment, preferring the recommended option, and state the assumption you made.'] };
  assert.deepEqual(answers, [{ request_id: 7, result: { answers: { scope: ANSWER, name: ANSWER } } }]);
  assert.deepEqual(fired.calls.at(-1), ['events.schedule', { key: 'deadline', delay_ms: 30_000 }]);
  const notice = fired.calls.find(([operation]) => operation === 'terminal.notice')[1];
  assert.equal(notice.audience, 'model');
  assert.match(notice.text, /^No answer within 120 s \(the user may be away\), so the question was answered/);

  const later = run('timer', { key: 'deadline' }, fired.state, { now: NOW + 150_000 });
  assert.deepEqual(later.calls.find(([operation]) => operation === 'app.respond')[1], { request_id: 'a', result: { decision: 'decline' } });
});

test('answered, already-resolved and disabled requests are left alone', () => {
  let state = run('channel', hop({ request_id: 1, phase: 'requested', kind: 'permission', questions: [] }), null).state;
  assert.deepEqual(run('channel', hop({ request_id: 1, phase: 'resolved', kind: 'permission', questions: [] }), state).calls, [['events.cancel', { key: 'deadline' }]]);
  const raced = run('timer', { key: 'deadline' }, state, { now: NOW + 120_000, answer: call => call.operation === 'app.respond' ? new Error('app_request_not_pending') : {} });
  assert.deepEqual(raced.calls.map(([operation]) => operation), ['app.respond', 'events.cancel']);
  assert.deepEqual(raced.state.pending, {});
  assert.deepEqual(run('app_server_request', request('item/fileChange/requestApproval', 2), null, { settings: { timeout_seconds: 0 } }).calls, []);
  const viewing = run('timer', { key: 'deadline' }, state, { now: NOW + 120_000, answer: call => call.operation === 'app.respond' ? new Error('client_surface_context_changed') : {} });
  assert.equal(viewing.state.pending['1'].deadline, NOW + 130_000, 'another thread in view retries instead of dropping the request');
  assert.deepEqual(viewing.calls.at(-1), ['events.schedule', { key: 'deadline', delay_ms: 10_000 }]);
  const late = run('timer', { key: 'deadline' }, state, { now: NOW + 3_600_000 });
  assert.deepEqual(late.calls[0], ['app.respond', { request_id: 1, result: { permissions: {} } }], 'a timer delayed by sleep still answers');
  assert.deepEqual(run('resume', { thread_id: 't', last_turn: null, restarted: false }, state).calls, []);
  for (const [event, payload] of [['resume', { thread_id: 't', last_turn: null, restarted: true }], ['start', {}]]) {
    const reset = run(event, payload, state);
    assert.deepEqual(reset.state.pending, {}, `${event} drops entries from an earlier session or the forked parent`);
    assert.deepEqual(reset.calls, [['events.cancel', { key: 'deadline' }]]);
  }
  const elicitation = run('channel', hop({ request_id: 3, phase: 'requested', kind: 'elicitation', questions: [] }), null).state;
  assert.deepEqual(run('timer', { key: 'deadline' }, elicitation, { now: NOW + 120_000 }).calls[0], ['app.respond', { request_id: 3, result: { action: 'decline' } }]);
});
