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
    if (call.operation === 'session.info') return { thread_id: 'lead' };
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
  assert.deepEqual(published, { channel: 'request', data: { request_id: 7, phase: 'requested', kind: 'question', questions: ['scope', 'name'], deadline: NOW + 120_000 } });
  assert.equal(tui.calls.find(([operation]) => operation === 'terminal.notice')[1].placement, 'toast');

  let state = run('channel', hop(published.data), null).state;
  state = run('channel', hop({ request_id: 'a', phase: 'requested', kind: 'approval', questions: [], deadline: NOW + 150_000 }), state, { now: NOW + 30_000 }).state;
  assert.deepEqual(run('channel', hop({ request_id: 'b', phase: 'requested', kind: 'approval', questions: [], deadline: NOW + 180_000 }), state, { now: NOW + 60_000 }).calls,
    [['events.schedule', { key: 'deadline', delay_ms: 60_000 }]]);

  const fired = run('timer', { key: 'deadline' }, state, { now: NOW + 120_000 });
  const answers = fired.calls.filter(([operation]) => operation === 'app.respond').map(([, args]) => args);
  const ANSWER = { answers: ['No answer within the time limit (the user may be away). Continue with already-authorized work that does not depend on this answer. For optional choices, use your best judgment, preferring the recommended option, and state the assumption. This timeout is not consent for permissions, spending or a required decision.'] };
  assert.deepEqual(answers, [{ request_id: 7, result: { answers: { scope: ANSWER, name: ANSWER } } }]);
  assert.deepEqual(fired.calls.at(-1), ['events.schedule', { key: 'deadline', delay_ms: 30_000 }]);
  const notice = fired.calls.find(([operation]) => operation === 'terminal.notice')[1];
  assert.equal(notice.audience, 'user');
  assert.match(notice.text, /^No answer within 120 s \(the user may be away\), so the question was answered/);

  const later = run('timer', { key: 'deadline' }, fired.state, { now: NOW + 150_000 });
  assert.deepEqual(later.calls.find(([operation]) => operation === 'app.respond')[1], { request_id: 'a', result: { decision: 'decline' } });
});

test('delivery delays and duplicate notifications preserve the original deadline and human answers win', () => {
  const data = run('app_server_request', request('item/tool/requestUserInput', 7, { threadId: 'lead', questions: [{ id: 'scope' }] }), null)
    .calls.find(([operation]) => operation === 'events.publish')[1].data;
  const delayed = run('channel', hop(data), null, { now: NOW + 90_000 });
  assert.deepEqual(delayed.calls, [['events.schedule', { key: 'deadline', delay_ms: 30_000 }]]);
  const duplicate = run('channel', hop({ ...data, deadline: NOW + 210_000 }), delayed.state, { now: NOW + 100_000 });
  assert.deepEqual(duplicate.calls, [['events.schedule', { key: 'deadline', delay_ms: 20_000 }]]);
  assert.equal(run('timer', { key: 'deadline' }, duplicate.state, { now: NOW + 120_000 }).calls.filter(([operation]) => operation === 'app.respond').length, 1);
  const resolved = run('channel', hop({ ...data, phase: 'resolved' }), duplicate.state).state;
  assert.deepEqual(run('timer', { key: 'deadline' }, resolved, { now: NOW + 120_000 }).calls, [['events.cancel', { key: 'deadline' }]]);
  assert.deepEqual(run('app_server_request', request('item/tool/requestUserInput', 8, { threadId: 'child', questions: [] }), null).calls, []);
});

test('timeouts deny authority, retry only transient refusals and clear stale or disabled requests', () => {
  const pending = {};
  for (const [kind, expected] of [['approval', { decision: 'decline' }], ['permission', { permissions: {} }], ['elicitation', { action: 'decline' }]]) {
    pending[kind] = { request_id: kind, kind, questions: [], deadline: NOW };
    const fired = run('timer', { key: 'deadline' }, { pending: { [kind]: pending[kind] } });
    assert.deepEqual(fired.calls.find(([operation]) => operation === 'app.respond')[1].result, expected);
  }
  const retry = run('timer', { key: 'deadline' }, { pending }, { answer: call => call.operation === 'app.respond' ? new Error('client_context_changed') : {} });
  assert.equal(Object.values(retry.state.pending).every(item => item.deadline === NOW + 10_000), true);
  const gone = run('timer', { key: 'deadline' }, retry.state, { now: NOW + 10_000, answer: call => call.operation === 'app.respond' ? new Error('app_request_not_pending') : {} });
  assert.deepEqual(gone.state.pending, {});
  assert.equal(gone.calls.some(([operation]) => operation === 'terminal.notice'), false);
  for (const [event, payload, settings] of [['start', {}, {}], ['resume', { restarted: true }, {}], ['timer', { key: 'deadline' }, { timeout_seconds: 0 }]]) {
    const reset = run(event, payload, retry.state, { settings });
    assert.deepEqual(reset.state.pending, {});
    assert.deepEqual(reset.calls, [['events.cancel', { key: 'deadline' }]]);
  }
});

