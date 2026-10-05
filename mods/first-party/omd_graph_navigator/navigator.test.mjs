import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { runnerSync } from '../../../tests/mod_runner.mjs';

const runner = readFileSync(new URL('../../../runtime/omd/src/mods/runner.mjs', import.meta.url), 'utf8');
const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('./mod.json', import.meta.url), 'utf8'));
const surface = { events: { terminal: 'terminal', channel: 'events' }, replacements: [], middleware: [], state: 'store', contracts: 'contracts' };
const digest = 'a'.repeat(64);
const node = 'module:src/main.ts';
const provenance = { workspace_snapshot: false, validation: 'double_list_and_hash' };
const search = { schema: 1, generator: 'omd-repository-analysis-five-language-v3', repository_identity: 'workspace', revision: 'live-source', source_digest: digest,
  rows: [{ id: node, label: 'src/main.ts', detail: 'module · 1 extracted' }], count: 1, page: 0, page_size: 32, provenance };
const packet = { schema: 1, graph_generator: search.generator, repository_identity: search.repository_identity, revision: search.revision, source_digest: digest,
  nodes: [{ id: node }], relationships: [], coverage: [], guidance: 'Verify inferred and unknown relationships against source.', provenance };
const call = (method, input) => ({ operation: 'mods.service', arguments: { name: 'omd.repository_analysis', method, input } });
function execute(input) {
  const result = runnerSync({ source, filename: 'index.ts', api: '0.2.0-experimental.5', surface, capabilities: manifest.capabilities, settings: {}, state: null, event: 'inspect', ...input });
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
const ask = (op, argument = '', state = null, receipts = []) => run({ event: 'channel', state, receipts,
  payload: { publisher: 'omd_graph_navigator', channel: 'omd_graph_navigator/request', data: { op, argument }, correlation: null, sequence: 1, dropped: 0 } });
const draft = { call: { operation: 'composer.read', arguments: null }, value: { text: '', cursor: 0, selection: null, revision: 4, attachments: [], suggestion: null } };
const write = insert => ({ call: { operation: 'composer.write', arguments: { revision: 4, edit: { kind: 'insert', text: insert } } }, value: { text: insert, cursor: 0, revision: 5 } });
const open = (response = search) => ask('', '', null, [{ call: call('search', { query: '', page: 0, root: '' }), value: response }]);
function rowFor(state) {
  const view = run({ event: 'terminal', state, payload: { event: 'idle' } });
  return view.value.sites.dialog.components[0].children.find(item => item.type === 'list').rows[0];
}

test('the graph command hops to the native handler, which inserts only revalidated bounded evidence', () => {
  assert.deepEqual(manifest.services.imports, [{ name: 'omd.repository_analysis', version: '1.0.0' }]);
  const requested = run({ event: 'command', name: 'graph', payload: 'search main', receipts: [{ call: { operation: 'events.publish', arguments: { channel: 'request', data: { op: 'search', argument: 'main' } } }, value: { delivered: 1, dropped: 0 } }] });
  assert.equal(requested.state.open, true);
  assert.equal(run({ event: 'command', name: 'graph', payload: 'close', state: requested.state }).state.open, false);
  const opened = open();
  assert.equal(opened.state.digest, digest);
  const row = rowFor(opened.state);
  assert.match(row.value, /^graph-row:/);
  assert.notEqual(row.value, node);
  const mounted = run({ event: 'terminal', state: opened.state, payload: { event: 'idle' } });
  assert.equal(mounted.value.sites.dialog.components[0].children.find(item => item.type === 'list').selected, row.value);
  const packetCall = { call: call('select', { node_id: node, expected_source_digest: digest, root: '' }), value: packet };
  const insert = execute({ event: 'channel', state: opened.state, receipts: [packetCall, draft], payload: { publisher: 'omd_graph_navigator', channel: 'omd_graph_navigator/request', data: { op: 'select', argument: row.value }, correlation: null, sequence: 1, dropped: 0 } }).output.host_call.arguments.edit.text;
  assert.match(insert, /live source code-graph evidence/);
  assert.match(insert, /"workspace_snapshot":false/);
  const selected = ask('select', row.value, opened.state, [packetCall, draft, write(insert)]);
  assert.equal(selected.state.open, false);
});

test('changed or malformed service evidence cannot be inserted', () => {
  const opened = open();
  const token = rowFor(opened.state).value;
  const stale = ask('search', 'main', opened.state, [{ call: call('search', { query: 'main', page: 0, root: '', expected_source_digest: digest }), error: 'analysis_source_digest_stale' }]);
  assert.match(stale.state.error, /source_digest_stale/);
  const blocked = ask('select', token, opened.state, [{ call: call('select', { node_id: node, expected_source_digest: digest, root: '' }), error: 'analysis_source_digest_stale' }]);
  assert.match(blocked.state.error, /source_digest_stale/);
  const forged = ask('select', token, opened.state, [{ call: call('select', { node_id: node, expected_source_digest: digest, root: '' }), value: { ...packet, provenance: { workspace_snapshot: true, validation: 'double_list_and_hash' } } }]);
  assert.match(forged.state.error, /does not match/);
  assert.equal(forged.state.open, true);
  for (const malformed of [node, 'graph-row:unknown', `${token}x`]) assert.match(ask('select', malformed, opened.state).state.error, /select a visible graph node first/);
  const refreshed = ask('refresh', '', opened.state, [{ call: call('search', { query: '', page: 0, root: '' }), value: search }]);
  assert.notEqual(rowFor(refreshed.state).value, token);
  assert.match(ask('select', token, refreshed.state).state.error, /select a visible graph node first/);
});

test('provider-valid long node IDs survive state, terminal selection, and service dispatch', () => {
  const long = `module:${'x'.repeat(768 - 'module:'.length)}`;
  const response = { ...search, rows: [{ id: long, label: 'deep source', detail: 'module' }] };
  const opened = open(response);
  assert.equal(opened.state.rows[0].id, long);
  const row = rowFor(opened.state);
  assert.notEqual(row.value, long);
  assert.ok(Buffer.byteLength(row.value, 'utf8') <= 256);
  const selected = execute({ event: 'channel', state: opened.state, receipts: [{ call: call('select', { node_id: long, expected_source_digest: digest, root: '' }), value: { ...packet, nodes: [{ id: long }] } }, draft],
    payload: { publisher: 'omd_graph_navigator', channel: 'omd_graph_navigator/request', data: { op: 'select', argument: row.value }, correlation: null, sequence: 1, dropped: 0 } }).output;
  assert.match(selected.host_call.arguments.edit.text, /live source code-graph evidence/);
  assert.match(open({ ...response, rows: [{ ...response.rows[0], id: `${long}x` }] }).state.error, /service response is invalid/);
});

test('UTF-8 insert limit refuses oversized evidence before closing the dialog', () => {
  const opened = open();
  const token = rowFor(opened.state).value;
  const attempt = (evidence, read = [draft]) => execute({ event: 'channel', state: opened.state, receipts: [{ call: call('select', { node_id: node, expected_source_digest: digest, root: '' }), value: evidence }, ...read],
    payload: { publisher: 'omd_graph_navigator', channel: 'omd_graph_navigator/request', data: { op: 'select', argument: token }, correlation: null, sequence: 1, dropped: 0 } }).output;
  const baseline = attempt({ ...packet, guidance: '' }).host_call.arguments.edit.text;
  const padding = 16_384 - Buffer.byteLength(baseline, 'utf8');
  assert.ok(padding > 0);
  assert.equal(Buffer.byteLength(attempt({ ...packet, guidance: 'x'.repeat(padding) }).host_call.arguments.edit.text, 'utf8'), 16_384);
  const over = attempt({ ...packet, guidance: 'x'.repeat(padding + 1) }, []);
  assert.match(over.state.error, /composer insertion limit/);
  assert.equal(over.state.open, true);
  const oversized = { ...packet, guidance: 'é'.repeat(8100) };
  assert.ok(Buffer.byteLength(JSON.stringify(oversized), 'utf8') < 32 * 1024);
  const refused = attempt(oversized, []);
  assert.match(refused.state.error, /composer insertion limit/);
  assert.equal(refused.state.digest, digest);
});

test('terminal row labels and spans meet exact byte and character bounds', () => {
  for (const [label, detail] of [
    ['A'.repeat(96), 'B'.repeat(180)],
    ['界'.repeat(96), 'é'.repeat(180)],
  ]) {
    const row = rowFor(open({ ...search, rows: [{ id: node, label, detail }] }).state);
    assert.ok(Buffer.byteLength(row.value, 'utf8') <= 256);
    assert.ok(Buffer.byteLength(row.label, 'utf8') <= 256);
    assert.ok([...row.label].length <= 256);
    assert.equal(Buffer.byteLength(row.spans[0].text, 'utf8'), 256);
    assert.ok([...row.spans[0].text].length <= 256);
    assert.ok(row.spans[0].text.startsWith(row.label));
  }
});
