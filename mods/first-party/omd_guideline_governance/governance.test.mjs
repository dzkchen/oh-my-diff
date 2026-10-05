import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { runnerSync } from '../../../tests/mod_runner.mjs';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const runner = readFileSync(new URL('../../../runtime/omd/src/mods/runner.mjs', import.meta.url), 'utf8');
const surface = { events: {}, replacements: [], middleware: [], state: 'store', contracts: 'contracts' };
const candidate = 'a'.repeat(64);
const evidenceRef = { reference: 'b'.repeat(64), sha256: 'b'.repeat(64) };
const commonRule = [{ id: 'requirements', text: 'Preserve every explicit requirement.' }, { id: 'existing', text: 'Prefer existing code.' },
  { id: 'native', text: 'Prefer suitable native capabilities.' }, { id: 'smallest', text: 'Make the smallest clear correct change.' }];
const development = task_id => ({ task_id, reference: evidenceRef, split: 'development' });
const validationEvidence = task_id => ({ task_id, reference: evidenceRef, split: 'validation' });
const full = (version, task_id) => ({ schema: 1, version, replaces: null, rationale: 'Bounded development traces',
  variant: { kind: 'full_checklist', checklist: commonRule }, development_evidence: [development(task_id)] });
const tiny = (version, task_id) => ({ schema: 1, version, replaces: null, rationale: 'Tiny core trial',
  variant: { kind: 'tiny_core', core: [commonRule[0], commonRule[3]], selected_rules: [{ id: 'installed', text: 'Use a suitable installed dependency.' }] },
  development_evidence: [development(task_id)] });
const validated = (id, selection, task_id, outcome = 'passed') => ({ schema: 1, id, proposal_version: selection.version,
  proposal_sha256: selection.proposal_sha256, validator: 'declared-separate-validator', outcome, summary: 'Checks completed on a separate task',
  validation_evidence: [validationEvidence(task_id)] });
const maintainer = { actor: 'declared-maintainer', reason: 'Promote after review' };
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, sorted(item)])) : value;

const refusal = output => output.value?.status === 'refused' ? { ...output, error: output.value.reason } : typeof output.value?.display === 'string' && output.value.display.startsWith('Refused: ') ? { ...output, error: output.value.display.slice(9) } : output;
function invoke(event, name, payload, receipts = []) {
  const request = { source, filename: 'omd_guideline_governance.ts', api: '0.2.0-experimental.5', capabilities: ['tools', 'commands', 'store', 'fs.read'],
    environment: ['crypto'], state: null, settings: {}, event, name, payload, receipts, surface, hook_budget_ms: 3000 };
  const result = runnerSync(request);
  assert.ifError(result.error);
  assert.ok(result.stdout, result.stderr);
  return refusal(JSON.parse(result.stdout));
}

function fixture() {
  let saved = null;
  let storeRevision = 0;
  let stale = false;
  let collision = false;
  const calls = [];
  return {
    calls,
    get saved() { return saved; },
    set saved(value) { saved = value; storeRevision++; },
    set stale(value) { stale = value; },
    set collision(value) { collision = value; },
    run(event, name, payload = {}) {
      const receipts = [];
      for (let index = 0; index < 80; index++) {
        const output = invoke(event, name, payload, receipts);
        if (!output.host_call) return output.value?.status === 'refused' ? { ...output, error: output.value.reason } : output;
        const call = output.host_call;
        if (event === 'command' && !['store.get', 'store.put'].includes(call.operation)) assert.fail(`TUI command host cannot serve ${call.operation}`);
        calls.push(call);
        let value;
        if (call.operation === 'store.get') value = saved ? { value: sorted(saved), revision: storeRevision,
          provenance: { mod: 'fixture', source_sha256: candidate, thread_id: null, origin: 'tool', at: 'fixture' } } : null;
        else if (call.operation === 'store.put') {
          if (collision || call.arguments.expected_revision !== (saved ? storeRevision : null)) {
            receipts.push({ call, error: 'store_revision_conflict' });
            continue;
          }
          saved = call.arguments.value;
          storeRevision++;
          value = { revision: storeRevision };
        } else if (['workspace.snapshot', 'workspace.fingerprint'].includes(call.operation)) {
          if (stale && call.arguments.expected) {
            receipts.push({ call, error: 'workspace_candidate_stale' });
            continue;
          }
          value = { snapshot: { reference: 'fixture', sha256: candidate }, candidate_sha256: candidate };
        } else if (call.operation === 'evidence.read') value = { reference: evidenceRef, text: '{', cursor: 1, bytes: 12 };
        else if (call.operation === 'evidence.write') value = evidenceRef;
        else assert.fail(`unexpected operation ${call.operation}`);
        receipts.push({ call, value });
      }
      assert.fail('governance did not finish');
    },
    tool(name, payload = {}) { return this.run('tool', name, payload); },
    command(name, payload = {}) { return this.run('command', name, payload); },
  };
}

test('proposals remain inert and both native guideline variants render', () => {
  const f = fixture();
  const first = f.tool('propose', { expected_revision: 0, proposal: full('full-v1', 'dev-full') });
  assert.equal(first.error, undefined, first.error);
  assert.equal(first.value.active, null);
  assert.equal(f.tool('active').value.active, null);
  const second = f.tool('propose', { expected_revision: 0, proposal: tiny('tiny-v1', 'dev-tiny') });
  assert.equal(second.error, undefined, second.error);
  assert.notEqual(first.value.selection.proposal_sha256, second.value.selection.proposal_sha256);
  assert.equal(f.saved.proposals.length, 2);
  assert.equal(f.saved.transitions.length, 0);
  assert.equal(f.calls.filter(call => call.operation === 'evidence.read').length, 2);
  assert.match(f.tool('propose', { expected_revision: 0, proposal: { ...tiny('bad-v1', 'dev-tiny'),
    variant: { kind: 'tiny_core', core: [commonRule[0]], selected_rules: [commonRule[0]] } } }).error, /guideline_rule_duplicate/);
});

