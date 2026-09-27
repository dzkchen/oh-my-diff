import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const runner = readFileSync(new URL('../../runtime/omd/src/mods/runner.mjs', import.meta.url), 'utf8');
const sources = Object.fromEntries(['anchored-edit', 'session-review'].map(name => [name, readFileSync(new URL(`./plugins/omd-${name}/mod/index.ts`, import.meta.url), 'utf8')]));
sources.memory = readFileSync(new URL('./plugins/omd-curated-memory/mod/index.ts', import.meta.url), 'utf8');
sources.advisor = readFileSync(new URL('../../mods/first-party/omd_advisor/index.ts', import.meta.url), 'utf8');
sources.research = readFileSync(new URL('../../mods/first-party/omd_research/index.ts', import.meta.url), 'utf8');
const digest = text => createHash('sha256').update(text).digest('hex');

function invoke(name, payload, host, extra = {}) {
  const receipts = [];
  for (let i = 0; i < 40; i++) {
    const request = { source: sources[name], filename: 'index.ts', api: '0.1.0-experimental.9', capabilities: name === 'anchored-edit' ? ['tools', 'workspace'] : ['commands', 'sessions_read'], state: null, settings: {}, event: name === 'anchored-edit' ? 'tool' : 'command', name: name === 'anchored-edit' ? 'edit' : 'review', payload, receipts, ...extra };
    const result = spawnSync(process.execPath, ['--no-warnings', '--experimental-vm-modules', '--input-type=module', '--eval', runner], { input: JSON.stringify(request), encoding: 'utf8', timeout: 5000 });
    assert.ifError(result.error);
    const reply = JSON.parse(result.stdout);
    if (reply.error) throw new Error(reply.error);
    if (!reply.host_call) return reply;
    try { receipts.push({ call: reply.host_call, value: host(reply.host_call) }); }
    catch (error) { receipts.push({ call: reply.host_call, error: String(error) }); }
  }
  throw new Error('host_call_limit');
}

function workspace(initial, transactionError) {
  const files = { ...initial };
  const calls = [];
  return { files, calls, host(call) {
    calls.push(call);
    if (call.operation === 'workspace.read') return { files: Object.fromEntries(call.arguments.paths.map(path => [path, Object.hasOwn(files, path) ? { text: files[path], sha256: digest(files[path]) } : null])) };
    assert.equal(call.operation, 'workspace.transaction');
    if (transactionError) throw new Error(transactionError);
    for (const [path, hash] of Object.entries(call.arguments.expected)) assert.equal(digest(files[path]), hash);
    Object.assign(files, call.arguments.writes);
    return { files: Object.fromEntries(Object.keys(call.arguments.writes).map(path => [path, digest(files[path])])) };
  } };
}

const edit = (text, extra = {}) => ({ path: 'file.txt', sha256: digest(text), start_line: 1, end_line: text.split('\n').length - Number(text.endsWith('\n')), edits: [{ before: 'value', after: 'updated' }], ...extra });

test('anchors preserve exact CRLF, Unicode, whitespace, final newline and multi-file scope', () => {
  const text = '\tvalue = "世界";\r\n  untouched\r\n';
  const host = workspace({ 'file.txt': text, 'other.txt': 'value without newline' });
  const reply = invoke('anchored-edit', { files: [edit(text), edit(host.files['other.txt'], { path: 'other.txt' })] }, host.host);
  assert.equal(reply.value.status, 'applied');
  assert.equal(host.files['file.txt'], '\tupdated = "世界";\r\n  untouched\r\n');
  assert.equal(host.files['other.txt'], 'updated without newline');
  assert.equal(host.calls.filter(call => call.operation === 'workspace.transaction').length, 1);
});

