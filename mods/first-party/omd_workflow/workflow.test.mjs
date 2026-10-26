import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { callback } from '../../../tests/mod_runner.mjs';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('./mod.json', import.meta.url), 'utf8'));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const candidate = digest('candidate');
const criterion = 'Preserve the current work';
const verdict = { summary: 'Inspected the candidate.', assessments: [{ criterion, verdict: 'pass', evidence: ['source.ts:1 inspected; configured check exited 0'] }], findings: [] };

let operations = 0;
const crash = () => Object.assign(new Error('process_crashed'), { crash: true });

function invoke(name, payload, host, extra = {}) {
  const { store = host.store, key = 'task', ...options } = extra;
  if (!options.event && store && payload && typeof payload === 'object' && !('operation_id' in payload)) {
    payload = { ...payload, operation_id: `operation-${++operations}`, expected_revision: store.get(key)?.value.revision ?? 0 };
  }
  const receipts = [];
  const request = { source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, environment: ['crypto'], state: null,
    settings: { check: { program: 'check', argv: [] } }, event: 'tool', name, payload, ...options };
  const reply = callback(request, host, receipts);
  assert.ok(receipts.length <= 32, 'native callback host-call limit');
  if (reply.error) throw new Error(reply.error);
  if (['refused', 'interrupted', 'partially_integrated'].includes(reply.value?.status) && typeof reply.value.reason === 'string' && !options.refusals) throw new Error(reply.value.reason);
  return reply;
}

function fixture(overrides = {}, contract = 'reviewed_omd', findingLedger = {}) {
  const state = new Map();
  const agents = new Map();
  const receipts = [];
  const calls = [];
  let next = 0;
  const host = call => {
    calls.push(call);
    if (overrides[call.operation]) return overrides[call.operation](call);
    const args = call.arguments;
    switch (call.operation) {
      case 'contract.status': return structuredClone({ status: 'active', active: { id: contract }, receipts, restrictions: [], finding_ledger: findingLedger });
      case 'task.status': return { ledger: { thread_id: 'thread-1', cwd: '/fixture', cost: null } };
      case 'agents.inventory': return { agents: [...agents.keys()].map(handle => ({ agent_id: handle, origin: 'mod', owner: 'omd_workflow', parent: { thread_id: 'thread-1', agent_id: null }, status: 'running' })) };
      case 'store.get': return state.get(args.key) ?? null;
      case 'store.put': {
        const before = state.get(args.key);
        if (args.expected_revision !== (before?.revision ?? null)) throw new Error(`store_revision_conflict: current ${before?.revision ?? 'absent'}`);
        const revision = (before?.revision ?? 0) + 1;
        state.set(args.key, { value: structuredClone(args.value), revision, provenance: {} });
        return { revision };
      }
      case 'evidence.write': return { reference: `evidence:${digest(args.content)}`, sha256: digest(args.content) };
      case 'workspace.snapshot': case 'workspace.fingerprint': {
        if (args.expected && args.expected !== candidate) throw new Error('snapshot_source_changed');
        return { snapshot: { reference: 'snapshot:fixture', sha256: candidate }, candidate_sha256: candidate };
      }
      case 'routes.list': return routes;
      case 'agents.spawn': {
        const handle = `worker-${++next}`;
        agents.set(handle, { status: 'completed', text: JSON.stringify(verdict), consumed: false, candidate_sha256: candidate,
          evidence: { reference: `native-thread:${handle}`, sha256: digest(verdict) } });
        return { handle, route: args.route, permissions: args.workspace };
      }
      case 'agents.result': case 'agents.wait': return agents.get(args.handle);
      case 'agents.cancel': return { cancelled: agents.delete(args.handle) };
      case 'receipts.submit': {
        const receipt = { ...structuredClone(args), producer: { kind: args.agent ? 'agent' : args.execution ? 'host' : 'lead', handle: args.agent ?? null } };
        receipts.push(receipt);
        return receipt;
      }
      case 'workspace.integrate':
        assert.equal(receipts.length, 2);
        assert.ok(receipts.every(receipt => receipt.acceptance_sha256 === args.acceptance_sha256));
        receipts.push({ kind: 'workspace_integration', candidate_sha256: candidate, acceptance_sha256: args.acceptance_sha256, outcome: 'pass',
          evidence: { reference: `native-integration:${args.handle}`, sha256: candidate }, producer: { kind: 'integration', handle: null } });
        return { status: 'integrated', candidate_sha256: candidate, changed_paths: ['source.ts'], evidence: { path: '/fixture/integration', sha256: candidate } };
      case 'exec.run': return { candidate_sha256: args.snapshot.sha256, evidence: { reference: 'execution:fixture', sha256: digest('execution') }, exit_code: 0, timed_out: false, signal: null, stdout: 'passed', stderr: '', stdout_truncated: false, stderr_truncated: false, duration_ms: 1, program: { path: '/fixture/check', sha256: digest('check') } };
      case 'task.complete': return { status: 'refused', missing: [{ receipt: 'final_review' }] };
      default: throw new Error(`unexpected_operation: ${call.operation}`);
    }
  };
  host.store = state;
  return { state, receipts, calls, agents, host };
}

