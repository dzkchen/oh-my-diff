import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { callback } from '../../../tests/mod_runner.mjs';

const read = name => readFileSync(new URL(name, import.meta.url), 'utf8');
const manifest = JSON.parse(read('./mod.json'));
const request = { source: read('./index.ts'), filename: fileURLToPath(new URL('./index.ts', import.meta.url)), entrypoint: 'index.ts', api: manifest.api,
  capabilities: manifest.capabilities, settings: { route: 'helper' }, hook_budget_ms: 10_000 };

function ask(payload, state, reply = args => ({ status: 'completed', text: `answer to ${args.prompt}`, error: null }), settings = request.settings, added = { route: 'plan-gpt-omd_btw' }) {
  const forks = [];
  const writes = [];
  let ttl = 0;
  const output = callback({ ...request, settings, state, event: 'command', name: 'aside', payload }, ({ operation, arguments: args }) => {
    if (operation === 'terminal.notice') { assert.ok(args.clear || (args.ttl_ms >= 1000 && args.ttl_ms <= 60_000)); ttl = args.ttl_ms ?? ttl; return args.clear ? { cleared: true } : { shown: true }; }
    if (operation === 'routes.add') { assert.deepEqual(args, {}); if (added instanceof Error) throw added; return added; }
    if (operation === 'settings.write') { writes.push(args); return { settings: args.values }; }
    if (operation !== 'model.fork') assert.fail(`unexpected ${operation}`);
    assert.ok(args.timeout_ms <= ttl, 'the answering notice outlasts the wait');
    forks.push(args);
    return reply(args);
  });
  assert.equal(output.error, undefined);
  return { state: output.state, display: output.value.display, forks, writes, registrations: output.registrations };
}

test('/btw routes here; side questions fork the conversation without tools, replay earlier exchanges and stay out of the conversation', () => {
  const first = ask('why tabs?', null);
  assert.deepEqual(first.registrations.builtins, [{ commands: { replace: { btw: 'aside' } } }]);
  assert.deepEqual(first.forks.map(args => [args.prompt, args.context, args.tools, args.route]), [['why tabs?', [], undefined, 'helper']]);
  assert.equal(first.display, 'btw: why tabs?\n\nanswer to why tabs?');
  assert.deepEqual(first.state, [{ question: 'why tabs?', answer: 'answer to why tabs?' }]);
  const second = ask('and spaces?', first.state);
  assert.match(second.forks[0].context[0], /Side question: why tabs\?\nYour answer: answer to why tabs\?/);
  assert.equal(second.display, 'Earlier side questions:\n  · why tabs?\n\nbtw: and spaces?\n\nanswer to and spaces?');
  const reopened = ask('', second.state);
  assert.deepEqual([reopened.forks, reopened.display, reopened.state], [[], second.display, second.state]);
});

test('the thread keeps the newest 20 exchanges and a failed answer saves nothing', () => {
  let state = Array.from({ length: 20 }, (_, index) => ({ question: `q${index}`, answer: 'a' }));
  state = ask('q20', state).state;
  assert.deepEqual([state.length, state[0].question, state[19].question], [20, 'q1', 'q20']);
  const failed = ask('q21', state, () => ({ status: 'failed', text: '', error: 'provider_unavailable' }));
  assert.deepEqual([failed.display, failed.state], ['/btw failed: provider_unavailable', state]);
  assert.equal(ask('', null).display, 'No side questions in this thread yet. Ask one with /btw <question>.');
  const cut = ask('q22', null, () => ({ status: 'incomplete', text: 'partial', error: null }));
  assert.deepEqual(cut.state, [{ question: 'q22', answer: 'partial (cut off)' }]);
  const empty = ask('q22', null, () => ({ status: 'incomplete', text: ' ', error: null }));
  assert.deepEqual([empty.display, empty.state], ['/btw failed: the model returned no answer', null]);
});

test('without a route the first side question asks for a plan route, saves it and answers on it', () => {
  const unset = ask('q23', null, undefined, {});
  const failed = ask('q23', null, () => ({ status: 'failed', text: '', error: 'provider_unavailable' }), {});
  assert.deepEqual([failed.display, failed.writes], ['/btw failed: provider_unavailable', [{ values: { route: 'plan-gpt-omd_btw' } }]]);
  assert.deepEqual([unset.forks.map(args => args.route), unset.writes], [['plan-gpt-omd_btw'], [{ values: { route: 'plan-gpt-omd_btw' } }]]);
  assert.equal(unset.display, 'btw: q23\n\nanswer to q23');
  const declined = ask('q24', null, undefined, {}, { status: 'declined' });
  assert.deepEqual([declined.forks, declined.writes, declined.state], [[], [], null]);
  assert.match(declined.display, /^No model for \/btw yet\. Run \/btw again/);
  const unsigned = ask('q25', null, undefined, {}, new Error('routes_add_needs_chatgpt: sign in'));
  assert.deepEqual([unsigned.forks, unsigned.writes], [[], []]);
  assert.match(unsigned.display, /^No model for \/btw yet \(routes_add_needs_chatgpt: sign in\): pick one in \/mods/);
});
