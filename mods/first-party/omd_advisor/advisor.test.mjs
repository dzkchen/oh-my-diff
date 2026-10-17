import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { callback } from '../../../tests/mod_runner.mjs';

const root = new URL('./', import.meta.url);
const source = readFileSync(new URL('index.ts', root), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('mod.json', root), 'utf8'));

const digest = text => createHash('sha256').update(text).digest('hex');

function invoke(payload, host, extra = {}) {
  const request = { source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, environment: manifest.environment, state: null, settings: {}, event: 'command', name: '', payload, ...extra };
  const reply = callback(request, host);
  if (reply.error) throw new Error(reply.error);
  return reply;
}

const advisorOptions = { event: 'turn_end', name: '', settings: { every_turn: true } };
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