test('stale, ambiguous, overlapping, generated, missing and malformed anchors never attempt writes', () => {
  const cases = [
    ['value\n', { sha256: '0'.repeat(64) }, 'stale_file_hash'],
    ['value value\n', {}, 'ambiguous_anchor'],
    ['value\n', { edits: [{ before: 'value', after: 'a' }, { before: 'alue', after: 'b' }] }, 'overlapping_anchors'],
    ['// @generated\nvalue\n', {}, 'generated_file'],
    ['value\n', { edits: [{ before: ' value', after: 'other' }] }, 'anchor_changed'],
    ['value\n', { start_line: 2 }, 'invalid_line_scope'],
    ['value\n', { path: '../file.txt' }, 'relative_path_required'],
    ['value\n', { sha256: 'not-a-hash' }, 'malformed_anchor'],
    ['value\n', { edits: [{ before: '', after: 'insert' }] }, 'exact_nonempty'],
    ['value\n', { path: 'absent.txt' }, 'stale_file_hash'],
  ];
  for (const [text, changes, expected] of cases) {
    const host = workspace({ 'file.txt': text });
    const result = invoke('anchored-edit', { files: [edit(text, changes)] }, host.host).value;
    assert.equal(result.status, 'fallback');
    assert.match(result.reason, new RegExp(expected));
    assert.equal(result.tool, 'apply_patch');
    assert.equal(host.files['file.txt'], text);
    assert.equal(host.calls.filter(call => call.operation === 'workspace.transaction').length, 0);
  }
});

test('line scope disambiguates repeated text without changing bytes outside scope', () => {
  const host = workspace({ 'file.txt': 'value\nvalue\n' });
  const result = invoke('anchored-edit', { files: [edit(host.files['file.txt'], { start_line: 2, end_line: 2 })] }, host.host).value;
  assert.equal(result.status, 'applied');
  assert.equal(host.files['file.txt'], 'value\nupdated\n');
});

test('permission denial and concurrent-write rollback conflict remain explicit without retry', () => {
  const text = 'value\n';
  const denied = invoke('anchored-edit', { files: [edit(text)] }, () => { throw new Error('read_denied'); }).value;
  assert.equal(denied.status, 'denied');
  const host = workspace({ 'file.txt': text }, 'rollback_conflict');
  const result = invoke('anchored-edit', { files: [edit(text)] }, host.host).value;
  assert.equal(result.status, 'transaction_failed');
  assert.match(result.review, /Inspect current files/);
  assert.equal(host.calls.length, 2);
});

function sessions(rows, error) {
  const calls = [];
  const summaries = rows.map(([id, records, meta = {}]) => ({ session_id: id, task_id: id, parent_id: null, timestamp: '2026-09-25T10:00:00Z', revision: digest(JSON.stringify(records)), handle: digest(id), history_mode: 'full', inherited_history: false, incomplete_tail: false, ...meta }));
  return { calls, host(call) {
    calls.push(call);
    if (call.operation === 'sessions.list') return { sessions: summaries, cursor: null, revision: digest('list'), unavailable: 0, scan_truncated: false };
    assert.equal(call.operation, 'sessions.read');
    if (error) throw new Error(error);
    const at = summaries.findIndex(row => row.session_id === call.arguments.session_id && row.handle === call.arguments.handle);
    const records = rows[at][1].map((record, index) => ({ session_id: summaries[at].session_id, turn_id: 'turn-1', item: index + 1, role: 'user', text: record, redacted: false, truncated: false, timestamp: null, untrusted: true }));
    return { session: summaries[at], records, cursor: null, bytes: JSON.stringify(records).length, projection_truncated: false };
  } };
}

test('session command separates explicit preferences from repeated evidence and only reads', () => {
  const fixture = sessions([['a', ['Please always use pnpm for this project.', 'command not found while preparing build']], ['b', ['Investigate a different failing task.', 'command not found during verification']]]);
  const report = invoke('session-review', ['--since', '2026-09-01..2026-09-26'], fixture.host).value.display;
  assert.match(report, /explicit user preference/);
  assert.match(report, /inferred repeated pattern/);
  assert.match(report, /omd-session:\/\/a\/turn\/turn-1\?item=1&revision=[a-f0-9]{64}/);
  assert.equal(fixture.calls[0].arguments.until, '2026-09-26');
  assert.ok(fixture.calls.every(call => ['sessions.list', 'sessions.read'].includes(call.operation)));
});

