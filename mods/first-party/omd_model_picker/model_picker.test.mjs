import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runnerSync } from '../../../tests/mod_runner.mjs';

const surface = {
  events: { terminal: 'terminal', component_event: 'terminal', channel: 'events', timer: 'events', start: 'lifecycle', resume: 'lifecycle', turn_start: 'lifecycle', turn_end: 'lifecycle', idle: 'lifecycle', tool_result: 'lifecycle', agent_end: 'lifecycle', compaction_end: 'lifecycle', app_notification: 'threads' },
  replacements: [], intercept: { render: 'terminal' }, middleware: [], state: 'store', contracts: 'contracts',
};
const source = readFileSync(new URL('index.ts', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('mod.json', import.meta.url), 'utf8'));
const assets = Object.fromEntries((manifest.assets ?? []).map(asset => [asset, { text: readFileSync(new URL(asset, import.meta.url), 'utf8') }]));
function run(input) {
  const result = runnerSync({ source, assets, filename: 'index.ts', api: manifest.api, surface, capabilities: [], settings: {}, state: null, event: 'inspect', ...input });
  assert.ifError(result.error);
  const output = JSON.parse(result.stdout);
  assert.equal(result.status, 0, `${result.stderr}\n${output.error ?? ''}`);
  assert.equal(output.error, undefined, output.error);
  return output;
}

test('model and reasoning lists use bounded generic components', () => {
  const props = { view_id: 'model', title: 'Model', subtitle: 'Choose one', selected: 1, items: [
    { label: 'A', description: null, current: true, disabled: false, order: 0 },
    { label: 'B', description: 'Reasoning model', current: false, disabled: false, order: 1 },
  ] };
  const capabilities = ['terminal', 'events', 'store'];
  const render = (overrides = {}, columns = 40, state = null) => {
    const input = { component: 'list', id: 'model', surface: 'inline', viewport: { columns, rows: 24 }, lifecycle: 'live', owner: null, props: { ...props, ...overrides } };
    return run({ capabilities, event: 'intercept', name: '0', payload: { surface: 'render', input, original: input, origin: { caller: 'engine' } }, state });
  };
  const output = render();
  assert.equal(output.registrations.interceptors[0].pattern, 'render');
  const tree = output.value.result.tree;
  assert.equal(tree[0].text, 'oh my diff · Model');
  assert.equal(tree[1].type, 'list');
  assert.equal(tree[1].selected, '1');
  assert.deepEqual(tree[1].rows.map(row => row.value), ['0', '1']);
  assert.match(tree[1].rows[0].spans[0].text, /current/);
  assert.equal(JSON.stringify(tree).includes('Reasoning model'), false);
  assert.match(tree[2].text, /enter/);
  assert.match(render({}, 100).value.result.tree[2].rows[1].spans[0].text, /Reasoning model/);
  assert.equal(render({ items: Array(201).fill(props.items[0]) }).host_call.operation, 'continuation.next');
  assert.equal(render({ view_id: 'unknown' }).host_call.operation, 'continuation.next');
  const profiles = { profiles: [{ name: 'work', model: 'work/gpt', billing: 'included_subscription', available: true }, { name: 'router', model: 'router/claude', billing: 'explicit_paid_api_grant', available: true }], current: 'work' };
  const listed = render({}, 40, profiles).value.result.tree;
  assert.deepEqual(listed.slice(-3, -1).map(row => row.text), ['● work · work/gpt', '○ router · router/claude · paid']);
});