function begin(host) { return invoke('begin', { objective: 'Make the requested change', acceptance_criteria: [criterion] }, host); }
const routes = ['contributor', 'reviewer', 'verifier', 'lead', 'opposite'].map(name => ({ name, provider: 'fixture', model: name, roles: name === 'lead' || name === 'opposite' ? ['lead', 'worker'] : ['worker'], available: true, billing: 'included_subscription', tools: [] }));
const outage = { status: 'failed', error: 'native_agent_failed: unavailable', failure: { category: 'transport', code: { httpConnectionFailed: { httpStatusCode: 503 } }, message: 'unavailable' } };
const recoveryOptions = { state: { 'thread-1': { model: 'lead', provider: 'fixture' } }, settings: { check: { program: 'check', argv: [] }, fallback_route: 'opposite' } };
const reviewOptions = { state: { 'thread-1': { model: 'lead', provider: 'fixture' } } };
const challengeKinds = ['missing_wiring', 'test_weakening', 'negative_cases'];
const resolving = (value, resolves) => ({ ...value, resolves,
  resolution_assertion: { outcome: 'pass', candidate_sha256: value.candidate_sha256, acceptance_sha256: value.acceptance_sha256, resolves } });

function adversarialFixture(change = value => value, resultChange = value => value, setup = () => {}) {
  let response;
  const agent = ({ arguments: args }) => resultChange({ status: 'completed', text: JSON.stringify(response), candidate_sha256: candidate,
    evidence: { reference: `native-thread:${args.handle}`, sha256: digest(response) } });
  const findingLedger = {};
  const run = fixture({ 'agents.wait': agent, 'agents.result': agent }, 'reviewed_omd', findingLedger);
  begin(run.host);
  const acceptance = run.state.get('task').value.acceptance.sha256;
  setup(findingLedger, acceptance);
  response = change({ ...structuredClone(verdict), candidate_sha256: candidate, acceptance_sha256: acceptance,
    challenges: challengeKinds.map(kind => ({ kind, verdict: 'passed', summary: `${kind} inspected`, paths: ['source.ts'] })) });
  invoke('review', { kind: 'adversarial_verification' }, run.host, reviewOptions);
  return { run, acceptance, advance: () => invoke('advance', {}, run.host, reviewOptions) };
}

