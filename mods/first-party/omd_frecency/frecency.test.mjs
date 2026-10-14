import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { callback } from '../../../tests/mod_runner.mjs';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('./mod.json', import.meta.url), 'utf8'));
const surface = { events: { turn_start: 'lifecycle', completion: 'composer' }, replacements: ['completion'], middleware: [], intercept: { input: 'input' }, state: 'store', contracts: 'contracts' };

function run(event, payload, host, name = '', state = null) {
  const request = { source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, state, settings: {}, event, name, payload, surface, hook_budget_ms: 2000 };
  const receipts = [];
  const output = callback(request, host, receipts, { capture: error => error.host === true });
  if (output.error) throw new Error(output.error);
  return { value: output.value, calls: output.calls, state: output.state, receipts };
}

function repository(files, status) {
  const writes = [];
  const host = ({ operation, arguments: args }) => {
    if (operation === 'store.get') return files && { value: files, revision: 3, provenance: {} };
    if (operation === 'store.put') {
      assert.ok(Buffer.byteLength(JSON.stringify(args.value)) <= 65_536, 'store_value_limit');
      assert.equal(args.expected_revision, files ? 3 : null);
      return writes.push(args.value), { revision: 4 };
    }
    if (operation === 'exec.run') {
      const limit = args.max_output_bytes ?? Infinity;
      return { exit_code: 0, stdout: Buffer.from(status).subarray(0, limit).toString(), stdout_truncated: Buffer.byteLength(status) > limit, stderr: '' };
    }
    if (operation === 'workspace.stat') return { files: Object.fromEntries(args.paths.map(path => [path, path.startsWith('old/') ? null : { kind: 'file', size: 1, mtime_ms: 0 }])) };
    throw new Error(operation);
  };
  return { host, writes };
}

test('mentions rank by fuzzy tier, frecency and Git status, tolerate typos and drop renamed files', () => {
  const files = { tick: 10, files: { 'test/parser_test.ts': [5, 10], 'old/parser.ts': [3, 9] } };
  const mention = (query, candidates) => {
    const { host, writes } = repository(files, ' M src/parser.ts\n?? "docs/new notes.md"\nR  a.ts -> src/moved.ts\n D gone.ts\n');
    const { value } = run('completion', { kind: 'mention', query, candidates: candidates.map(path => ({ path, score: 1 })) }, host);
    return { paths: value.items.map(item => item.path), writes };
  };
  const ranked = mention('parser', ['docs/parser-notes.md', 'src/parse.ts', 'src/parser.ts', 'test/parser_test.ts']);
  assert.deepEqual(ranked.paths, ['test/parser_test.ts', 'src/parser.ts', 'docs/parser-notes.md', 'src/parse.ts']);
  assert.deepEqual(ranked.writes, [{ tick: 10, files: { 'test/parser_test.ts': [5, 10] } }]);
  assert.deepEqual(mention('parsre', []).paths, ['test/parser_test.ts', 'src/parser.ts']);
  assert.equal(mention('Parser', ['src/Parser.java', 'src/parser.ts']).paths[0], 'src/Parser.java');
  assert.equal(mention('parser', ['src/Parser.java', 'src/parser.ts']).paths[0], 'test/parser_test.ts');
  assert.deepEqual(mention('', []).paths, ['test/parser_test.ts', 'src/parser.ts', 'src/moved.ts', 'docs/new notes.md']);
  assert.equal(run('completion', { kind: 'argument', command: 'note', query: '', line: '' }, () => { throw new Error('no host call'); }).value, null);
  const { host } = repository(null, '');
  assert.deepEqual(run('service', { query: 'tree', paths: ['src/tree.ts', 'src/treat.ts'] }, host, 'omd.frecency.rank').value, { paths: ['src/tree.ts', 'src/treat.ts'] });
  assert.deepEqual(run('service', { query: 'index logo', paths: ['mods/omd_logo/index.ts'] }, host, 'omd.frecency.rank').value, { paths: ['mods/omd_logo/index.ts'] });
  assert.equal(run('service', { query: 'tree', paths: Array.from({ length: 60 }, (_, index) => `src/tree${index}.ts`) }, host, 'omd.frecency.rank').value.paths.length, 60);
});

test('backfilled history is statted page by page, so deleted files never surface and are forgotten in one save', () => {
  const stale = Array.from({ length: 120 }, (_, index) => [`old/file${index}.ts`, [5, 10]]);
  const kept = Array.from({ length: 30 }, (_, index) => [`keep/file${index}.ts`, [1, 10]]);
  const { host, writes } = repository({ tick: 10, files: Object.fromEntries([...stale, ...kept]) }, ' M src/edited.ts\n');
  const { value, calls } = run('completion', { kind: 'mention', query: '', candidates: [{ path: 'src/a.ts', score: 1 }] }, host);
  const paths = value.items.map(item => item.path);
  assert.deepEqual(paths.filter(path => path.startsWith('old/')), []);
  assert.deepEqual(paths, ['src/edited.ts', ...kept.map(([path]) => path), 'src/a.ts']);
  assert.equal(calls.filter(call => call.operation === 'workspace.stat').length, 4);
  assert.equal(writes.length, 1);
  assert.deepEqual(Object.keys(writes[0].files), kept.map(([path]) => path));
});

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
  const { value, receipts } = run('completion', { kind: 'mention', query: '', candidates: [] }, host);
  assert.deepEqual(receipts.filter(receipt => 'error' in receipt), []);
  assert.equal(value.items.length, 50);
  assert.equal(writes.length, 1);
  assert.deepEqual(Object.keys(writes[0].files).filter(path => path.startsWith('old/')), []);
});

test('submitted prompts queue paths; the next turn learns only files Git does not ignore', () => {
  const none = () => { throw new Error('no host call'); };
  const submit = text => run('intercept', { surface: 'input', input: { text, attachments: 0 }, origin: { caller: 'user' } },
    call => call.operation === 'continuation.next' ? { result: { text: call.arguments.input.text }, trace: [] } : none(), '0');
  assert.equal(submit('explain the failing build').state, null);
  const queued = submit('Fix `@src/a.ts:12`, "docs/my notes.md" and (build/out.js)');
  assert.deepEqual(queued.value, { result: { text: 'Fix `@src/a.ts:12`, "docs/my notes.md" and (build/out.js)' } });
  assert.deepEqual(queued.state, ['src/a.ts', 'docs/my notes.md', 'build/out.js']);
  const { host, writes } = repository({ tick: 4, files: { 'src/a.ts': [2, 1] } }, 'src/a.ts\0docs/my notes.md\0');
  const learned = run('turn_start', { turn_id: 't' }, host, '', queued.state);
  assert.deepEqual(learned.calls[0].arguments.argv.slice(-3), ['src/a.ts', 'docs/my notes.md', 'build/out.js']);
  assert.deepEqual(writes, [{ tick: 5, files: { 'src/a.ts': [3, 5], 'docs/my notes.md': [1, 5] } }]);
  assert.equal(learned.state, null);
  assert.deepEqual(run('turn_start', { turn_id: 'u' }, none).calls, []);
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