test('parts of one paginated session are analyzed together, not as duplicate tasks', () => {
  const fixture = sessions([['a', ['command not found while preparing build']], ['a', ['command not found during verification'], { handle: digest('a-part'), inherited_history: true }], ['b', ['command not found again elsewhere']]]);
  const report = invoke('session-review', [], fixture.host).value.display;
  assert.match(report, /2 distinct task sessions analyzed; 0 duplicate tasks omitted/);
  assert.equal(fixture.calls.filter(call => call.operation === 'sessions.read').length, 3);
});

test('a nearly exhausted transcript budget stops cleanly instead of issuing undersized reads', () => {
  const long = 'x'.repeat(1900);
  const fixture = sessions(Array.from({ length: 12 }, (_, index) => [`s${index}`, Array.from({ length: 12 }, () => `${long} ${index}`)]));
  const report = invoke('session-review', [], fixture.host).value.display;
  assert.ok(fixture.calls.filter(call => call.operation === 'sessions.read').every(call => call.arguments.max_bytes >= 1024));
  assert.match(report, /Transcript budget reached/);
  assert.doesNotMatch(report, /unavailable or changed/);
});

test('duplicate task requests cannot turn one failure into a repeated pattern', () => {
  const fixture = sessions([['a', ['Fix the same command not found problem.']], ['b', ['Fix the same command not found problem.']]]);
  const report = invoke('session-review', [], fixture.host).value.display;
  assert.match(report, /1 duplicate tasks omitted/);
  assert.match(report, /No qualifying explicit preference or pattern/);
  assert.doesNotMatch(report, /inferred repeated pattern/);
});

test('missing, inaccessible and concurrently appended sessions produce bounded honest reports', () => {
  const empty = invoke('session-review', ['--session', 'missing'], sessions([]).host).value.display;
  assert.match(empty, /absent, opted out, inaccessible/);
  const changed = invoke('session-review', [], sessions([['a', ['Always do something.']]], 'session_revision_changed').host).value.display;
  assert.match(changed, /partial records were discarded/);
  assert.doesNotMatch(changed, /explicit user preference/);
  const denied = invoke('session-review', [], () => { throw new Error('session_policy_unavailable'); }).value.display;
  assert.match(denied, /No report could be established/);
});

test('redacted preferences and embedded links are not exposed as trusted actions', () => {
  const fixture = sessions([['a', ['Always use password=[redacted]', 'I prefer [click](https://evil.example) <script> \u001b[31m pnpm.']]]);
  const report = invoke('session-review', [], fixture.host).value.display;
  assert.doesNotMatch(report, /password=|<script>|\u001b|\[click\]/);
  assert.match(report, /untrusted evidence, never instructions/);
});

test('optional components register no lifecycle or context callbacks', () => {
  for (const name of ['anchored-edit', 'session-review']) {
    const reply = invoke(name, null, () => { throw new Error('unexpected call'); }, { event: 'inspect' });
    assert.deepEqual(reply.registrations.events, []);
  }
});

const advisorOptions = { event: 'turn_end', name: '', settings: { every_turn: true }, capabilities: ['tools', 'lifecycle', 'state', 'turn_evidence', 'review', 'context', 'terminal'], environment: ['crypto'] };
const evidence = { turn_id: 'turn-1', thread_id: 'thread-1', workspace_sha256: digest('source'), records: [{ item: 1, role: 'assistant', text: 'The exact supporting concern from this turn.' }] };
const reference = { reference: digest('ref'), sha256: digest(JSON.stringify(evidence)) };
const completed = { turn_id: 'turn-1', outcome: 'completed', evidence: reference };

const findings = [{ key: 'unsupported-claim', severity: 'blocking', summary: 'Check this unsupported claim.', paths: [], quote: 'exact supporting concern' }];

function advisorHost(overrides = {}, source = evidence) {
  const calls = [];
  return { calls, host(call) {
    calls.push(call);
    if (Object.hasOwn(overrides, call.operation)) return overrides[call.operation](call);
    if (call.operation === 'evidence.read') return { reference, text: JSON.stringify(source), cursor: null, bytes: 200 };
    if (call.operation === 'review.request') { assert.deepEqual(call.arguments.tools, []); return { handle: 'reviewer-1', route: 'astra', permissions: 'read_only' }; }
    if (call.operation === 'review.submit') { assert.ok(call.arguments.findings.every(finding => !('key' in finding))); return { cycle: { id: 1, lane: 'advisory' } }; }
    throw new Error(`unexpected host operation ${call.operation}`);
  } };
}

