import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { callback } from '../../../tests/mod_runner.mjs';

const usageMod = {
  source: readFileSync(new URL('index.ts', import.meta.url), 'utf8'),
  capabilities: JSON.parse(readFileSync(new URL('mod.json', import.meta.url), 'utf8')).capabilities,
};
const NOW = 1_800_000_000_000;

function call({ source, capabilities }, input, answer = () => ({ delivered: 1, dropped: 0 })) {
  const calls = [];
  const output = callback({ source, filename: 'index.ts', api: '1.0.0', capabilities, settings: {}, state: null, virtual_time_ms: NOW, ...input }, hostCall => {
    calls.push(hostCall);
    const value = answer(hostCall);
    if (value instanceof Error) throw value;
    return value;
  });
  assert.equal(output.error, undefined, output.error);
  return { ...output, calls };
}

const hud = { categories: true };
const response = (id, patch = {}) => ({
  request_id: id, attempt: 1, ledger_request: Number(id.replace(/\D/g, '')) || null, scope: { thread_id: 'lead', agent_id: null, kind: 'main' },
  route: 'session', provider: 'openai', credential: 'chatgpt', requested_model: 'gpt-6.1-sol', served_model: 'gpt-6.1-sol', status: 'completed', stop_reason: 'end_turn',
  output: { text: '', tool_calls: [] }, usage: { input_tokens: 10_000, input_tokens_details: { cached_tokens: 8_000 }, output_tokens: 500 },
  cache: { read_tokens: 8_000, write_tokens: null }, cost: { microusd: 0, basis: 'included_subscription' }, context_window: 272_000,
  timing: { started_at_ms: NOW - 60_000, first_event_ms: 200, duration_ms: 1_000 }, synthetic: null, error: null, ...patch,
});
const feed = (state, events, settings = hud) => events.reduce((current, [event, payload, extra = {}]) => call(usageMod, { event, payload, state: current, settings, ...extra }).state, state);
const dialog = (state, settings = hud, now = NOW) => {
  const opened = { ...state, open: true };
  const view = call(usageMod, { event: 'terminal', payload: { event: 'idle', ledger: { thread_id: 'lead', cwd: '/repo', cost: null } }, state: opened, settings, virtual_time_ms: now }).value;
  return { view, text: view.sites.dialog.components[0].children.map(child => child.text ?? '').join('\n') };
};
const start = (session = { thread_id: 'lead', model: 'gpt-6.1-sol', provider: 'openai' }, limits = null) => call(usageMod, { event: 'start', payload: {}, settings: hud }, ({ operation, arguments: args }) =>
  operation === 'session.info' ? { root: '/repo', cwd: '/repo', codex_version: '0.162.0', route: null, turns_started: 0, ...session }
    : operation === 'app.request' && args.method === 'config/read' ? { config: { model_context_window: 272_000, model_auto_compact_token_limit: 240_000 } }
      : operation === 'app.request' ? (limits ? { rateLimits: limits } : new Error('unavailable')) : { delivered: 1, dropped: 0 }).state;

test('costs follow the ledger basis: an unpriced native response stays unknown', () => {
  assert.match(dialog(feed(start(), [['model_response', response('i1')]])).text, /1 included/);
  assert.match(dialog(feed(start(), [['model_response', response('u1', { credential: null, cost: { microusd: null, basis: 'unpriced' } })]])).text, /unknown cost/);
});

