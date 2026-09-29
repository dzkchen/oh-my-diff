import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const runner = readFileSync(new URL('../../../runtime/omd/src/mods/runner.mjs', import.meta.url), 'utf8');
const surface = { events: {}, replacements: [], middleware: [], state: 'store', contracts: 'contracts' };
const sha = text => createHash('sha256').update(text).digest('hex');
const candidate = 'a'.repeat(64);
const evidenceRef = { reference: 'b'.repeat(64), sha256: 'b'.repeat(64) };
const evidenceText = JSON.stringify({ media_type: 'text/plain', label: 'fixture', content: 'Focused check passed' });
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, sorted(item)])) : value;

function invoke(event, name, payload, receipts = []) {
  const request = { source, filename: 'omd_source_knowledge.ts', api: '0.2.0-experimental.1', capabilities: ['tools', 'commands', 'fs.read', 'store'],
    environment: ['crypto'], state: null, settings: {}, event, name, payload, receipts, surface, hook_budget_ms: 3000 };
  const result = spawnSync(process.execPath, ['--no-warnings', '--experimental-vm-modules', '--input-type=module', '--eval', runner], {
    input: JSON.stringify(request), encoding: 'utf8', timeout: 6000,
  });
  assert.ifError(result.error);
  assert.ok(result.stdout, result.stderr);
  return JSON.parse(result.stdout);
}

function fixture(files = {}) {
  let saved = null;
  let revision = 0;
  const calls = [];
  let stale = false;
  let collision = false;
  let evidenceAvailable = true;
  let hashStale = false;
  return {
    files, calls,
    set stale(value) { stale = value; },
    set collision(value) { collision = value; },
    set evidenceAvailable(value) { evidenceAvailable = value; },
    set hashStale(value) { hashStale = value; },
    get saved() { return saved; },
    set saved(value) { saved = value; revision = value ? revision + 1 : 0; },
    run(name, payload, event = 'tool') {
      const receipts = [];
      for (let index = 0; index < 80; index++) {
        const output = invoke(event, name, payload, receipts);
        if (!output.host_call) return output;
        const call = output.host_call;
        if (event === 'command' && !['store.get', 'store.put'].includes(call.operation)) assert.fail(`TUI command host cannot serve ${call.operation}`);
        calls.push(call);
        let value;
        if (call.operation === 'store.get') value = saved ? { value: sorted(saved), revision, provenance: { mod: 'fixture', source_sha256: candidate, thread_id: null, origin: 'tool', at: 'fixture' } } : null;
        else if (call.operation === 'store.put') {
          if (collision || call.arguments.expected_revision !== (saved ? revision : null)) {
            receipts.push({ call, error: 'store_revision_conflict' });
            continue;
          }
          saved = call.arguments.value;
          revision++;
          value = { revision };
        } else if (['workspace.snapshot', 'workspace.fingerprint'].includes(call.operation)) {
          if (stale && call.arguments.expected) {
            receipts.push({ call, error: 'workspace_candidate_stale' });
            continue;
          }
          value = { snapshot: { reference: 'fixture', sha256: candidate }, candidate_sha256: candidate };
        } else if (call.operation === 'workspace.stat') {
          value = { files: Object.fromEntries(call.arguments.paths.map(path => [path, files[path] === undefined ? null
            : { kind: 'file', size: Buffer.byteLength(files[path]), mtime_ms: 1,
              ...(call.arguments.hash ? { sha256: hashStale ? candidate : sha(files[path]) } : {}) }])) };
        } else if (call.operation === 'workspace.read') {
          value = { files: Object.fromEntries(call.arguments.paths.map(path => [path, files[path] === undefined ? null
            : { text: files[path], sha256: sha(files[path]) }])) };
        } else if (call.operation === 'workspace.check_access') {
          value = { paths: call.arguments.paths, write: false };
        } else if (call.operation === 'evidence.read') {
          if (!evidenceAvailable) {
            receipts.push({ call, error: 'resource_scope_mismatch' });
            continue;
          }
          value = { reference: evidenceRef, text: evidenceText, cursor: null, bytes: Buffer.byteLength(evidenceText) };
        } else assert.fail(`unexpected operation ${call.operation}`);
        receipts.push({ call, value });
      }
      assert.fail('source knowledge did not finish');
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

test('reuse batches bounded source reads and orders facts deterministically', () => {
  const f = fixture({ 'src/config.txt': 'first\nsecond\n', 'src/other.txt': 'alpha\nbeta\n' });
  assert.equal(f.run('retain_source', { ...retain, id: 'z' }).error, undefined);
  assert.equal(f.run('retain_source', { ...retain, expected_revision: 1, id: 'a', source: { ...retain.source, path: 'src/other.txt' } }).error, undefined);
  f.calls.length = 0;
  const result = f.run('session', { ...common, mode: 'reuse' });
  assert.equal(result.error, undefined, result.error);
  assert.deepEqual(result.value.facts.map(fact => fact.id), ['a', 'z']);
  assert.equal(f.calls.filter(call => call.operation === 'workspace.stat').length, 2);
  assert.equal(f.calls.filter(call => call.operation === 'workspace.read').length, 1);
  assert.equal(f.calls.filter(call => call.operation === 'workspace.check_access').length, 1);
  assert.equal(f.calls.filter(call => call.operation === 'store.put').length, 0);
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
  assert.equal(command(f, 'remove', { ...common, expected_revision: 3, kind: 'evidence', id: 'check-1', action }).error, undefined);
  assert.deepEqual(f.run('session', { ...common, mode: 'reuse' }).value.approved_lessons, []);
  assert.equal(f.run('inspect', common).value.lessons[0].state, 'approved');
  assert.equal(command(f, 'reset', { ...common, expected_revision: 4, action }).error, undefined);
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

test('preview.1 facts migrate on the next compare-and-swap write', () => {
  const f = fixture({ 'src/config.txt': 'first\nsecond\n' });
  const old = { schema: 1, repository_identity: common.repository_identity, revision: 0, facts: [] };
  f.saved = { ...old, integrity_sha256: sha(JSON.stringify(old)) };
  const captured = f.run('retain_source', retain);
  assert.equal(captured.error, undefined, captured.error);
  assert.equal(f.saved.schema, 2);
  assert.equal(f.saved.generation, 0);
  assert.deepEqual(f.saved.evidence, []);
  assert.deepEqual(f.saved.lessons, []);
  assert.equal(f.run('session', { ...common, mode: 'reuse' }).value.facts.length, 1);
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
