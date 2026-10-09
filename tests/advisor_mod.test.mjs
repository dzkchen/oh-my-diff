import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { callback } from './mod_runner.mjs';

const root = new URL('../mods/first-party/omd_advisor/', import.meta.url);
const source = readFileSync(new URL('index.ts', root), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('mod.json', root), 'utf8'));

test('every-turn advisor suppresses the same model unless explicitly enabled', () => {
  for (const skip of [true, false]) {
    const calls = [];
    const result = callback({ source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities,
      settings: { every_turn: true, skip_same_model: skip }, state: null, environment: manifest.environment,
      surface: { events: { start: 'lifecycle', resume: 'lifecycle', turn_start: 'lifecycle', workspace_change: 'fs.read', turn_end: 'lifecycle', agent_end: 'agents', context: 'context', terminal: 'terminal' }, replacements: [], middleware: [], state: 'store', contracts: 'contracts' },
      event: 'turn_end', payload: { outcome: 'completed', turn_id: 'turn', evidence: { sha256: 'a'.repeat(64) } },
    }, ({ operation }) => {
      calls.push(operation);
      if (operation === 'routes.list') return [{ name: 'astra', model: 'same' }];
      if (operation === 'task.status') return { ledger: { thread_id: 'thread' } };
      if (operation === 'app.request') return { thread: { model: 'same' } };
      if (operation === 'evidence.read') throw new Error('fixture_stop_after_suppression');
      throw new Error(`unexpected ${operation}`);
    }, []);
    assert.equal(result.error, undefined);
    assert.equal(calls.includes('evidence.read'), !skip);
    assert.equal(calls.includes('workspace.snapshot'), false);
    assert.equal(calls.includes('agents.spawn'), false);
  }
});