test('usage ledger is request-idempotent, keeps lead context apart from workers and orders by observation time', () => {
  let state = start();
  state = feed(state, [
    ['model_response', response('r2', { timing: { started_at_ms: NOW - 30_000, first_event_ms: 1, duration_ms: 1_000 }, usage: { input_tokens: 20_000, input_tokens_details: { cached_tokens: 18_000 }, output_tokens: 700 } })],
    ['model_response', response('r1')],
    ['model_response', response('r1')],
    ['model_response', response('w1', { scope: { thread_id: 'child', agent_id: 'agent-1', kind: 'subagent' }, usage: { input_tokens: 90_000, input_tokens_details: { cached_tokens: 0 }, output_tokens: 10 } })],
    ['model_response', response('p1', { scope: { thread_id: 'parent', agent_id: null, kind: 'main' } })],
  ]);
  assert.equal(state.hud.entries.length, 4);
  assert.deepEqual(state.hud.entries.map(entry => entry.request), ['r1', 'w1', 'p1', 'r2']);
  const { text } = dialog(state);
  assert.match(text, /input 20k \+ output 700 of 272k/);
  assert.match(text, /headroom 219k/);
  assert.match(text, /Workers: 1 .*90k tokens/);
  assert.match(text, /Lead input 30k · cache read 26k/);

  state = feed(state, [['model_response', response('s1', { cost: { microusd: null, basis: 'unsettled' }, route: 'api', credential: 'key' })]]);
  state = feed(state, [['model_response', response('s1', { cost: { microusd: 1_500, basis: 'settled' }, route: 'api', credential: 'key' })],
    ['model_response', response('s1', { usage: null, cost: { microusd: null, basis: 'unsettled' }, route: 'api', credential: 'key' })]]);
  const settled = state.hud.entries.find(entry => entry.request === 's1');
  assert.deepEqual([settled.cost.basis, settled.revision, settled.tokens.input], ['settled', 1, 10_000]);

  for (let index = 0; index < 125; index++) state.hud.entries.push({ ...settled, key: `x${index}#1`, request: `x${index}`, at: NOW - 3_600_000 + index });
  state = feed(state, [['model_response', response('r3')]]);
  assert.ok(JSON.stringify(state).length <= 65_536, 'saved state must fit the 64 KiB store limit');
  assert.ok(state.hud.entries.length < 120);
  assert.equal(state.hud.entries.length + state.hud.dropped, 131);
});

test('quota windows stay with the account that reported them and only Codex sets credits', () => {
  const update = (state, rateLimits) => call(usageMod, { event: 'app_notification', payload: { method: 'account/rateLimits/updated', params: { rateLimits }, thread_id: null, coalesced: 0, dropped: 0 }, state, settings: hud }).state;
  const window = (used, windowDurationMins) => ({ usedPercent: used, windowDurationMins, resetsAt: NOW / 1000 + 3600 });
  let state = start();
  state = update(state, { limitId: 'codex', primary: window(20, 300), credits: { hasCredits: true, balance: '5' } });
  state = update(state, { limitId: 'claude', primary: window(70, 300), credits: { unlimited: true } });
  state = update(state, { limitId: 'cursor', primary: window(40, 43200) });
  const { text } = dialog(state);
  assert.match(text, /Claude account 5h: 70% used/);
  assert.match(text, /Codex account 5h: 20% used/);
  assert.match(text, /Cursor account 30d: 40% used/);
  assert.match(text, /Codex account Extra-usage credits: balance 5/);
  assert.doesNotMatch(text, /unlimited/);
  const handled = [...usageMod.source.matchAll(/method === '([^']+)'/g)].map(match => match[1]);
  const { subscriptions } = JSON.parse(readFileSync(new URL('mod.json', import.meta.url), 'utf8'));
  assert.deepEqual(handled.filter(method => !subscriptions.app.includes(method)), []);
  const sample = (used, at) => ({ scope: 'codex', minutes: 300, used, resets: NOW + 3_600_000, at, seen: at });
  state.hud.samples = [sample(90, NOW - 3_600_000), sample(30, NOW)];
  assert.match(dialog(state).text, /projection ~0% at reset/);
});

const billed = (id, usd, patch = {}) => response(id, { cost: { microusd: null, basis: 'unpriced' }, usage: { input_tokens: 10_000, output_tokens: 500, omd_reported_cost: { usd, basis: 'provider_billed' } }, ...patch });
const notices = calls => calls.filter(item => item.operation === 'terminal.notice').map(item => item.arguments);