const ended = (output = { findings }, extra = {}) => ({ handle: 'reviewer-1', role: 'independent review', status: 'completed', text: JSON.stringify(output), sha256: digest(JSON.stringify(output)), ...extra });

function review(options = advisorOptions, output = undefined, source = evidence) {
  const request = advisorHost({}, source);
  const requested = invoke('advisor', completed, request.host, options);
  assert.equal(requested.state.status, 'reviewing');
  assert.deepEqual(request.calls.map(call => call.operation), ['evidence.read', 'review.request']);
  const submit = advisorHost();
  const result = invoke('advisor', ended(output), submit.host, { ...options, event: 'agent_end', state: requested.state });
  return { ...result, calls: submit.calls, requested };
}

test('advisor owns typed result interpretation, deduplication and selected blocking candidates', () => {
  const result = review();
  assert.equal(result.state.status, 'recorded');
  assert.equal(result.state.findings[0].severity, 'warning');
  assert.match(result.state.findings[0].fingerprint, /^[a-f0-9]{64}$/);
  assert.match(result.state.findings[0].summary, new RegExp(reference.sha256));
  invoke('advisor', completed, () => assert.fail('duplicate review'), { ...advisorOptions, state: result.state });
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
  assert.deepEqual(invalid.calls, []);
  const denied = advisorHost({ 'review.request': () => { throw new Error('allowance_exhausted'); } });
  assert.equal(invoke('advisor', completed, denied.host, advisorOptions).state.status, 'denied');
  assert.equal(denied.calls.length, 2);
  const requested = invoke('advisor', completed, advisorHost().host, advisorOptions).state;
  const failed = invoke('advisor', ended(undefined, { status: 'failed', error: 'native_agent_deadline', text: undefined }), () => assert.fail('failed review submitted'), { ...advisorOptions, event: 'agent_end', state: requested });
  assert.equal(failed.state.status, 'incomplete');
  const foreign = invoke('advisor', ended(undefined, { handle: 'other' }), () => assert.fail('foreign result submitted'), { ...advisorOptions, event: 'agent_end', state: requested });
  assert.equal(foreign.state.status, 'reviewing');
});

test('advisor keeps cross-thread and stale advice out of context, with explicit resume only', () => {
  const state = review().state;
  const context = { thread_id: 'thread-1', turn_id: 'turn-2', checkpoint: { live: { workspace_sha256: evidence.workspace_sha256 } } };
  assert.match(invoke('advisor', context, advisorHost().host, { ...advisorOptions, event: 'context', state }).value.text, /Independent advisor findings/);
  assert.equal(invoke('advisor', { ...context, thread_id: 'other' }, () => assert.fail('cross-thread call'), { ...advisorOptions, event: 'context', state }).value, null);
  assert.equal(invoke('advisor', { ...context, checkpoint: { live: { workspace_sha256: digest('changed') } } }, () => assert.fail('stale call'), { ...advisorOptions, event: 'context', state }).value, null);
  invoke('advisor', { phase: 'resume' }, () => assert.fail('resume must not relaunch review'), { ...advisorOptions, event: 'resume', state });
});

test('advisor off has no completed-turn or context subscriber and aborts do not request review', () => {
  const registration = invoke('advisor', null, () => assert.fail('unexpected host call'), { ...advisorOptions, event: 'inspect', settings: {} });
  assert.deepEqual(registration.registrations.events, ['terminal']);
  invoke('advisor', { ...completed, outcome: 'aborted' }, () => assert.fail('aborted turn review'), advisorOptions);
});

