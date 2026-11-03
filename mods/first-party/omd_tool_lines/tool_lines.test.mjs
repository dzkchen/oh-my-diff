import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { callback } from '../../../tests/mod_runner.mjs';

const filename = fileURLToPath(new URL('index.ts', import.meta.url));
const source = readFileSync(filename, 'utf8');
const manifest = JSON.parse(readFileSync(new URL('mod.json', import.meta.url), 'utf8'));
const exec = (id, status = 'completed') => ({ call_id: id, kind: 'exec', command: `cargo test ${id}`, parsed: [], user_shell: false,
  status, exit_code: status === 'failed' ? 1 : 0, output_lines: 50, duration_ms: 100 });
const render = (props, columns = 120) => {
  const input = { component: 'tool_call', props: { expanded: false, ...props }, viewport: { columns, rows: 40 } };
  const result = callback({ source, filename, api: manifest.api, capabilities: manifest.capabilities, event: 'intercept', name: '0',
    payload: { surface: 'render', input, original: input, origin: { caller: 'engine' } } }, () => ({ result: { tree: [{ type: 'native' }] }, trace: [] }));
  assert.equal(result.error, undefined, result.error);
  return result;
};
const text = result => result.value.result.tree.flatMap(line => line.spans ?? []).map(span => span.text).join('');

test('a run of shell calls becomes one summary with failure and running counts', () => {
  const calls = [exec('one'), exec('two', 'failed'), exec('three', 'running')];
  const result = render({ kind: 'explore', call_id: 'one', status: 'running', calls });
  assert.equal(result.value.result.tree.length, 1);
  assert.match(text(result), /3 commands.*cargo test three.*1 running.*1 failed/);
});

test('completed groups summarize their calls without listing every command', () => {
  const result = render({ kind: 'explore', call_id: 'one', status: 'completed', calls: [exec('one'), exec('two')] });
  assert.equal(result.value.result.tree.length, 1);
  assert.match(text(result), /2 commands.*cargo test two.*ok/);
  assert.doesNotMatch(text(result), /cargo test one/);
});

test('expanded groups and user shell commands keep the native output', () => {
  for (const props of [{ kind: 'explore', calls: [exec('one'), exec('two')], expanded: true }, { ...exec('one'), user_shell: true }]) {
    assert.deepEqual(render(props).value.result.tree, [{ type: 'native' }]);
  }
});

test('search groups pluralize their name and distinguish interrupted commands', () => {
  const calls = [exec('one'), exec('two', 'interrupted')].map(call => ({ ...call, parsed: [{ type: 'search', cmd: 'rg needle', query: 'needle', path: '.' }] }));
  const result = render({ kind: 'explore', call_id: 'one', status: 'interrupted', calls });
  assert.match(text(result), /2 searches.*1 interrupted/);
  assert.doesNotMatch(text(result), /failed|\bok\b/);
});
