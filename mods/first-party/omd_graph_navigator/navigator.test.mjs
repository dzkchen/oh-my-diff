import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const runner = readFileSync(new URL('../../../runtime/omd/src/mods/runner.mjs', import.meta.url), 'utf8');
const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('./mod.json', import.meta.url), 'utf8'));
const surface = { events: { terminal: 'terminal' }, replacements: [], middleware: [], state: 'store', contracts: 'contracts' };
const digest = 'a'.repeat(64);
const node = 'module:src/main.ts';
const provenance = { workspace_snapshot: false, validation: 'double_list_and_hash' };
const search = { schema: 1, generator: 'omd-repository-analysis-five-language-v3', repository_identity: 'workspace', revision: 'live-source', source_digest: digest,
  rows: [{ id: node, label: 'src/main.ts', detail: 'module · 1 extracted' }], count: 1, page: 0, page_size: 32, provenance };
const packet = { schema: 1, graph_generator: search.generator, repository_identity: search.repository_identity, revision: search.revision, source_digest: digest,
  nodes: [{ id: node }], relationships: [], coverage: [], guidance: 'Verify inferred and unknown relationships against source.', provenance };
const call = (method, input) => ({ operation: 'mods.service', arguments: { name: 'omd.repository_analysis', method, input } });
function execute(input) {
  const result = spawnSync(process.execPath, ['--no-warnings', '--experimental-vm-modules', '--input-type=module', '--eval', runner], {
    input: JSON.stringify({ source, filename: 'index.ts', api: '0.2.0-experimental.1', surface, capabilities: ['commands', 'services', 'store', 'terminal'], settings: {}, state: null, event: 'inspect', ...input }),
    encoding: 'utf8', timeout: 5000,
  });
  assert.ifError(result.error);
  const output = JSON.parse(result.stdout);
  return { result, output };
}
function run(input) {
  const { result, output } = execute(input);
  assert.equal(result.status, 0, `${result.stderr}\n${output.error ?? ''}`);
  assert.equal(output.error, undefined, output.error);
  return output;
}
function runFailure(input) {
  const { result, output } = execute(input);
  assert.notEqual(result.status, 0);
  return output;
}
function rowFor(state) {
  const view = run({ event: 'terminal', state, payload: { event: 'idle' } });
  return view.value.sites.dialog.components[0].children.find(item => item.type === 'list').rows[0];
}

test('live graph navigator imports a service and inserts only revalidated bounded evidence', () => {
  assert.deepEqual(manifest.capabilities, ['commands', 'services', 'store', 'terminal']);
  assert.deepEqual(manifest.services.imports, [{ name: 'omd.repository_analysis', version: '1.0.0' }]);
  const opened = run({ event: 'command', name: 'open', payload: '', receipts: [{ call: call('search', { query: '', page: 0, root: '' }), value: search }] });
  assert.equal(opened.state.digest, digest);
  const row = rowFor(opened.state);
  assert.match(row.value, /^graph-row:/);
  assert.notEqual(row.value, node);
  const mounted = run({ event: 'terminal', state: opened.state, payload: { event: 'idle' } });
  assert.equal(mounted.value.sites.dialog.components[0].children.find(item => item.type === 'list').selected, row.value);
  const selected = run({ event: 'command', name: 'select', payload: row.value, state: opened.state,
    receipts: [{ call: call('select', { node_id: node, expected_source_digest: digest, root: '' }), value: packet }] });
  assert.match(selected.value.insert, /live source code-graph evidence/);
  assert.match(selected.value.insert, /"workspace_snapshot":false/);
  assert.equal(selected.state.open, false);
  assert.deepEqual(selected.calls.map(item => item.operation), ['mods.service']);
});

test('changed or malformed service evidence cannot be inserted', () => {
  const opened = run({ event: 'command', name: 'open', payload: '', receipts: [{ call: call('search', { query: '', page: 0, root: '' }), value: search }] });
  const token = rowFor(opened.state).value;
  const stale = runFailure({ event: 'command', name: 'search', payload: 'main', state: opened.state,
    receipts: [{ call: call('search', { query: 'main', page: 0, root: '', expected_source_digest: digest }), error: 'analysis_source_digest_stale' }] });
  assert.match(stale.error, /source_digest_stale/);
  const blocked = runFailure({ event: 'command', name: 'select', payload: token, state: opened.state,
    receipts: [{ call: call('select', { node_id: node, expected_source_digest: digest, root: '' }), error: 'analysis_source_digest_stale' }] });
  assert.match(blocked.error, /source_digest_stale/);
  const forged = run({ event: 'command', name: 'select', payload: token, state: opened.state,
    receipts: [{ call: call('select', { node_id: node, expected_source_digest: digest, root: '' }), value: { ...packet, provenance: { workspace_snapshot: true, validation: 'double_list_and_hash' } } }] });
  assert.match(forged.value.display, /does not match/);
  assert.equal(forged.state.open, true);
  for (const malformed of [node, 'graph-row:unknown', `${token}x`]) {
    const rejected = run({ event: 'command', name: 'select', payload: malformed, state: opened.state });
    assert.match(rejected.value.display, /select a visible graph node first/);
    assert.deepEqual(rejected.calls, []);
  }
  const refreshed = run({ event: 'command', name: 'refresh', state: opened.state,
    receipts: [{ call: call('search', { query: '', page: 0, root: '' }), value: search }] });
  assert.notEqual(rowFor(refreshed.state).value, token);
  const expired = run({ event: 'command', name: 'select', payload: token, state: refreshed.state });
  assert.match(expired.value.display, /select a visible graph node first/);
  assert.deepEqual(expired.calls, []);
});

