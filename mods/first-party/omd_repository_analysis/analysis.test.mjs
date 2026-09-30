import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const runner = readFileSync(new URL('../../../runtime/omd/src/mods/runner.mjs', import.meta.url), 'utf8');
const surface = { events: {}, replacements: [], middleware: [], state: 'store', contracts: 'contracts' };
const hash = text => createHash('sha256').update(text).digest('hex');
const candidate = 'a'.repeat(64);
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, sorted(item)])) : value;

function run(name, payload, receipts = [], event = 'tool') {
  const request = { source, filename: 'omd_repository_analysis.ts', api: '0.2.0-experimental.5', capabilities: ['tools', 'services', 'fs.read', 'store'], environment: ['crypto'],
    state: null, settings: {}, event, name, payload, receipts, surface, hook_budget_ms: 3000 };
  const result = spawnSync(process.execPath, ['--no-warnings', '--experimental-vm-modules', '--input-type=module', '--eval', runner], {
    input: JSON.stringify(request), encoding: 'utf8', timeout: 6000,
  });
  assert.ifError(result.error);
  return JSON.parse(result.stdout);
}

function replay(name, payload, files, saved = null, stale = false, event = 'tool') {
  const receipts = [];
  const calls = [];
  let written = null;
  for (let index = 0; index < 40; index++) {
    const output = run(name, payload, receipts, event);
    if (!output.host_call) return { output, calls, written };
    const call = output.host_call;
    calls.push(call);
    let value;
    if (['workspace.snapshot', 'workspace.fingerprint'].includes(call.operation)) {
      if (call.arguments.expected && stale) {
        receipts.push({ call, error: 'workspace_candidate_stale' });
        continue;
      }
      value = { snapshot: { reference: 'fixture', sha256: candidate }, candidate_sha256: candidate };
    } else if (call.operation === 'workspace.list') {
      const entries = Object.entries(files).map(([path, text]) => ({ path, kind: 'file', size: Buffer.byteLength(text), mtime_ms: 1 }));
      value = { entries: stale && event === 'service' && calls.filter(item => item.operation === 'workspace.list').length > 1 ? entries.slice(1) : entries,
        truncated: false };
    } else if (call.operation === 'workspace.read') {
      value = { files: Object.fromEntries(call.arguments.paths.map(path => [path, { text: files[path], sha256: hash(files[path]) }])) };
    } else if (call.operation === 'workspace.stat') {
      value = { files: Object.fromEntries(call.arguments.paths.map(path => [path, files[path] === undefined ? null
        : { kind: 'file', size: Buffer.byteLength(files[path]), mtime_ms: 1, sha256: hash(files[path]) }])) };
    } else if (call.operation === 'store.get') {
      value = saved ? { value: sorted(saved), revision: 1, provenance: { mod: 'omd_repository_analysis', source_sha256: candidate, thread_id: null, origin: 'tool', at: 1 } } : null;
    } else if (call.operation === 'store.put') {
      written = call.arguments.value;
      value = { revision: 1 };
    } else assert.fail(`unexpected operation ${call.operation}`);
    receipts.push({ call, value });
  }
  assert.fail('analysis did not finish');
}

const graphInput = { repository_identity: 'fixture/repository', revision: 'r1' };
const graphFiles = {
  'src/lib.rs': 'mod worker;\nuse crate::worker::run;\npub fn entry() { run(); mystery(); }\n',
  'src/worker.rs': 'pub fn run() { service(); }\nfn service() {}\n',
  'tests/graph_test.rs': 'use crate::worker::run;\n#[test]\nfn test_run() { run(); }\n',
};
const healthFiles = {
  'src/domain/legacy.rs': 'use crate::infra::db;\npub fn legacy() { db(); }\n',
  'src/infra/db.rs': 'pub fn db() {}\n',
};
const constraints = { schema: 1, version: 'approved-v1', repository_identity: 'fixture/repository', approval: { actor: 'maintainer', reason: 'approved boundary' },
  dependency_boundaries: [{ id: 'domain-infra', from_prefix: 'src/domain', denied_to_prefix: 'src/infra' }], repair_scope: ['src/domain'], max_findings: 64 };