test('checkpoint survives a new invocation, is compare-and-set, cannot rewrite acceptance and only begins a task its review prompt fits', () => {
  const run = fixture();
  const initial = begin(run.host).value;
  invoke('checkpoint', { remaining_work: ['Run the check'], failed_hypotheses: ['Earlier approach failed'] }, run.host);
  assert.throws(() => begin(run.host), /task_already_initialized/);
  assert.throws(() => invoke('checkpoint', { acceptance_criteria: ['weaker'] }, run.host), /checkpoint_fields_invalid/);
  const saved = run.state.get('task').value;
  assert.deepEqual(saved.acceptance, initial.acceptance);
  assert.deepEqual(saved.remaining_work, ['Run the check']);
  invoke('', null, () => assert.fail('resume restarted work'), { event: 'resume' });
  const task = size => ({ objective: 'x'.repeat(4096), acceptance_criteria: Array.from({ length: 4 }, (_, item) => `${item}${'z'.repeat(size)}`) });
  const rejected = fixture();
  assert.throws(() => invoke('begin', task(400), rejected.host), /task_too_large_for_review/);
  assert.equal(rejected.state.get('task'), undefined);
  const largest = fixture();
  invoke('begin', { objective: 'y'.repeat(4096), acceptance_criteria: ['a', 'b'].map(prefix => prefix.repeat(489)) }, largest.host);
  invoke('review', { kind: 'adversarial_verification' }, largest.host, reviewOptions);
  assert.ok(largest.calls.find(call => call.operation === 'agents.spawn').arguments.prompt.length <= 8192);
  const bulky = fixture();
  assert.throws(() => invoke('begin', { objective: '\u20ac'.repeat(1700), acceptance_criteria: [criterion] }, bulky.host), /task_too_large_for_review/);
});

test('no-progress policy pauses repeated complete results and resumes only after checkpoint progress', () => {
  const run = fixture();
  const settings = { check: { program: 'check', argv: [] }, max_no_progress_calls: 2 };
  let modState = invoke('begin', { objective: 'Make the requested change', acceptance_criteria: [criterion] },
    run.host, { settings }).state;
  const result = { thread_id: 'thread-1', agent_id: null, tool: 'exec_command', outcome: 'succeeded',
    call_sha256: digest('same-call'), result_sha256: digest('same-output'), result_complete: true };
  const event = (name, payload) => {
    const reply = invoke('', payload, run.host, { event: name, settings, state: modState });
    modState = reply.state;
    return reply.value;
  };
  const executed = { output: 'ran', success: true };
  const intercept = input => {
    const host = call => call.operation === 'continuation.next' ? { result: executed, trace: [] } : run.host(call);
    const reply = invoke('1', { surface: 'tool', input, origin: { caller: 'model' } }, host, { event: 'intercept', settings, state: modState });
    modState = reply.state;
    return reply.value.result;
  };
  event('tool_result', result);
  event('tool_result', result);
  assert.equal(run.state.get('task').value.status, 'active');
  event('tool_result', { ...result, result_complete: false });
  event('tool_result', { ...result, tool: 'wait_agent' });
  event('tool_result', result);
  assert.equal(run.state.get('task').value.status, 'paused');
  assert.deepEqual(intercept({ tool: 'exec_command', thread_id: 'thread-1', arguments: {}, call_id: 'next' }),
    { deny: 'workflow_paused_no_progress' });
  assert.deepEqual(intercept({ tool: 'mod_omd_workflow_checkpoint', thread_id: 'thread-1', arguments: {}, call_id: 'repair' }), executed);
  modState = invoke('checkpoint', { remaining_work: ['Try a different approach'] }, run.host,
    { settings, state: modState }).state;
  assert.equal(run.state.get('task').value.status, 'active');
  assert.deepEqual(intercept({ tool: 'exec_command', thread_id: 'thread-1', arguments: {}, call_id: 'retry' }), executed);
  event('tool_result', result);
  assert.equal(run.state.get('task').value.calls[result.call_sha256].unchanged_calls, 1);
});

test('checks bind execution to unchanged input and refuse stale or failed results', () => {
  const run = fixture();
  begin(run.host);
  assert.equal(invoke('check', {}, run.host).value.outcome, 'pass');
  assert.equal(run.receipts[0].candidate_sha256, candidate);
  assert.equal(run.receipts[0].acceptance_sha256, run.state.get('task').value.acceptance.sha256);
  const changed = fixture({ 'exec.run': () => { throw new Error('snapshot_execution_changed_source'); } });
  begin(changed.host);
  assert.throws(() => invoke('check', {}, changed.host), /snapshot_execution_changed_source/);
  assert.equal(changed.receipts.length, 0);
  const failed = fixture({ 'exec.run': () => ({ exit_code: 1, candidate_sha256: candidate, evidence: { reference: 'execution:failed', sha256: digest('failed') } }) });
  begin(failed.host);
  assert.equal(invoke('check', {}, failed.host).value.outcome, 'fail');
});

