import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { runnerSync } from './mod_runner.mjs';

const runner = readFileSync(new URL('../runtime/omd/src/mods/runner.mjs', import.meta.url), 'utf8');
const mod = name => ({
  source: readFileSync(new URL(`../mods/first-party/${name}/index.ts`, import.meta.url), 'utf8'),
  capabilities: JSON.parse(readFileSync(new URL(`../mods/first-party/${name}/mod.json`, import.meta.url), 'utf8')).capabilities,
});
const usageMod = mod('omd_usage');
const theme = mod('omd_theme');
const surface = {
  events: { terminal: 'terminal', channel: 'events', timer: 'events', start: 'lifecycle', resume: 'lifecycle', turn_start: 'lifecycle', turn_end: 'lifecycle', tool_result: 'lifecycle', compaction_start: 'lifecycle', compaction_end: 'lifecycle', model_response: 'model', agent: 'middleware', tool_call: 'middleware', app_notification: 'threads' },
  replacements: [], intercept: { model_request: 'middleware', render: 'terminal' }, middleware: [], state: 'store', contracts: 'contracts',
};
const NOW = 1_800_000_000_000;

function call({ source, capabilities }, input, answer = () => ({ delivered: 1, dropped: 0 })) {
  const receipts = [];
  const published = [];
  for (;;) {
    const result = runnerSync({ source, filename: 'index.ts', api: '0.2.0-experimental.5', surface, capabilities, settings: {}, state: null, virtual_time_ms: NOW, ...input, receipts });
    assert.ifError(result.error);
    const output = JSON.parse(result.stdout);
    assert.equal(output.error, undefined, `${output.error}\n${result.stderr}`);
    if (!output.host_call) return { ...output, published };
    if (output.host_call.operation === 'events.publish') published.push(output.host_call.arguments);
    const value = answer(output.host_call);
    receipts.push(value instanceof Error ? { call: output.host_call, error: value.message } : { call: output.host_call, value });
  }
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
  operation === 'session.info' ? { root: '/repo', cwd: '/repo', codex_version: '0.160.1', route: null, turns_started: 0, ...session }
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
  assert.equal(state.hud.entries.length, 120);
  assert.equal(state.hud.dropped, 11);
  assert.match(dialog(state).text, /11 older dropped \(not in these totals\)/);
});