const researchOptions = { event: 'tool', name: 'gather', capabilities: ['tools', 'agents', 'workspace'], settings: { enabled: true } };
const researchQuestion = { question: 'Where are the read permissions enforced across these packages?', scope: ['runtime', 'mods', 'scripts'], brief: 'Trace the read permission boundary and return source evidence only.', expected_sources: 6, lead_read_minutes: 12, brief_and_handoff_minutes: 2, already_located: false };
function researchHost(overrides = {}) {
  const calls = [];
  const source = 'Exact source evidence in this file.';
  const output = { findings: [{ text: 'The file states the boundary.', sources: [{ path: 'runtime/example.rs', sha256: digest(source), quote: source }] }], uncertainty: ['Synthetic source fixture.'] };
  const completed = { status: 'completed', text: JSON.stringify(output), consumed: false, evidence: { ref: 'native-thread:worker', sha256: digest(JSON.stringify(output)) } };
  return { calls, host(call) {
    calls.push(call);
    if (Object.hasOwn(overrides, call.operation)) return overrides[call.operation](call);
    if (call.operation === 'workers.presets') return [{ name: 'research_luna', model: 'gpt-6-luna', provider: 'fixture', tools: ['exec_command', 'apply_patch', 'spawn_agent'], available: true, billing: 'explicit_paid_api_grant' }];
    if (call.operation === 'agents.spawn') { assert.deepEqual(call.arguments.tools, ['exec_command']); assert.equal(call.arguments.workspace, 'read_only'); return { handle: 'worker', route: 'research_luna', permissions: 'read_only' }; }
    if (call.operation === 'agents.wait' || call.operation === 'agents.result') return completed;
    if (call.operation === 'workspace.read') return { files: { 'runtime/example.rs': { text: source, sha256: digest(source) } } };
    if (call.operation === 'agents.cancel') return { cancelled: true };
    throw new Error(`unexpected ${call.operation}`);
  } };
}

test('research rejects small, located or uneconomic questions without a host call', () => {
  for (const change of [{ already_located: true }, { expected_sources: 2 }, { scope: ['runtime'] }, { lead_read_minutes: 3 }]) {
    const result = invoke('research', { ...researchQuestion, ...change }, () => assert.fail('narrow research launched'), researchOptions).value;
    assert.equal(result.status, 'not_admitted');
  }
});

test('research requires the separately granted exact model and never falls back', () => {
  for (const presets of [[], [{ name: 'research_luna', model: 'other-model', available: true, billing: 'explicit_paid_api_grant' }], [{ name: 'research_luna', model: 'gpt-6-luna', available: false, billing: 'explicit_paid_api_grant' }]]) {
    const host = researchHost({ 'workers.presets': () => presets });
    assert.equal(invoke('research', researchQuestion, host.host, researchOptions).value.status, 'denied');
    assert.equal(host.calls.length, 1);
  }
});

test('research narrows tools, validates source hashes and quotes, and returns decisions to the lead', () => {
  const host = researchHost();
  const result = invoke('research', researchQuestion, host.host, researchOptions).value;
  assert.equal(result.status, 'sources_gathered');
  assert.equal(result.decision_owner, 'lead');
  assert.match(result.qualification, /candidate/);
  assert.ok(host.calls.some(call => call.operation === 'agents.result' && call.arguments.consume));
  const stale = researchHost({ 'workspace.read': () => ({ files: { 'runtime/example.rs': { text: 'changed', sha256: digest('changed') } } }) });
  assert.equal(invoke('research', researchQuestion, stale.host, researchOptions).value.status, 'stale_or_unverified');
  assert.ok(!stale.calls.some(call => call.operation === 'agents.result'));
});

test('research can use a separately authorized subscription preset without paid fallback', () => {
  const host = researchHost({ 'workers.presets': () => [{ name: 'research_luna', model: 'gpt-6-luna', provider: 'openai', tools: ['exec_command'], available: true, billing: 'included_subscription' }] });
  assert.equal(invoke('research', researchQuestion, host.host, researchOptions).value.status, 'sources_gathered');
  assert.equal(host.calls.filter(call => call.operation === 'agents.spawn').length, 1);
});