test('contribution is checked and reviewed on frozen input before integration, and refused before spawning without a check', () => {
  const run = fixture();
  begin(run.host);
  assert.equal(invoke('delegate', { brief: 'Implement the requested change' }, run.host).value.status, 'running');
  assert.equal(invoke('advance', {}, run.host).value.status, 'running');
  assert.equal(invoke('advance', {}, run.host).value.status, 'integrated');
  const spawned = run.calls.filter(call => call.operation === 'agents.spawn');
  assert.equal(spawned[0].arguments.workspace, 'isolated_worktree');
  assert.ok(spawned.slice(1).every(call => call.arguments.workspace === 'read_only' && call.arguments.snapshot.sha256 === candidate));
  assert.deepEqual(run.receipts.map(receipt => receipt.kind), ['contribution_checks', 'contribution_review', 'workspace_integration']);
  assert.equal(run.receipts[0].execution, true);
  assert.equal(run.calls.filter(call => call.operation === 'agents.cancel').length, 2);
  const unchecked = fixture();
  begin(unchecked.host);
  assert.throws(() => invoke('delegate', { brief: 'Implement the requested change' }, unchecked.host, { settings: {} }), /configure_check_command_first/);
  assert.ok(!unchecked.calls.some(call => call.operation === 'agents.spawn'));
});

test('a review that cannot start keeps the finished worker pending and the next advance retries it', () => {
  const run = fixture();
  let denied = true;
  const host = Object.assign(call => {
    if (denied && call.operation === 'agents.spawn' && call.arguments.role === 'contribution_review') throw new Error('allowance_denied');
    return run.host(call);
  }, { store: run.host.store });
  begin(host);
  invoke('delegate', { brief: 'Implement the requested change' }, host);
  const refused = invoke('advance', {}, host, { refusals: true }).value;
  assert.deepEqual([refused.status, refused.reason], ['refused', 'allowance_denied']);
  assert.deepEqual([...run.agents.keys()], ['worker-1']);
  assert.deepEqual([run.state.get('task').value.status, run.state.get('task').value.pending.handle], ['active', 'worker-1']);
  denied = false;
  assert.equal(invoke('advance', {}, host).value.status, 'running');
  assert.deepEqual([run.state.get('task').value.pending.kind, run.state.get('task').value.pending.worker], ['contribution_review', 'worker-1']);
  assert.ok(run.agents.has('worker-1'));
});

test('the context line stays valid JSON and bounded however much work remains', () => {
  const run = fixture();
  begin(run.host);
  invoke('checkpoint', { remaining_work: Array.from({ length: 32 }, (_, index) => `${index} ${'x'.repeat(500)}`), failed_hypotheses: ['y'.repeat(500)] }, run.host);
  const { text } = invoke('', {}, run.host, { event: 'context' }).value;
  const task = JSON.parse(/: (\{.*\})\. Preserve/s.exec(text)[1]);
  assert.deepEqual([task.status, task.remaining_work.length, task.remaining_count, task.failed_hypotheses[0].length], ['active', 3, 32, 60]);
});

test('denial, outage and integration conflict never complete the task', () => {
  for (const [operation, behavior, expected] of [
    ['agents.spawn', () => { throw new Error('allowance_denied'); }, /allowance_denied/],
    ['agents.wait', () => ({ status: 'failed', error: 'provider_outage' }), /provider_outage/],
    ['workspace.integrate', () => { throw new Error('integration_conflict'); }, /integration_conflict/],
  ]) {
    const run = fixture({ [operation]: behavior });
    begin(run.host);
    assert.throws(() => {
      invoke('delegate', { brief: 'Make the change' }, run.host);
      for (let step = 0; step < 3; step++) invoke('advance', {}, run.host);
    }, expected);
    assert.ok(!run.calls.some(call => call.operation === 'task.complete'));
    if (operation !== 'agents.spawn') assert.ok(run.calls.some(call => call.operation === 'agents.cancel'));
    assert.notEqual(run.state.get('task').value.status, 'completed');
  }
});