test('provider costs, cache policy and missing usage keep their own labels', () => {
  let state = start({ thread_id: 'lead', model: 'claude-opus-5-5', provider: 'omd_claude_cli' });
  state = feed(state, [
    ['model_response', response('c1', { provider: 'omd_claude_cli', credential: 'claude', route: 'claude', requested_model: 'claude-opus-5-5', served_model: 'claude-opus-5-5-20261001',
      usage: { input_tokens: 12_000, input_tokens_details: { cached_tokens: 9_000, cache_write_tokens: 2_000 }, output_tokens: 300, omd_cache_ttl_seconds: 300, omd_subscription_charge: 'unknown', omd_reported_cost: { usd: 0.25, basis: 'client_list_estimate' } }, context_window: null })],
    ['app_notification', { method: 'thread/tokenUsage/updated', params: { threadId: 'lead', tokenUsage: { modelContextWindow: 200_000 } }, thread_id: 'lead', coalesced: 0, dropped: 0 }],
    ['model_response', response('o1', { provider: 'openrouter', route: 'openrouter', credential: 'or', scope: { thread_id: 'child', agent_id: 'agent-2', kind: 'subagent' }, cost: { microusd: 900, basis: 'settled' },
      usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 0 }, output_tokens: 10, omd_reported_cost: { usd: 0.0012, basis: 'provider_billed' } } })],
    ['model_response', response('u1', { provider: 'custom', route: 'custom', credential: 'custom', scope: { thread_id: 'child', agent_id: 'agent-3', kind: 'subagent' }, usage: null, cost: { microusd: null, basis: 'unpriced' } })],
    ['model_response', response('k5', { provider: 'omd_cursor', route: 'cursor', credential: 'cursor', scope: { thread_id: 'child', agent_id: 'agent-5', kind: 'subagent' }, cost: { microusd: null, basis: 'unsettled' } })],
    ['model_response', response('a1', { provider: 'openai', route: 'api', credential: 'key', scope: { thread_id: 'child', agent_id: 'agent-4', kind: 'subagent' }, cost: { microusd: 2_500_000, basis: 'settled' } })],
  ]);
  const { text } = dialog(state, hud, NOW - 59_000 + 120_000);
  assert.match(text, /Model claude-opus-5-5-20261001 \(requested claude-opus-5-5\)/);
  assert.match(text, /Last response: input 12k \+ output 300 of 200k \(6%\)/);
  assert.match(text, /Lead: 1 included \(~\$0.25 list-equivalent\)/);
  assert.match(text, /Workers: \$0.00 billed · ~\$2.50 configured-rate est. · 1 unsettled · 1 unknown cost/);
  assert.match(text, /Subscription overage: not reported by the provider \(unknown\)/);
  assert.match(text, /cache write 2.0k/);
  assert.match(text, /Cache expiry: ~3m left \(provider TTL from last cache use; projection, not guaranteed\)/);
  assert.match(dialog(state, hud, NOW + 600_000).text, /Cache expiry: TTL passed/);
  const scheduled = [];
  call(usageMod, { event: 'model_response', payload: response('c2', { provider: 'omd_claude_cli', credential: 'claude', route: 'claude', requested_model: 'claude-opus-5-5', served_model: 'claude-opus-5-5-20261001', usage: { input_tokens: 12_500, input_tokens_details: { cached_tokens: 12_000 }, output_tokens: 10 } }), state, settings: hud },
    hostCall => (hostCall.operation === 'events.schedule' && scheduled.push(hostCall.arguments), hostCall.operation === 'events.schedule' ? { key: hostCall.arguments.key, delay_ms: hostCall.arguments.delay_ms } : { delivered: 1, dropped: 0 }));
  assert.deepEqual(scheduled, [{ key: 'time:countdown', delay_ms: 60_000 }]);
  const tick = (now, answer) => call(usageMod, { event: 'timer', payload: { key: 'time:countdown' }, state, settings: hud, virtual_time_ms: now }, answer);
  assert.equal(tick(NOW, hostCall => { scheduled.push(hostCall.operation); return { key: 'time:countdown', delay_ms: 60_000 }; }).state.hud.tick, 1);
  assert.deepEqual(scheduled.slice(1), ['events.schedule']);
  assert.equal(tick(NOW + 600_000, hostCall => { scheduled.push(hostCall.operation); return {}; }).state.hud.tick, 1);
  assert.deepEqual(scheduled.slice(1), ['events.schedule']);
  state = feed(state, [['app_notification', { method: 'thread/settings/updated', params: { threadId: 'lead', threadSettings: { model: 'claude-opus-5-5', effort: 'high', modelProvider: 'omd_claude_cli' } }, thread_id: 'lead', coalesced: 0, dropped: 0 }]]);
  assert.match(dialog(state).text, /route claude · reasoning high/);

  const refreshed = call(usageMod, { event: 'channel', payload: { publisher: 'omd_usage', channel: 'omd_usage/refresh', data: null, correlation: null, sequence: 1, dropped: 0 }, state, settings: { ...hud, budget_usd: 2 } }, ({ operation }) =>
    operation === 'task.status' ? { ledger: { thread_id: 'lead', cwd: '/repo', cost: { attempts: [{ request: 5, provider_billed: true, settled_microusd: 1_000_000 }] } }, limits: { requests: 100, exposure_microusd: 5_000_000 }, worker_limits: {} }
      : operation === 'contract.status' ? { status: 'none' } : { delivered: 1, dropped: 0 });
  const published = refreshed.published.at(-1).data;
  assert.match(dialog(refreshed.state).text, /Workers: \$1.00 billed · ~\$2.50 configured-rate est. · 1 unknown cost/);
  assert.deepEqual(published.spend, { usd: 3.5012, kind: 'mixed', uncertain: true, list: 0.25 });
  assert.equal(published.budget, 'over');
  assert.equal(published.cache.ratio, 0.75);
  assert.deepEqual(refreshed.state.ledger.cost, { settled_task_charge_microusd: null }, 'saved state keeps no ledger attempts');
});

