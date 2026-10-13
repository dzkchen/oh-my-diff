import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { advance, calls, clock, component, emit, find, hostOperations, invoke, runScenario, text } from '@oh-my-diff/mod-api/testing';

const skip = !process.env.OMD_MOD_BIN && 'needs the omd-mod engine in OMD_MOD_BIN';
const directory = fileURLToPath(new URL('.', import.meta.url));
const NOW = 1_800_000_000_000;
const thread = 'lead';
const response = (id, cost, model = 'claude-opus-5-5', usage = { input_tokens: 120_000, output_tokens: 4_000 }) => ({
  request_id: id, attempt: 1, scope: { thread_id: thread, agent_id: null, kind: 'main' }, served_model: model, requested_model: model,
  usage, cost, context_window: 200_000, synthetic: null,
});
const turnEnd = emit('turn_end', { thread_id: thread });
const draw = (columns = 120) => emit('terminal', { event: 'idle', ledger: { thread_id: thread }, client: { columns, reduced_motion: false } });
const stored = (value, revision) => ({ value, revision, provenance: { mod: 'burn_meter', source_sha256: '0'.repeat(64), thread_id: null, origin: 'cli', at: '1970-01-01T00:00:00Z' } });
const site = (step, name) => step.value[0].value?.sites?.[name]?.components ?? null;
const fire = props => ({ id: 'band', rows: 3, from: 0, goal: 0, demo: null, level: null, text: null, extra: '', reduced: false, ...props });

test('priced spend is counted once per request, crosses thresholds once and adds to the lifetime total', { skip }, () => {
  const trace = runScenario(directory, clock(NOW), hostOperations({
    'store.get': [null, stored(600_000, 1), stored(1_300_000, 2)],
    'store.put': [{ revision: 1 }, { revision: 2 }],
    'terminal.notice': [{}],
    'app.request': [{ error: 'unavailable' }],
  }), { steps: [
    emit('model_response', response('r1', { microusd: 600_000, basis: 'settled' })),
    emit('model_response', response('r1', { microusd: 600_000, basis: 'settled' })),
    emit('model_response', response('r2', { microusd: 700_000, basis: 'provider_reported' }, 'claude-haiku-4-5-20251001', { input_tokens: 2_000, output_tokens: 900 })),
    turnEnd, draw(),
  ] });
  assert.deepEqual(trace.unused_mock_replies, []);
  assert.deepEqual(calls(trace, 'store.put').map(call => [call.arguments.value, call.arguments.expected_revision, call.arguments.scope]), [[600_000, null, 'user'], [1_300_000, 1, 'user']]);
  assert.deepEqual(calls(trace, 'terminal.notice').map(call => call.arguments.text), ['$1.00 burned this session = 0.31 McDoubles']);
  const band = site(trace.steps[4], 'above_composer');
  assert.match(text(band), /BURN/);
  assert.match(text(band), /opus 5\.5 120k in 4k out\n/m);
  assert.match(text(band), /lifetime \$1\.30/);
  const module = find(band, node => node.type === 'module');
  assert.deepEqual([module.module, module.props.from, module.props.goal, module.props.text], ['fire', 0.6, 1.3, null]);
});

test('included and unpriced turns say so instead of a price, and plan windows drive the bar', { skip }, () => {
  const resets = (NOW + 2 * 3_600_000) / 1000;
  const trace = runScenario(directory, clock(NOW), hostOperations({
    'app.request': [{ rateLimits: { primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: resets }, secondary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: resets + 86_400 * 3 } } }],
    'store.get': [null],
  }), { steps: [
    emit('model_response', response('r1', { microusd: 0, basis: 'included_subscription' }, 'gpt-6.1-sol')),
    turnEnd, draw(),
  ] });
  assert.deepEqual(trace.unused_mock_replies, []);
  assert.deepEqual(calls(trace, 'store.put'), []);
  assert.deepEqual(calls(trace, 'terminal.notice'), []);
  const band = site(trace.steps[2], 'above_composer');
  assert.match(text(band), /5h 42% in 2h 0m/);
  assert.match(text(band), /wk 12% in 3d 2h/);
  assert.match(text(band), /gpt-6\.1-sol 120k in 4k out/);
  const module = find(band, node => node.type === 'module');
  assert.deepEqual([module.props.text, module.props.level], ['included in plan', 0.42]);
});

test('the fuse animates only while the amount rolls and settles at once with reduced motion', { skip }, () => {
  const steps = [component('burn_meter', 'fire', { props: fire({ goal: 1.3 }), columns: 40 })];
  for (let index = 0; index < 50; index++) steps.push(advance(70), component('burn_meter', 'fire', { props: fire({ goal: 1.3 }), columns: 40 }));
  steps.push(component('burn_meter', 'fire', { instance: 'still', props: fire({ goal: 1.3, reduced: true }), columns: 40 }), advance(70),
    component('burn_meter', 'fire', { instance: 'still', props: fire({ goal: 1.3, reduced: true }), columns: 40 }));
  const frames = runScenario(directory, clock(NOW), { steps }).steps.filter(step => step.type === 'component').map(step => step.value);
  assert.equal(frames[0].next_ms, 70);
  assert.equal(frames[50].next_ms, null);
  assert.match(text(frames[50].tree), /\$1\.30 = 0\.12 burritos/);
  assert.equal(frames[50].tree.length, 4);
  assert.equal(frames.at(-1).next_ms, null);
  assert.match(text(frames.at(-1).tree), /\$1\.30/);
});

test('the demo burns to $30, posting each threshold once and then stopping', { skip }, () => {
  const props = fire({ demo: NOW });
  const steps = [component('burn_meter', 'fire', { props })];
  for (let index = 0; index < 60; index++) steps.push(advance(500), component('burn_meter', 'fire', { props }));
  const frames = runScenario(directory, clock(NOW), { steps }).steps.filter(step => step.type === 'component').map(step => step.value);
  assert.deepEqual(frames.map(frame => frame.post?.data).filter(Boolean), [{ notice: 1 }, { notice: 5 }, { notice: 10 }, { notice: 25 }, { done: true }]);
  assert.equal(frames.at(-1).next_ms, null);
});

test('/burn answers usage and lifetime without a session', { skip }, () => {
  const trace = runScenario(directory, { steps: [invoke('burn_meter', 'command', 'burn', 'nope'), invoke('burn_meter', 'command', 'burn', 'lifetime')] });
  assert.deepEqual(trace.steps.map(step => step.value?.display), ['usage: /burn [panel|show|hide|demo|lifetime]', 'Lifetime burn: $0.00 = 0.00 burritos.']);
});
