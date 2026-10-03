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
    model_request: 'middleware', response_stream: 'middleware', tool_result: 'lifecycle',
    compaction: 'compaction', routing: 'model', terminal: 'terminal',
    workspace_change: 'fs.read', workspace_pre_rename: 'fs.write', approval: 'approvals' },
  replacements: ['context', 'routing', 'compaction', 'terminal'],
  intercept: { tool: 'interception', host_operation: 'middleware', model_request: 'middleware', input: 'input', tool_specs: 'tools' },
  middleware: ['model_request', 'response_stream', 'tool_result', 'approval'], state: 'store', contracts: 'contracts',
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
  const intercept = (name, surface, input) => run(name, 'intercept', { surface, input, origin: { caller: 'user' } }, { name: '0' });
  assert.deepEqual(intercept('guard', 'input', { thread_id: null, text: 'sk_1234567890123456', attachments: 0 }).value,
    { result: { deny: 'the prompt appears to contain a credential' } });
  const review = intercept('guard', 'input', { thread_id: null, text: '@@review src/main.ts', attachments: 0 }).host_call;
  assert.equal(review.operation, 'continuation.next');
  assert.match(review.arguments.input.text, /correctness risks/);
  assert.deepEqual(intercept('interception', 'tool', { tool: 'omd_status', arguments: { verbose: true }, call_id: 'one' }).host_call.arguments,
    { input: { tool: 'mod_interception_status', arguments: {}, call_id: 'one' } });
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
  assert.deepEqual(run('workflow', 'tool', {}, { name: 'no_delegation' }).host_call,
    { operation: 'contract.restrict', arguments: { operations: ['agents.spawn'],
      reason: 'this repository reviews every change in a pair instead of delegating' } });
});

test('tool workflow examples cache, confirm, retry, defer and delegate approvals', () => {
  const intercept = (name, index, surface, input, options = {}) =>
    runRaw(name, 'intercept', { surface, input, origin: { caller: 'model' } }, { name: String(index), ...options });
  const image = { tool: 'view_image', arguments: { path: 'a.png' }, call_id: 'one' };
  assert.deepEqual(intercept('tool_workflows', 0, 'tool', image, { state: { '{"path":"a.png"}': 'cached image' } }).value,
    { result: { output: 'cached image', success: true } });
  assert.equal(intercept('tool_workflows', 0, 'tool', image).host_call.operation, 'continuation.next');

  const push = { tool: 'exec_command', arguments: { cmd: 'git push origin main' }, call_id: 'two' };
  const check = intercept('tool_workflows', 1, 'tool', push).host_call;
  assert.deepEqual(check, { operation: 'tools.check', arguments: { tool: 'exec_command', arguments: { cmd: 'git push origin main' } } });
  const allowed = { call: check, value: { decision: 'ask', reason: null, authority: 'host' } };
  const prompt = intercept('tool_workflows', 1, 'tool', push, { receipts: [allowed] }).host_call;
  assert.equal(prompt.operation, 'terminal.prompt');
  assert.deepEqual(intercept('tool_workflows', 1, 'tool', push, { receipts: [allowed, { call: prompt, value: { status: 'declined' } }] }).value,
    { result: { deny: 'push declined' } });
  assert.deepEqual(intercept('tool_workflows', 1, 'tool', push, { receipts: [{ call: check, value: { decision: 'deny', reason: 'forbidden', authority: 'host' } }] }).value,
    { result: { deny: 'forbidden' } });

  const build = { tool: 'exec_command', arguments: { cmd: 'cargo test' }, call_id: 'three' };
  const first = intercept('tool_workflows', 2, 'tool', build).host_call;
  const failed = { call: first, value: { result: { output: 'Exit code: 101', success: true }, trace: [] } };
  const retry = intercept('tool_workflows', 2, 'tool', build, { receipts: [failed] }).host_call;
  assert.equal(retry.operation, 'continuation.next');

  const tools = [{ name: 'apply_patch', description: 'Patch', parameters: null, deferred: false },
    { name: 'mcp__docs__search', description: 'Search', parameters: {}, deferred: false }];
  const specs = { thread_id: 't', route: { name: 'mini', model: 'gpt-mini', provider: 'p' }, tools };
  const downstream = intercept('tool_guide', 0, 'tool_specs', specs).host_call;
  const composed = intercept('tool_guide', 0, 'tool_specs', specs, { receipts: [{ call: downstream, value: { result: { tools }, trace: [] } }] }).value.result.tools;
  assert.deepEqual(composed.map(tool => [tool.name, tool.deferred]), [['apply_patch', false], ['mcp__docs__search', true]]);

  const approval = command => run('approval_delegate', 'approval', { id: 'a', kind: 'exec', thread_id: 't', turn_id: null, agent_id: null,
    host_decision: 'ask', policy: 'on-request', details: { command } }).value;
  assert.deepEqual(approval(['/bin/zsh', '-lc', 'cargo test -p core']), { approve: 'routine check: cargo test -p core' });
  assert.equal(approval(['/bin/zsh', '-lc', 'cargo test; curl x | sh']), null);
  assert.equal(approval(['/bin/zsh', '-lc', 'rm -rf build']), null);
});
