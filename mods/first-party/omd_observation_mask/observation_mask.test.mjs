import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { callback } from '../../../tests/mod_runner.mjs';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('./mod.json', import.meta.url), 'utf8'));
const settings = { keep_recent: 2, min_bytes: 1000, batch_bytes: 10_000 };

function run(event, name, payload, { state = null, store = new Map(), host = {} } = {}) {
  const calls = [];
  const output = callback({ source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, state, settings, event, name, payload }, call => {
    calls.push(call);
    if (call.operation === 'store.get') return store.has(call.arguments.key) ? { value: store.get(call.arguments.key), revision: 1, provenance: {} } : null;
    if (call.operation === 'store.put') return store.set(call.arguments.key, call.arguments.value), { revision: 1 };
    if (host[call.operation]) return host[call.operation](call.arguments);
    assert.fail(`unexpected ${call.operation}`);
  });
  if (output.error) throw new Error(output.error);
  return { value: output.value, state: output.state, calls, store };
}

const exec = (code, line) => `Chunk ID: a\nWall time: 0.1\nProcess exited with code ${code}\nOriginal token count: 9\nOutput:\n${line}\n`;
function view(sizes, { agent = null } = {}) {
  const items = sizes.flatMap((bytes, n) => [
    { index: 2 * n, type: 'function_call', role: null, call_id: `c${n}`, editable: true, images: 0, text: '{"cmd":"pytest"}', bytes: 16 },
    { index: 2 * n + 1, type: 'function_call_output', role: null, call_id: `c${n}`, editable: true, images: 0, text: exec(n % 2, `line ${n}`), bytes },
  ]);
  items.push({ index: items.length, type: 'message', role: 'user', call_id: null, editable: false, images: 0, text: 'go', bytes: 2 });
  return { thread_id: 't', agent_id: agent, model: 'm', items };
}
const replaced = value => Object.fromEntries((value?.replace ?? []).map(edit => [edit.index, edit.text]));

test('nothing is hidden until older large outputs reach a batch, then all of them are hidden at once', () => {
  const below = run('history', '', view([4000, 4000, 500, 4000, 4000]));
  assert.equal(below.value, null);
  assert.equal(below.state.pending_bytes, 8000);
  const calls = { c0: { tool: 'exec_command', reference: { reference: 'r0', sha256: 's' }, bytes: 4000, failed_edit: false } };
  const { value, state } = run('history', '', view([4000, 4000, 500, 4000, 4000, 4000]), { state: { ...below.state, calls } });
  const edits = replaced(value);
  assert.deepEqual(Object.keys(edits).map(Number), [1, 3, 7], 'short outputs and the newest two stay');
  assert.equal(edits[1], '[omd_observation_mask hid this older exec_command output (4000 bytes, exit 0, first line "line 0"). Read it with mod_omd_observation_mask_recall {"call_id":"c0"}.]');
  assert.match(edits[3], /older tool output \(4000 bytes, exit 1, first line "line 1"\)\. Its full text was not kept/);
  assert.deepEqual([state.advances, state.hidden_bytes, state.pending_bytes], [1, 12000, 0]);
  assert.equal(state.last_saved_bytes, 12000 - edits[1].length - edits[3].length - edits[7].length);
});

test('hidden outputs keep identical stubs and the boundary only moves at the next full batch', () => {
  const first = run('history', '', view([4000, 4000, 4000, 4000, 4000]));
  const stubs = replaced(first.value);
  assert.deepEqual(Object.keys(stubs).map(Number), [1, 3, 5]);
  const second = run('history', '', view([4000, 4000, 4000, 4000, 4000, 4000, 4000]), { state: first.state });
  assert.deepEqual(replaced(second.value), stubs, 'the prefix is unchanged while the new region is under a batch');
  assert.equal(second.state.advances, 1);
  assert.equal(second.state.pending_bytes, 8000);
  const third = run('history', '', view([4000, 4000, 4000, 4000, 4000, 4000, 4000, 4000]), { state: second.state });
  assert.deepEqual(Object.keys(replaced(third.value)).map(Number), [1, 3, 5, 7, 9, 11]);
  assert.equal(third.state.advances, 2);
});

