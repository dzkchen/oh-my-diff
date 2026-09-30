import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const runner = readFileSync(new URL('../runtime/omd/src/mods/runner.mjs', import.meta.url), 'utf8');
const examples = new URL('../mods/examples/', import.meta.url);
const names = ['context', 'coordination', 'guard', 'interception', 'kernel', 'recovery', 'routing',
  'service-consumer', 'service-provider', 'service_request', 'terminal', 'virtual_reader', 'workflow', 'workspace'];
const surface = {
  events: { context: 'context', agent_end: 'lifecycle', turn_start: 'lifecycle', turn_end: 'lifecycle',
    tool_before: 'interception', model_request: 'middleware', response_stream: 'middleware', tool_result: 'lifecycle',
    compaction: 'compaction', routing: 'model', input: 'input', terminal: 'terminal',
    workspace_change: 'fs.read', workspace_pre_rename: 'fs.write' },
  replacements: ['context', 'routing', 'compaction', 'tool_before', 'terminal', 'input'],
  middleware: ['model_request', 'response_stream', 'tool_result'], state: 'store', contracts: 'contracts',
};

function packageFile(name, file) {
  return new URL(`${name}/${file}`, examples);
}

function runRaw(name, event, payload = null, options = {}) {
  const manifest = JSON.parse(readFileSync(packageFile(name, 'mod.json'), 'utf8'));
  const source = readFileSync(packageFile(name, 'index.ts'), 'utf8');
  const request = { source, filename: `${name}/index.ts`, api: manifest.api, capabilities: manifest.capabilities,
    surface, state: null, settings: {}, event, payload, hook_budget_ms: 1000, ...options };
  const result = spawnSync(process.execPath,
    ['--no-warnings', '--experimental-vm-modules', '--input-type=module', '--eval', runner],
    { input: JSON.stringify(request), encoding: 'utf8', timeout: 5000 });
  assert.ifError(result.error);
  return JSON.parse(result.stdout);
}

function run(name, event, payload = null, options = {}) {
  const result = runRaw(name, event, payload, options);
  assert.equal(result.error, undefined, result.error);
  return result;
}

test('all packed legacy examples declare the current API and type-only current imports', () => {
  for (const name of names) {
    const manifest = JSON.parse(readFileSync(packageFile(name, 'mod.json'), 'utf8'));
    const source = readFileSync(packageFile(name, 'index.ts'), 'utf8');
    assert.equal(manifest.api, '0.2.0-experimental.5', name);
    assert.equal(manifest.version, '2.0.0', name);
    assert.doesNotMatch(source, /mod-api\/0\.1|api-0\.1\.d\.ts/, name);
    run(name, 'inspect');
  }
});

test('context example does not present legacy checkpoint data as verified', () => {
  const value = run('context', 'context', { thread_id: 'task', turn_id: 'one', ledger: { thread_id: 'task', cost: null },
    checkpoint: { remaining_work: ['stale claim'] } }).value;
  assert.match(value.text, /no verified host checkpoint/);
  assert.doesNotMatch(value.text, /stale claim/);
});

test('coordination fails before agent spawn without two distinct included routes', () => {
  const first = run('coordination', 'tool', { prompt: 'inspect changes' }, { name: 'compare' });
  assert.deepEqual(first.host_call, { operation: 'routes.list', arguments: null });
  const denied = runRaw('coordination', 'tool', { prompt: 'inspect changes' }, { name: 'compare',
    receipts: [{ call: first.host_call, value: [{ name: 'paid', model: 'paid', provider: 'fixture',
      billing: 'explicit_paid_api_grant', available: true, roles: ['worker'], reasoning: 'high', tools: [] }] }] });
  assert.match(denied.error, /two_distinct_included_worker_routes_required/);
});