test('quota samples are scoped to the lead account, deduplicated, projected only with enough span and stale after reset', () => {
  const limits = used => ({ primary: { usedPercent: used, windowDurationMins: 300, resetsAt: (NOW + 7_200_000) / 1000 }, secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: null }, credits: { hasCredits: true, unlimited: false, balance: '12' } });
  let state = start(undefined, limits(20));
  state = feed(state, [['model_response', response('r1')]]);
  const notify = (current, used, now) => call(usageMod, { event: 'app_notification', payload: { method: 'account/rateLimits/updated', params: { rateLimits: limits(used) }, thread_id: null, coalesced: 0, dropped: 0 }, state: current, settings: hud, virtual_time_ms: now }).state;
  state = notify(state, 20, NOW + 60_000);
  assert.equal(state.hud.samples.filter(sample => sample.minutes === 300).length, 1);
  assert.match(dialog(state, hud, NOW + 60_000).text, /5h: 20% used · resets in 1h59m · observed 0m ago · insufficient data for a projection/);
  state = notify(state, 40, NOW + 1_860_000);
  const text = dialog(state, hud, NOW + 1_860_000).text;
  assert.match(text, /5h: 40% used · resets in 1h29m .* projection ~97% at reset \(2 samples over 31m\)/);
  assert.match(text, /7d: 10% used · reset time not reported/);
  assert.match(text, /Extra-usage credits: balance 12/);
  assert.match(dialog(state, hud, NOW + 7_300_000).text, /5h: 40% used · reset passed 2m ago, awaiting a new reading/);
  state = feed(state, [['model_response', response('r2', { provider: 'omd_claude_cli', credential: 'claude', timing: { started_at_ms: NOW + 1_900_000, first_event_ms: 1, duration_ms: 1 } })]]);
  assert.match(dialog(state, hud, NOW + 1_910_000).text, /No quota windows reported for this account and route/);
});

test('compaction, rewind and route switches mark the context reading stale; categories need the detailed mode', () => {
  let state = start();
  state = feed(state, [['model_response', response('r1')]]);
  state = feed(state, [['app_notification', { method: 'thread/settings/updated', params: { threadId: 'lead', threadSettings: { model: 'gpt-6.1-luna', modelProvider: 'openai' } }, thread_id: 'lead', coalesced: 0, dropped: 0 }]]);
  assert.match(dialog(state).text, /stale: route switched since/);
  state = feed(state, [['app_notification', { method: 'thread/reverted', params: { threadId: 'lead' }, thread_id: 'lead', coalesced: 0, dropped: 0 }]]);
  assert.match(dialog(state).text, /stale: rewound since/);
  state = feed(state, [['compaction_start', { turn_id: 't', trigger: 'auto' }]]);
  assert.match(dialog(state).text, /Compaction: 0 installed of 1 started · last one running or not installed/);
  state = feed(state, [['compaction_end', { turn_id: 't', trigger: 'auto' }]]);
  assert.match(dialog(state).text, /stale: compacted since/);
  assert.match(dialog(state, {}).text, /Category drilldown off/);

  const request = { request_id: 'r9', attempt: 1, scope: { thread_id: 'lead', agent_id: null, kind: 'main' }, routes: [], original: null, route: 'codex', model: 'gpt-6.1-sol', provider: 'openai', effort: null, tools: [],
    sections: [{ id: 'a', kind: 'instructions', role: 'system', group: 'instructions', protected: true, text: null, bytes: 4_000, truncated: false },
      { id: 'b', kind: 'user.text', role: 'user', group: 'm1', protected: false, text: null, bytes: 1_000, truncated: false },
      { id: 'c', kind: 'agents_md.instructions', role: 'user', group: 'm0', protected: false, text: null, bytes: 3_000, truncated: false },
      { id: 'd', kind: 'tool_output', role: 'tool', group: 'm2', protected: false, text: null, bytes: 2_000, truncated: false }] };
  const payload = { surface: 'model_request', input: request, original: request, origin: { caller: 'engine' } };
  const first = call(usageMod, { event: 'intercept', name: '0', payload, state, settings: hud }, () => ({ result: { route: 'codex', effort: null }, trace: [] }));
  assert.match(dialog(first.state).text, /Assembled request 0m ago: ~2.5k tokens \(bytes\/4, approximate\) · system 40% · context 30% · tool output 20% · user 10%/);
});