test('the opt-in observer flags cited visible output, drops forged quotes and duplicates, and clears stale or superseded notes', () => {
  const surface = { events: { start: 'lifecycle', resume: 'lifecycle', turn_start: 'lifecycle', workspace_change: 'fs.read', turn_end: 'lifecycle', agent_end: 'agents', context: 'context', terminal: 'terminal' }, replacements: [], middleware: [], state: 'store', contracts: 'contracts' };
  const said = 'I raised the upload retry limit to unlimited, so failed uploads now retry forever. The api_key=sk-live-123456 stays in config.';
  const evidence = sha => ({ turn_id: `turn-${sha}`, thread_id: 'thread', workspace_sha256: 'c'.repeat(64), records: [{ item: 1, role: 'user', text: 'Make uploads reliable' }, { item: 2, role: 'assistant', text: `${said} ${'Details follow. '.repeat(10)}` }, { item: 3, type: 'tool_call', name: 'shell', call_id: 'c1' }] });
  const run = (event, payload, state, host = () => { throw new Error('unexpected'); }, { settings = { observe: true }, name } = {}) => {
    const calls = [];
    const result = callback({ source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, settings, state, environment: manifest.environment, surface, event, payload, name }, call => { calls.push(call); return host(call); }, []);
    assert.equal(result.error, undefined);
    return { ...result, calls };
  };
  const off = run('terminal', { event: 'idle', ledger: null }, null, undefined, { settings: {} });
  assert.deepEqual(off.registrations.events, ['terminal']);
  assert.deepEqual(off.registrations.commands.map(command => command.name), ['advisor']);

  const end = (sha, host) => run('turn_end', { turn_id: `turn-${sha}`, outcome: 'completed', evidence: { reference: `evidence:${sha}`, sha256: sha.repeat(64) } }, state, ({ operation, arguments: input }) => {
    if (operation === 'evidence.read') return { reference: input.reference, text: JSON.stringify(evidence(sha)), cursor: null, bytes: 1 };
    return host(operation, input);
  });
  const finish = (handle, notes) => run('agent_end', { handle, role: 'advisor', status: 'completed', text: typeof notes === 'string' ? notes : JSON.stringify({ notes }), sha256: 'f'.repeat(64) }, state, ({ operation }) => {
    if (operation === 'agents.inventory') return { agents: [{ agent_id: handle, usage: { requests: 1, input_tokens: 900, output_tokens: 80, cached_tokens: 0, microusd: 1200, basis: 'settled', source: 'accounting' }, duration_ms: 4200 }] };
    if (operation === 'agents.cancel') return { cancelled: false };
    throw new Error(`unexpected ${operation}`);
  });
  const note = { kind: 'behavior_change', implication: 'Failed uploads never stop retrying, which can hide outages.', detail: 'The limit was removed rather than raised.', quote: 'retry limit to unlimited' };
  let state = null;
  let step = end('a', (operation, input) => {
    assert.equal(operation, 'agents.spawn');
    assert.deepEqual([input.workspace, input.tools, input.snapshot, input.evidence.reference], ['read_only', [], undefined, 'evidence:a']);
    assert.match(input.prompt, /\[redacted\]/);
    assert.doesNotMatch(input.prompt, /sk-live-123456/);
    return { handle: 'h1', route: 'astra', permissions: 'read_only' };
  });
  state = step.state;
  assert.equal(state.observer.status, 'observing');
  step = finish('h1', [note, { ...note, kind: 'uncertainty', quote: 'tests all pass on every platform' }]);
  state = step.state;
  assert.deepEqual(state.observer.notes.map(item => [item.kind, item.item, item.turn]), [['behavior_change', 2, 'turn-a']]);
  assert.equal(state.observer.dropped, 1, 'a quote missing from the visible output is dropped');
  assert.deepEqual(state.observer.cost, { microusd: 1200, input_tokens: 900, output_tokens: 80, basis: 'settled', duration_ms: 4200 });
  const view = run('terminal', { event: 'idle', ledger: null }, state).value;
  assert.equal(view.status[0], 'Advisor on demand · 1 to know');
  const [slot, box] = view.sites.above_composer.components;
  assert.deepEqual([slot.type, box.title, box.children[0].rows[0].value, box.children[0].action.command], ['slot', 'You should know', '1', 'omd_advisor:observations']);

  state = end('b', () => ({ handle: 'h2', route: 'astra', permissions: 'read_only' })).state;
  state = finish('h2', [{ ...note, implication: 'Reworded: uploads retry without end.' }]).state;
  assert.deepEqual(state.observer.notes.map(item => item.implication), [note.implication], 'a repeated note is suppressed and the unchanged candidate keeps its note');

  state = run('command', '1', state, undefined, { name: 'observations' }).state;
  const dialog = run('terminal', { event: 'idle', ledger: null }, state).value.sites.dialog.components[0];
  assert.equal(dialog.children[1].text, 'Source: turn turn-a, visible message 2: "retry limit to unlimited"');
  const dismissed = run('command', 'dismiss 1', state, undefined, { name: 'observations' }).state;
  assert.deepEqual([dismissed.observer.notes, dismissed.observer.inspect], [[], null]);

  const stale = run('workspace_change', { repository: '/repo', source: 'external', call_id: null, changes: [], status: 'observed' }, state, ({ operation }) => {
    assert.equal(operation, 'workspace.fingerprint');
    throw new Error('candidate_changed');
  }).state;
  assert.deepEqual([stale.observer.status, stale.observer.notes], ['stale', []]);
  state = stale;

  const denied = end('c', () => { throw new Error('admission_denied: worker_limits'); });
  assert.deepEqual([denied.state.observer.status, denied.state.observer.reason], ['unavailable', 'admission_denied: worker_limits']);
  assert.equal(run('terminal', { event: 'idle', ledger: null }, denied.state).value.status[0], 'Advisor on demand · watch unavailable');
  state = end('d', () => ({ handle: 'h4', route: 'astra', permissions: 'read_only' })).state;
  const invalid = finish('h4', 'not json').state;
  assert.equal(invalid.observer.status, 'invalid_result');
  assert.ok(Buffer.byteLength(run('terminal', { event: 'idle', ledger: null }, invalid).value.status[0]) <= 40, 'a status segment over 40 bytes drops the whole view');
  assert.equal(finish('h4', [{ ...note, kind: 'constructor' }]).state.observer.status, 'invalid_result', 'a kind inherited from Object is rejected');
  const superseded = run('turn_start', { turn_id: 'turn-e' }, state, ({ operation, arguments: input }) => { assert.deepEqual([operation, input], ['agents.cancel', { handle: 'h4' }]); return { cancelled: true }; });
  assert.equal(superseded.state.observer.status, 'superseded');
  const resumed = run('resume', null, state, () => ({ cancelled: true }));
  assert.equal(resumed.state.observer.status, 'interrupted', 'resume never relaunches an observer');
  assert.deepEqual(resumed.calls.map(call => [call.operation, call.arguments]), [['agents.cancel', { handle: 'h4' }]], 'resume stops the interrupted observer');
});