test('validation is task-disjoint and exact hash bound; only passed records promote', () => {
  const f = fixture();
  const proposal = f.tool('propose', { expected_revision: 0, proposal: full('full-v1', 'dev-a') }).value.selection;
  assert.match(f.tool('validate', { expected_revision: 0, validation: validated('overlap', proposal, 'dev-a') }).error, /guideline_validation_task_overlap/);
  assert.match(f.tool('validate', { expected_revision: 0, validation: { ...validated('wrong', proposal, 'val-a'), proposal_sha256: 'c'.repeat(64) } }).error,
    /guideline_validation_unavailable/);
  const failed = f.tool('validate', { expected_revision: 0, validation: validated('failed', proposal, 'val-a', 'failed') });
  assert.equal(failed.error, undefined, failed.error);
  const request = { expected_revision: 0, expected_active: null, proposal, validation_id: 'failed',
    validation_sha256: failed.value.validation_sha256, maintainer };
  assert.match(f.command('promote', request).error, /guideline_promotion_unavailable/);
  const passed = f.tool('validate', { expected_revision: 0, validation: validated('passed', proposal, 'val-b') });
  assert.equal(passed.error, undefined, passed.error);
  const promoted = f.command('promote', JSON.stringify({ ...request, validation_id: 'passed', validation_sha256: passed.value.validation_sha256 }));
  assert.equal(promoted.error, undefined, promoted.error);
  assert.deepEqual(Object.keys(promoted.value), ['display']);
  assert.match(promoted.value.display, /full-v1 promoted/);
  assert.deepEqual(f.tool('active').value.active, proposal);
  assert.match(f.tool('active').value.rendered, /complete short simplicity checklist/);
  assert.match(f.command('promote', { ...request, validation_id: 'passed', validation_sha256: passed.value.validation_sha256 }).error,
    /guideline_revision_stale/);
});

test('rollback restores the prior explicit selection, then clears it', () => {
  const f = fixture();
  const first = f.tool('propose', { expected_revision: 0, proposal: full('full-v1', 'dev-a') }).value.selection;
  const firstValidation = f.tool('validate', { expected_revision: 0, validation: validated('full-pass', first, 'val-a') }).value.validation_sha256;
  assert.equal(f.command('promote', { expected_revision: 0, expected_active: null, proposal: first, validation_id: 'full-pass',
    validation_sha256: firstValidation, maintainer }).error, undefined);
  const next = f.tool('propose', { expected_revision: 1, proposal: tiny('tiny-v1', 'dev-b') }).value.selection;
  const nextValidation = f.tool('validate', { expected_revision: 1, validation: validated('tiny-pass', next, 'val-b') }).value.validation_sha256;
  assert.equal(f.command('promote', { expected_revision: 1, expected_active: first, proposal: next, validation_id: 'tiny-pass',
    validation_sha256: nextValidation, maintainer }).error, undefined);
  const restored = f.command('rollback', JSON.stringify({ expected_revision: 2, expected_active: next, maintainer }));
  assert.deepEqual(Object.keys(restored.value), ['display']);
  assert.deepEqual(f.tool('active').value.active, first);
  const cleared = f.command('rollback', JSON.stringify({ expected_revision: 3, expected_active: first, maintainer }));
  assert.deepEqual(Object.keys(cleared.value), ['display']);
  assert.equal(f.tool('active').value.active, null);
  assert.equal(f.tool('active').value.transitions.length, 4);
});

test('stale workspace, concurrent store write, active mismatch and tampering fail closed', () => {
  const f = fixture();
  f.stale = true;
  assert.match(f.tool('propose', { expected_revision: 0, proposal: full('full-v1', 'dev-a') }).error, /workspace_candidate_stale/);
  assert.equal(f.saved, null);
  f.stale = false;
  f.collision = true;
  assert.match(f.tool('propose', { expected_revision: 0, proposal: full('full-v1', 'dev-a') }).error, /store_revision_conflict/);
  assert.equal(f.saved, null);
  f.collision = false;
  const selection = f.tool('propose', { expected_revision: 0, proposal: full('full-v1', 'dev-a') }).value.selection;
  const passed = f.tool('validate', { expected_revision: 0, validation: validated('passed', selection, 'val-a') }).value;
  assert.match(f.command('promote', { expected_revision: 0, expected_active: { ...selection, proposal_sha256: 'c'.repeat(64) }, proposal: selection,
    validation_id: 'passed', validation_sha256: passed.validation_sha256, maintainer }).error, /guideline_active_stale/);
  f.saved = { ...f.saved, proposals: [] };
  assert.match(f.tool('active').error, /guideline_state_invalid/);
});

test('slash command JSON is bounded, canonical, and exact', () => {
  const f = fixture();
  for (const args of ['', '[]', '{"expected_revision":0,"expected_revision":1}', 'x'.repeat(8193)]) {
    assert.match(f.command('promote', args).error, /guideline_(command|input)/);
  }
  assert.match(f.command('rollback', '{"expected_revision":0, "expected_active":null,"maintainer":{}}').error, /guideline_command_noncanonical/);
  assert.match(f.command('rollback', JSON.stringify({ expected_revision: 0, expected_active: null, maintainer, extra: true })).error,
    /guideline_command_invalid/);
  assert.equal(f.calls.length, 0);
});
