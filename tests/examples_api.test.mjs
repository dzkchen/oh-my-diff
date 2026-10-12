import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { runnerSync } from './mod_runner.mjs';

const runner = readFileSync(new URL('../runtime/omd/src/mods/runner.mjs', import.meta.url), 'utf8');
const examples = new URL('../mods/examples/', import.meta.url);
const names = ['context', 'coordination', 'guard', 'interception', 'kernel', 'recovery', 'routing',
  'service-consumer', 'service-provider', 'service_request', 'terminal', 'virtual_reader', 'workflow', 'workspace'];
const surface = {
  events: { context: 'context', agent_end: 'lifecycle', turn_start: 'lifecycle', turn_end: 'lifecycle',
    model_response: 'model', tool_result: 'lifecycle', start: 'lifecycle', process_event: 'exec',
    compaction: 'compaction', routing: 'model', terminal: 'terminal',
    workspace_change: 'fs.read', workspace_pre_rename: 'fs.write', approval: 'approvals', component_event: 'terminal', timer: 'events', channel: 'events',
    composer: 'composer', prompt: 'middleware' },
  replacements: ['context', 'routing', 'compaction'],
  intercept: { tool: 'interception', host_operation: 'middleware', model_request: 'middleware', response_stream: 'middleware', input: 'input', tool_specs: 'tools',
    command_list: 'commands', command: 'commands', config_list: 'config', config_set: 'config.write', admission: 'policy', render: 'terminal',
    composer_edit: 'composer', composer_key: 'composer', mention: 'input' },
  middleware: ['tool_result', 'approval', 'prompt'], state: 'store', contracts: 'contracts',
};

function packageFile(name, file) {
  return new URL(`${name}/${file}`, examples);
}

function runRaw(name, event, payload = null, options = {}) {
  const manifest = JSON.parse(readFileSync(packageFile(name, 'mod.json'), 'utf8'));
  const source = readFileSync(packageFile(name, 'index.ts'), 'utf8');
  const request = { source, filename: `${name}/index.ts`, api: manifest.api, capabilities: manifest.capabilities,
    surface, state: null, settings: {}, event, payload, hook_budget_ms: 1000, ...options };
  const result = runnerSync(request);
  assert.ifError(result.error);
  return JSON.parse(result.stdout);
}

function run(name, event, payload = null, options = {}) {
  const result = runRaw(name, event, payload, options);
  assert.equal(result.error, undefined, result.error);
  return result;
}

test('host control examples preserve clipboard status and scoped arguments', () => {
  const selected = run('terminal', 'command', null, { name: 'copy_selection' });
  assert.deepEqual(selected.host_call, { operation: 'terminal.selection', arguments: {} });
  const receipt = { call: selected.host_call, value: { text: 'selected error', truncated: true } };
  const copying = run('terminal', 'command', null, { name: 'copy_selection', receipts: [receipt] });
  assert.deepEqual(copying.host_call, { operation: 'terminal.copy', arguments: { text: 'selected error' } });
  const copied = run('terminal', 'command', null, { name: 'copy_selection', receipts: [receipt, { call: copying.host_call, value: { status: 'pending' } }] });
  assert.equal(copied.value.display, 'Clipboard: pending (selection truncated)');
  const empty = run('terminal', 'command', null, { name: 'copy_selection', receipts: [{ call: selected.host_call, value: { text: null, truncated: false } }] });
  assert.equal(empty.host_call, null);
  assert.deepEqual(run('os_tools', 'command', 'C', { name: 'locale' }).host_call, { operation: 'environment.set', arguments: { name: 'LANG', value: 'C' } });
  assert.deepEqual(run('os_tools', 'command', '', { name: 'locale' }).host_call, { operation: 'environment.set', arguments: { name: 'LANG', value: null } });
  assert.deepEqual(run('os_tools', 'command', '', { name: 'locale', receipts: [{
    call: { operation: 'environment.set', arguments: { name: 'LANG', value: null } },
    value: { name: 'LANG', set: false },
  }] }).value, { display: 'Future child locale: inherited' });
  assert.deepEqual(run('status_tools', 'command', ' turn-a ', { name: 'abort_turn' }).host_call, { operation: 'turns.abort', arguments: { turn_id: 'turn-a' } });
});

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
  const intercept = (index, surface, input) => run('kernel', 'intercept', { surface, input, origin: { caller: 'engine' } }, { name: index });
  assert.equal(intercept('0', 'model_request', { routes, original: routes[1], route: 'sol' }).host_call.arguments.input.route, 'sol');
  assert.deepEqual(run('routing', 'routing', { routes }, { settings: { route: 'sol' } }).value, { route: 'sol' });
  assert.match(runRaw('routing', 'routing', { routes }, { settings: { route: 'astra' } }).error,
    /configured_included_route_unavailable/);
  assert.equal(intercept('1', 'response_stream', { kind: 'text', index: 0, protected: false, text: 'experimental' }).host_call.arguments.input.text,
    'preview');
  assert.deepEqual(intercept('1', 'response_stream', { kind: 'reasoning', index: 1, protected: true }).value, { unmatched: true });
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

