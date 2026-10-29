import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { callback } from '../../../tests/mod_runner.mjs';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('./mod.json', import.meta.url), 'utf8'));
const sha = text => createHash('sha256').update(text).digest('hex');
const candidate = 'a'.repeat(64);
const evidenceRef = { reference: 'b'.repeat(64), sha256: 'b'.repeat(64) };
const evidenceText = JSON.stringify({ media_type: 'text/plain', label: 'fixture', content: 'Focused check passed' });
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, sorted(item)])) : value;

const refusal = output => output.value?.status === 'refused' ? { ...output, error: output.value.reason } : typeof output.value?.display === 'string' && output.value.display.startsWith('Refused: ') ? { ...output, error: output.value.display.slice(9) } : output;
function invoke(event, name, payload, host) {
  const request = { source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, environment: manifest.environment,
    state: null, settings: {}, event, name, payload, hook_budget_ms: 3000 };
  const output = callback(request, host, [], { capture: error => error.host === true });
  assert.ok(!output.error, output.error);
  return refusal(output);
}

const refuse = message => { throw Object.assign(new Error(message), { host: true }); };

function fixture(files = {}) {
  let retainedText = evidenceText;
  let saved = null;
  let revision = 0;
  const calls = [];
  let stale = false;
  let collision = false;
  let evidenceAvailable = true;
  let hashStale = false;
  const binary = new Set();
  let readFailure = null;
  return {
    files, calls, binary,
    set stale(value) { stale = value; },
    set collision(value) { collision = value; },
    set evidenceAvailable(value) { evidenceAvailable = value; },
    set evidenceText(value) { retainedText = value; },
    set hashStale(value) { hashStale = value; },
    set readFailure(value) { readFailure = value; },
    get saved() { return saved; },
    set saved(value) { saved = value; revision = value ? revision + 1 : 0; },
    run(name, payload, event = 'tool') {
      return invoke(event, name, payload, call => {
        if (event === 'command' && !['store.get', 'store.put'].includes(call.operation)) assert.fail(`TUI command host cannot serve ${call.operation}`);
        calls.push(call);
        let value;
        if (call.operation === 'store.get') value = saved ? { value: sorted(saved), revision, provenance: { mod: 'fixture', source_sha256: candidate, thread_id: null, origin: 'tool', at: 'fixture' } } : null;
        else if (call.operation === 'store.put') {
          if (collision || call.arguments.expected_revision !== (saved ? revision : null)) refuse('store_revision_conflict');
          saved = call.arguments.value;
          revision++;
          value = { revision };
        } else if (['workspace.snapshot', 'workspace.fingerprint'].includes(call.operation)) {
          if (stale && call.arguments.expected) refuse('workspace_candidate_stale');
          value = { snapshot: { reference: 'fixture', sha256: candidate }, candidate_sha256: candidate };
        } else if (call.operation === 'workspace.stat') {
          value = { files: Object.fromEntries(call.arguments.paths.map(path => [path, files[path] === undefined ? null
            : { kind: 'file', size: Buffer.byteLength(files[path]), mtime_ms: 1,
              ...(call.arguments.hash ? { sha256: hashStale ? candidate : sha(files[path]) } : {}) }])) };
        } else if (call.operation === 'workspace.read') {
          if (readFailure) refuse(readFailure);
          if (call.arguments.paths.some(path => binary.has(path))) refuse('workspace_text_not_utf8');
          value = { files: Object.fromEntries(call.arguments.paths.map(path => [path, files[path] === undefined ? null
            : { text: files[path], sha256: sha(files[path]) }])) };
        } else if (call.operation === 'workspace.check_access') {
          value = { paths: call.arguments.paths, write: false };
        } else if (call.operation === 'evidence.read') {
          if (!evidenceAvailable) refuse('resource_scope_mismatch');
          value = { reference: call.arguments.reference, text: retainedText, cursor: null, bytes: Buffer.byteLength(retainedText) };
        } else assert.fail(`unexpected operation ${call.operation}`);
        return value;
      });
    },
  };
}

const common = { repository_identity: 'fixture/repository' };
const retain = { ...common, expected_revision: 0, id: 'source.fact', task_id: 'task-1', label: 'Configuration source',
  source: { path: 'src/config.txt', start_line: 2, end_line: 2 } };
const retainEvidence = { ...common, expected_revision: 0, id: 'check-1', task_id: 'task-1', summary: 'Focused configuration check',
  kind: 'test', reference: evidenceRef };
const propose = { ...common, expected_revision: 1, id: 'lesson-1', task_id: 'task-1', text: 'Run the focused configuration check.',
  evidence_ids: ['check-1'] };
const action = { actor: 'fixture-maintainer', reason: 'Reviewed the bounded evidence' };
const command = (f, name, value) => f.run(name, JSON.stringify(value), 'command');

