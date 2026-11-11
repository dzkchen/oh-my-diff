import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { callback } from '../../../tests/mod_runner.mjs';

const usageMod = {
  source: readFileSync(new URL('index.ts', import.meta.url), 'utf8'),
  capabilities: JSON.parse(readFileSync(new URL('mod.json', import.meta.url), 'utf8')).capabilities,
  assets: { 'cache_ttl.ts': { text: readFileSync(new URL('cache_ttl.ts', import.meta.url), 'utf8'), sha256: '0'.repeat(64) } },
};
const NOW = 1_800_000_000_000;

function call({ source, capabilities, assets }, input, answer = () => ({ delivered: 1, dropped: 0 })) {
  const calls = [];
  const output = callback({ source, filename: 'index.ts', entrypoint: 'index.ts', assets, api: '1.0.0', capabilities, settings: {}, state: null, virtual_time_ms: NOW, ...input }, hostCall => {
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
  assert.match(dialog(feed(start(), [['model_response', response('i1')]])).text, /1 request included/);
  assert.match(dialog(feed(start(), [['model_response', response('u1', { credential: null, cost: { microusd: null, basis: 'unpriced' } })]])).text, /1 request, cost unknown/);
});

test('the dialog uses plain labels, shows its keys and leaves out rows with nothing to show', () => {
  const { text } = dialog(feed(start(), [['model_response', response('i1')]]));
  assert.match(text, /Esc or Alt\+a closes/);
  assert.match(text, /This conversation: 1 request included/);
  assert.doesNotMatch(text, /Lead|Host ledger|ledger|none|unavailable|unknown|No tools|No plan|Workers/);
  const opened = { ...feed(start(), [['model_response', response('i1')]]), open: true };
  const paid = cost => call(usageMod, { event: 'terminal', payload: { event: 'idle', ledger: { thread_id: 'lead', cwd: '/repo', cost } }, state: opened }).value.sites.dialog.components[0].children.map(child => child.text ?? '').join('\n');
  assert.match(paid({ settled_task_charge_microusd: 1_250_000 }), /Paid API use: \$1\.25/);
  assert.doesNotMatch(paid({ settled_task_charge_microusd: 0 }), /Paid API/);
});

test('cache expiry says whether the lifetime is the provider\'s or an estimate', () => {
  const api = response('a1', { credential: 'key', cost: { microusd: 100, basis: 'settled' } });
  assert.match(dialog(feed(start(), [['model_response', api]])).text, /Cache expiry: ~29m left \(estimated TTL/);
  const reported = response('c1', { provider: 'claude', credential: 'profile', cost: { microusd: 100, basis: 'settled' }, usage: { ...api.usage, omd_cache_ttl_seconds: 3600 } });
  assert.match(dialog(feed(start({ thread_id: 'lead', model: 'gpt-6.1-sol', provider: 'claude' }), [['model_response', reported]])).text, /Cache expiry: ~59m left \(provider TTL/);
  assert.doesNotMatch(dialog(feed(start(), [['model_response', response('i1')]])).text, /Cache expiry/);
});

test('cache expiry replays reported lifetimes in request order without crossing cache identities', () => {
  const api = (id, minutes, patch = {}) => response(id, { credential: 'key', cost: { microusd: 100, basis: 'settled' },
    timing: { started_at_ms: NOW - minutes * 60_000, first_event_ms: 1, duration_ms: 1000 }, ...patch });
  const reported = api('r1', 2, { usage: { input_tokens: 10_000, output_tokens: 500, omd_cache_ttl_seconds: 3600 } });
  const read = api('r2', 1);
  const partial = feed(start(), [['model_response', reported]]);
  for (const entry of partial.hud.entries) { delete entry.cache; delete entry.started; }
  assert.doesNotMatch(dialog(partial).text, /Cache expiry/);
  assert.match(dialog(feed(partial, [['model_response', read]])).text, /Cache expiry: ~29m left \(estimated TTL/);
  for (const observations of [[reported, read], [read, reported], [read, reported, read]]) {
    const state = feed(start(), observations.map(item => ['model_response', item]));
    assert.match(dialog(state).text, /Cache expiry: ~59m left \(provider TTL/);
  }
  for (const patch of [{ route: 'other' }, { credential: 'other' }, { requested_model: 'other' }, { served_model: 'other' }]) {
    const state = feed(start(), [['model_response', reported], ['model_response', { ...read, ...patch }]]);
    assert.match(dialog(state).text, /Cache expiry: ~29m left \(estimated TTL/);
  }
  assert.doesNotMatch(dialog(feed(start(), [['model_response', reported], ['model_response', { ...read, provider: 'other' }]])).text, /Cache expiry/);
  const unmeasured = { ...read, usage: { input_tokens: 10_000, output_tokens: 500 } };
  assert.match(dialog(feed(start(), [['model_response', reported], ['model_response', unmeasured]])).text, /Cache expiry: ~59m left \(provider TTL/,
    'response.cache supplies cache activity independently of normalized token usage');
  const corrected = { ...reported, usage: { ...reported.usage, omd_cache_ttl_seconds: 7200 } };
  assert.match(dialog(feed(start(), [['model_response', reported], ['model_response', read], ['model_response', corrected]])).text, /Cache expiry: ~1h59m left \(provider TTL/);
  const worker = { ...corrected, request_id: 'w3', scope: { thread_id: 'child', agent_id: 'worker', kind: 'subagent' },
    timing: { ...read.timing, started_at_ms: NOW - 30_000 } };
  assert.match(dialog(feed(start(), [['model_response', reported], ['model_response', read], ['model_response', worker]])).text, /Cache expiry: ~59m left \(provider TTL/);
  const slow = { ...read, timing: { ...read.timing, started_at_ms: NOW - 2 * 60_000, duration_ms: 90_000 } };
  assert.match(dialog(feed(start(), [['model_response', { ...reported, timing: { ...reported.timing, started_at_ms: NOW - 10 * 60_000 } }], ['model_response', slow]])).text,
    /Cache expiry: ~58m left \(provider TTL/, 'cache use is timed from request start, independently of response duration');
});

test('OpenAI long-cache reads preserve the write deadline and extend an expired deadline only thirty minutes', () => {
  const api = (id, minutes, reported, cache) => response(id, { credential: 'key', cost: { microusd: 100, basis: 'settled' },
    usage: { input_tokens: 10_000, input_tokens_details: { cached_tokens: cache.read_tokens }, output_tokens: 500, ...reported ? { omd_cache_ttl_seconds: 43200 } : {} }, cache,
    timing: { started_at_ms: NOW - minutes * 60_000, first_event_ms: 1, duration_ms: 1000 } });
  const write = api('w1', 60, true, { read_tokens: 0, write_tokens: 10_000 });
  for (const reported of [false, true]) {
    const read = api('r2', 1, reported, { read_tokens: 8000, write_tokens: 0 });
    for (const observations of [[write, read], [read, write], [write, read, write]]) {
      const state = feed(start(), observations.map(item => ['model_response', item]));
      assert.match(dialog(state).text, /Cache expiry: ~11h00m left \(provider TTL/);
      assert.match(dialog(state, hud, NOW + 11 * 3_600_000 + 1).text, /Cache expiry: TTL passed/);
    }
    const old = { ...write, timing: { ...write.timing, started_at_ms: NOW - 13 * 3_600_000 } };
    assert.match(dialog(feed(start(), [['model_response', old], ['model_response', read]])).text, /Cache expiry: ~29m left \(provider TTL/);
  }
});

test('every dialog action ends in a refresh that changes the saved state, since the host redraws the dialog only on a change', () => {
  const open = { ...feed(start(), [['model_response', response('i1')]]), open: true };
  const task = hostCall => hostCall.operation === 'task.status' ? { ledger: { thread_id: 'lead', cost: null }, limits: {}, worker_limits: {} } : { delivered: 1, dropped: 0 };
  for (const argument of ['', 'refresh', 'expanded', 'compact', 'close', 'toggle']) {
    const out = call(usageMod, { event: 'command', name: 'usage', payload: argument, state: open }, task);
    assert.deepEqual(out.calls.filter(item => item.operation === 'events.publish').map(item => item.arguments.channel), ['refresh'], argument);
  }
  assert.equal(call(usageMod, { event: 'command', name: 'usage', payload: 'noop', state: open }, task).calls.length, 0);
  const refresh = state => call(usageMod, { event: 'channel', payload: { channel: 'omd_usage/refresh', data: null, publisher: 'omd_usage' }, state }, task).state;
  const once = refresh(open);
  assert.notDeepEqual(refresh(once), once);
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
  assert.match(text, /Conversation input 30k · cache read 26k/);

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
  const budget = value => call(usageMod, { event: 'command', name: 'usage', payload: `budget ${value}`, state: null, settings: {} }).calls.map(item => item.operation);
  assert.deepEqual([budget('Infinity'), budget('5')], [[], ['settings.write']]);
});

test('/usage codex closes the dialog and opens Codex\'s own usage menu', () => {
  const out = call(usageMod, { event: 'command', name: 'usage', payload: 'codex', state: null, settings: {} }, ({ operation }) => operation === 'commands.invoke' ? { command: 'usage', result: { invoked: true } } : null);
  assert.deepEqual(out.calls.find(item => item.operation === 'commands.invoke').arguments, { command: 'usage' });
  assert.equal(out.value, null);
  assert.equal(out.state.open, false);
});

test('the budget notice says how many requests had no price', () => {
  const settings = { ...hud, budget_usd: 10 };
  const unknown = response('u1', { credential: null, cost: { microusd: null, basis: 'unpriced' } });
  const state = call(usageMod, { event: 'model_response', payload: unknown, state: start(), settings }).state;
  const out = call(usageMod, { event: 'model_response', payload: billed('b1', 9), state, settings });
  assert.match(notices(out.calls)[0].text, /\$9\.00 spent; 1 request has no price yet/);
});

test('native thread dollars replace the configured-rate estimate and the budget follows them', () => {
  const settings = { ...hud, budget_usd: 10 };
  const usage = native => hostCall => hostCall.operation === 'task.status' ? { ledger: { thread_id: 'lead', cost: null }, limits: {}, worker_limits: {} }
    : hostCall.operation === 'app.request' && hostCall.arguments.method === 'account/usage/read'
      ? { summary: {}, threadUsage: { threadId: hostCall.arguments.params.threadId, estimatedUsageCreditsMicros: 0, groups: [], nativeUsageUsdMicros: native } } : { delivered: 1, dropped: 0 };
  const estimated = feed(start(), [['model_response', response('e1', { route: 'api', credential: 'key', cost: { microusd: 4_000_000, basis: 'settled' } })]], settings);
  const refresh = (state, native) => call(usageMod, { event: 'channel', payload: { channel: 'omd_usage/refresh', data: null, publisher: 'omd_usage' }, state, settings }, usage(native));
  assert.match(dialog(estimated, settings).text, /~\$4\.00 configured-rate est\./);
  const native = refresh(estimated, 7_500_000);
  assert.equal(native.state.hud.native, 7.5);
  assert.deepEqual(native.calls.find(item => item.operation === 'app.request').arguments, { method: 'account/usage/read', params: { threadId: 'lead' } });
  assert.match(dialog(native.state, settings).text, /This conversation: \$7\.50 native/);
  assert.doesNotMatch(dialog(native.state, settings).text, /configured-rate/);
  assert.match(dialog(native.state, settings).text, /\$7\.50 spent/);
  assert.equal(refresh(native.state, null).state.hud.native, null, 'unknown native usage falls back to the estimate');
  const worker = feed(native.state, [['model_response', response('w1', { scope: { thread_id: 'child', agent_id: 'agent-1', kind: 'subagent' }, route: 'api', credential: 'key', cost: { microusd: 2_000_000, basis: 'settled' } })]], settings);
  assert.match(dialog(worker, settings).text, /\$9\.50 spent/, 'native usage replaces only the lead estimate');
  const ended = call(usageMod, { event: 'turn_end', payload: { turn_id: 't1' }, state: { ...worker, open: false }, settings }, usage(9_000_000));
  assert.equal(ended.state.hud.native, 9, 'a budget refreshes native usage with the dialog closed');
  assert.ok(ended.calls.some(item => item.operation === 'terminal.notice'), 'the refreshed spend crosses the budget');
});

test('tool and agent events write state only when the dialog shows them or something changed', () => {
  const event = (state, name, payload, now = NOW) => call(usageMod, { event: name, payload, state, settings: hud, virtual_time_ms: now }).state;
  assert.equal(event(null, 'tool_call', { call_id: 'c1', tool: 'exec_command' }), null, 'a closed dialog skips running-tool writes');
  assert.equal(event(null, 'tool_result', { call_id: 'c1' }), null);
  const shown = event({ open: true }, 'tool_call', { call_id: 'c2', tool: 'exec_command' });
  assert.deepEqual(Object.keys(shown.hud.tools), ['c2']);
  assert.deepEqual(event(shown, 'tool_result', { call_id: 'c2' }).hud.tools, {});
  const agent = { agent_id: 'a1', thread_id: 't1', role: 'explorer', origin: 'spawn', status: 'running' };
  const seen = event(null, 'agent', { agent });
  assert.equal(seen.hud.agents.a1.status, 'running');
  assert.equal(event(seen, 'agent', { agent }, NOW + 60_000).hud.agents.a1.at, NOW, 'an unchanged agent status is not rewritten');
  assert.equal(event(seen, 'agent', { agent: { ...agent, status: 'completed' } }).hud.agents.a1.status, 'completed');
});

test('the model_request intercept sizes the assembled request by role and passes the request on unchanged', () => {
  const section = (id, kind, role, bytes) => ({ id, kind, role, group: id, protected: false, text: id, bytes, truncated: false });
  const input = { request_id: 'r1', attempt: 1, scope: { thread_id: 'lead', agent_id: null, kind: 'main' }, routes: [], original: {}, route: 'lead', model: 'm', provider: 'p', effort: null, tools: [],
    sections: [section('a', 'instructions', 'system', 4000), section('b', 'user_message', 'user', 2000), section('c', 'agents_md.instructions', 'user', 1000), section('d', 'tool_output', 'tool', 3000)] };
  const result = { route: 'lead', effort: null, cache: { from: null } };
  const forwarded = [];
  const out = call(usageMod, { event: 'intercept', name: '0', payload: { surface: 'model_request', input, original: input, origin: { caller: 'engine' } }, state: start(), settings: hud },
    ({ operation, arguments: args }) => operation === 'continuation.next' ? (forwarded.push(args.input), { result, trace: [] }) : { delivered: 1, dropped: 0 });
  assert.deepEqual(forwarded, [input]);
  assert.deepEqual(out.value.result, result);
  assert.deepEqual(out.state.hud.assembled, { at: NOW, bytes: 10_000, categories: [['system', 4000], ['tool output', 3000], ['user', 2000], ['context', 1000]] });
  assert.match(dialog(out.state).text, /system 40% · tool output 30% · user 20% · context 10%/);
});