test('graph retains extracted imports, inferred calls, unknown targets, and stable source digest', () => {
  const first = replay('graph', graphInput, graphFiles).output;
  assert.equal(first.error, undefined, first.error);
  const graph = first.value;
  assert.ok(graph.edges.some(edge => edge.relationship === 'imports' && edge.confidence === 'extracted'));
  assert.ok(graph.edges.some(edge => edge.relationship === 'calls' && edge.confidence === 'inferred'));
  assert.ok(graph.edges.some(edge => edge.confidence === 'unknown'));
  assert.ok(graph.nodes.some(node => node.kind === 'test'));
  assert.equal(replay('graph', graphInput, graphFiles).output.value.source_digest, graph.source_digest);
  const selected = replay('select', { ...graphInput, expected_source_digest: graph.source_digest, node_ids: ['symbol:src/lib.rs:3:entry'] }, graphFiles).output;
  assert.equal(selected.error, undefined, selected.error);
  assert.ok(selected.value.relationships.some(edge => edge.confidence === 'inferred'));
  assert.equal(selected.value.source_digest, graph.source_digest);
  assert.match(replay('graph', { ...graphInput, expected_source_digest: '0'.repeat(64) }, graphFiles).output.error, /analysis_source_digest_stale/);
  assert.match(replay('select', { ...graphInput, expected_source_digest: graph.source_digest, node_ids: ['missing'] }, graphFiles).output.error, /analysis_selection_unknown/);
  assert.match(replay('graph', graphInput, graphFiles, null, true).output.error, /workspace_candidate_stale/);
});

test('HTML view is source-bound and escapes repository path content', () => {
  const files = { 'src/evil<script>.rs': 'pub fn entry() { mystery(); }\n' };
  const graph = replay('graph', graphInput, files).output.value;
  const rendered = replay('html', { ...graphInput, expected_source_digest: graph.source_digest }, files).output;
  assert.equal(rendered.error, undefined, rendered.error);
  assert.ok(rendered.value.html.includes('src/evil&lt;script&gt;.rs'));
  assert.ok(!rendered.value.html.includes('src/evil<script>.rs'));
  assert.ok(rendered.value.html.includes(graph.source_digest));
  assert.match(rendered.value.html, /id="source-0"/);
  assert.match(rendered.value.html, /href="#source-0" data-path="src\/evil&lt;script&gt;\.rs" data-line="1" data-sha256="[a-f0-9]{64}"/);
  assert.match(rendered.value.html, /href="src\/evil%3Cscript%3E\.rs#L1">Open source<\/a>/);
  assert.match(rendered.value.html, /id="search"/);
  assert.match(rendered.value.html, /id="confidence"/);
  assert.match(rendered.value.html, /id="node"/);
  assert.match(rendered.value.html, /id="diagram"/);
  assert.match(rendered.value.html, /id="related"/);
  const behavior = rendered.value.html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(behavior);
  assert.doesNotThrow(() => new Script(behavior));
  assert.equal(replay('html', { ...graphInput, expected_source_digest: graph.source_digest }, files).output.value.html, rendered.value.html);
  assert.match(replay('html', { ...graphInput, expected_source_digest: '0'.repeat(64) }, files).output.error, /analysis_source_digest_stale/);
});

test('commented imports do not become deterministic boundary findings and unsupported syntax is unknown', () => {
  const files = { ...healthFiles, 'src/domain/comment.rs': '// use crate::infra::db;\nuse crate::{infra::db};\n' };
  const graph = replay('graph', graphInput, files).output.value;
  assert.ok(graph.edges.some(edge => edge.evidence.path === 'src/domain/comment.rs' && edge.confidence === 'unknown'));
  assert.ok(!graph.edges.some(edge => edge.evidence.path === 'src/domain/comment.rs' && edge.confidence === 'extracted' && edge.relationship === 'imports'));
  const result = replay('baseline', { ...graphInput, constraints }, files).output;
  assert.equal(result.error, undefined, result.error);
  assert.equal(result.value.baseline.observations.filter(item => item.evidence.path === 'src/domain/comment.rs').length, 0);
});