const digest = text => createHash('sha256').update(text).digest('hex');

function invoke(payload, host, extra = {}) {
  const request = { source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, environment: manifest.environment, surface: { events: {}, state: 'store', contracts: 'contracts' }, state: null, settings: {}, event: 'command', name: '', payload, ...extra };
  const reply = callback(request, host, [], { capture: error => !error.crash && !(error instanceof assert.AssertionError) });
  if (reply.error) throw new Error(reply.error);
  return reply;
}

const nativeEvents = readFileSync(new URL('../runtime/omd/src/mods.rs', import.meta.url), 'utf8').match(/pub const MOD_EVENTS:[\s\S]*?= &\[([\s\S]*?)\];/)[1];
const advisorOptions = { surface: { events: Object.fromEntries([...nativeEvents.matchAll(/\("([a-z_]+)", "([a-z_.]+)"\)/g)].map(match => [match[1], match[2]])), state: 'store', contracts: 'contracts' }, event: 'turn_end', name: '', settings: { every_turn: true } };
const evidence = { turn_id: 'turn-1', thread_id: 'thread-1', workspace_sha256: digest('source'), records: [{ item: 1, role: 'assistant', text: 'The exact supporting concern from this turn.' }] };
const reference = { reference: digest('ref'), sha256: digest(JSON.stringify(evidence)) };
const completed = { turn_id: 'turn-1', outcome: 'completed', evidence: reference };

const findings = [{ key: 'unsupported-claim', severity: 'blocking', summary: 'Check this unsupported claim.', paths: [], quote: 'exact supporting concern' }];

function advisorHost(overrides = {}, source = evidence) {
  const calls = [];
  return { calls, host(call) {
    calls.push(call);
    if (Object.hasOwn(overrides, call.operation)) return overrides[call.operation](call);
    if (call.operation === 'routes.list') return [];
    if (call.operation === 'task.status') return { ledger: { thread_id: 'thread-1' } };
    if (call.operation === 'app.request') return { thread: { model: 'lead-model' } };
    if (call.operation === 'evidence.read') return { reference, text: JSON.stringify(source), cursor: null, bytes: 200 };
    if (['workspace.snapshot', 'workspace.fingerprint'].includes(call.operation)) return { snapshot: { reference: 'snapshot:fixture', sha256: source.workspace_sha256 }, candidate_sha256: source.workspace_sha256 };
    if (call.operation === 'contract.status') return { status: 'active', active: { gates: { complete: [{ receipt: 'advisor_review', producer: 'separate_agent', blocking_findings: 'reject' }] } } };
    if (call.operation === 'agents.spawn') { assert.deepEqual(call.arguments.tools, []); assert.equal(call.arguments.snapshot.sha256, source.workspace_sha256); return { handle: 'reviewer-1', route: 'astra', permissions: 'read_only' }; }
    if (call.operation === 'agents.cancel') return { cancelled: true };
    if (call.operation === 'receipts.submit') { assert.ok(call.arguments.findings.every(finding => !('key' in finding))); assert.equal(call.arguments.agent, 'reviewer-1'); return call.arguments; }
    throw new Error(`unexpected host operation ${call.operation}`);
  } };
}

const ended = (output = { findings }, extra = {}) => ({ handle: 'reviewer-1', role: 'independent review', status: 'completed', text: JSON.stringify(output), sha256: digest(JSON.stringify(output)), ...extra });

function review(options = advisorOptions, output = undefined, source = evidence) {
  const request = advisorHost({}, source);
  const requested = invoke(completed, request.host, options);
  assert.equal(requested.state.status, 'reviewing');
  assert.deepEqual(request.calls.map(call => call.operation), [...(options.settings.skip_same_model === false ? [] : ['routes.list', 'task.status', 'app.request']), 'evidence.read', ...(options.settings.mode === 'blocking' ? ['contract.status'] : []), 'workspace.snapshot', 'agents.spawn']);
  const submit = advisorHost();
  const result = invoke(ended(output), submit.host, { ...options, event: 'agent_end', state: requested.state });
  return { ...result, calls: submit.calls, requested };
}