test('source facts remain cold, refresh exact excerpts, and invalidate missing sources', () => {
  const f = fixture({ 'src/config.txt': 'first\nsecond\n' });
  const first = f.run('retain_source', retain);
  assert.equal(first.error, undefined, first.error);
  assert.equal(first.value.fact.version.excerpt, 'second');
  assert.equal(first.value.revision, 1);
  assert.equal(f.run('session', { ...common, mode: 'cold' }).value.facts.length, 0);
  const reuse = f.run('session', { ...common, mode: 'reuse' });
  assert.equal(reuse.value.facts[0].version.excerpt_sha256, sha('second'));
  assert.deepEqual(reuse.value.refreshed_fact_ids, []);
  f.files['src/config.txt'] = 'first\nupdated\n';
  const changed = f.run('session', { ...common, mode: 'reuse' });
  assert.deepEqual(changed.value.refreshed_fact_ids, ['source.fact']);
  assert.equal(changed.value.facts[0].version.excerpt, 'updated');
  assert.equal(changed.value.revision, 2);
  delete f.files['src/config.txt'];
  const missing = f.run('session', { ...common, mode: 'reuse' });
  assert.deepEqual(missing.value.invalidated_ids, ['source.fact']);
  assert.equal(missing.value.facts.length, 0);
  assert.equal(f.run('inspect', common).value.facts[0].reason, 'source_missing');
  assert.equal(f.saved.facts[0].version, null);
});

test('source, store and candidate changes fail closed', () => {
  const f = fixture({ 'src/config.txt': 'first\nsecond\n' });
  f.stale = true;
  assert.match(f.run('retain_source', retain).error, /workspace_candidate_stale/);
  assert.equal(f.saved, null);
  f.stale = false;
  f.collision = true;
  assert.match(f.run('retain_source', retain).error, /store_revision_conflict/);
  assert.equal(f.saved, null);
  f.collision = false;
  assert.equal(f.run('retain_source', retain).error, undefined);
  assert.match(f.run('retain_source', retain).error, /knowledge_revision_stale/);
  assert.match(f.run('session', { repository_identity: 'other', mode: 'reuse' }).error, /knowledge_state_invalid/);
  f.saved = { ...f.saved, facts: [] };
  assert.match(f.run('session', { ...common, mode: 'reuse' }).error, /knowledge_state_invalid/);
});

test('unsafe paths, secrets, unavailable lines and context bounds do not enter reuse', () => {
  const f = fixture({ 'src/config.txt': 'first\nsecond\n' });
  for (const path of ['../outside', '/absolute', 'src/.git/config', 'src/.GIT/config', 'src/../config.txt']) {
    assert.match(f.run('retain_source', { ...retain, source: { ...retain.source, path } }).error, /knowledge_anchor_invalid/);
  }
  assert.match(f.run('retain_source', { ...retain, source: { ...retain.source, start_line: 3, end_line: 3 } }).error, /knowledge_source_range_missing/);
  f.files['src/config.txt'] = 'first\napi_key = abc\n';
  assert.match(f.run('retain_source', retain).error, /knowledge_source_excluded/);
  f.files['src/config.txt'] = 'first\nsecond\n';
  assert.equal(f.run('retain_source', retain).error, undefined);
  f.files['src/config.txt'] = 'first\nsecret=abc\n';
  const reuse = f.run('session', { ...common, mode: 'reuse' });
  assert.equal(reuse.value.facts.length, 0);
  assert.deepEqual(reuse.value.invalidated_ids, ['source.fact']);
  assert.equal(f.saved.facts[0].version, null);
  assert.match(f.run('inspect', { ...common, max_context_bytes: 1 }).error, /knowledge_context_limit/);
});

test('reuse orders facts deterministically', () => {
  const f = fixture({ 'src/config.txt': 'first\nsecond\n', 'src/other.txt': 'alpha\nbeta\n' });
  assert.equal(f.run('retain_source', { ...retain, id: 'z' }).error, undefined);
  assert.equal(f.run('retain_source', { ...retain, expected_revision: 1, id: 'a', source: { ...retain.source, path: 'src/other.txt' } }).error, undefined);
  const result = f.run('session', { ...common, mode: 'reuse' });
  assert.equal(result.error, undefined, result.error);
  assert.deepEqual(result.value.facts.map(fact => fact.id), ['a', 'z']);
});