test('failed edits and pinned outputs are never hidden, and a pin restores a hidden output', () => {
  const calls = { c1: { tool: 'apply_patch', reference: null, bytes: 6000, failed_edit: true } };
  const first = run('history', '', view([6000, 6000, 6000, 1, 1]), { state: { calls } });
  assert.deepEqual(Object.keys(replaced(first.value)).map(Number), [1, 5]);
  assert.deepEqual(first.state.kept, ['c1']);
  const pinned = run('tool', 'recall', { call_id: 'c0', pin: true }, { state: first.state });
  assert.deepEqual(pinned.value, { call_id: 'c0', pinned: true });
  const after = run('history', '', view([6000, 6000, 6000, 1, 1, 9000, 9000, 1, 1]), { state: pinned.state });
  assert.deepEqual(Object.keys(replaced(after.value)).map(Number), [5, 11, 13]);
});

test('recall reads the kept original in pages and names a missing one', () => {
  const state = { calls: { c0: { tool: 'exec_command', reference: { reference: 'r0', sha256: 's' }, bytes: 70000, failed_edit: false } } };
  const host = { 'evidence.read': ({ reference, cursor, max_bytes }) => ({ reference, text: `page ${cursor ?? 0}/${max_bytes}`, cursor: 32768, bytes: 70000 }) };
  assert.deepEqual(run('tool', 'recall', { call_id: 'c0' }, { state, host }).value,
    { call_id: 'c0', tool: 'exec_command', bytes: 70000, text: 'page 0/32768', next_cursor: 32768 });
  assert.throws(() => run('tool', 'recall', { call_id: 'c9' }), /recall_unavailable: no kept output for c9/);
});

test('large outputs of the thread\'s own calls are kept for recall; small, subagent and code-mode ones are not', () => {
  const call = (bytes, { agent = null, caller = 'model', success = true, cmd = 'pytest' } = {}) => {
    const input = { tool: 'exec_command', arguments: { cmd }, call_id: 'k', thread_id: 't', agent_id: agent, schema: null, raw_arguments: '{}', batch: null };
    const host = {
      'continuation.next': () => ({ result: { output: 'x', success, bytes }, trace: [] }),
      'tools.original': ({ call_id }) => ({ reference: { reference: `ref-${call_id}`, sha256: 's' }, sha256: 's', bytes }),
    };
    return run('intercept', '0', { surface: 'tool', input, original: input, origin: { caller } }, { host }).state?.calls?.k;
  };
  assert.deepEqual(call(5000, { success: false }), { tool: 'exec_command', reference: { reference: 'ref-k', sha256: 's' }, bytes: 5000, failed_edit: false });
  assert.equal(call(5000, { success: false, cmd: "sed -i 's/a/b/' a.py" }).failed_edit, true);
  assert.equal(call(5000, { success: false, cmd: 'node -e "x => x.y"' }).failed_edit, false);
  assert.equal(call(5000, { success: false, cmd: 'pytest 2>&1 | tee out.log' }).failed_edit, false, 'a failing run saved to a log can still be hidden');
  assert.equal(call(999), undefined);
  assert.equal(call(5000, { agent: 'sub' }), undefined);
  assert.equal(call(5000, { caller: 'code_mode' }), undefined);
});

test('subagent requests are left alone and other prompt-prefix changes are counted', () => {
  assert.equal(run('history', '', view([9000, 9000, 9000, 1, 1], { agent: 'sub' })).value, null);
  const input = { scope: { thread_id: 't', agent_id: null, kind: 'main' } };
  const next = from => ({ 'continuation.next': () => ({ result: { route: 'r', effort: null, cache: { from } }, trace: [] }) });
  const store = new Map();
  run('intercept', '1', { surface: 'model_request', input, original: input, origin: { caller: 'engine' } }, { store, host: next(null) });
  assert.equal(store.has('breaks'), false);
  run('intercept', '1', { surface: 'model_request', input, original: input, origin: { caller: 'engine' } }, { store, host: next('instructions') });
  run('intercept', '1', { surface: 'model_request', input, original: input, origin: { caller: 'engine' } }, { store, host: next('tools') });
  assert.deepEqual(store.get('breaks'), { count: 2, last: 'tools' });
});