test('advisor owns typed result interpretation, deduplication and selected blocking candidates', () => {
  const result = review();
  assert.equal(result.state.status, 'recorded');
  assert.equal(result.state.findings[0].severity, 'warning');
  assert.match(result.state.findings[0].fingerprint, /^[a-f0-9]{64}$/);
  assert.match(result.state.findings[0].summary, new RegExp(reference.sha256));
  const duplicate = advisorHost();
  invoke(completed, duplicate.host, { ...advisorOptions, state: result.state });
  assert.ok(!duplicate.calls.some(call => ['evidence.read', 'agents.spawn'].includes(call.operation)));
  const blocking = review({ ...advisorOptions, settings: { every_turn: true, mode: 'blocking' } });
  assert.equal(blocking.state.findings[0].severity, 'blocking');
  const reworded = review(advisorOptions, { findings: [findings[0], { ...findings[0], summary: 'The same concern, reworded.' }] });
  assert.equal(reworded.state.findings.length, 1);
});

test('advisor keeps the newest evidence when older records exceed the excerpt', () => {
  const records = Array.from({ length: 20 }, (_, item) => ({ item, role: 'assistant', text: `${'older context '.repeat(60)}${item}` }));
  records.push({ item: 20, role: 'assistant', text: `${'x'.repeat(7000)} The final assistant message states the concern.` });
  const source = { ...evidence, records };
  const newest = review(advisorOptions, { findings: [{ ...findings[0], quote: 'xxxxxxxxxxxxxxxxxxxxxxxx' }] }, source);
  assert.equal(newest.state.status, 'recorded');
  assert.match(newest.requested.state.brief, /"item":20/);
  assert.match(newest.requested.state.brief, /"omitted_older_records":20/);
});

test('advisor rejects invented citations, honors denial, and reports incomplete results', () => {
  const invalid = review(advisorOptions, { findings: [{ key: 'unfounded', severity: 'advice', summary: 'Unfounded claim', paths: [], quote: 'This never appeared in the turn' }] });
  assert.equal(invalid.state.status, 'invalid_result');
  assert.deepEqual(invalid.calls.map(call => call.operation), ['agents.cancel']);
  const denied = advisorHost({ 'agents.spawn': () => { throw new Error('allowance_exhausted'); } });
  assert.equal(invoke(completed, denied.host, advisorOptions).state.status, 'denied');
  assert.equal(denied.calls.length, 6);
  const requested = invoke(completed, advisorHost().host, advisorOptions).state;
  const failed = invoke(ended(undefined, { status: 'failed', error: 'native_agent_deadline', text: undefined }), call => { assert.equal(call.operation, 'agents.cancel'); return { cancelled: true }; }, { ...advisorOptions, event: 'agent_end', state: requested });
  assert.equal(failed.state.status, 'incomplete');
  const foreign = invoke(ended(undefined, { handle: 'other' }), () => assert.fail('foreign result submitted'), { ...advisorOptions, event: 'agent_end', state: requested });
  assert.equal(foreign.state.status, 'reviewing');
});

test('advisor keeps cross-thread and stale advice out of context, with explicit resume only', () => {
  const state = review().state;
  const context = { thread_id: 'thread-1', turn_id: 'turn-2', checkpoint: { live: { workspace_sha256: evidence.workspace_sha256 } } };
  assert.match(invoke(context, advisorHost().host, { ...advisorOptions, event: 'context', state }).value.text, /Independent advisor findings/);
  assert.equal(invoke({ ...context, thread_id: 'other' }, () => assert.fail('cross-thread call'), { ...advisorOptions, event: 'context', state }).value, null);
  assert.equal(invoke(context, advisorHost({ 'workspace.fingerprint': () => { throw new Error('snapshot_source_changed'); } }).host, { ...advisorOptions, event: 'context', state }).value, null);
  invoke({ phase: 'resume' }, () => assert.fail('resume must not relaunch review'), { ...advisorOptions, event: 'resume', state });
});

test('advisor off has no completed-turn or context subscriber and aborts do not request review', () => {
  const registration = invoke(null, () => assert.fail('unexpected host call'), { ...advisorOptions, event: 'inspect', settings: {} });
  assert.deepEqual(registration.registrations.events, ['terminal']);
  invoke({ ...completed, outcome: 'aborted' }, () => assert.fail('aborted turn review'), advisorOptions);
});

