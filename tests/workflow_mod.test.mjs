import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const runner = readFileSync(new URL('../runtime/omd/src/mods/runner.mjs', import.meta.url), 'utf8');
const source = readFileSync(new URL('../mods/first-party/omd_workflow/index.ts', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../mods/first-party/omd_workflow/mod.json', import.meta.url), 'utf8'));
const native = readFileSync(new URL('../runtime/omd/src/mods.rs', import.meta.url), 'utf8');
const events = native.match(/pub const MOD_EVENTS:[\s\S]*?= &\[([\s\S]*?)\];/)[1];
const intercepts = Object.fromEntries([...native.match(/pub const MOD_INTERCEPT_SURFACES:[\s\S]*?= &\[([\s\S]*?)\];/)[1].matchAll(/\("([a-z_]+)", "([a-z_.]+)"\)/g)].map(match => [match[1], match[2]]));
const surface = { events: Object.fromEntries([...events.matchAll(/\("([a-z_]+)", "([a-z_.]+)"\)/g)].map(match => [match[1], match[2]])), replacements: [], middleware: ['model_request'], intercept: intercepts, state: 'store', contracts: 'contracts' };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const candidate = digest('candidate');
const criterion = 'Preserve the current work';
const verdict = { summary: 'Inspected the candidate.', assessments: [{ criterion, verdict: 'pass', evidence: ['source.ts:1 inspected; configured check exited 0'] }], findings: [] };

function invoke(name, payload, host, extra = {}) {
  const receipts = [];
  for (let turn = 0; turn < 33; turn++) {
    const request = { source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, state: null,
      settings: { check: { program: 'check', argv: [] } }, surface, event: 'tool', name, payload, receipts, ...extra };
    const child = spawnSync(process.execPath, ['--no-warnings', '--experimental-vm-modules', '--input-type=module', '--eval', runner], { input: JSON.stringify(request), encoding: 'utf8', timeout: 5000 });
    assert.ifError(child.error);
    const reply = JSON.parse(child.stdout);
    if (reply.error) throw new Error(reply.error);
    if (!reply.host_call) {
      if (reply.value?.status === 'refused' && typeof reply.value.reason === 'string' && !extra.refusals) throw new Error(reply.value.reason);
      return reply;
    }
    assert.ok(receipts.length < 32, 'native callback host-call limit');
    try { receipts.push({ call: reply.host_call, value: host(reply.host_call) }); }
    catch (error) { receipts.push({ call: reply.host_call, error: error.message }); }
  }
  throw new Error('fixture_operation_limit');
}

function fixture(overrides = {}, contract = 'reviewed_omd', findingLedger = {}) {
  const state = new Map();
  const agents = new Map();
  const receipts = [];
  const calls = [];
  let next = 0;
  return { state, receipts, calls, host(call) {
    calls.push(call);
    if (overrides[call.operation]) return overrides[call.operation](call);
    const args = call.arguments;
    switch (call.operation) {
      case 'contract.status': return { status: 'active', active: { id: contract }, receipts, restrictions: [], finding_ledger: findingLedger };
      case 'task.status': return { ledger: { thread_id: 'thread-1', cost: null } };
      case 'store.get': return state.get(args.key) ?? null;
      case 'store.put': {
        const before = state.get(args.key);
        assert.equal(args.expected_revision, before?.revision ?? null);
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
      case 'receipts.submit': receipts.push(structuredClone(args)); return args;
      case 'workspace.integrate': assert.equal(receipts.length, 2); assert.ok(receipts.every(receipt => receipt.acceptance_sha256 === args.acceptance_sha256)); return { status: 'integrated', candidate_sha256: candidate, changed_paths: ['source.ts'], evidence: { path: '/fixture/integration', sha256: candidate } };
      case 'exec.run': return { candidate_sha256: args.snapshot.sha256, evidence: { reference: 'execution:fixture', sha256: digest('execution') }, exit_code: 0, timed_out: false, signal: null, stdout: 'passed', stderr: '', stdout_truncated: false, stderr_truncated: false, duration_ms: 1, program: { path: '/fixture/check', sha256: digest('check') } };
      case 'task.complete': return { status: 'refused', missing: [{ receipt: 'final_review' }] };
      default: throw new Error(`unexpected_operation: ${call.operation}`);
    }
  } };
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

test('workflow registers its contracts without running work and rejects missing selection', () => {
  const reply = invoke('', null, () => assert.fail('activation called host'), { event: 'inspect' });
  assert.deepEqual(reply.registrations.contracts.map(contract => [contract.id, contract.assurance]), [['reviewed_omd', 'independently-verified'], ['solo_evidence', 'self-reviewed']]);
  const denied = fixture({ 'contract.status': () => ({ status: 'none', active: null }) });
  assert.deepEqual(invoke('begin', { objective: 'x', acceptance_criteria: [criterion] }, denied.host, { refusals: true }).value, { status: 'refused', reason: 'select_workflow_contract_first' });
  assert.throws(() => begin(denied.host), /select_workflow_contract_first/);
  assert.equal(denied.calls.length, 2);
  const oldHost = fixture({ 'contract.status': () => ({ status: 'active', active: { id: 'reviewed_omd' } }) });
  assert.throws(() => begin(oldHost.host), /finding_ledger_required/);
});

test('task-entry lead chooses a distinct same-billing opposite route for review and fallback', () => {
  const run = fixture();
  begin(run.host);
  const options = { state: { 'thread-1': { model: 'lead', provider: 'fixture' } },
    settings: { check: { program: 'check', argv: [] }, review_route: 'opposite_lead', fallback_route: 'opposite_lead' } };
  const started = invoke('delegate', { brief: 'Make the change', outage_action: 'opposite_lead' }, run.host, options);
  assert.equal(started.value.status, 'running');
  const selected = run.state.get('task').value.pending.delegation;
  assert.equal(selected.reviewer.name, 'opposite');
  assert.equal(selected.fallback.name, 'opposite');
  assert.equal(selected.original_lead.name, 'lead');
});

test('checkpoint survives a new invocation, is compare-and-set, and cannot rewrite acceptance', () => {
  const run = fixture();
  const initial = begin(run.host).value;
  invoke('checkpoint', { remaining_work: ['Run the check'], failed_hypotheses: ['Earlier approach failed'] }, run.host);
  assert.throws(() => begin(run.host), /task_already_initialized/);
  assert.throws(() => invoke('checkpoint', { acceptance_criteria: ['weaker'] }, run.host), /checkpoint_fields_invalid/);
  const saved = run.state.get('task').value;
  assert.deepEqual(saved.acceptance, initial.acceptance);
  assert.deepEqual(saved.remaining_work, ['Run the check']);
  const context = invoke('', { thread_id: 'thread-1' }, run.host, { event: 'context' });
  assert.match(context.value.text, /Run the check/);
  invoke('', null, () => assert.fail('resume restarted work'), { event: 'resume' });
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
    const reply = invoke('0', { surface: 'tool', input, origin: { caller: 'model' } }, host, { event: 'intercept', settings, state: modState });
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

test('no-progress detection keeps pausing after many distinct calls by evicting the oldest observations', () => {
  const run = fixture();
  const settings = { check: { program: 'check', argv: [] }, max_no_progress_calls: 1 };
  const options = { settings };
  let modState = invoke('begin', { objective: 'Make the requested change', acceptance_criteria: [criterion] }, run.host, options).state;
  const entry = run.state.get('task');
  const seeded = Object.fromEntries(Array.from({ length: 128 }, (_, index) =>
    [digest(`call-${index}`), { result_sha256: digest('output'), progress_revision: 1, unchanged_calls: 1 }]));
  run.state.set('task', { ...entry, value: { ...entry.value, calls: seeded } });
  const result = { thread_id: 'thread-1', agent_id: null, tool: 'exec_command', outcome: 'succeeded',
    call_sha256: digest('repeated-call'), result_sha256: digest('same-output'), result_complete: true };
  for (let index = 0; index < 2; index++) modState = invoke('', result, run.host, { ...options, event: 'tool_result', state: modState }).state;
  const task = run.state.get('task').value;
  assert.equal(task.status, 'paused');
  assert.equal(Object.keys(task.calls).length, 128);
  assert.equal(task.calls[digest('call-0')], undefined);
  assert.equal(task.calls[result.call_sha256].unchanged_calls, 2);
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

test('contribution is checked and reviewed on frozen input before integration', () => {
  const run = fixture();
  begin(run.host);
  assert.equal(invoke('delegate', { brief: 'Implement the requested change' }, run.host).value.status, 'running');
  assert.equal(invoke('advance', {}, run.host).value.status, 'running');
  assert.equal(invoke('advance', {}, run.host).value.status, 'integrated');
  const spawned = run.calls.filter(call => call.operation === 'agents.spawn');
  assert.equal(spawned[0].arguments.workspace, 'isolated_worktree');
  assert.ok(spawned.slice(1).every(call => call.arguments.workspace === 'read_only' && call.arguments.snapshot.sha256 === candidate));
  assert.deepEqual(run.receipts.map(receipt => receipt.kind), ['contribution_checks', 'contribution_review']);
  assert.equal(run.receipts[0].execution, true);
  assert.equal(run.calls.find(call => call.operation === 'exec.run').arguments.snapshot.sha256, candidate);
  assert.equal(run.calls.filter(call => call.operation === 'agents.cancel').length, 2);
});

test('denial, outage, malformed review and integration conflict never complete the task', () => {
  for (const [operation, behavior, expected] of [
    ['agents.spawn', () => { throw new Error('allowance_denied'); }, /allowance_denied/],
    ['agents.wait', () => ({ status: 'failed', error: 'provider_outage' }), /provider_outage/],
    ['agents.wait', () => ({ status: 'completed', text: '{}', candidate_sha256: candidate, evidence: { reference: 'bad', sha256: candidate } }), /review_schema_invalid/],
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
  assert.equal(run.receipts[0].outcome, 'pass');
  assert.equal(run.receipts[0].candidate_sha256, candidate);
  assert.equal(run.receipts[0].acceptance_sha256, acceptance);
  assert.equal(run.receipts[0].agent, 'worker-1');
  assert.deepEqual(run.state.get('task').value.decisions.at(-1).challenges.map(challenge => challenge.kind), challengeKinds);
  const prompt = run.calls.find(call => call.operation === 'agents.spawn').arguments.prompt;
  assert.ok(prompt.includes(candidate) && prompt.includes(acceptance));
  assert.ok(challengeKinds.every(kind => prompt.includes(kind)));
});

test('adversarial verification rejects missing, duplicate, unknown and invalid challenge evidence before receipt submission', () => {
  const malformed = [
    value => ({ ...value, challenges: value.challenges.slice(0, 2) }),
    value => ({ ...value, challenges: [value.challenges[0], value.challenges[0], value.challenges[2]] }),
    value => ({ ...value, challenges: [{ ...value.challenges[0], kind: 'other' }, ...value.challenges.slice(1)] }),
    value => ({ ...value, challenges: [{ ...value.challenges[0], paths: ['../source.ts'] }, ...value.challenges.slice(1)] }),
    value => ({ ...value, challenges: [{ ...value.challenges[0], paths: [] }, ...value.challenges.slice(1)] }),
  ];
  for (const change of malformed) {
    const { run, advance } = adversarialFixture(change);
    assert.throws(advance, /adversarial_categories_required_exactly_once|adversarial_challenge_invalid/);
    assert.equal(run.receipts.length, 0);
    assert.equal(run.state.get('task').value.status, 'interrupted');
    assert.ok(!run.calls.some(call => call.operation === 'task.complete'));
  }
});

test('adversarial verification rejects stale candidate or acceptance claims without a receipt', () => {
  for (const change of [
    value => ({ ...value, candidate_sha256: digest('other candidate') }),
    value => ({ ...value, acceptance_sha256: digest('other acceptance') }),
  ]) {
    const { run, advance } = adversarialFixture(change);
    assert.throws(advance, /adversarial_binding_mismatch/);
    assert.equal(run.receipts.length, 0);
  }
  const stale = adversarialFixture(value => value, value => ({ ...value, candidate_sha256: digest('other candidate') }));
  assert.throws(stale.advance, /review_candidate_changed/);
  assert.equal(stale.run.receipts.length, 0);
});

test('adversarial findings, blocked checks and unavailable evidence yield failed incomplete receipts', () => {
  for (const [verdict, status] of [['finding', 'needs_repair'], ['blocked', 'blocked'], ['unverified', 'unverified']]) {
    const { run, advance } = adversarialFixture(value => ({ ...value, challenges: [{ ...value.challenges[0], verdict }, ...value.challenges.slice(1)] }));
    const response = advance().value;
    assert.equal(response.status, status);
    assert.equal(response.receipt.outcome, 'fail');
    assert.equal(run.receipts[0].outcome, 'fail');
    assert.equal(run.state.get('task').value.status, status);
    assert.equal(response.challenges[0].verdict, verdict);
  }
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
  assert.equal(spawned.snapshot.sha256, candidate);
  assert.equal(spawned.evidence.sha256, acceptance);
  assert.equal(advance().value.status, 'recorded');
  assert.deepEqual(run.receipts[0].resolves, [fingerprint]);
  assert.equal(run.receipts[0].acceptance_sha256, acceptance);
  assert.equal(run.receipts[0].candidate_sha256, candidate);
});

test('a clean later review does not claim resolution of an earlier blocker', () => {
  const fingerprint = 'prior.blocker';
  const ledger = {};
  const { run, advance } = adversarialFixture(value => value, value => value, (entries, acceptanceSha) => {
    entries[fingerprint] = { finding: { fingerprint, severity: 'blocking', summary: 'Old failure', paths: ['source.ts'] },
      reported_candidate_sha256: digest('prior candidate'), acceptance_sha256: acceptanceSha,
      reported_producer: { kind: 'agent', handle: 'old-reviewer' }, report_receipt_index: 0, resolution: null };
    ledger[fingerprint] = entries[fingerprint];
  });
  assert.deepEqual(run.calls.find(call => call.operation === 'agents.spawn').arguments.resolution_context.findings, [fingerprint]);
  assert.equal(advance().value.status, 'recorded');
  assert.equal(run.receipts[0].resolves, undefined);
  assert.equal(ledger[fingerprint].resolution, null);
});

test('invented, duplicate, stale-candidate and failing resolutions are rejected without a receipt', () => {
  const fingerprint = 'prior.blocker';
  const setup = (ledger, acceptanceSha, reported = digest('prior candidate')) => { ledger[fingerprint] = {
    finding: { fingerprint, severity: 'blocking', summary: 'Old failure', paths: ['source.ts'] },
    reported_candidate_sha256: reported, acceptance_sha256: acceptanceSha,
    reported_producer: { kind: 'agent', handle: 'old-reviewer' }, report_receipt_index: 0, resolution: null }; };
  for (const [change, prepare, expected] of [
    [value => resolving(value, ['invented']), setup, /review_resolution_not_offered/],
    [value => resolving(value, [fingerprint, fingerprint]), setup, /review_resolution_invalid/],
    [value => resolving(value, [fingerprint]), (ledger, acceptanceSha) => setup(ledger, acceptanceSha, candidate), /review_resolution_not_offered/],
    [value => ({ ...resolving(value, [fingerprint]), challenges: [{ ...value.challenges[0], verdict: 'finding' }, ...value.challenges.slice(1)] }),
      setup, /review_resolution_requires_passing_agent/],
  ]) {
    const { run, advance } = adversarialFixture(change, value => value, prepare);
    assert.throws(advance, expected);
    assert.equal(run.receipts.length, 0);
  }
});

test('reviewer resolution requires its own exact pass assertion before receipt submission', () => {
  const fingerprint = 'prior.blocker';
  const setup = (ledger, acceptanceSha) => { ledger[fingerprint] = {
    finding: { fingerprint, severity: 'blocking', summary: 'Old failure', paths: ['source.ts'] },
    reported_candidate_sha256: digest('prior candidate'), acceptance_sha256: acceptanceSha,
    reported_producer: { kind: 'agent', handle: 'old-reviewer' }, report_receipt_index: 0, resolution: null }; };
  for (const change of [
    value => ({ ...value, resolves: [fingerprint] }),
    value => ({ ...resolving(value, [fingerprint]), resolution_assertion: { ...resolving(value, [fingerprint]).resolution_assertion, outcome: 'fail' } }),
    value => ({ ...resolving(value, [fingerprint]), resolution_assertion: { ...resolving(value, [fingerprint]).resolution_assertion, candidate_sha256: digest('other candidate') } }),
    value => ({ ...resolving(value, [fingerprint]), resolution_assertion: { ...resolving(value, [fingerprint]).resolution_assertion, resolves: ['invented'] } }),
  ]) {
    const { run, advance } = adversarialFixture(change, value => value, setup);
    assert.throws(advance, /review_resolution_assertion_invalid/);
    assert.equal(run.receipts.length, 0);
  }
});

test('host refusal preserves remaining work and solo verification cannot claim independence', () => {
  const run = fixture({}, 'solo_evidence');
  begin(run.host);
  const receipt = invoke('self_verify', { kind: 'self_review', candidate_sha256: candidate, review: verdict }, run.host).value;
  assert.equal(receipt.agent, undefined);
  assert.equal(receipt.kind, 'self_review');
  assert.throws(() => invoke('delegate', { brief: 'Delegate anyway' }, run.host), /reviewed_contract_required/);
  assert.throws(() => invoke('complete', {}, run.host), /record_current_acceptance_assessments_first/);
  invoke('acceptance', { candidate_sha256: candidate, review: verdict }, run.host);
  assert.equal(invoke('complete', {}, run.host).value.status, 'refused');
  assert.deepEqual(run.state.get('task').value.remaining_work, [criterion]);
});

test('parent history is explicitly delivered by the host, never reconstructed from the public session projection', () => {
  const run = fixture();
  begin(run.host);
  invoke('delegate', { brief: 'Implement using the selected full context', parent_history: true }, run.host);
  assert.equal(run.calls.find(call => call.operation === 'agents.spawn').arguments.parent_history, true);
  assert.ok(!run.calls.some(call => call.operation.startsWith('sessions.')));
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
  assert.equal(run.state.get('task').value.outage_retries, 1);
  assert.equal(run.state.get('task').value.outage_fallbacks, 1);
});

test('outage recovery pauses for nontransport errors, different failures, exhausted attempts and billing changes', () => {
  for (const category of ['authorization', 'rate_limit', 'sandbox', 'allowance', 'invalid_request', 'unknown']) {
    const run = fixture({ 'agents.wait': () => ({ ...outage, failure: { ...outage.failure, category } }) });
    begin(run.host);
    invoke('delegate', { brief: 'Make the change' }, run.host);
    assert.throws(() => invoke('advance', {}, run.host), /native_agent_failed/);
    assert.equal(run.calls.filter(call => call.operation === 'agents.spawn').length, 1);
  }
  for (const changed of [false, true]) {
    let waits = 0;
    const run = fixture({ 'agents.wait': () => ++waits === 2 && changed ? { ...outage, failure: { ...outage.failure, code: 'different' } } : outage });
    begin(run.host);
    invoke('delegate', { brief: 'Make the change', outage_action: 'opposite_lead' }, run.host, recoveryOptions);
    invoke('advance', {}, run.host, recoveryOptions);
    if (!changed) invoke('advance', {}, run.host, recoveryOptions);
    assert.throws(() => invoke('advance', {}, run.host, recoveryOptions), /native_agent_failed/);
    assert.equal(run.calls.filter(call => call.operation === 'agents.spawn').length, changed ? 2 : 3);
    assert.equal(invoke('advance', {}, run.host).value.status, 'idle');
  }
  const paid = fixture({ 'routes.list': () => routes.map(route => route.name === 'opposite' ? { ...route, billing: 'explicit_paid_api_grant' } : route) });
  begin(paid.host);
  assert.throws(() => invoke('delegate', { brief: 'Make the change', outage_action: 'opposite_lead' }, paid.host, recoveryOptions), /same_billing_required/);
  assert.ok(!paid.calls.some(call => call.operation === 'agents.spawn'));
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

const typedSource = readFileSync(new URL('../mods/first-party/omd_typed_tasks/index.ts', import.meta.url), 'utf8');
const typedManifest = JSON.parse(readFileSync(new URL('../mods/first-party/omd_typed_tasks/mod.json', import.meta.url), 'utf8'));
const resultSchema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false };
const typedSettings = { max_fan_out: 4, check: { program: 'check', argv: [] }, review_route: 'reviewer', task_types: {
  read: { role: 'investigator', route: 'contributor', tools: 'read_search', result_schema: resultSchema },
  edit: { role: 'editor', route: 'contributor', tools: 'workspace_edit', result_schema: resultSchema },
} };
const typedResult = { status: 'completed', text: JSON.stringify({ result: { answer: 'observed' }, sources: [{ ref: 'source.ts:1', why: 'inspected' }] }), candidate_sha256: candidate, evidence: { reference: 'native-thread:typed', sha256: digest('typed') } };
const typed = (name, payload, run) => invoke(name, payload, call => call.operation === 'mods.service' ? run.state.get('task').value : run.host(call),
  { source: typedSource, capabilities: typedManifest.capabilities, settings: typedSettings });

test('typed tasks validate all results before checks and independently review edits before host integration', () => {
  const run = fixture({ 'agents.wait': call => call.arguments.handle === 'worker-3'
    ? { ...typedResult, text: JSON.stringify({ assessments: verdict.assessments, findings: [] }) } : typedResult });
  begin(run.host);
  assert.equal(typed('run', { tasks: [{ id: 'read', type: 'read', prompt: 'Inspect' }, { id: 'edit', type: 'edit', prompt: 'Edit' }] }, run).value.status, 'running');
  typed('advance', {}, run);
  assert.ok(!run.calls.some(call => call.operation === 'exec.run'));
  for (let step = 0; step < 5; step++) typed('advance', {}, run);
  assert.equal(run.state.get('batch').value.status, 'completed');
  assert.deepEqual(run.receipts.map(receipt => receipt.kind), ['contribution_checks', 'contribution_review']);
  assert.equal(run.calls.filter(call => call.operation === 'workspace.integrate').length, 1);
  const edits = run.calls.filter(call => call.operation === 'agents.spawn');
  assert.deepEqual(edits.map(call => call.arguments.workspace), ['read_only', 'isolated_worktree', 'read_only']);
  assert.ok(edits[0].arguments.snapshot);
});

test('typed fanout stays bounded while workers run, and explicit cancellation never reverts integrated work', () => {
  const run = fixture({ 'agents.wait': () => ({ status: 'running' }) });
  begin(run.host);
  typed('run', { tasks: [1, 2, 3, 4].map(id => ({ id: String(id), type: 'read', prompt: 'Inspect' })) }, run);
  for (let step = 0; step < 3; step++) assert.equal(typed('advance', {}, run).value.status, 'running');
  assert.equal(run.calls.filter(call => call.operation === 'agents.wait').length, 3);
  assert.equal(typed('cancel', {}, run).value.status, 'cancelled');
  assert.equal(run.calls.filter(call => call.operation === 'agents.cancel').length, 4);
  assert.ok(!run.calls.some(call => call.operation === 'workspace.restore'));
});

test('typed malformed output, host refusal and vanished handles stay interrupted without respawning', () => {
  for (const kind of ['malformed', 'refused', 'missing']) {
    const run = fixture({ 'agents.wait': call => {
      if (kind === 'missing') throw new Error('unknown_or_foreign_agent');
      if (kind === 'malformed') return { ...typedResult, text: '{}' };
      return call.arguments.handle === 'worker-1' ? typedResult : { ...typedResult, text: JSON.stringify({ assessments: verdict.assessments, findings: [] }) };
    }, 'workspace.integrate': () => ({ status: 'refused', missing: ['required receipt'] }) });
    begin(run.host);
    typed('run', { tasks: [{ id: 'edit', type: 'edit', prompt: 'Edit' }] }, run);
    assert.throws(() => { for (let step = 0; step < 5; step++) typed('advance', {}, run); }, /worker_result_schema_mismatch|unknown_or_foreign_agent|typed_integration_refused/);
    assert.equal(run.state.get('batch').value.status, 'interrupted');
    const spawns = run.calls.filter(call => call.operation === 'agents.spawn').length;
    assert.equal(typed('advance', {}, run).value.status, 'interrupted');
    assert.equal(run.calls.filter(call => call.operation === 'agents.spawn').length, spawns);
  }
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