test('retained evidence supports inert lessons, exact approval, and dependency invalidation', () => {
  const f = fixture();
  const captured = f.run('retain_evidence', retainEvidence);
  assert.equal(captured.error, undefined, captured.error);
  assert.equal(captured.value.evidence.retained_payload.content, 'Focused check passed');
  f.evidenceAvailable = false;
  assert.equal(f.run('propose_lesson', propose).error, undefined);
  assert.deepEqual(f.run('session', { ...common, mode: 'reuse' }).value.approved_lessons, []);
  assert.equal(f.run('inspect', common).value.lessons[0].state, 'candidate');
  const approved = command(f, 'approve_lesson', { ...common, expected_revision: 2, lesson_id: 'lesson-1', action });
  assert.equal(approved.error, undefined, approved.error);
  assert.deepEqual(Object.keys(approved.value), ['display']);
  assert.deepEqual(f.run('session', { ...common, mode: 'reuse' }).value.approved_lessons.map(item => item.id), ['lesson-1']);
  assert.deepEqual(f.run('session', { ...common, mode: 'cold' }).value.approved_lessons, []);
  assert.equal(command(f, 'forget', { ...common, expected_revision: 3, kind: 'evidence', id: 'check-1', action }).error, undefined);
  assert.deepEqual(f.run('session', { ...common, mode: 'reuse' }).value.approved_lessons, []);
  assert.equal(f.run('inspect', common).value.lessons[0].state, 'candidate');
  f.evidenceAvailable = true;
  f.evidenceText = JSON.stringify({ media_type: 'text/plain', label: 'different', content: 'An unrelated check passed' });
  assert.equal(f.run('retain_evidence', { ...retainEvidence, expected_revision: 4, reference: { reference: 'c'.repeat(64), sha256: 'c'.repeat(64) } }).error, undefined);
  assert.notEqual(f.saved.evidence[0].payload_sha256, captured.value.evidence.payload_sha256);
  assert.deepEqual(f.run('session', { ...common, mode: 'reuse' }).value.approved_lessons, []);
  assert.equal(command(f, 'approve_lesson', { ...common, expected_revision: 5, lesson_id: 'lesson-1', action }).error, undefined);
  assert.equal(f.run('session', { ...common, mode: 'reuse' }).value.approved_lessons.length, 1);
  assert.equal(command(f, 'discard', { ...common, expected_revision: 6, action }).error, undefined);
  assert.equal(f.run('inspect', common).value.generation, 1);
  assert.deepEqual(f.run('inspect', common).value.lessons, []);
});

test('evidence scope, stale revisions, malformed commands, and store races fail closed', () => {
  const f = fixture();
  f.evidenceAvailable = false;
  assert.match(f.run('retain_evidence', retainEvidence).error, /resource_scope_mismatch/);
  assert.equal(f.saved, null);
  f.evidenceAvailable = true;
  f.stale = true;
  assert.match(f.run('retain_evidence', retainEvidence).error, /workspace_candidate_stale/);
  assert.equal(f.saved, null);
  f.stale = false;
  assert.equal(f.run('retain_evidence', retainEvidence).error, undefined);
  assert.match(f.run('retain_evidence', retainEvidence).error, /knowledge_revision_stale/);
  assert.match(f.run('propose_lesson', { ...propose, evidence_ids: ['missing'] }).error, /knowledge_lesson_unavailable/);
  assert.equal(f.run('propose_lesson', propose).error, undefined);
  assert.match(f.run('approve_lesson', 'bad json', 'command').error, /knowledge_command_invalid/);
  assert.match(command(f, 'approve_lesson', { ...common, expected_revision: 1, lesson_id: 'lesson-1', action }).error, /knowledge_revision_stale/);
  f.collision = true;
  assert.match(command(f, 'approve_lesson', { ...common, expected_revision: 2, lesson_id: 'lesson-1', action }).error, /store_revision_conflict/);
  f.collision = false;
  f.saved = { ...f.saved, evidence: [{ ...f.saved.evidence[0], retained_payload: { changed: true } }] };
  assert.match(f.run('inspect', common).error, /knowledge_state_invalid/);
});

test('retention refuses oversized state before the native store write', () => {
  const f = fixture({ 'large.txt': 'x'.repeat(16384) });
  const value = { ...retain, source: { path: 'large.txt', start_line: 1, end_line: 1 } };
  assert.equal(f.run('retain_source', value).error, undefined);
  const before = JSON.stringify(f.saved);
  f.calls.length = 0;
  assert.match(f.run('retain_source', { ...value, id: 'second', expected_revision: 1 }).error, /knowledge_state_limit/);
  assert.equal(JSON.stringify(f.saved), before);
});

