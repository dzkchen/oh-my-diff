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
  const input = { component: 'tool_call', props: { expanded: false, presentation: 'row', ...props }, viewport: { columns, rows: 40 } };
  const result = callback({ source, filename, api: manifest.api, capabilities: manifest.capabilities, event: 'intercept', name: '0',
    payload: { surface: 'render', input, original: input, origin: { caller: 'engine' } } }, () => ({ result: { tree: [{ type: 'native' }] }, trace: [] }));
  assert.equal(result.error, undefined, result.error);
  return result;
};
const text = result => result.value.result.tree.flatMap(line => line.spans ?? []).map(span => span.text).join('');

const tree = props => render(props).value.result.tree;
const group = (calls, status = 'completed') => ({ kind: 'explore', call_id: 'one', status, calls });
const read = (id, name) => ({ ...exec(id), command: `cat ${name}`, parsed: [{ type: 'read', cmd: `cat ${name}`, name, path: name }] });
const search = id => ({ ...exec(id), command: 'rg -n refine x.sh', parsed: [{ type: 'search', cmd: 'rg -n refine x.sh', query: 'refine', path: 'x.sh' }] });

test('a finished group is one muted line of verb phrases in first-use order', () => {
  const lines = tree(group([read('a', 'bench.py'), exec('b'), read('c', 'b.py'), search('d'), exec('e')]));
  assert.equal(lines.length, 1);
  assert.equal(text({ value: { result: { tree: lines } } }), '• Read files, ran commands, searched files');
  assert.ok(lines[0].spans.every(span => span.tone === 'muted'));
  assert.equal(text(render(group([exec('a'), exec('b')]))), '• Ran commands');
  assert.equal(text(render(group([read('a', 'x'), exec('b')]))), '• Read a file, ran a command');
  const two = { ...exec('c'), command: 'cat a b', parsed: ['a', 'b'].map(name => ({ type: 'read', cmd: `cat ${name}`, name, path: name })) };
  assert.equal(text(render(group([two, exec('d')]))), '• Read files, ran a command');
});

test('a running group shows its live step', () => {
  assert.equal(text(render(group([read('a', 'x'), exec('b', 'running')], 'running'))), '• Running cargo test b');
  assert.equal(text(render(group([exec('a'), { ...search('b'), status: 'running' }], 'running'))), '• Searching for refine in x.sh');
});

test('failures stay visible as a count with the latest exit code', () => {
  const calls = [{ ...exec('a', 'failed'), exit_code: 2 }, { ...exec('b', 'failed'), exit_code: 255 }, exec('c', 'interrupted')];
  const lines = tree(group(calls, 'failed'));
  assert.equal(text({ value: { result: { tree: lines } } }), '✗ Ran commands · 2 failed · exit 255 · 1 interrupted');
  assert.equal(lines[0].spans.at(-1).tone, 'failure');
  assert.equal(text(render({ ...exec('a', 'failed'), command: 'ls -lh /nope', exit_code: 2 })), '✗ Command failed (ls -lh /nope) · exit 2');
});

test('single rows read as one step', () => {
  assert.equal(text(render(read('a', 'bench.py'))), '• Read bench.py');
  assert.equal(text(render(group([search('a')]))), '• Searched for refine in x.sh');
  assert.equal(text(render(exec('a'))), '• cargo test a');
  assert.equal(text(render({ kind: 'web_search', call_id: 'w', status: 'completed', action: 'search', query: 'qwen docs' })), '• Searched the web for qwen docs');
  assert.equal(text(render({ kind: 'web_search', call_id: 'w', status: 'completed', action: 'other', query: '' })), '• Searched the web');
  assert.equal(text(render({ kind: 'patch', call_id: 'p', status: 'failed', file_count: 0, added: 0, removed: 0, error: '', files: [] })), '✗ Edit failed');
  assert.equal(text(render({ kind: 'patch', call_id: 'p', status: 'completed', file_count: 1, added: 9, removed: 3, error: null, files: [{ path: 'a.rs', change: 'update', added: 9, removed: 3 }] })), '• Edited a.rs · +9 −3');
  assert.equal(text(render({ kind: 'mcp', call_id: 'm', server: 's', tool: 't', arguments: {}, status: 'failed', duration_ms: 5, output_lines: null, error: 'timed out' })), '✗ Called s.t · timed out');
});