test('admission guard and command curator examples refuse, withhold, curate and cap', () => {
  const intercept = (name, index, surface, input, options = {}) =>
    runRaw(name, 'intercept', { surface, input, origin: { caller: 'engine' } }, { name: String(index), ...options });
  const admit = capabilities => intercept('admission_guard', 0, 'admission',
    { package: { id: 'p', version: '1.0.0', sha256: 'a', source: '/p', scope: 'user', capabilities, dependencies: [], requires: [], services: {} }, reason: 'load' });
  assert.deepEqual(admit(['exec', 'os', 'http']).value, { result: { deny: 'unsandboxed processes with network access need a manual review' } });
  assert.deepEqual(admit(['http']).value, { result: { withhold: ['exec', 'process', 'sidecars'] } });
  assert.equal(admit(['commands']).host_call.operation, 'continuation.next');
  const request = url => intercept('admission_guard', 1, 'host_operation', { operation: 'http.request', namespace: 'http', arguments: { url } });
  assert.deepEqual(request('http://example.com').value, { result: { error: 'admission_guard allows only https requests' } });
  assert.equal(request('https://example.com').host_call.operation, 'continuation.next');

  const rows = [{ command: 'review', description: 'Review', owner: null, hidden: false, args_hint: null, immediate: true, protected: false },
    { command: 'feedback', description: 'Feedback', owner: null, hidden: false, args_hint: null, immediate: true, protected: false }];
  const listed = intercept('command_curator', 0, 'command_list', { commands: rows }).host_call;
  const curated = intercept('command_curator', 0, 'command_list', { commands: rows },
    { receipts: [{ call: listed, value: { result: { commands: rows }, trace: [] } }] }).value.result.commands;
  assert.deepEqual(curated.map(row => [row.command, row.hidden, row.args_hint]), [['review', false, '[base branch]'], ['feedback', true, null]]);
  const command = (name, args, active_turn) => intercept('command_curator', 1, 'command',
    { command: name, args, owner: null, immediate: true, active_turn });
  assert.deepEqual(command('compact', '', true).value, { result: { deny: 'compact after the turn ends' } });
  assert.equal(command('review', '  main ', false).host_call.arguments.input.args, 'main');
  const set = value => intercept('command_curator', 3, 'config_set',
    { key: 'agents.max_depth', value, original: 1, source: 'user', scope: 'codex' }).host_call.arguments.input.value;
  assert.equal(set(8), 3);
  assert.equal(set(2), 2);
});