test('reuse keeps facts in unchanged files of any total size without reading them', () => {
  const f = fixture({ 'a.txt': `small\n${'a'.repeat(30_000)}\n`, 'b.txt': `small\n${'b'.repeat(30_000)}\n` });
  for (const [index, path] of ['a.txt', 'b.txt'].entries()) {
    assert.equal(f.run('retain_source', { ...retain, id: path, expected_revision: index, source: { path, start_line: 1, end_line: 1 } }).error, undefined);
  }
  f.calls.length = 0;
  const reuse = f.run('session', { ...common, mode: 'reuse' }).value;
  assert.deepEqual(reuse.facts.map(fact => fact.id), ['a.txt', 'b.txt']);
  assert.deepEqual(reuse.invalidated_ids, []);
  assert.equal(f.calls.filter(call => ['workspace.read', 'store.put'].includes(call.operation)).length, 0);
});

test('a source that is no longer UTF-8 invalidates only its own fact', () => {
  const f = fixture({ 'a.txt': 'alpha\n', 'b.txt': 'beta\n' });
  for (const [index, path] of ['a.txt', 'b.txt'].entries()) {
    assert.equal(f.run('retain_source', { ...retain, id: path, expected_revision: index, source: { path, start_line: 1, end_line: 1 } }).error, undefined);
  }
  f.files['a.txt'] = 'alpha\xff\n';
  f.binary.add('a.txt');
  const reuse = f.run('session', { ...common, mode: 'reuse' });
  assert.equal(reuse.error, undefined, reuse.error);
  assert.deepEqual(reuse.value.facts.map(fact => fact.id), ['b.txt']);
  assert.deepEqual(reuse.value.invalidated_ids, ['a.txt']);
  assert.equal(f.run('inspect', common).value.facts.find(fact => fact.id === 'a.txt').reason, 'source_unavailable');
});

test('reuse rereads at most 48 KiB of changed files, leaves the rest unverified and catches up on the next session', () => {
  const f = fixture();
  for (const [index, path] of ['a.txt', 'b.txt'].entries()) {
    f.files[path] = 'small\n';
    assert.equal(f.run('retain_source', { ...retain, id: path, expected_revision: index, source: { path, start_line: 1, end_line: 1 } }).error, undefined);
    f.files[path] = `changed\n${path[0].repeat(30_000)}\n`;
  }
  f.calls.length = 0;
  const reuse = f.run('session', { ...common, mode: 'reuse' }).value;
  assert.deepEqual([reuse.invalidated_ids, reuse.facts.map(fact => fact.id)], [[], ['a.txt']]);
  assert.deepEqual(f.saved.facts.map(fact => [fact.id, fact.status, fact.reason]), [['a.txt', 'fresh', null], ['b.txt', 'fresh', null]]);
  assert.deepEqual(f.calls.filter(call => call.operation === 'workspace.read').map(call => call.arguments.paths), [['a.txt']]);
  f.calls.length = 0;
  assert.deepEqual(f.run('session', { ...common, mode: 'reuse' }).value.facts.map(fact => fact.id), ['a.txt', 'b.txt']);
  assert.deepEqual(f.calls.filter(call => call.operation === 'workspace.read').map(call => call.arguments.paths), [['b.txt']]);
});

test('a skipped or transiently unreadable file leaves its fact and the store revision untouched', () => {
  const f = fixture({ 'a.txt': 'small\n' });
  assert.equal(f.run('retain_source', { ...retain, id: 'a.txt', source: { path: 'a.txt', start_line: 1, end_line: 1 } }).error, undefined);
  const before = JSON.stringify(f.saved);
  f.files['a.txt'] = 'changed\n';
  f.readFailure = 'workspace_read_busy';
  const reuse = f.run('session', { ...common, mode: 'reuse' });
  assert.deepEqual([reuse.error, reuse.value.revision, reuse.value.refreshed_fact_ids, reuse.value.invalidated_ids, reuse.value.facts], [undefined, 1, [], [], []]);
  assert.equal(JSON.stringify(f.saved), before);
  f.readFailure = null;
  assert.equal(f.run('retain_source', { ...retain, id: 'b.txt', expected_revision: 1, source: { path: 'a.txt', start_line: 1, end_line: 1 } }).error, undefined);
});

test('source policy permits harmless hidden files and rejects a changed post-read hash', () => {
  const f = fixture({ 'src/.config': 'visible\nline\n' });
  const hidden = { ...retain, source: { path: 'src/.config', start_line: 2, end_line: 2 } };
  f.hashStale = true;
  assert.match(f.run('retain_source', hidden).error, /knowledge_source_stale/);
  assert.equal(f.saved, null);
  f.hashStale = false;
  assert.equal(f.run('retain_source', hidden).error, undefined);
  assert.equal(f.run('session', { ...common, mode: 'reuse' }).value.facts[0].version.excerpt, 'line');
  f.files['src/.config'] = '  leading indentation\n';
  const invalidated = f.run('session', { ...common, mode: 'reuse' });
  assert.deepEqual(invalidated.value.invalidated_ids, ['source.fact']);
});