test('health separates existing deterministic debt, introduced boundaries, and unknown targets', () => {
  const input = { ...graphInput, constraints };
  const initial = replay('baseline', input, healthFiles);
  assert.equal(initial.output.error, undefined, initial.output.error);
  assert.equal(initial.output.value.baseline.observations.length, 1);
  assert.equal(initial.written.integrity_sha256, initial.output.value.baseline.integrity_sha256);
  const changed = { ...healthFiles, 'src/domain/new.rs': 'use crate::infra::db;\nuse crate::infra::missing;\npub fn more() {}\n' };
  const checked = replay('check', { ...input, revision: 'r2' }, changed, initial.written).output;
  assert.equal(checked.error, undefined, checked.error);
  assert.equal(checked.value.existing_debt.length, 1);
  assert.equal(checked.value.introduced_findings.length, 1);
  assert.equal(checked.value.uncertain_findings.length, 1);
  assert.equal(checked.value.introduced_findings[0].repair, 'authorized_scope_metadata');
  assert.notEqual(checked.value.current_source_digest, checked.value.baseline_source_digest);
});

test('health rejects duplicate baselines, changed constraints, tampered baselines, and unsafe scope', () => {
  const input = { ...graphInput, constraints };
  const saved = replay('baseline', input, healthFiles).written;
  assert.equal(saved.generator, 'omd-repository-analysis-five-language-v3');
  assert.match(replay('baseline', input, healthFiles, saved).output.error, /analysis_baseline_exists/);
  assert.match(replay('check', input, healthFiles, { ...saved, generator: 'omd-repository-analysis-five-language-v2' }).output.error, /analysis_baseline_invalid/);
  assert.match(replay('check', { ...input, constraints: { ...constraints, version: 'changed' } }, healthFiles, saved).output.error, /analysis_constraints_stale/);
  assert.match(replay('check', input, healthFiles, { ...saved, source_digest: '0'.repeat(64) }).output.error, /analysis_baseline_invalid/);
  assert.match(run('graph', { ...graphInput, root: '../outside' }).error, /analysis_scope_invalid/);
});

test('graph extracts five languages with source-bound imports and unknown Java targets', () => {
  const files = { ...graphFiles,
    'app.py': 'from service import handle\ndef py_call():\n    handle()\n',
    'service.py': 'def handle():\n    pass\n',
    'client.ts': "import { helper } from './helper';\nexport function invoke() { helper(); }\n",
    'helper.ts': 'export function helper() {}\n',
    'client.js': "import { help } from './helper.js';\nexport function start() { help(); }\n",
    'helper.js': 'export function help() {}\n',
    'Demo.java': 'import demo.Missing;\nclass Demo { void execute() { absent(); } }\n',
  };
  const result = replay('graph', graphInput, files).output;
  assert.equal(result.error, undefined, result.error);
  const graph = result.value;
  assert.deepEqual([...new Set(graph.sources.map(item => item.language))].sort(), ['java', 'javascript', 'python', 'rust', 'typescript']);
  for (const [from, to] of [['app.py', 'service.py'], ['client.ts', 'helper.ts'], ['client.js', 'helper.js'], ['src/lib.rs', 'src/worker.rs']]) {
    assert.ok(graph.edges.some(edge => edge.relationship === 'imports' && edge.evidence.path === from && edge.to === `module:${to}` && edge.confidence === 'extracted'), `${from} -> ${to}`);
  }
  assert.ok(graph.edges.some(edge => edge.evidence.path === 'Demo.java' && edge.relationship === 'imports' && edge.confidence === 'unknown'));
  assert.ok(!graph.edges.some(edge => edge.relationship === 'imports' && edge.confidence === 'unknown'
    && (edge.detail.includes('export function invoke') || edge.detail.includes('export function helper'))));
  assert.ok(graph.nodes.some(node => node.name === 'py_call'));
  assert.ok(graph.nodes.some(node => node.name === 'invoke'));
  assert.equal(graph.unsupported_languages.length, 0);
  assert.equal(replay('graph', graphInput, files).output.value.source_digest, graph.source_digest);
  const changed = { ...files, 'helper.ts': 'export function helper() { return 1; }\n' };
  assert.match(replay('select', { ...graphInput, expected_source_digest: graph.source_digest, node_ids: ['module:helper.ts'] }, changed).output.error, /analysis_source_digest_stale/);
});