test('render hook examples draw a spinner, frame tool calls, annotate messages and wrap questions around the native drawing', () => {
  const render = (component, index, props, options = {}) => {
    const input = { component, id: 'one', surface: 'fullscreen', viewport: { columns: 80, rows: 24 }, lifecycle: options.lifecycle ?? 'final', owner: null, props };
    return run('render_hooks', 'intercept', { surface: 'render', input, original: input, origin: { caller: 'engine' } }, { name: String(index), ...options });
  };
  const spinner = render('spinner', 0, { header: 'Working', elapsed_seconds: 5, details: null, message: null, interrupt_hint: true }, { lifecycle: 'live' });
  assert.deepEqual(spinner.value.result.tree[0].spans.map(span => span.text), ['◓ ', 'Working', ' · 5s']);
  const native = { tree: [{ type: 'native' }] };
  const after = (index, component, props, lifecycle = 'final') => {
    const first = render(component, index, props, { lifecycle });
    assert.equal(first.host_call.operation, 'continuation.next');
    return render(component, index, props, { lifecycle, receipts: [{ call: first.host_call, value: { result: native, trace: [] } }] }).value.result.tree;
  };
  const tool = after(1, 'tool_call', { call_id: 'one', kind: 'mcp', server: 'docs', tool: 'search', arguments: {}, status: 'failed', duration_ms: 3, output_lines: null, expanded: false });
  assert.equal(tool[0].title, '✗ docs.search');
  assert.deepEqual(tool[0].children, [{ type: 'native' }]);
  const command = after(1, 'tool_call', { call_id: 'one', kind: 'exec', command: 'echo hi', parsed: [], status: 'completed', exit_code: 0, duration_ms: 1, output_lines: 1, output_tail: 'hi', user_shell: false, expanded: false });
  assert.equal(command[0].title, '⚙ echo hi');
  assert.deepEqual(after(1, 'tool_call', { call_id: 'one', kind: 'exec', command: 'echo hi', parsed: [], status: 'completed', exit_code: 0, duration_ms: 1, output_lines: 1, output_tail: 'hi', user_shell: false, expanded: true }), native.tree);
  const message = after(2, 'assistant_message', { text: 'three short words', first: true });
  assert.deepEqual(message.map(node => node.text ?? node.type), ['3 words', 'native']);
  const question = after(3, 'question', { questions: [], current: 0, queued: 0 }, 'live');
  assert.deepEqual(question.map(node => node.type), ['text', 'native']);
});

test('reactive dashboard keeps a form, streamed status and derived summary on keyed atoms', () => {
  const manifest = JSON.parse(readFileSync(new URL('../mods/examples/reactive_dashboard/mod.json', import.meta.url), 'utf8'));
  assert.ok(manifest.subscriptions?.channels.includes('reactive_dashboard/stream'));
  const stream = run('reactive_dashboard', 'channel', { channel: 'reactive_dashboard/stream', data: null });
  assert.deepEqual(stream.host_call, { operation: 'events.schedule', arguments: { key: 'tick', delay_ms: 100 } });
  const typing = run('reactive_dashboard', 'component_event', { component: 'dashboard_query', kind: 'change', value: 'log', origin: 'user' });
  assert.equal(typing.state ?? null, null, 'edits do not write state until the input submits');
  const changed = run('reactive_dashboard', 'command', ' login ', { name: 'search' });
  assert.deepEqual(changed.state, { query: 'login', counts: { searches: 1 } });
  const view = run('reactive_dashboard', 'terminal', { event: 'idle', ledger: null }, { state: changed.state }).value;
  assert.equal(view.sites.sidebar.components[0].value, 'login');
  assert.equal(view.sites.sidebar.components[1].text, 'login · 1 searches · 0 ticks');
  const tick = run('reactive_dashboard', 'timer', { key: 'tick' }, { state: changed.state });
  assert.deepEqual(tick.host_call, { operation: 'events.schedule', arguments: { key: 'tick', delay_ms: 100 } });
  const ticked = run('reactive_dashboard', 'timer', { key: 'tick' }, { state: changed.state, receipts: [{ call: tick.host_call, value: { key: 'tick', delay_ms: 100 } }] });
  assert.equal(ticked.state.ticks, 1);
  const cleared = run('reactive_dashboard', 'command', '  ', { name: 'search', state: ticked.state });
  assert.deepEqual(cleared.state, { query: '', counts: { searches: 2 }, ticks: 1 });
  const input = { component: 'spinner', id: 'main', surface: 'inline', viewport: { columns: 80, rows: 24 }, lifecycle: 'live', owner: null,
    props: { header: 'Working', elapsed_seconds: 1, details: null, message: null, interrupt_hint: false } };
  const first = run('reactive_dashboard', 'intercept', { surface: 'render', input, original: input, origin: { caller: 'engine' } }, { name: '0', state: ticked.state });
  const drawn = run('reactive_dashboard', 'intercept', { surface: 'render', input, original: input, origin: { caller: 'engine' } },
    { name: '0', state: ticked.state, receipts: [{ call: first.host_call, value: { result: { tree: [{ type: 'native' }] }, trace: [] } }] }).value;
  assert.equal(drawn.result.tree[1].text, 'stream · 1 ticks');
  assert.deepEqual(drawn.reads, ['ticks']);
});