test('adversarial verification requires three exact categories and binds agent evidence to candidate and acceptance', () => {
  const { run, acceptance, advance } = adversarialFixture();
  const response = advance().value;
  assert.equal(response.status, 'recorded');
  assert.deepEqual(run.receipts.map(receipt => receipt.kind), ['adversarial_verification']);
  assert.deepEqual([run.receipts[0].outcome, run.receipts[0].candidate_sha256, run.receipts[0].acceptance_sha256], ['pass', candidate, acceptance]);
  const prompt = run.calls.find(call => call.operation === 'agents.spawn').arguments.prompt;
  assert.ok(prompt.includes(candidate) && prompt.includes(acceptance));
  assert.ok(challengeKinds.every(kind => prompt.includes(kind)));
});

test('reviewer explicitly resolves only offered prior blocking fingerprints on a passing changed candidate', () => {
  const fingerprint = 'prior.blocker';
  const { run, acceptance, advance } = adversarialFixture(value => resolving(value, [fingerprint]), value => value,
    (ledger, acceptanceSha) => { ledger[fingerprint] = { finding: { fingerprint, severity: 'blocking', summary: 'Old failure', paths: ['source.ts'] },
      reported_candidate_sha256: digest('prior candidate'), acceptance_sha256: acceptanceSha,
      reported_producer: { kind: 'agent', handle: 'old-reviewer' }, report_receipt_index: 0, resolution: null }; });
  const spawned = run.calls.find(call => call.operation === 'agents.spawn').arguments;
  const prompt = spawned.prompt;
  assert.match(prompt, /prior\.blocker/);
  assert.match(prompt, /Old failure/);
  assert.deepEqual(spawned.resolution_context, { acceptance_sha256: acceptance, findings: [fingerprint] });
  assert.equal(advance().value.status, 'recorded');
  assert.deepEqual(run.receipts[0].resolves, [fingerprint]);
  const many = adversarialFixture(value => value, value => value, (ledger, acceptanceSha) => {
    for (let index = 0; index < 32; index++) ledger[`long.${index}`] = { finding: { fingerprint: `long.${index}`, severity: 'blocking', summary: 'S'.repeat(512), paths: ['p/'.repeat(100)] },
      reported_candidate_sha256: digest('prior candidate'), acceptance_sha256: acceptanceSha, reported_producer: { kind: 'agent', handle: 'old-reviewer' }, report_receipt_index: index, resolution: null };
  });
  const crowded = many.run.calls.find(call => call.operation === 'agents.spawn').arguments;
  const offered = crowded.resolution_context.findings;
  assert.ok(Buffer.byteLength(crowded.prompt) <= 8192 && offered.length > 0 && offered.length < 32);
  assert.deepEqual(offered, Array.from({ length: offered.length }, (_, index) => `long.${index}`));
  assert.ok(crowded.prompt.includes(`long.${offered.length - 1}`) && !crowded.prompt.includes(`long.${offered.length}"`) && crowded.prompt.includes(`(+${32 - offered.length} more open findings)`));
  assert.deepEqual(many.run.state.get('task').value.pending.eligible_resolutions, offered);
});

test('equivalent transport outages allow one fresh retry and one configured fallback with original-lead review', () => {
  let waits = 0;
  const run = fixture({ 'agents.wait': ({ arguments: args }) => ++waits <= 2 ? outage : { status: 'completed', text: JSON.stringify(verdict), candidate_sha256: candidate, evidence: { reference: `native-thread:${args.handle}`, sha256: digest(verdict) } } });
  begin(run.host);
  invoke('delegate', { brief: 'Implement the request', outage_action: 'opposite_lead' }, run.host, recoveryOptions);
  assert.equal(invoke('advance', {}, run.host, recoveryOptions).value.recovery, 'same_route_retry');
  assert.equal(invoke('advance', {}, run.host, recoveryOptions).value.recovery, 'opposite_lead_fallback');
  invoke('advance', {}, run.host, recoveryOptions);
  assert.equal(invoke('advance', {}, run.host, recoveryOptions).value.status, 'integrated');
  assert.deepEqual(run.calls.filter(call => call.operation === 'agents.spawn').map(call => call.arguments.route), ['contributor', 'contributor', 'opposite', 'lead']);
});