test('subagent rows name their agents', () => {
  const agent = (tool, status, agents) => render({ kind: 'agent', call_id: 'g', tool, status, duration_ms: null, agents, prompt: 'go' });
  assert.equal(text(agent('spawn_agent', 'completed', ['Papers', 'Code', 'Prior'])), '• Papers, Code and Prior started working');
  assert.equal(text(agent('wait', 'running', ['Papers'])), '• Waiting for Papers');
  assert.equal(text(agent('spawn_agent', 'failed', ['Papers'])), "✗ Couldn't start Papers");
  assert.equal(text(agent('spawn_agent', 'completed', [])), '• An agent started working');
});

const run = (calls, extra = {}) => ({ kind: 'run', call_id: 'r', status: 'completed', duration_ms: 5, calls, ...extra });
const web = { kind: 'web_search', call_id: 'w', status: 'completed', duration_ms: 5, action: 'search', query: 'qwen docs' };
const patch = { kind: 'patch', call_id: 'p', status: 'completed', duration_ms: 5, file_count: 1, added: 9, removed: 3, error: null, files: [{ path: 'a.rs', change: 'update', added: 9, removed: 3 }] };
const mcp = { kind: 'mcp', call_id: 'm', server: 's', tool: 't', arguments: {}, status: 'completed', duration_ms: 5, output_lines: null, error: null };
const sub = (agent, activity = 'started') => ({ kind: 'subagent', call_id: agent, activity, agent, path: `/root/${agent}`, model: null, effort: null, status: 'completed', duration_ms: null });

test('a run of mixed tools is one line of verb phrases in first-use order', () => {
  assert.equal(text(render(run([read('a', 'x'), exec('b'), web, read('c', 'y'), patch, mcp, exec('d')]))),
    '• Read files, ran commands, searched the web, edited a file, called a tool');
  assert.equal(text(render(run([read('a', 'x'), { ...exec('b', 'running'), command: 'git -C work status' }], { status: 'running' }))), '• Running git -C work status');
  assert.equal(text(render(run([{ ...exec('a', 'failed'), exit_code: 2 }, patch], { status: 'failed' }))), '✗ Ran a command, edited a file · 1 failed · exit 2');
  assert.equal(text(render(run([sub('Papers'), sub('Code'), sub('Prior')]))), '• Papers, Code and Prior started working');
  assert.equal(text(render(run([sub('Papers', 'completed'), exec('a')]))), '• Papers finished, ran a command');
  assert.equal(text(render(run([exec('a')], { status: 'failed', call_count: 70 }))), '✗ Ran a command');
  assert.equal(text(render(run([{ kind: 'future', call_id: 'f', status: 'completed', duration_ms: null }]))), '• Called a tool');
});

test('an opened run keeps its summary row and its steps read one per line', () => {
  assert.equal(text(render({ ...run([exec('a'), web]), expanded: true, presentation: 'opened' })), '• Ran a command, searched the web');
  assert.equal(text(render(sub('Papers'))), '• Papers started working');
  assert.equal(text(render(sub('Papers', 'interacted'))), '• Messaged Papers');
  for (const props of [run([exec('a')]), exec('a'), sub('Papers')]) {
    assert.deepEqual(tree({ ...props, expanded: true, presentation: 'transcript' }), [{ type: 'native' }]);
  }
});

test('expanded rows, user shell commands and viewed images keep the native drawing', () => {
  for (const props of [{ ...group([exec('one'), exec('two')]), expanded: true }, { ...exec('one'), user_shell: true },
    { kind: 'image', call_id: 'img', tool: 'view_image', path: '/tmp/a.png', prompt: null, status: 'completed' }]) {
    assert.deepEqual(tree(props), [{ type: 'native' }]);
  }
});

test('narrow terminals keep the line within the width', () => {
  const failed = { ...exec('a', 'failed'), command: 'x'.repeat(200), exit_code: 127 };
  for (const props of [failed, group([failed, exec('b')])]) {
    const shown = text(render(props, 40));
    assert.ok([...shown].length <= 40, shown);
    assert.match(shown, /exit 127$/);
  }
});