test('external client example launches its renderer unsandboxed from a channel hop and lists attached clients', () => {
  assert.deepEqual(run('external_client', 'command', null, { name: 'launch' }).host_call, { operation: 'events.publish', arguments: { channel: 'launch', data: null } });
  const settings = { listen_url: 'ws://127.0.0.1:4500', token_file: '/tmp/token', client_path: '/tmp/client.mjs' };
  const channel = { publisher: 'external_client', channel: 'external_client/launch', data: null, correlation: null, sequence: 1, dropped: 0 };
  const which = run('external_client', 'channel', channel, { settings }).host_call;
  const node = { name: 'node', path: '/usr/local/bin/node', sha256: 'a'.repeat(64) };
  const found = { call: which, value: { found: [node] } };
  const start = run('external_client', 'channel', channel, { settings, receipts: [found] }).host_call;
  assert.deepEqual(start, { operation: 'process.start', arguments: { session: 'ui', name: 'node', path: node.path, sha256: node.sha256, arguments: ['/tmp/client.mjs'],
    sandbox: 'none', notify: ['exit'], environment: { EXTERNAL_CLIENT_URL: 'ws://127.0.0.1:4500', EXTERNAL_CLIENT_AUTH_FILE: '/tmp/token' } } });
  const started = run('external_client', 'channel', channel, { settings, receipts: [found, { call: start, value: { session: 'ui', running: true } }] });
  const clicked = run('external_client', 'component_event', { component: 'external_badge', kind: 'pointer', client: 'client-1',
    pointer: { column: 1, row: 0, half: null, action: 'down', button: 'left' } }, { state: started.state });
  const clients = [{ id: 'client-1', name: 'Text renderer', renderer: { kind: 'text', formats: ['text'], pointer: 'none', reduced_motion: true },
    viewport: null, focused: false, attached_ms: 1000 }];
  const [list, status] = run('external_client', 'terminal', { event: 'idle', ledger: null, client: null, clients }, { state: clicked.state }).value.sites.sidebar.components;
  assert.deepEqual(list.rows.map(row => row.value), ['client-1']);
  assert.equal(status.text, '1 attached; UI running; picked none; badge clicked by client-1');
});

test('composer examples suggest a recent prompt and tidy pastes through the edit chain', () => {
  const sent = run('ghost_history', 'prompt', { thread_id: 't', turn_id: 'u', original: 'run the tests', effective: 'run the tests', provenance: [] });
  const change = { kind: 'change', revision: 4, attachments_revision: 1, origin: 'user' };
  const read = run('ghost_history', 'composer', change, { state: sent.state });
  assert.deepEqual(read.host_call, { operation: 'composer.read', arguments: null });
  const draft = { text: 'run t', cursor: 5, selection: null, revision: 4, attachments: [], suggestion: null };
  const suggested = run('ghost_history', 'composer', change, { state: sent.state, receipts: [{ call: read.host_call, value: draft }] });
  assert.deepEqual(suggested.host_call, { operation: 'composer.suggest', arguments: { revision: 4, id: 'h4', text: 'he tests' } });
  const stale = run('ghost_history', 'composer', change, { state: sent.state,
    receipts: [{ call: read.host_call, value: draft }, { call: suggested.host_call, error: 'stale_revision' }] });
  assert.equal(stale.error, undefined, 'a stale suggestion is dropped');
  assert.equal(run('ghost_history', 'composer', { ...change, origin: 'ghost_history' }, { state: sent.state, package: { id: 'ghost_history' } }).host_call ?? null, null);

  const paste = text => ({ surface: 'composer_edit', input: { source: 'paste', caller: 'user', revision: 2, edit: { kind: 'insert', text } }, origin: { caller: 'user' } });
  assert.deepEqual(run('paste_tidy', 'intercept', paste('a  \nb\t'), { name: '0' }).host_call,
    { operation: 'continuation.next', arguments: { input: { source: 'paste', caller: 'user', revision: 2, edit: { kind: 'insert', text: 'a\nb' } } } });
  assert.deepEqual(run('paste_tidy', 'intercept', paste('-----BEGIN OPENSSH PRIVATE KEY-----'), { name: '0' }).value, { result: { deny: 'the paste looks like a private key' } });
  const history = { ...paste('x '), input: { ...paste('x ').input, source: 'history' } };
  assert.deepEqual(run('paste_tidy', 'intercept', history, { name: '0' }).value, { unmatched: true });
});