test('the budget counts spend that left the rolling window or settled late, warns once per 80% and 100% crossing, and retries a refused notice', () => {
  const settings = { ...hud, budget_usd: 10 };
  const run = (state, id, usd, at) => {
    const out = call(usageMod, { event: 'model_response', payload: billed(id, usd, { timing: { started_at_ms: at, first_event_ms: 1, duration_ms: 1 } }), state, settings });
    return { state: out.state, notes: notices(out.calls) };
  };
  let step = run(start(), 'b1', 8.5, NOW - 60_000);
  assert.equal(step.notes.length, 1);
  assert.equal(step.state.hud.alerted.level, 80);
  step = run(step.state, 'b2', 0.1, NOW - 50_000);
  assert.deepEqual(step.notes, []);

  for (let index = 0; index < 125; index++) step.state.hud.entries.push({ ...step.state.hud.entries[0], key: `x${index}#1`, request: `x${index}`, reported: null, cost: { microusd: 0, basis: 'included_subscription' }, at: NOW - 40_000 + index });
  step = run(step.state, 'b3', 2.0, NOW - 1_000);
  assert.ok(step.state.hud.dropped > 0);
  assert.equal(step.notes.length, 1);
  assert.equal(step.state.hud.alerted.level, 100);
  assert.match(dialog(step.state, settings).text, /\$10\.6 spent/);
  assert.deepEqual(run(step.state, 'b4', 0.5, NOW).notes, []);
  assert.equal(run(step.state, 'b1', 8.5, NOW - 60_000).state.hud.shed, step.state.hud.shed);

  const refuse = hostCall => hostCall.operation === 'terminal.notice' ? new Error('ui_unavailable') : { delivered: 1, dropped: 0 };
  const refused = call(usageMod, { event: 'model_response', payload: billed('n1', 9), state: start(), settings }, refuse);
  assert.equal(refused.state.hud.alerted, null);
  const retried = call(usageMod, { event: 'model_response', payload: billed('n2', 0.1), state: refused.state, settings });
  assert.equal(notices(retried.calls).length, 1);
  assert.equal(retried.state.hud.alerted.level, 80);

  const pending = response('p7', { ledger_request: 7, cost: { microusd: null, basis: 'unsettled' }, route: 'api', credential: 'key', timing: { started_at_ms: NOW - 90_000, first_event_ms: 1, duration_ms: 1 } });
  const state = call(usageMod, { event: 'model_response', payload: pending, state: start(), settings }).state;
  for (let index = 0; index < 125; index++) state.hud.entries.push({ ...state.hud.entries[0], key: `x${index}#1`, request: `x${index}`, billing: null, cost: { microusd: 0, basis: 'included_subscription' }, at: NOW - 40_000 + index });
  const dropped = call(usageMod, { event: 'model_response', payload: response('r9'), state, settings }).state;
  assert.deepEqual(dropped.hud.owed.map(([id]) => id), [7]);
  const again = call(usageMod, { event: 'model_response', payload: pending, state: dropped, settings }).state;
  assert.deepEqual(again.hud.owed.map(([id]) => id), [7]);
  const settle = hostCall => hostCall.operation === 'task.status'
    ? { ledger: { thread_id: 'lead', cost: { attempts: [{ request: 7, settled_microusd: 9_000_000 }] } }, limits: {}, worker_limits: {} } : { delivered: 1, dropped: 0 };
  const settled = call(usageMod, { event: 'turn_end', payload: { turn_id: 't1' }, state: again, settings }, settle);
  assert.deepEqual([settled.state.hud.owed, settled.state.hud.shed], [[], 9]);
  assert.equal(notices(settled.calls).length, 1);
  assert.equal(call(usageMod, { event: 'model_response', payload: { ...pending, cost: { microusd: 9_000_000, basis: 'settled' } }, state: settled.state, settings }).state.hud.shed, 9);
  const budget = value => call(usageMod, { event: 'command', name: 'budget', payload: value, state: null, settings: {} }).calls.map(item => item.operation);
  assert.deepEqual([budget('Infinity'), budget('5')], [[], ['settings.write']]);
});
