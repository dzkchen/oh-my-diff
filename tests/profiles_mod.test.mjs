import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const runner = readFileSync(new URL('../runtime/omd/src/mods/runner.mjs', import.meta.url), 'utf8');
const mod = new URL('../mods/first-party/omd_profiles/', import.meta.url);
const source = readFileSync(new URL('index.ts', mod), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('mod.json', mod), 'utf8'));
const surface = { events: { routing: 'model', start: 'lifecycle', resume: 'lifecycle', turn_start: 'lifecycle', terminal: 'terminal' }, replacements: ['routing'], middleware: [], state: 'store', contracts: 'contracts' };
const route = (name, billing) => ({ name, model: `${name}/up`, provider: 'omd_profiles', reasoning: 'high', roles: ['lead'], billing, tools: [], available: true, credential: `cred-${name}` });

test('profile switches stay on the thread, ask before paid routes and report refusals', () => {
  const calls = [];
  let answer = 'accepted';
  let selected = { route: route('paid', 'explicit_paid_api_grant'), effective_at: 'next_request' };
  const invoke = (state, event, payload, name) => {
    const receipts = [];
    for (;;) {
      const request = { source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, state, settings: {}, event, name, payload, receipts, surface, hook_budget_ms: 10000 };
      const output = JSON.parse(spawnSync(process.execPath, ['--no-warnings', '--experimental-vm-modules', '--input-type=module', '--eval', runner],
        { input: JSON.stringify(request), encoding: 'utf8', timeout: 20000 }).stdout);
      if (output.error) throw new Error(output.error);
      if (!output.host_call) return output;
      const { operation, arguments: args } = output.host_call;
      calls.push({ operation, args });
      const value = { 'routes.list': [route('work', 'included_subscription'), route('paid', 'explicit_paid_api_grant'), { ...route('other', 'included_subscription'), provider: 'openai' }],
        'credentials.list': [{ id: 'cred-work', label: 'work', kind: 'chatgpt' }], 'terminal.prompt': { status: answer }, 'events.publish': { delivered: 1, dropped: 0 }, 'sidecars.status': { running: true } }[operation];
      receipts.push(operation === 'routes.select' && typeof selected === 'string' ? { call: output.host_call, error: selected } : { call: output.host_call, value: operation === 'routes.select' ? selected : value });
    }
  };
  let state = invoke(null, 'routing', { routes: [route('work', 'included_subscription'), route('paid', 'explicit_paid_api_grant')], model: 'paid/up', provider: 'omd_profiles', reasoning: 'high' }).state;
  assert.equal(state.current, 'paid');
  assert.deepEqual(invoke(state, 'routing', { routes: [], model: 'gpt', provider: 'openai', reasoning: null }).value, null);
  state = invoke(state, 'start', {}).state;
  assert.deepEqual(state.profiles.map(profile => profile.name), ['work', 'paid']);
  assert.match(invoke(state, 'command', '', 'profile').value.display, /^○ work · work\/up · subscription · chatgpt work\n● paid · paid\/up · paid API · credential missing$/);
  answer = 'declined';
  assert.equal(invoke(state, 'command', 'use paid', 'profile').value.display, 'Kept the current profile.');
  answer = 'accepted';
  state = invoke(state, 'command', 'use paid', 'profile').state;
  assert.equal(state.pending, 'paid');
  state = invoke(state, 'command', 'use work', 'profile').state;
  assert.equal(calls.filter(call => call.operation === 'terminal.prompt').length, 2);
  state = invoke({ ...state, pending: 'paid' }, 'turn_start', { turn_id: 't1' }).state;
  assert.ok(calls.some(call => call.operation === 'routes.select' && call.args.route === 'paid' && call.args.scope === 'thread'));
  assert.ok(!calls.some(call => call.operation === 'app.request'));
  assert.deepEqual(invoke(state, 'terminal', { event: 'redraw', ledger: null }).value, { status: ['profile paid'] });
  selected = 'route_unavailable_for_thread: work';
  state = invoke({ ...state, pending: 'work' }, 'turn_start', { turn_id: 't2' }).state;
  assert.deepEqual(invoke(state, 'terminal', { event: 'redraw', ledger: null }).value, { status: ['profile switch failed'] });
  assert.match(invoke(state, 'command', '', 'profile').value.display, /^Last switch failed: work: route_unavailable_for_thread: work\n/);
});
