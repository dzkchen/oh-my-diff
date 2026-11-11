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

test('viewed images keep the native clickable link while generated images are summarized', () => {
  const image = tool => ({ kind: 'image', call_id: 'img', tool, path: '/tmp/a.png', prompt: 'a cat', status: 'completed' });
  assert.deepEqual(render(image('view_image')).value.result.tree, [{ type: 'native' }]);
  assert.match(text(render(image('image_generation'))), /Generate image/);
});

test('a failed row adds its last output or error line below it', () => {
  const failed = render({ ...exec('one', 'failed'), output_tail: 'compiling\nerror: no such file\n\n' });
  assert.deepEqual(failed.value.result.tree.map(line => line.id), ['tool_lines_0', 'tool_lines_0_reason']);
  assert.equal(failed.value.result.tree[1].spans[0].text, '  └ error: no such file');
  const group = render({ kind: 'explore', call_id: 'one', status: 'completed', calls: [{ ...exec('one', 'failed'), output_tail: 'boom' }, exec('two')] });
  assert.match(text(group), /└ boom$/);
  const mcp = render({ kind: 'mcp', call_id: 'm', server: 's', tool: 't', arguments: {}, status: 'failed', duration_ms: 5, output_lines: null, error: 'timed out\ndetails' });
  assert.match(text(mcp), /└ timed out$/);
  assert.equal(render({ ...exec('two'), output_tail: 'fine' }).value.result.tree.length, 1);
});

test('a group marks its latest failure with the exit code and a muted error line', () => {
  const calls = [{ ...exec('one', 'failed'), exit_code: 2, output_tail: 'old' }, { ...exec('two', 'failed'), exit_code: 127, output_tail: 'sh: nope: not found' }, exec('three')];
  const tree = render({ kind: 'explore', call_id: 'one', status: 'completed', calls }, 60).value.result.tree;
  assert.match(tree[0].spans.map(span => span.text).join(''), /2 failed · exit 127/);
  assert.equal(tree[1].spans[0].text, '  └ sh: nope: not found');
  assert.equal(tree[1].spans[0].tone, 'muted');
  assert.doesNotMatch(text(render({ kind: 'explore', call_id: 'one', status: 'completed', calls: [exec('one'), exec('two')] })), /exit/);
  const narrow = render({ kind: 'explore', call_id: 'one', status: 'completed', calls: [{ ...exec('one', 'failed'), output_tail: 'x'.repeat(200) }, exec('two')] }, 40).value.result.tree[1];
  assert.ok([...narrow.spans[0].text].length <= 40);
});

test('host-shaped props render: unparsed shell, list and read calls in one failed group', () => {
  const shell = { ...exec('s', 'failed'), command: "sh -c 'exit 127'", exit_code: 127, parsed: [{ type: 'unknown', cmd: "sh -c 'exit 127'" }], output_tail: 'boom: compiler exploded' };
  const list = { ...exec('l'), command: 'ls', parsed: [{ type: 'list_files', cmd: 'ls', path: null }], exit_code: 0 };
  const read = { ...exec('r', 'failed'), command: 'cat missing.txt', parsed: [{ type: 'read', cmd: 'cat missing.txt', name: 'missing.txt', path: 'missing.txt' }], exit_code: 1, output_tail: null };
  const group = render({ kind: 'explore', call_id: 'l', status: 'failed', duration_ms: 9, calls: [list, read, shell] }).value.result.tree;
  assert.deepEqual(group.map(line => line.id), ['tool_lines_0', 'tool_lines_0_reason']);
  assert.match(text({ value: { result: { tree: group } } }), /1 list, 1 read, 1 command.*2 failed · exit 127.*└ boom: compiler exploded/);
  const single = render(shell).value.result.tree;
  assert.match(text({ value: { result: { tree: single } } }), /✗ Shell sh -c 'exit 127' · exit 127.*└ boom: compiler exploded/);
});