test('research disabled registers no work, and an unfinished request is cancelled', () => {
  const disabled = invoke('research', null, () => assert.fail('disabled operation'), { ...researchOptions, event: 'inspect', settings: {} });
  assert.deepEqual(disabled.registrations.tools, []);
  assert.deepEqual(disabled.registrations.events, []);
  const host = researchHost({ 'agents.wait': () => ({ status: 'running' }) });
  assert.equal(invoke('research', researchQuestion, host.host, researchOptions).value.status, 'incomplete');
  assert.ok(host.calls.some(call => call.operation === 'agents.cancel'));
  assert.equal(host.calls.filter(call => call.operation === 'agents.wait').length, 20);
  let waits = 0;
  const slow = researchHost({ 'agents.wait': call => ++waits < 3 ? { status: 'running' } : researchHost().host(call) });
  assert.equal(invoke('research', researchQuestion, slow.host, researchOptions).value.status, 'sources_gathered');
});

test('advisor inline notes compose with the workspace and disappear on resume, next turn and changed source', () => {
  const state = review().state;
  const payload = { event: 'turn_end', checkpoint: { live: { workspace_sha256: evidence.workspace_sha256 } } };
  const view = invoke('advisor', payload, () => assert.fail('render launches work'), { ...advisorOptions, event: 'terminal', state }).value;
  assert.equal(view.sites.above_composer.mode, 'wrap');
  assert.deepEqual(view.status, ['Advisor: 1 note']);
  assert.equal(view.sites.above_composer.components[0].type, 'slot');
  assert.match(view.sites.above_composer.components[1].children[0].text, /warning: Check/);
  for (const event of ['resume', 'turn_start', 'start']) {
    const hidden = invoke('advisor', {}, () => assert.fail('lifecycle relaunch'), { ...advisorOptions, event, state }).state;
    assert.equal(hidden.present, false);
    assert.equal(invoke('advisor', payload, () => assert.fail('render launches work'), { ...advisorOptions, event: 'terminal', state: hidden }).value.sites, undefined);
  }
  assert.equal(invoke('advisor', { ...payload, checkpoint: { live: { workspace_sha256: digest('changed') } } }, () => assert.fail('render launches work'), { ...advisorOptions, event: 'terminal', state }).value.sites, undefined);
});

const memoryOptions = { event: 'tool', name: 'recall', capabilities: ['tools', 'commands', 'state', 'lifecycle', 'context', 'turn_evidence', 'knowledge_read', 'knowledge_write'], settings: {} };
const memoryData = { repository_identity: digest('repo'), revision: 4, generation: 0, evidence: [{ id: 'evidence1', status: { status: 'available' } }], facts: [{ id: 'fact1', label: 'Exact source', source: { path: 'README.md', start_line: 1, end_line: 1 }, status: { status: 'fresh', version: { excerpt: 'Use pnpm for this project.' } } }], lessons: [{ id: 'lesson1', text: 'Use tabs', evidence_ids: ['evidence1'], state: { state: 'approved' } }, { id: 'proposal', text: 'An unapproved proposal', evidence_ids: ['evidence1'], state: { state: 'candidate' } }] };
function memoryHost(overrides = {}) {
  const calls = [];
  return { calls, host(call) {
    calls.push(call);
    if (Object.hasOwn(overrides, call.operation)) return overrides[call.operation](call);
    if (call.operation === 'knowledge.inspect') return memoryData;
    if (call.operation === 'context.freeze') return reference;
    if (call.operation === 'context.deliver') return { facts: memoryData.facts, approved_lessons: [memoryData.lessons[0]] };
    if (call.operation === 'knowledge.propose') return { ...call.arguments, state: { state: 'candidate' } };
    throw new Error(`unexpected operation ${call.operation}`);
  } };
}

