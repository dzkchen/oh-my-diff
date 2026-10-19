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
  const published = [];
  const output = callback({ source, filename: 'index.ts', api: '1.0.0', capabilities, settings: {}, state: null, virtual_time_ms: NOW, ...input }, hostCall => {
    if (hostCall.operation === 'events.publish') published.push(hostCall.arguments);
    const value = answer(hostCall);
    if (value instanceof Error) throw value;
    return value;
  });
  assert.equal(output.error, undefined, output.error);
  return { ...output, published };
}

const hud = { categories: true };
const response = (id, patch = {}) => ({
  request_id: id, attempt: 1, ledger_request: Number(id.replace(/\D/g, '')) || null, scope: { thread_id: 'lead', agent_id: null, kind: 'main' },
  route: 'codex', provider: 'openai', credential: 'chatgpt', requested_model: 'gpt-6.1-sol', served_model: 'gpt-6.1-sol', status: 'completed', stop_reason: 'end_turn',
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
  assert.match(text, /Last response: input 20k \+ output 700 of 272k \(8%\)/);
  assert.match(text, /Auto-compact at 240k · reserve 32k · headroom 219k/);
  assert.match(text, /Inherited from the parent session: 1 requests/);
  assert.match(text, /Workers: 1 included · 90k tokens/);
  assert.match(text, /Lead input 30k · cache read 26k \(87% of input\) · cache write not reported/);
  assert.match(text, /Cache expiry: unavailable for openai; reuse is never guaranteed/);
  assert.match(text, /totals are not lifetime spend/);

  state = feed(state, [['model_response', response('s1', { cost: { microusd: null, basis: 'unsettled' }, route: 'api', credential: 'key' })]]);
  assert.match(dialog(state).text, /1 unsettled/);
  state = feed(state, [['model_response', response('s1', { cost: { microusd: 1_500, basis: 'settled' }, route: 'api', credential: 'key' })],
    ['model_response', response('s1', { usage: null, cost: { microusd: null, basis: 'unsettled' }, route: 'api', credential: 'key' })]]);
  const settled = state.hud.entries.find(entry => entry.request === 's1');
  assert.deepEqual([settled.cost.basis, settled.revision, settled.tokens.input], ['settled', 1, 10_000]);

  for (let index = 0; index < 125; index++) state.hud.entries.push({ ...settled, key: `x${index}#1`, request: `x${index}`, at: NOW - 3_600_000 + index });
  state = feed(state, [['model_response', response('r3')]]);
  assert.ok(JSON.stringify(state).length <= 65_536, 'saved state must fit the 64 KiB store limit');
  assert.ok(state.hud.entries.length < 120);
  assert.equal(state.hud.entries.length + state.hud.dropped, 131);
  assert.match(dialog(state).text, new RegExp(`${state.hud.dropped} older dropped \\(not in these totals\\)`));
});