test('retained eight-file graph keeps a resolvable TypeScript import extracted', () => {
  const files = { ...graphFiles,
    'app.py': 'from service import handle\ndef py_call():\n    handle()\n',
    'service.py': 'def handle():\n    pass\n',
    'client.ts': "import { helper } from './helper';\nexport function invoke() { helper(); }\n",
    'helper.ts': 'export function helper() {}\n',
    'Demo.java': 'import demo.Missing;\nclass Demo { void execute() { absent(); } }\n',
  };
  const result = replay('graph', graphInput, files).output;
  assert.equal(result.error, undefined, result.error);
  assert.equal(result.value.sources.length, 8);
  assert.equal(result.value.nodes.length, 22);
  assert.ok(result.value.edges.some(edge => edge.evidence.path === 'client.ts' && edge.relationship === 'imports'
    && edge.to === 'module:helper.ts' && edge.confidence === 'extracted'));
  assert.ok(!result.value.nodes.some(node => node.kind === 'unknown' && node.name === './helper'));
  assert.ok(result.value.nodes.some(node => node.kind === 'unknown' && node.name === 'demo.Missing'));
});

test('native lexical declarations, test names and ambiguous calls have distinct nodes', () => {
  const files = {
    'src/types.rs': 'pub type Item = u8;\nfn helper() {}\n',
    'src/other.rs': 'fn helper() {}\nfn caller() { helper(); }\n',
    'src/main.rs': 'fn entry() { helper(); }\n',
    '__tests__/Widget.java': 'record Widget(int value) {}\nclass WidgetTest {}\n',
  };
  const result = replay('graph', graphInput, files).output;
  assert.equal(result.error, undefined, result.error);
  const nodes = result.value.nodes;
  assert.ok(nodes.some(node => node.id === 'symbol:src/types.rs:1:Item'));
  assert.ok(nodes.some(node => node.id === 'symbol:__tests__/Widget.java:1:Widget' && node.kind === 'test'));
  assert.ok(nodes.some(node => node.id === 'symbol:__tests__/Widget.java:2:WidgetTest' && node.kind === 'test'));
  assert.ok(nodes.some(node => node.id === 'unknown:ambiguous_call:helper'));
  assert.ok(result.value.edges.some(edge => edge.evidence.path === 'src/main.rs' && edge.to === 'unknown:ambiguous_call:helper'
    && edge.confidence === 'unknown'));
  assert.ok(result.value.edges.some(edge => edge.evidence.path === 'src/other.rs' && edge.to === 'symbol:src/other.rs:1:helper'
    && edge.confidence === 'inferred'));
});

test('health records introduced duplication and weakened verification as inferred findings', () => {
  const approved = { ...constraints,
    duplication_scopes: [{ id: 'domain-logic', path_prefixes: ['src/domain'], minimum_logical_lines: 3 }],
    verification: [{ id: 'domain-tests', test_path_prefix: 'tests', minimum_tests: 1, minimum_assertions_per_test: 1 }] };
  const initialFiles = { ...healthFiles,
    'src/domain/order.rs': 'pub fn calculate() {\n    validate();\n    persist();\n}\n',
    'tests/order_test.rs': '#[test]\nfn order_test() {\n    assert_eq!(1 + 1, 2);\n}\n' };
  const initial = replay('baseline', { ...graphInput, constraints: approved }, initialFiles);
  assert.equal(initial.output.error, undefined, initial.output.error);
  assert.equal(initial.written.checks.length, 1);
  const changed = { ...initialFiles,
    'src/domain/new.rs': 'use crate::infra::db;\npub fn calculate_copy() {\n    validate();\n    persist();\n}\n',
    'tests/order_test.rs': '#[test]\nfn order_test() {\n    calculate();\n}\n' };
  const checked = replay('check', { ...graphInput, revision: 'r2', constraints: approved }, changed, initial.written).output;
  assert.equal(checked.error, undefined, checked.error);
  assert.ok(checked.value.introduced_findings.some(item => item.kind === 'duplicated_domain_logic' && item.certainty === 'inferred'));
  assert.ok(checked.value.introduced_findings.some(item => item.kind === 'weakened_check' && item.subject.endsWith(':assertions-reduced')));
  assert.ok(checked.value.introduced_findings.some(item => item.kind === 'dependency_boundary' && item.certainty === 'deterministic'));
  assert.equal(checked.value.existing_debt.length, 1);
  const removed = { ...changed };
  delete removed['tests/order_test.rs'];
  const missing = replay('check', { ...graphInput, revision: 'r3', constraints: approved }, removed, initial.written).output;
  assert.equal(missing.error, undefined, missing.error);
  assert.ok(missing.value.introduced_findings.some(item => item.kind === 'weakened_check' && item.subject.endsWith(':removed')));
  assert.ok(missing.value.introduced_findings.some(item => item.kind === 'weakened_check' && item.subject.endsWith(':minimum-tests')));
  assert.match(replay('check', { ...graphInput, revision: 'r2', constraints: approved }, changed, { ...initial.written, checks: [] }).output.error, /analysis_baseline_invalid/);
  assert.match(replay('baseline', { ...graphInput, constraints: { ...approved, duplication_scopes: [{ ...approved.duplication_scopes[0], minimum_logical_lines: 1 }] } }, initialFiles).output.error, /analysis_duplication_invalid/);
});