test('composer key examples rewrite and drop only the keys they match', () => {
  const key = (name, cursor = 3) => ({ surface: 'composer_key', input: { key: name, text: name.length === 1 ? name : null, revision: 1, cursor }, origin: { caller: 'user' } });
  assert.deepEqual(run('key_remap', 'intercept', key('Ctrl+b'), { name: '0' }).host_call,
    { operation: 'continuation.next', arguments: { input: { ...key('Ctrl+b').input, key: 'Left' } } });
  assert.deepEqual(run('key_remap', 'intercept', key('b'), { name: '0' }).value, { unmatched: true });
  assert.deepEqual(run('input_guard', 'intercept', key('Ctrl+u'), { name: '0' }).value, { result: { deny: 'Ctrl+U is disabled' } });
  assert.deepEqual(run('input_guard', 'intercept', key(' ', 0), { name: '1' }).value, { result: { deny: 'leading space' } });
  assert.deepEqual(run('input_guard', 'intercept', key(' ', 2), { name: '1' }).value, { unmatched: true });
});

test('token completion example answers each registered trigger', () => {
  const token = (trigger, query) => ({ kind: 'token', trigger, query, line: `see ${trigger}${query}` });
  assert.deepEqual(run('shortcodes', 'completion', token(':', 'r')).value, { items: [{ insert: '🚀' }] });
  const log = run('shortcodes', 'completion', token('#', '1'));
  assert.equal(log.host_call.operation, 'exec.run');
  const answered = run('shortcodes', 'completion', token('#', '1'), { receipts: [{ call: log.host_call, value: { stdout: 'fix #12\nmerge #31 and #12\nrefs #7\n' } }] });
  assert.deepEqual(answered.value, { items: [{ insert: '#12' }] });
  assert.deepEqual(run('shortcodes', 'inspect').registrations.completions, [{ trigger: ':' }, { trigger: '#' }]);
});

test('mention example denies secrets and redirects build output to its source', () => {
  const mention = path => ({ surface: 'mention', input: { thread_id: 't', path }, origin: { caller: 'user' } });
  assert.deepEqual(run('mention_guard', 'intercept', mention('config/.env.local'), { name: '0' }).value, { result: { deny: 'secret files are not read into prompts' } });
  assert.deepEqual(run('mention_guard', 'intercept', mention('src/app.ts'), { name: '0' }).value, { unmatched: true });
  const stat = run('mention_guard', 'intercept', mention('dist/app.js'), { name: '1' });
  assert.deepEqual(stat.host_call, { operation: 'workspace.stat', arguments: { paths: ['src/app.ts'] } });
  const redirected = run('mention_guard', 'intercept', mention('dist/app.js'), { name: '1',
    receipts: [{ call: stat.host_call, value: { files: { 'src/app.ts': { kind: 'file', size: 1, mtime_ms: 0 } } } }] });
  assert.deepEqual(redirected.host_call, { operation: 'continuation.next', arguments: { input: { thread_id: 't', path: 'src/app.ts' } } });
});