test('provider-valid long node IDs survive state, terminal selection, and service dispatch', () => {
  const long = `module:${'x'.repeat(768 - 'module:'.length)}`;
  const response = { ...search, rows: [{ id: long, label: 'deep source', detail: 'module' }] };
  const opened = run({ event: 'command', name: 'open', payload: '', receipts: [{ call: call('search', { query: '', page: 0, root: '' }), value: response }] });
  assert.equal(opened.state.rows[0].id, long);
  const row = rowFor(opened.state);
  assert.notEqual(row.value, long);
  assert.ok(Buffer.byteLength(row.value, 'utf8') <= 256);
  const selected = run({ event: 'command', name: 'select', payload: row.value, state: opened.state,
    receipts: [{ call: call('select', { node_id: long, expected_source_digest: digest, root: '' }), value: { ...packet, nodes: [{ id: long }] } }] });
  assert.match(selected.value.insert, /live source code-graph evidence/);
  const tooLong = run({ event: 'command', name: 'open', payload: '', receipts: [{ call: call('search', { query: '', page: 0, root: '' }), value: { ...response, rows: [{ ...response.rows[0], id: `${long}x` }] } }] });
  assert.match(tooLong.state.error, /service response is invalid/);
});

test('UTF-8 insert limit refuses oversized evidence before closing the dialog', () => {
  const opened = run({ event: 'command', name: 'open', payload: '', receipts: [{ call: call('search', { query: '', page: 0, root: '' }), value: search }] });
  const token = rowFor(opened.state).value;
  const select = evidence => run({ event: 'command', name: 'select', payload: token, state: opened.state,
    receipts: [{ call: call('select', { node_id: node, expected_source_digest: digest, root: '' }), value: evidence }] });
  const baseline = select({ ...packet, guidance: '' });
  const padding = 16_384 - Buffer.byteLength(baseline.value.insert, 'utf8');
  assert.ok(padding > 0);
  const exact = select({ ...packet, guidance: 'x'.repeat(padding) });
  assert.equal(Buffer.byteLength(exact.value.insert, 'utf8'), 16_384);
  assert.equal(exact.state.open, false);
  const oneByteOver = select({ ...packet, guidance: 'x'.repeat(padding + 1) });
  assert.match(oneByteOver.value.display, /composer insertion limit/);
  assert.equal(oneByteOver.state.open, true);
  const oversized = { ...packet, guidance: 'é'.repeat(8100) };
  assert.ok(Buffer.byteLength(JSON.stringify(oversized), 'utf8') < 32 * 1024);
  const selected = select(oversized);
  assert.match(selected.value.display, /composer insertion limit/);
  assert.equal(selected.value.insert, undefined);
  assert.equal(selected.state.open, true);
  assert.equal(selected.state.digest, digest);
});

test('terminal row labels and spans meet exact byte and character bounds', () => {
  for (const [label, detail] of [
    ['A'.repeat(96), 'B'.repeat(180)],
    ['界'.repeat(96), 'é'.repeat(180)],
  ]) {
    const response = { ...search, rows: [{ id: node, label, detail }] };
    const opened = run({ event: 'command', name: 'open', payload: '', receipts: [{ call: call('search', { query: '', page: 0, root: '' }), value: response }] });
    const row = rowFor(opened.state);
    assert.ok(Buffer.byteLength(row.value, 'utf8') <= 256);
    assert.ok(Buffer.byteLength(row.label, 'utf8') <= 256);
    assert.ok([...row.label].length <= 256);
    assert.equal(Buffer.byteLength(row.spans[0].text, 'utf8'), 256);
    assert.ok([...row.spans[0].text].length <= 256);
    assert.ok(row.spans[0].text.startsWith(row.label));
  }
});
