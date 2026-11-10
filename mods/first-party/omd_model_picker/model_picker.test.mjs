import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { callback } from '../../../tests/mod_runner.mjs';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('./mod.json', import.meta.url), 'utf8'));
const base = { source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, subscriptions: manifest.subscriptions };
const native = { result: { tree: [{ type: 'native' }] }, trace: [] };

const item = (order, label, extra = {}) => ({ order, label, description: null, current: false, disabled: false, ...extra });
function draw(props, { settings = {}, state = null, columns = 100 } = {}) {
  const input = { component: 'list', props: { view_id: 'model', title: 'Select Model', subtitle: null, selected: 0, items: [item(0, 'gpt-6')], ...props }, viewport: { columns, rows: 30 } };
  const output = callback({ ...base, settings, state, event: 'intercept', name: '0', payload: { surface: 'render', input, original: input, origin: { caller: 'engine' } } },
    call => (assert.equal(call.operation, 'continuation.next'), native));
  assert.equal(output.error, undefined, output.error);
  return output.value.result.tree;
}
const byId = (tree, id) => tree.find(component => component.id === id);

test('the model list is redrawn with current and unavailable rows tagged and its selection kept', () => {
  const tree = draw({ items: [item(0, 'gpt-6', { current: true, description: 'default' }), item(1, 'gpt-7', { disabled: true }), item(2, 'mini')], selected: 2, subtitle: 'Pick one' });
  assert.deepEqual(tree.map(component => component.id), ['omd_picker_title', 'omd_picker_subtitle', 'omd_picker_choices', 'omd_picker_hints']);
  assert.equal(byId(tree, 'omd_picker_title').text, 'oh my diff · Select Model');
  const list = byId(tree, 'omd_picker_choices');
  assert.deepEqual(list.rows.map(row => [row.value, row.spans[0].text, row.spans[0].tone]),
    [['0', 'gpt-6 · current · default', 'accent'], ['1', 'gpt-7 · unavailable', 'muted'], ['2', 'mini', 'normal']]);
  assert.equal(list.selected, '2');
});

test('narrow terminals drop descriptions, the subtitle and the long hints', () => {
  const tree = draw({ items: [item(0, 'gpt-6', { description: 'default' })], subtitle: 'Pick one' }, { columns: 60 });
  assert.equal(byId(tree, 'omd_picker_subtitle'), undefined);
  assert.equal(byId(tree, 'omd_picker_choices').rows[0].spans[0].text, 'gpt-6');
  assert.equal(byId(tree, 'omd_picker_hints').text, 'up/down · enter · esc');
});

test('other views, oversized lists and tiny terminals keep the native picker', () => {
  assert.deepEqual(draw({ view_id: 'theme' }), [{ type: 'native' }]);
  assert.deepEqual(draw({ items: Array.from({ length: 201 }, (_, index) => item(index, `m${index}`)) }), [{ type: 'native' }]);
  assert.deepEqual(draw({}, { columns: 19 }), [{ type: 'native' }]);
  assert.ok(draw({ view_id: 'reasoning' }).length > 1);
});

test('long labels are cut to a 256-byte row and the brand is cleaned, capped and optional', () => {
  const long = draw({ items: [item(0, '界'.repeat(200))] }, { columns: 300 });
  const text = byId(long, 'omd_picker_choices').rows[0].spans[0].text;
  assert.ok(new TextEncoder().encode(text).length <= 256 && text.endsWith('…'), text);
  assert.equal(byId(draw({}, { settings: { brand: '  my\u0007\n brand ' } }), 'omd_picker_title').text, 'my brand · Select Model');
  assert.equal(byId(draw({}, { settings: { brand: 'x'.repeat(40) } }), 'omd_picker_title').text, `${'x'.repeat(24)} · Select Model`);
  assert.equal(byId(draw({}, { settings: { brand: '' } }), 'omd_picker_title').text, 'Select Model');
});

test('profiles from omd_profiles show on the model view only, at most four, with the current one marked', () => {
  const profiles = ['a', 'b', 'c', 'd', 'e'].map(name => ({ name, model: `m-${name}`, billing: name === 'b' ? 'metered' : 'included_subscription', available: name !== 'c' }));
  const state = { profiles, current: 'a' };
  const tree = draw({}, { state });
  const rows = tree.filter(component => component.id.startsWith('omd_picker_profile_'));
  assert.deepEqual(rows.map(row => [row.text, row.tone]), [['● a · m-a', 'accent'], ['○ b · m-b · paid', 'normal'], ['○ c · m-c', 'muted'], ['○ d · m-d', 'normal']]);
  assert.equal(tree.at(-1).id, 'omd_picker_hints');
  assert.equal(draw({ view_id: 'reasoning' }, { state }).some(component => component.id.startsWith('omd_picker_profile')), false);
});

test('the native layout setting registers nothing, and routes published by omd_profiles are saved as state', () => {
  const idle = callback({ ...base, settings: { layout: 'native' }, state: null, event: 'start', payload: null }, call => assert.fail(call.operation));
  assert.equal(idle.error, undefined, idle.error);
  assert.deepEqual([idle.registrations.events, idle.registrations.interceptors], [[], []]);
  const data = { profiles: [], current: 'x' };
  const saved = callback({ ...base, settings: {}, state: null, event: 'channel', payload: { channel: 'omd_profiles/routes', data, publisher: 'omd_profiles' } }, call => assert.fail(call.operation));
  assert.equal(saved.error, undefined, saved.error);
  assert.deepEqual(saved.state, data);
  const other = callback({ ...base, settings: {}, state: null, event: 'channel', payload: { channel: 'other/routes', data, publisher: 'other' } }, call => assert.fail(call.operation));
  assert.equal(other.state ?? null, null);
});
