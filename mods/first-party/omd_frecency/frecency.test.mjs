import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { callback } from '../../../tests/mod_runner.mjs';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('./mod.json', import.meta.url), 'utf8'));

function run(event, payload, host, name = '', state = null) {
  const request = { source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, state, settings: {}, event, name, payload, hook_budget_ms: 2000 };
  const receipts = [];
  const output = callback(request, host, receipts, { capture: error => error.host === true });
  if (output.error) throw new Error(output.error);
  return { value: output.value, calls: output.calls, state: output.state, receipts };
}

function repository(files, status) {
  const writes = [];
  const store = {};
  let execs = 0;
  const host = ({ operation, arguments: args }) => {
    if (operation === 'store.get' && args.key === 'status') return store.status ?? null;
    if (operation === 'store.get') return files && { value: files, revision: 3, provenance: {} };
    if (operation === 'store.put') {
      assert.ok(Buffer.byteLength(JSON.stringify(args.value)) <= 65_536, 'store_value_limit');
      if (args.key === 'status') return store.status = { value: args.value, revision: (store.status?.revision ?? 0) + 1, provenance: {} }, { revision: store.status.revision };
      assert.equal(args.expected_revision, files ? 3 : null);
      return writes.push(args.value), { revision: 4 };
    }
    if (operation === 'exec.run') {
      execs++;
      const limit = args.max_output_bytes ?? Infinity;
      return { exit_code: 0, stdout: Buffer.from(status).subarray(0, limit).toString(), stdout_truncated: Buffer.byteLength(status) > limit, stderr: '' };
    }
    if (operation === 'workspace.stat') return { files: Object.fromEntries(args.paths.map(path => [path, path.startsWith('old/') ? null : { kind: 'file', size: 1, mtime_ms: 0 }])) };
    throw new Error(operation);
  };
  return { host, writes, execs: () => execs };
}

test('a failed existence check keeps history entries instead of hiding them', () => {
  const { host, writes } = repository({ tick: 10, files: { 'notes/plan.md': [5, 10] } }, '');
  const failing = call => {
    if (call.operation === 'workspace.stat') throw Object.assign(new Error('workspace_stat_failed'), { host: true });
    return host(call);
  };
  assert.deepEqual(run('completion', { kind: 'mention', query: 'plan', candidates: [] }, failing).value.items, [{ path: 'notes/plan.md' }]);
  assert.deepEqual(writes, []);
});

test('ranking a full history beside a large Git status keeps every host call inside the receipt budget', () => {
  const entries = prefix => Array.from({ length: 70 }, (_, index) => `${prefix}/${'a'.repeat(200)}${index}.ts`);
  const files = { tick: 10, files: Object.fromEntries([...entries('old').map(path => [path, [5, 10]]), ...entries('keep').map(path => [path, [1, 10]])]) };
  assert.ok(Buffer.byteLength(JSON.stringify(files)) <= 32_000);
  const status = Array.from({ length: 3000 }, (_, index) => `?? untracked/file${index}.ts\n`).join('');
  const { host, writes } = repository(files, status);
  for (const refresh of [true, false]) {
    const { value, receipts } = run('completion', { kind: 'mention', query: '', candidates: [] }, host);
    assert.deepEqual(receipts.filter(receipt => 'error' in receipt), []);
    assert.equal(receipts.some(receipt => receipt.call.operation === 'exec.run'), refresh);
    assert.equal(value.items.length, 50);
  }
  assert.deepEqual(Object.keys(writes.at(-1).files).filter(path => path.startsWith('old/')), []);
});

test('mention queries typed within the cache window reuse one Git status', () => {
  const { host, execs } = repository(null, ' M src/parser.ts\n');
  const query = (now, text) => callback({ source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, state: null, settings: {},
    event: 'completion', name: '', payload: { kind: 'mention', query: text, candidates: [{ path: 'src/lexer.ts' }] }, hook_budget_ms: 2000, virtual_time_ms: now }, host).value.items;
  assert.deepEqual(query(1_000, 'p'), [{ path: 'src/parser.ts' }, { path: 'src/lexer.ts' }]);
  assert.deepEqual(query(2_000, 'pa'), [{ path: 'src/parser.ts' }, { path: 'src/lexer.ts' }]);
  assert.equal(execs(), 1);
  query(40_000, 'par');
  assert.equal(execs(), 2);
});

for (const [label, component, count] of [['Unicode', '雪'.repeat(60), 100], ['JSON escaping', '\\'.repeat(120), 64]]) {
  test(`learning trims serialized UTF-8 storage bytes for ${label}`, () => {
    const path = index => `${component}/${component.slice(0, label === 'Unicode' ? 40 : 120)}${String(index).padStart(3, '0')}.ts`;
    const files = { tick: 0, files: Object.fromEntries(Array.from({ length: count }, (_, index) => [path(index), [1, 0]])) };
    const initialBytes = Buffer.byteLength(JSON.stringify(files));
    assert.ok(initialBytes > 30_000 && initialBytes <= 32_000);
    const tokens = Array.from({ length: 16 }, (_, index) => path(count + index));
    const queued = run('intercept', { surface: 'input', input: { text: tokens.join(' '), attachments: 0 }, origin: { caller: 'user' } },
      call => ({ result: { text: call.arguments.input.text }, trace: [] }), '0').state;
    assert.deepEqual(queued, tokens);
    assert.ok(Buffer.byteLength(JSON.stringify({ tick: 1, files: { ...files.files, ...Object.fromEntries(tokens.map(path => [path, [1, 1]])) } })) > 32_000);
    const { host, writes } = repository(files, tokens.join('\0') + '\0');
    const learned = run('turn_start', { turn_id: 'unicode' }, host, '', queued);
    assert.equal(learned.state, null);
    assert.equal(writes.length, 1);
    assert.ok(Buffer.byteLength(JSON.stringify(writes[0])) < 32_000);
    assert.equal(writes[0].tick, 1);
    for (const path of tokens) assert.deepEqual(writes[0].files[path], [1, 1]);
    const retained = Object.keys(writes[0].files);
    const old = retained.filter(name => !tokens.includes(name));
    assert.deepEqual(old, Array.from({ length: old.length }, (_, index) => path(index)));
  });
}