function consultHost(overrides = {}) {
  const calls = [];
  const snapshot = { reference: digest('history'), sha256: digest('history-sha') };
  const history = `{"records":[{"role":"user","text":"Fix the parser. api_key=sk-live-123456"}]}`;
  return { calls, host(call) {
    calls.push(call);
    if (Object.hasOwn(overrides, call.operation)) return overrides[call.operation](call);
    if (call.operation === 'routes.list') return [{ name: 'astra', model: 'advisor-model' }];
    if (call.operation === 'task.status') return { ledger: { thread_id: 'thread-1' } };
    if (call.operation === 'app.request') return { thread: { model: 'lead-model' } };
    if (call.operation === 'sessions.snapshot') return { evidence: snapshot };
    if (call.operation === 'evidence.read') return { reference: snapshot, text: history.slice(call.arguments.cursor ?? 0), cursor: null, bytes: history.length };
    if (call.operation === 'exec.run') return { exit_code: 0, stdout: 'diff --git a/x b/x\n+password: hunter2\n', stderr: '' };
    if (call.operation === 'workspace.stat') return { files: { 'src/a.ts': { size: 10 } } };
    if (call.operation === 'workspace.read') return { files: { 'src/a.ts': { text: 'export {}', sha256: digest('export {}') } } };
    if (call.operation === 'model.complete') return { text: 'Verdict: sound' };
    throw new Error(`unexpected host operation ${call.operation}`);
  } };
}
const consultOptions = settings => ({ ...advisorOptions, settings, state: null });
const prompt = fixture => fixture.calls.find(call => call.operation === 'model.complete')?.arguments.prompt;