test('changed route or workspace stops a retry and persisted interruption never recreates an agent', () => {
  let changed = false;
  const run = fixture({ 'agents.wait': () => outage, 'routes.list': () => routes.map(route => changed && route.name === 'contributor' ? { ...route, model: 'replacement' } : route) });
  begin(run.host);
  invoke('delegate', { brief: 'Make the change' }, run.host);
  changed = true;
  assert.throws(() => invoke('advance', {}, run.host), /authorized_route_changed/);
  assert.equal(invoke('advance', {}, run.host).value.status, 'idle');
  assert.equal(run.calls.filter(call => call.operation === 'agents.spawn').length, 1);
  const missing = fixture({ 'agents.wait': () => { throw new Error('agent_missing'); } });
  begin(missing.host);
  invoke('delegate', { brief: 'Make the change' }, missing.host);
  assert.throws(() => invoke('advance', {}, missing.host), /agent_missing/);
  assert.equal(missing.state.get('task').value.status, 'interrupted');
  assert.equal(invoke('advance', {}, missing.host).value.status, 'idle');
});

function crashing(run, rules = {}) {
  const host = call => {
    const value = run.host(call);
    if (rules.after?.(call)) {
      rules.after = null;
      throw crash();
    }
    return value;
  };
  host.store = run.state;
  return host;
}

test('workflow operations replay committed results across processes and reject conflicting, stale and foreign-thread reuse', () => {
  let thread = 'thread-1';
  const run = fixture({ 'task.status': () => ({ ledger: { thread_id: thread, cwd: '/fixture', cost: null } }) });
  assert.equal(begin(run.host).value.revision, 1);
  const operation = { remaining_work: ['Run the check'], operation_id: 'checkpoint-1', expected_revision: 1 };
  const saved = invoke('checkpoint', operation, run.host).value;
  assert.equal(saved.revision, 2);
  assert.deepEqual(invoke('checkpoint', operation, run.host).value, saved);
  assert.equal(run.receipts.filter(receipt => receipt.kind === 'checkpoint').length, 1);
  assert.throws(() => invoke('checkpoint', { ...operation, remaining_work: ['Something else'] }, run.host), /operation_id_conflict/);
  assert.throws(() => invoke('checkpoint', { ...operation, operation_id: 'checkpoint-2' }, run.host), /stale_revision: current 2/);
  assert.equal(invoke('checkpoint', { remaining_work: ['Run the check'] }, run.host, { refusals: true, store: null }).value.reason, 'operation_id_and_expected_revision_required');
  thread = 'thread-2';
  assert.throws(() => invoke('checkpoint', operation, run.host), /operation_id_conflict/);
  assert.deepEqual(run.state.get('task').value.remaining_work, ['Run the check']);
});

test('a crash after commitment delivers the checkpoint receipt on replay without repeating the change', () => {
  const run = fixture();
  const rules = {};
  const host = crashing(run, rules);
  begin(host);
  const operation = { remaining_work: ['Run the check'], operation_id: 'checkpoint-1', expected_revision: 1 };
  rules.after = call => call.operation === 'evidence.write' && call.arguments.label === 'Workflow checkpoint';
  assert.throws(() => invoke('checkpoint', operation, host), /process_crashed/);
  const committed = run.state.get('task').value;
  assert.deepEqual([committed.revision, committed.remaining_work, committed.operations.at(-1).unacknowledged], [2, ['Run the check'], true]);
  assert.equal(run.receipts.length, 0);
  assert.deepEqual(invoke('checkpoint', operation, host).value, committed.operations.at(-1).result);
  assert.equal(run.state.get('task').value.operations.at(-1).unacknowledged, undefined);
  invoke('checkpoint', operation, host);
  assert.deepEqual(run.receipts.map(receipt => receipt.kind), ['checkpoint']);
  assert.equal(run.state.get('task').value.revision, 2);
});