test('guard and interception keep scoped input and status behavior', () => {
  assert.deepEqual(run('guard', 'input', { text: 'sk_1234567890123456', attachments: 0 }).value,
    { deny: 'the prompt appears to contain a credential' });
  assert.match(run('guard', 'input', { text: '@@review src/main.ts', attachments: 0 }).value.text, /correctness risks/);
  assert.deepEqual(run('interception', 'tool_before', { tool: 'omd_status', arguments: {}, call_id: 'one' }).value,
    { tool: 'mod_interception_status', arguments: {} });
  const status = run('interception', 'tool', {}, { name: 'status' });
  assert.deepEqual(status.host_call, { operation: 'task.status', arguments: null });
});

test('model routing examples select only available included routes and protect stream text', () => {
  const routes = [
    { name: 'astra', model: 'astra', provider: 'fixture', billing: 'explicit_paid_api_grant', available: true, roles: ['lead'] },
    { name: 'sol', model: 'sol', provider: 'fixture', billing: 'included_subscription', available: true, roles: ['lead'] },
  ];
  assert.equal(run('kernel', 'model_request', { routes, original: routes[1], effective: routes[1] }).value, null);
  assert.deepEqual(run('routing', 'routing', { routes }, { settings: { route: 'sol' } }).value, { route: 'sol' });
  assert.match(runRaw('routing', 'routing', { routes }, { settings: { route: 'astra' } }).error,
    /configured_included_route_unavailable/);
  assert.deepEqual(run('kernel', 'response_stream', { protected: false, text: 'experimental' }).value,
    { text: 'preview' });
  assert.equal(run('kernel', 'response_stream', { protected: true, text: 'experimental' }).value, null);
});

test('recovery preserves compaction guidance and refuses unavailable checkpoint reads', () => {
  assert.equal(run('recovery', 'compaction', { token_limit: 20000, context_window: 30000 }).value.threshold, 16000);
  const context = run('recovery', 'context', { thread_id: 'task', turn_id: 'one', ledger: { thread_id: 'task', cost: null } }).value;
  assert.match(context.text, /checkpoint fields are unavailable/);
  assert.match(runRaw('recovery', 'tool', {}, { name: 'checkpoint' }).error, /unsupported_operation: checkpoint.read/);
});

test('services, sidecar request, and virtual read use public current operations', () => {
  const provider = run('service-provider', 'inspect');
  assert.equal(provider.registrations.services[0].name, 'example.formatter');
  const consumer = run('service-consumer', 'command', '  value  ', { name: 'format' });
  assert.deepEqual(consumer.host_call, { operation: 'mods.service', arguments: { name: 'example.formatter', method: 'format', input: '  value  ' } });
  const sidecar = run('service_request', 'tool', {}, { name: 'probe' });
  assert.deepEqual(sidecar.host_call, { operation: 'sidecars.invoke', arguments: { id: 'example_echo', input: { text: 'extension-owned request' } } });
  const refused = run('service_request', 'tool', {}, { name: 'probe', receipts: [{ call: sidecar.host_call, error: 'service_not_granted' }] });
  assert.deepEqual(refused.value, { ok: false, error: 'service_not_granted' });
  assert.deepEqual(refused.state, refused.value);
  const page = run('virtual_reader', 'virtual_read', { uri: 'fixture://manual/intro', max_bytes: 200 }, { name: 'fixture' }).value;
  assert.equal(page.identity, 'manual/intro');
  assert.equal(page.truncated, false);
});

test('terminal and workflow examples expose current presentation and completion gates', () => {
  const terminal = run('terminal', 'terminal', { event: 'idle', ledger: null }).value;
  assert.equal(terminal.sites.sidebar.components[0].type, 'pane');
  assert.equal(terminal.theme.icons, 'unicode');
  assert.deepEqual(run('terminal', 'command', 'review', { name: 'layout' }).value, { display: 'Layout request: review' });
  const workflow = run('workflow', 'inspect');
  assert.equal(workflow.registrations.contracts[0].schema, 2);
  assert.ok(workflow.registrations.contracts[0].gates.complete.some(requirement => requirement.receipt === 'final_review'));
  assert.deepEqual(run('workflow', 'command', null, { name: 'no_delegation' }).host_call,
    { operation: 'contract.restrict', arguments: { operations: ['agents.spawn'],
      reason: 'this repository reviews every change in a pair instead of delegating' } });
});