test('cold and repeated graph requests keep listing, reads, and source bounds explicit', () => {
  const files = Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`src/file_${index}.py`, `def function_${index}():\n    pass\n`]));
  for (const request of [replay('graph', graphInput, files), replay('graph', graphInput, files)]) {
    assert.equal(request.output.error, undefined, request.output.error);
    assert.equal(request.calls.filter(call => call.operation === 'workspace.list').length, 1);
    assert.equal(request.calls.filter(call => call.operation === 'workspace.read').length, 2);
    assert.equal(request.calls.filter(call => ['workspace.snapshot', 'workspace.fingerprint'].includes(call.operation)).length, 3);
  }
  const overflow = Object.fromEntries(Array.from({ length: 4097 }, (_, index) => [`src/file_${index}.py`, 'def work():\n    pass\n']));
  const denied = replay('graph', graphInput, overflow);
  assert.match(denied.output.error, /analysis_file_limit/);
  assert.equal(denied.calls.some(call => call.operation === 'workspace.read'), false);
});

test('live-source service search and select use double listing, hash checks and exact digest', () => {
  const search = replay('omd.repository_analysis.search', { query: 'entry', page: 0 }, graphFiles, null, false, 'service');
  assert.equal(search.output.error, undefined, search.output.error);
  assert.equal(search.output.value.provenance.workspace_snapshot, false);
  assert.equal(search.output.value.provenance.validation, 'double_list_and_hash');
  assert.equal(search.output.value.page_size, 32);
  assert.ok(search.output.value.rows.some(row => row.id === 'symbol:src/lib.rs:3:entry'));
  assert.equal(search.calls.filter(call => ['workspace.snapshot', 'workspace.fingerprint'].includes(call.operation)).length, 0);
  assert.equal(search.calls.filter(call => call.operation === 'workspace.list').length, 2);
  assert.equal(search.calls.filter(call => call.operation === 'workspace.stat').length, 1);
  const selected = replay('omd.repository_analysis.select', { node_id: 'symbol:src/lib.rs:3:entry',
    expected_source_digest: search.output.value.source_digest }, graphFiles, null, false, 'service').output;
  assert.equal(selected.error, undefined, selected.error);
  assert.equal(selected.value.source_digest, search.output.value.source_digest);
  assert.ok(selected.value.relationships.some(edge => edge.confidence === 'inferred'));
  assert.equal(selected.value.provenance.workspace_snapshot, false);
  assert.match(replay('omd.repository_analysis.select', { node_id: 'symbol:src/lib.rs:3:entry',
    expected_source_digest: '0'.repeat(64) }, graphFiles, null, false, 'service').output.error, /analysis_source_digest_stale/);
  assert.match(replay('omd.repository_analysis.search', {}, graphFiles, null, true, 'service').output.error, /analysis_source_stale/);
  const longPath = `src/${'x'.repeat(250)}.rs`;
  const longRow = replay('omd.repository_analysis.search', {}, { [longPath]: 'pub fn entry() {}\n' }, null, false, 'service').output;
  assert.equal(longRow.error, undefined, longRow.error);
  assert.ok(longRow.value.rows.some(row => row.id === `module:${longPath}` && row.id.length > 256));
  const oversized = `src/${'x'.repeat(250)}/${'z'.repeat(250)}.rs`;
  assert.match(replay('omd.repository_analysis.search', {}, { [oversized]: `pub fn ${'y'.repeat(270)}() {}\n` }, null, false, 'service').output.error,
    /analysis_service_node_id_limit/);
  assert.match(replay('omd.repository_analysis.select', { node_id: 'x'.repeat(769), expected_source_digest: search.output.value.source_digest }, graphFiles,
    null, false, 'service').output.error, /analysis_selection_invalid/);
});