test('an interrupted spawn is never repeated: its claim blocks other operations until replay or cancel resolves it', () => {
  const run = fixture();
  const rules = {};
  const host = crashing(run, rules);
  begin(host);
  const operation = { brief: 'Make the change', operation_id: 'delegate-1', expected_revision: 1 };
  rules.after = call => call.operation === 'agents.spawn';
  assert.throws(() => invoke('delegate', operation, host), /process_crashed/);
  assert.equal(run.state.get('task').value.pending.operation, 'delegate-1');
  assert.throws(() => invoke('review', { kind: 'final_review' }, host, reviewOptions), /operation_in_progress: delegate-1/);
  const resolved = invoke('delegate', operation, host, { refusals: true }).value;
  assert.deepEqual([resolved.status, resolved.reason, run.agents.size], ['interrupted', 'operation_interrupted', 0]);
  assert.deepEqual(invoke('delegate', operation, host, { refusals: true }).value, resolved);
  assert.equal(run.calls.filter(call => call.operation === 'agents.spawn').length, 1);
  rules.after = call => call.operation === 'agents.spawn';
  assert.throws(() => invoke('delegate', { brief: 'Make the change again' }, host), /process_crashed/);
  assert.equal(invoke('cancel', {}, host).value.status, 'cancelled');
  assert.deepEqual([run.agents.size, run.state.get('task').value.pending], [0, null]);
});

test('a losing writer cancels only its own spawn and never clears the winning record or claim', () => {
  for (const race of ['agents.wait', 'agents.spawn']) {
    const run = fixture();
    let racing = null;
    const host = call => {
      const value = run.host(call);
      if (call.operation === racing) {
        racing = null;
        const entry = run.state.get('task');
        run.state.set('task', { ...entry, revision: entry.revision + 1, value: { ...entry.value, calls: { [digest('observer')]: { result_sha256: digest('output'), progress_revision: 1, unchanged_calls: 1 } } } });
      }
      return value;
    };
    host.store = run.state;
    begin(host);
    if (race === 'agents.wait') {
      invoke('delegate', { brief: 'First writer', operation_id: 'delegate-a', expected_revision: 1 }, host);
      assert.throws(() => invoke('delegate', { brief: 'Second writer', operation_id: 'delegate-b', expected_revision: 1 }, host), /stale_revision: current 2/);
    }
    racing = race;
    assert.throws(() => invoke(race === 'agents.wait' ? 'advance' : 'delegate', race === 'agents.wait' ? {} : { brief: 'Raced writer', operation_id: 'delegate-c', expected_revision: 1 }, host), /store_revision_conflict/);
    const task = run.state.get('task').value;
    assert.ok(task.calls[digest('observer')]);
    if (race === 'agents.wait') {
      assert.deepEqual([task.pending.handle, run.agents.has('worker-1'), run.calls.filter(call => call.operation === 'agents.spawn').length], ['worker-1', true, 1]);
      assert.ok(!run.calls.some(call => call.operation === 'agents.cancel'));
    } else {
      assert.deepEqual([task.pending.operation, run.agents.size], ['delegate-c', 0]);
      assert.equal(invoke('delegate', { brief: 'Raced writer', operation_id: 'delegate-c', expected_revision: 1 }, host, { refusals: true }).value.status, 'interrupted');
    }
  }
});

test('operation receipts stay bounded and an evicted replay is stale instead of re-executed', () => {
  const run = fixture();
  begin(run.host);
  const work = index => Array.from({ length: 8 }, (_, item) => `${index}-${item} ${'x'.repeat(490)}`);
  const first = { remaining_work: work(0), operation_id: 'checkpoint-0', expected_revision: 1 };
  invoke('checkpoint', first, run.host);
  for (let index = 1; index < 9; index++) invoke('checkpoint', { remaining_work: work(index) }, run.host);
  const task = run.state.get('task').value;
  assert.ok(task.operations.length < 9 && JSON.stringify(task.operations).length <= 32768 + 1024);
  assert.ok(!task.operations.some(item => item.id === 'checkpoint-0'));
  assert.throws(() => invoke('checkpoint', first, run.host), /stale_revision: current 10/);
  assert.deepEqual(run.state.get('task').value.remaining_work, work(8));
});