test('memory recall excludes proposals, stale facts and contradictory lessons; cold reads nothing', () => {
  assert.deepEqual(invoke('memory', { mode: 'cold' }, () => assert.fail('cold host read'), memoryOptions).value.records, []);
  const host = memoryHost();
  assert.deepEqual(invoke('memory', {}, host.host, memoryOptions).value.records.map(row => row.id), ['fact1', 'lesson1']);
  const contradictory = structuredClone(memoryData);
  contradictory.lessons.push({ id: 'opposed', text: 'Do not use tabs', evidence_ids: ['evidence1'], state: { state: 'approved' } });
  contradictory.facts[0].status = { status: 'invalidated' };
  const result = invoke('memory', {}, memoryHost({ 'knowledge.inspect': () => contradictory }).host, memoryOptions).value;
  assert.deepEqual(result.records, []);
  assert.deepEqual(result.contradictions_excluded, ['lesson1', 'opposed']);
  for (const [text, opposed] of [["Don't use tabs", true], ['Never use tabs', true], ['Do use tabs', false], ['Always use tabs', false]]) {
    const pair = structuredClone(memoryData);
    pair.lessons.push({ id: 'other', text, evidence_ids: ['evidence1'], state: { state: 'approved' } });
    const excluded = invoke('memory', {}, memoryHost({ 'knowledge.inspect': () => pair }).host, memoryOptions).value.contradictions_excluded;
    assert.deepEqual(excluded, opposed ? ['lesson1', 'other'] : [], text);
  }
  assert.deepEqual(invoke('memory', { query: 'status' }, memoryHost().host, memoryOptions).value.records, []);
});

test('memory keeps learning as a revision-bound proposal and blocks secrets before host access', () => {
  const args = { id: 'new', text: 'Check source versions before reuse.', expected_revision: 4, evidence_ids: ['evidence1'] };
  const host = memoryHost();
  const result = invoke('memory', args, host.host, { ...memoryOptions, name: 'learn' }).value;
  assert.equal(result.status, 'proposal_only');
  assert.equal(host.calls[1].operation, 'knowledge.propose');
  assert.throws(() => invoke('memory', { ...args, expected_revision: 3 }, memoryHost().host, { ...memoryOptions, name: 'learn' }), /revision_changed/);
  assert.throws(() => invoke('memory', { ...args, text: 'password=EXCLUDED_SECRET' }, () => assert.fail('secret reached host'), { ...memoryOptions, name: 'learn' }), /lesson_invalid/);
  assert.equal(invoke('memory', { ...args, text: 'Use tabs' }, memoryHost().host, { ...memoryOptions, name: 'learn' }).value.status, 'duplicate');
});

test('memory freezes selected first recall, reuses it across compaction and excludes revoked snapshots', () => {
  const extra = { ...memoryOptions, event: 'context', settings: { live_recall: 'reuse', recall_ids: ['fact1', 'proposal'] } };
  const context = { thread_id: 'thread-a', turn_id: 'turn-1', checkpoint: {} };
  const host = memoryHost();
  const first = invoke('memory', context, host.host, extra);
  assert.deepEqual(host.calls[1].arguments.ids, ['fact1']);
  assert.match(first.value.text, /frozen/);
  const reused = memoryHost();
  invoke('memory', { ...context, turn_id: 'after-compaction' }, reused.host, { ...extra, state: first.state });
  assert.deepEqual(reused.calls.map(call => call.operation), ['context.deliver']);
  assert.equal(invoke('memory', context, memoryHost({ 'context.deliver': () => { throw new Error('snapshot_revoked'); } }).host, { ...extra, state: first.state }).value, null);
  const other = memoryHost();
  invoke('memory', { ...context, thread_id: 'thread-b' }, other.host, { ...extra, state: first.state });
  assert.equal(other.calls[0].operation, 'knowledge.inspect');
  const crowded = { ...first.state, threads: Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`thread-${index}`, first.state.threads['thread-a']])) };
  const fresh = invoke('memory', { ...context, thread_id: 'thread-new' }, memoryHost().host, { ...extra, state: crowded });
  assert.match(fresh.value.text, /frozen/);
  assert.equal(Object.keys(fresh.state.threads).length, 16);
  assert.ok(!('thread-0' in fresh.state.threads));
});

test('memory disabled and unselected live recall have no lifecycle cost or external authority', () => {
  const off = invoke('memory', null, () => assert.fail('off operation'), { ...memoryOptions, event: 'inspect', settings: { enabled: false } });
  assert.deepEqual(off.registrations.events, []);
  assert.deepEqual(off.registrations.tools, []);
  const ordinary = invoke('memory', null, () => assert.fail('inspect operation'), { ...memoryOptions, event: 'inspect' });
  assert.deepEqual(ordinary.registrations.events, []);
  assert.ok(!memoryOptions.capabilities.includes('sidecars'));
});