test('advisor ask sends a bounded, redacted prompt limited to shared sources and skips the lead model', () => {
  const full = consultHost();
  const answer = invoke({ question: 'Is the parser fix safe?', draft: 'x'.repeat(4000), files: ['src/a.ts', '../etc/passwd'] }, full.host, { ...consultOptions({}), event: 'tool', name: 'ask' });
  assert.equal(answer.value, 'Verdict: sound');
  assert.ok(Buffer.byteLength(prompt(full)) <= 8192);
  assert.match(prompt(full), /Is the parser fix safe\?[\s\S]*Lead draft[\s\S]*Fix the parser[\s\S]*diff --git/);
  assert.doesNotMatch(prompt(full), /sk-live|hunter2|etc\/passwd/);
  assert.equal(answer.state.consulted.trigger, 'ask');
  const narrow = consultHost();
  invoke({ files: ['src/a.ts'] }, narrow.host, { ...consultOptions({ share: ['diff'] }), event: 'tool', name: 'ask' });
  assert.match(prompt(narrow), /Withheld by the user: conversation, files/);
  assert.ok(!narrow.calls.some(call => ['sessions.snapshot', 'workspace.read'].includes(call.operation)));
  const same = consultHost({ 'app.request': () => ({ thread: { model: 'advisor-model' } }) });
  assert.match(invoke({}, same.host, { ...consultOptions({}), event: 'tool', name: 'ask' }).value, /skipped: its route uses the lead's model advisor-model/);
  assert.equal(prompt(same), undefined);
  const command = invoke('check the migration', () => assert.fail('command host call'), { ...consultOptions({}), event: 'command', name: 'advisor' }).value;
  assert.match(command.submit, /mod_omd_advisor_ask tool now with question: check the migration/);
});

test('advisor failure and loop triggers fire at their thresholds and ignore progress', () => {
  const options = { ...consultOptions({ triggers: ['failure', 'loop'] }), event: 'tool_output', name: '' };
  const output = (tool, success, text, extra = {}) => ({ call_id: 'c', tool, arguments: { cmd: tool }, success, text, tail: null, bytes: text.length, original: null, ...extra });
  let state = null;
  const run = (event, fixture = consultHost()) => { const reply = invoke(event, fixture.host, { ...options, state }); state = reply.state; return reply.value; };
  assert.equal(run(output('test', true, 'Process exited with code 1\nFAIL 1')), null);
  assert.equal(run(output('build', true, 'ok')), null);
  const fired = consultHost();
  assert.match(run(output('test', false, 'FAIL 2'), fired).append, /^Independent advisor \(failure, advisory\): Verdict: sound/);
  assert.match(prompt(fired), /failed; output ends:\nFAIL 2/);
  assert.equal(run(output('test', false, 'FAIL 3')), null);
  assert.equal(run(output('test', true, 'pass')), null);
  assert.equal(run(output('test', false, 'FAIL 4')), null);
  assert.equal(run(output('poll', true, 'Chunk ID: a\nWall time: 1.0 seconds\nProcess running with session ID 7\nOutput:\n')), null);
  assert.equal(run(output('poll', true, 'Chunk ID: b\nWall time: 2.0 seconds\nProcess running with session ID 7\nOutput:\n')), null);
  assert.equal(run(output('poll', true, 'Chunk ID: c\nWall time: 3.0 seconds\nProcess running with session ID 7\nOutput:\n')), null);
  assert.equal(run(output('read', true, 'v1')), null);
  assert.equal(run(output('read', true, 'Wall time: 1.0 seconds\nsame')), null);
  assert.equal(run(output('read', true, 'Wall time: 2.0 seconds\nsame')), null);
  assert.match(run(output('read', true, 'Wall time: 3.0 seconds\nsame')).append, /^Independent advisor \(loop, advisory\)/);
});

test('advisor completion trigger reviews only completed turns that changed files', () => {
  const options = { ...advisorOptions, settings: { triggers: ['completion'], skip_same_model: false } };
  const unchanged = advisorHost({ 'turns.activity': () => ({ turns: [{ files: [] }], recording: true }) });
  invoke(completed, unchanged.host, options);
  assert.deepEqual(unchanged.calls.map(call => call.operation), ['turns.activity']);
  const changed = advisorHost({ 'turns.activity': () => ({ turns: [{ files: [{ path: 'a.ts' }] }], recording: true }), 'routes.list': () => [], 'task.status': () => ({ ledger: { thread_id: 'thread-1' } }), 'app.request': () => ({ thread: { model: 'lead-model' } }) });
  assert.equal(invoke(completed, changed.host, options).state.status, 'reviewing');
});

test('advisor every-turn reviews honor same-model exclusion and explicit opt-out', () => {
  for (const skip of [undefined, false]) {
    const request = advisorHost({ 'routes.list': () => [{ name: 'advisor', model: 'lead-model' }], 'task.status': () => ({ ledger: { thread_id: 'thread-1' } }), 'app.request': () => ({ thread: { model: 'lead-model' } }) });
    invoke(completed, request.host, { ...advisorOptions, settings: { every_turn: true, route: 'advisor', ...(skip === false ? { skip_same_model: false } : {}) } });
    assert.equal(request.calls.some(call => call.operation === 'agents.spawn'), skip === false);
  }
});

test('advisor inline notes compose with the workspace and disappear on resume, next turn and changed source', () => {
  const state = review().state;
  const payload = { event: 'turn_end', checkpoint: { live: { workspace_sha256: evidence.workspace_sha256 } } };
  const view = invoke(payload, () => assert.fail('render launches work'), { ...advisorOptions, event: 'terminal', state }).value;
  assert.equal(view.sites.above_composer.mode, 'wrap');
  assert.deepEqual(view.status, ['Advisor: 1 note']);
  assert.equal(view.sites.above_composer.components[0].type, 'slot');
  assert.match(view.sites.above_composer.components[1].children[0].text, /warning: Check/);
  for (const event of ['resume', 'turn_start', 'start', 'workspace_change']) {
    const hidden = invoke({}, () => assert.fail('lifecycle relaunch'), { ...advisorOptions, event, state }).state;
    assert.equal(hidden.present, false);
    assert.equal(invoke(payload, () => assert.fail('render launches work'), { ...advisorOptions, event: 'terminal', state: hidden }).value.sites, undefined);
  }
});

test('advisor releases a superseded running reviewer before admitting the next turn', () => {
  const first = invoke(completed, advisorHost().host, advisorOptions);
  const nextEvidence = { ...evidence, turn_id: 'turn-2' };
  const next = advisorHost({}, nextEvidence);
  const second = invoke({ ...completed, turn_id: 'turn-2', evidence: { ...reference, sha256: digest('next-turn') } }, next.host,
    { ...advisorOptions, state: first.state });
  assert.equal(second.state.turn, 'turn-2');
  const operations = next.calls.map(call => call.operation);
  assert.ok(operations.indexOf('agents.cancel') < operations.indexOf('agents.spawn'));
});
