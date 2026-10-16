import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runnerSync } from '../../../tests/mod_runner.mjs';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('./mod.json', import.meta.url), 'utf8'));

function run(event, payload, state, name = '', ui_state = null) {
  const request = { source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, state, ui_state, settings: { rows: 6 }, event, name, payload, hook_budget_ms: 2000 };
  const output = runnerSync(request);
  if (output.error) throw new Error(output.error);
  return { ...output, ui_state: JSON.parse(output.ui_state) };
}
const notify = (state, method, thread, plan) => run('app_notification', { method, params: { threadId: thread, turnId: 't', plan }, thread_id: thread, coalesced: 0, dropped: 0 }, state).state;
const panel = (state, thread = 'lead', ui = null) => run('terminal', { event: 'idle', ledger: { thread_id: thread, cwd: '/repo', cost: null } }, state, '', ui).value
  ?.sites.above_composer.components.filter(item => item.type === 'line').map(item => item.spans.map(span => span.text).join(''));

test('the panel shows only its session plan, drops completed steps first and survives later events', () => {
  const steps = ['completed', 'completed', 'inProgress', 'completed', ...Array(6).fill('pending')].map((status, index) => ({ step: `step ${index + 1}`, status }));
  let state = notify(null, 'turn/plan/updated', 'lead', steps);
  state = notify(state, 'turn/plan/updated', 'child', [{ step: 'child work', status: 'pending' }]);
  assert.deepEqual(panel(state), ['● Plan (3/10)', '├─ ◐ step 3', '├─ ○ step 5', '├─ ○ step 6', '├─ ○ step 7', '├─ ○ step 8', '└─ +5 more (3 completed, 2 pending)']);
  assert.deepEqual(panel(state, 'child'), ['● Plan (0/1)', '└─ ○ child work']);
  assert.equal(panel(state, 'other'), undefined);
  const toggled = run('command', 'toggle', state, 'todos');
  assert.deepEqual(toggled.state, state);
  assert.deepEqual(panel(state, 'lead', toggled.ui_state), ['● Plan (3/10)', '└─ Alt+p to expand']);
  assert.equal(panel(state).length, 7);
  assert.equal(panel(state, 'lead', run('command', '', state, 'todos').ui_state).length, 11);
  assert.deepEqual(notify(state, 'turn/started', 'lead'), state);
  state = notify(state, 'turn/plan/updated', 'lead', steps.map(step => ({ ...step, status: 'completed' })));
  assert.deepEqual(panel(state).slice(0, 2), ['○ Plan (10/10)', '├─ ✓ step 6']);
  assert.equal(panel(notify(state, 'turn/started', 'lead')), undefined);
});

test('an active step below the row limit stays visible', () => {
  const steps = [...Array(12).fill('pending'), 'inProgress', 'pending'].map((status, index) => ({ step: `step ${index + 1}`, status }));
  const lines = panel(notify(null, 'turn/plan/updated', 'lead', steps));
  assert.deepEqual(lines.slice(1), ['├─ ○ step 9', '├─ ○ step 10', '├─ ○ step 11', '├─ ○ step 12', '├─ ◐ step 13', '└─ +9 more (0 completed, 9 pending)']);
});

test('long steps are clipped on code points, never inside an emoji', () => {
  const step = `${'x'.repeat(119)}🙂 tail`;
  const state = notify(null, 'turn/plan/updated', 'lead', [{ step, status: 'pending' }]);
  assert.equal(state.plans.lead.steps[0].step, `${'x'.repeat(119)}🙂`);
});