test('sidebar shows usage, allowance, tasks and workers; theme draws compact cache, cost and quota segments', () => {
  let state = start();
  state = feed(state, [['model_response', response('r1')],
    ['agent', { phase: 'start', agent: { agent_id: 'agent-123456789', thread_id: 'child', parent: { thread_id: 'lead', agent_id: null }, origin: 'model', owner: null, definition: null, role: 'explorer', status: 'running' } }],
    ['tool_call', { call_id: 'c1', agent_id: null, tool: 'exec_command', arguments: {} }],
    ['app_notification', { method: 'turn/plan/updated', params: { threadId: 'lead', plan: [{ step: 'Read', status: 'completed' }, { step: 'Fix', status: 'inProgress' }, { step: 'Test', status: 'pending' }] }, thread_id: 'lead', coalesced: 0, dropped: 0 }]]);
  state.allowance = { used: 1_200_000, limit: 5_000_000, requests: 3, max: 100 };
  const sidebar = call(usageMod, { event: 'terminal', payload: { event: 'idle', ledger: null }, state, settings: hud }).value;
  const panes = sidebar.sites.sidebar.components;
  assert.equal(panes[0].type, 'slot');
  assert.deepEqual(panes[1].children.map(child => child.text), ['Cache 80% hit', '1 included', '[##--------] $1.20/$5.00']);
  assert.deepEqual(panes[2].children.map(child => child.text), ['Tasks 1/3 · Fix', 'explorer · agent-12', 'running exec_command']);
  assert.deepEqual(sidebar.keybindings, { 'Alt+a': { command: 'omd_usage:hud', args: 'toggle' } });
  const toggled = call(usageMod, { event: 'command', name: 'hud', payload: 'toggle', state: { ...state, open: true }, settings: hud }).state;
  assert.equal(toggled.open, false);

  const data = { thread: 'lead', cache: { ratio: 0.8, expires: NOW + 240_000 }, spend: { usd: 0.42, kind: 'estimate', uncertain: true, list: null }, quota: { name: '5h', used: 72, resets: NOW + 5_400_000, observed: NOW - 60_000 }, budget: 'warn' };
  const on = { statusline: 'ascii' };
  const themed = call(theme, { event: 'channel', payload: { publisher: 'omd_usage', channel: 'omd_usage/hud', data, correlation: null, sequence: 1, dropped: 0 }, settings: on }).state;
  const spans = call(theme, { event: 'terminal', payload: { event: 'idle', ledger: { thread_id: 'lead', cwd: '/', cost: null }, identity: null }, state: themed, settings: on }).value.sites.above_composer.components[1].spans;
  assert.equal(spans.map(span => span.text).join(''), 'cache:80% ~4m | ~$0.42? | 5h 72% r1h30m');
  const below = call(theme, { event: 'terminal', payload: { event: 'idle', ledger: { thread_id: 'lead', cwd: '/', cost: null }, identity: null }, state: themed, settings: { statusline: 'minimal', statusline_position: 'below' }, virtual_time_ms: NOW + 6_000_000 }).value;
  assert.deepEqual(below.status, ['0 mods · ~$0.42?']);
  const passed = call(theme, { event: 'terminal', payload: { event: 'idle', ledger: { thread_id: 'lead', cwd: '/', cost: null }, identity: null }, state: themed, settings: on, virtual_time_ms: NOW + 6_000_000 }).value.sites.above_composer.components[1].spans;
  assert.match(passed.map(span => span.text).join(''), /cache:80% exp \| ~\$0.42\? \| 5h \?/);
});