test('explicit workflow cancellation releases pending reviewer and writer without integration or resetting acceptance', () => {
  const run = fixture();
  begin(run.host);
  const acceptance = structuredClone(run.state.get('task').value.acceptance);
  invoke('delegate', { brief: 'Implement the requested change' }, run.host);
  invoke('advance', {}, run.host);
  const start = run.calls.length;
  assert.equal(invoke('cancel', {}, run.host).value.status, 'cancelled');
  assert.deepEqual(run.calls.slice(start).filter(call => call.operation.startsWith('agents.')).map(call => call.operation), ['agents.cancel', 'agents.cancel']);
  assert.equal(run.calls.some(call => call.operation === 'workspace.integrate'), false);
  assert.deepEqual(run.state.get('task').value.acceptance, acceptance);
  assert.equal(invoke('advance', {}, run.host).value.status, 'idle');
});

test('a fenced or prefaced reviewer reply is accepted and an unparseable or self-contradicting one is re-reviewed once before the agents are released', () => {
  const reviewed = text => {
    const run = fixture();
    begin(run.host);
    invoke('delegate', { brief: 'Implement the requested change' }, run.host);
    invoke('advance', {}, run.host);
    run.agents.get('worker-2').text = text;
    return { run, result: invoke('advance', {}, run.host).value };
  };
  const json = JSON.stringify(verdict);
  for (const text of [`\`\`\`json\n${json}\n\`\`\``, `Here is {my} verdict: ${json}\nDone.`, `Shape: {"example": 1} and {}.\n${json}`, `${json}\nAgain: ${json}`, `${json}\nReordered: ${JSON.stringify({ findings: [], assessments: verdict.assessments, summary: verdict.summary })}`]) assert.equal(reviewed(text).result.status, 'integrated');
  const failing = JSON.stringify({ ...verdict, assessments: [{ ...verdict.assessments[0], verdict: 'fail' }] });
  assert.equal(reviewed(`Draft: ${json}\nOn re-checking, the criterion fails: ${failing}`).result.recovery, 'review_retry');
  const { run, result } = reviewed('I could not produce a verdict.');
  assert.deepEqual([result.status, result.recovery], ['running', 'review_retry']);
  assert.deepEqual([...run.agents.keys()], ['worker-1', 'worker-3']);
  assert.equal(run.state.get('task').value.pending.worker, 'worker-1');
  assert.equal(run.state.get('task').value.pending.review_retries, 1);
  run.agents.get('worker-3').text = 'still no verdict';
  const failed = invoke('advance', {}, run.host).value;
  assert.deepEqual([failed.status, failed.reason, run.agents.size], ['needs_repair', 'review_output_unparseable', 0]);
  assert.deepEqual([run.state.get('task').value.status, run.state.get('task').value.pending], ['needs_repair', null]);
  let waits = 0;
  const adversarial = adversarialFixture(value => value, value => ++waits === 1 ? { ...value, text: 'no verdict' } : value);
  assert.equal(adversarial.advance().value.recovery, 'review_retry');
  assert.equal(adversarial.advance().value.status, 'recorded');
  const spawned = adversarial.run.calls.filter(call => call.operation === 'agents.spawn');
  assert.deepEqual([spawned.length, spawned[1].arguments.snapshot.sha256, spawned[1].arguments.prompt], [2, candidate, spawned[0].arguments.prompt]);
});

test('an initial task waits for a selected contract and an invalid one stops the mod from loading', () => {
  const settings = { check: { program: 'check', argv: [] }, initial_task: { objective: 'Make the requested change', acceptance_criteria: [criterion] } };
  const waiting = fixture({ 'contract.status': () => ({ status: 'inactive', active: null, receipts: [], restrictions: [], finding_ledger: {} }) });
  invoke('', {}, waiting.host, { event: 'turn_start', settings });
  assert.equal(waiting.state.get('task'), undefined);
  for (const initial_task of [{ objective: 'x'.repeat(4096), acceptance_criteria: ['y'.repeat(500), 'z'.repeat(500)] }, { objective: 'Make the change' }]) {
    const refused = fixture();
    assert.throws(() => invoke('', {}, refused.host, { event: 'turn_start', settings: { ...settings, initial_task } }), /task_too_large_for_review|task_objective_and_acceptance_required/);
    assert.equal(refused.state.get('task'), undefined);
  }
  const selected = fixture();
  invoke('', {}, selected.host, { event: 'turn_start', settings });
  assert.equal(selected.state.get('task').value.status, 'active');
});
