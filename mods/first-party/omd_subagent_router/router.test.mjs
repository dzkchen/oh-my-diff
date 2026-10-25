import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { callback } from '../../../tests/mod_runner.mjs';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('./mod.json', import.meta.url), 'utf8'));
const efforts = list => list.map(reasoningEffort => ({ reasoningEffort }));
const MODELS = [
  { model: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol', hidden: false, modelProvider: null, supportedReasoningEfforts: efforts(['low', 'medium', 'high']) },
  { model: 'claude-sonnet-5-5', displayName: 'Claude Sonnet 5.5', hidden: false, modelProvider: 'omd_claude_cli', supportedReasoningEfforts: efforts(['low', 'high']) },
  { model: 'claude-opus-5-5', displayName: 'Claude Opus 5.5', hidden: false, modelProvider: 'omd_claude_cli', supportedReasoningEfforts: efforts(['high', 'xhigh']) },
];
const CLAUDE_ROUTE = { name: 'claude', provider: 'omd_claude_cli', model: 'claude-opus-5-5', roles: ['lead'], available: true };

function run(name, payload, { state = null, settings = {}, routes = [CLAUDE_ROUTE] } = {}) {
  const calls = [];
  const output = callback({ source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, state, settings, event: 'intercept', name, payload }, call => {
    calls.push(call);
    if (call.operation === 'continuation.next') return { result: payload.surface === 'input' ? { text: call.arguments.input.text } : { agent_id: 'agent:1', output: 'done', success: true }, trace: [] };
    if (call.operation === 'app.request' && call.arguments.method === 'model/list') return { data: MODELS, nextCursor: null };
    if (call.operation === 'routes.list') return routes;
    if (call.operation === 'terminal.notice') return null;
    assert.fail(`unexpected ${call.operation}`);
  });
  if (output.error) throw new Error(output.error);
  return {
    state: output.state,
    next: calls.find(call => call.operation === 'continuation.next')?.arguments.input,
    notices: calls.filter(call => call.operation === 'terminal.notice').map(call => call.arguments.text),
  };
}

const submit = (text, state = null) => run('0', { surface: 'input', input: { thread_id: 't', text, revision: null, attachments: [], elements: [] }, original: null, origin: { caller: 'user' } }, { state });
const prompt = (text, state) => submit(text, state).state;
const spawn = (fields, options) => {
  const input = { origin: 'model', caller: 'model', thread_id: 't', agent_id: null, definition: null, prompt: 'Research how retries work', model: null, effort: null, cwd: '/repo', tools: null, ...fields };
  return run('1', { surface: 'agent_spawn', input, original: input, origin: { caller: 'model' } }, options);
};

test('a prompt directive routes matching subagents to the named model on its provider', () => {
  const state = prompt('Use sonnet 5.5 as subagents to research the retry code, then fix it.');
  assert.deepEqual(state, { research: { query: 'sonnet 5.5', effort: null } });
  const routed = spawn({}, { state });
  assert.equal(routed.next.model, 'claude-sonnet-5-5');
  assert.deepEqual(routed.notices, []);
  assert.equal(spawn({ prompt: 'Fix the retry bug' }, { state }).next.model, null, 'a worker spawn keeps the lead model');
  assert.equal(spawn({ prompt: 'gAAAAABsealed' }, { state }).next.model, 'claude-sonnet-5-5', 'a sealed task takes the only directive');
  const two = { ...state, review: { query: 'opus', effort: null } };
  assert.equal(spawn({ prompt: 'gAAAAABsealed' }, { state: two }).next.model, null, 'two role directives leave a sealed task alone');
  assert.equal(spawn({ model: 'gpt-6.1-sol' }, { state }).next.model, 'gpt-6.1-sol', 'a model the lead chose stands');
  assert.equal(spawn({ model: 'sonnet-5.5' }, { state }).next.model, 'claude-sonnet-5-5', 'a model name the lead guessed is replaced');
});

test('mentions set a role and effort, and later directives replace earlier ones', () => {
  const first = prompt('@opus with xhigh effort for review');
  assert.deepEqual(first, { review: { query: 'opus', effort: 'xhigh' } });
  const routed = spawn({ prompt: 'Review the diff' }, { state: first });
  assert.equal(routed.next.model, 'claude-opus-5-5');
  assert.equal(routed.next.effort, 'xhigh');
  const reset = prompt('use the lead model as subagents for review', first);
  assert.equal(spawn({ prompt: 'Review the diff' }, { state: reset }).next.model, null);
});

test('settings give per-role defaults and an unsupported effort is dropped', () => {
  const routed = spawn({ definition: 'explorer', prompt: 'Map the modules' }, { settings: { research_model: 'claude-sonnet-5-5', research_effort: 'xhigh' } });
  assert.equal(routed.next.model, 'claude-sonnet-5-5');
  assert.equal(routed.next.effort, null);
  assert.equal(spawn({ effort: 'low' }, { settings: { research_model: 'sonnet' } }).next.effort, 'low', 'a supported lead effort stays');
  assert.equal(spawn({}, { settings: { review_model: 'opus' } }).next.model, null);
});

test('an unknown or unroutable model falls back to the lead model with a notice', () => {
  const said = submit('use gemini as subagents, and mail me@example.com for review');
  assert.equal(said.state, null, 'nothing unresolvable is kept');
  assert.equal(said.notices.length, 2, 'one toast and one transcript line');
  assert.match(said.notices[0], /No model matches "gemini"/);
  const unknown = spawn({}, { settings: { research_model: 'gemini' } });
  assert.equal(unknown.next.model, null);
  assert.match(unknown.notices[0], /No model matches "gemini"/);
  const unrouted = spawn({}, { state: { all: { query: 'sonnet', effort: null } }, routes: [{ ...CLAUDE_ROUTE, available: false }] });
  assert.equal(unrouted.next.model, null);
  assert.match(unrouted.notices[0], /Claude Sonnet 5\.5 has no usable route/);
});
