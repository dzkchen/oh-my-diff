import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { callback } from '../../../tests/mod_runner.mjs';

const read = name => readFileSync(new URL(name, import.meta.url), 'utf8');
const source = read('./index.ts');
const manifest = JSON.parse(read('./mod.json'));
const sha = text => createHash('sha256').update(text).digest('hex');

function session(settings = {}, prompt = 'accepted', beforePut = () => {}) {
  const stores = { thread: {}, repository: {}, user: {} };
  const agents = {};
  let state = null;
  const host = ({ operation, arguments: args }) => {
    const store = stores[args?.scope ?? 'repository'];
    switch (operation) {
      case 'session.info': return { thread_id: 'thread-1', root: '/repo', cwd: '/repo', codex_version: '0.163.0', model: null, provider: 'openai', route: null, turns_started: 0 };
      case 'store.get': return store[args.key] ?? null;
      case 'store.put': {
        beforePut(args);
        if (Buffer.byteLength(JSON.stringify(args.value)) > 65_536) throw new Error('store_value_limit');
        if ((store[args.key]?.revision ?? null) !== args.expected_revision) throw new Error('store_revision_conflict');
        store[args.key] = { value: args.value, revision: (store[args.key]?.revision ?? 0) + 1 };
        return { revision: store[args.key].revision };
      }
      case 'store.delete': delete store[args.key]; return { deleted: true };
      case 'store.list': return { keys: Object.entries(store).filter(([key]) => key.startsWith(args.prefix ?? '')).slice(0, args.limit)
        .map(([key, record]) => ({ key, revision: record.revision, bytes: 0, provenance: null })), cursor: null, generation: 0 };
      case 'workspace.stat': return { files: Object.fromEntries(args.paths.map(path => [path, path === 'missing' ? null : { kind: 'file', size: path.length * 60_000, mtime_ms: 0 }])) };
      case 'workspace.read': return { files: Object.fromEntries(args.paths.map(path => [path, path === 'missing' ? null : { text: path.repeat(60_000), sha256: sha(path) }])) };
      case 'routes.list': return [{ name: 'paid', roles: ['worker'], available: false }, { name: 'worker', roles: ['worker'], available: true }];
      case 'agents.spawn': {
        if (args.role === 'broke') throw new Error('allowance_exhausted');
        const handle = `agent-${Object.keys(agents).length + 1}`;
        agents[handle] = args;
        return { handle, route: args.route, permissions: args.workspace };
      }
      case 'agents.wait': return { status: 'completed', text: `done ${agents[args.handle].role}`, consumed: true, evidence: { reference: 'e', sha256: sha('e') } };
      case 'workspace.integrate': throw new Error('workspace_candidate_stale');
      case 'model.complete': return { text: `answer:${args.route}` };
      case 'terminal.prompt': return prompt === 'accepted' ? { status: 'accepted' } : { status: 'declined' };
      default: throw new Error(`unexpected ${operation}`);
    }
  };
  const run = (event, payload = {}, name = '') => {
    const request = { source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, environment: manifest.environment, state, settings,
      event, name, payload, hook_budget_ms: 2000 };
    const output = callback(request, host);
    if (output.error) throw new Error(output.error.split('\n')[0]);
    state = output.state;
    return output.value;
  };
  return { run, tool: (name, args = {}) => run('tool', args, name), command: text => run('command', text, 'refine').display, history: (agent = null) => run('history', { thread_id: 'thread-1', agent_id: agent, model: 'm', items: [{ index: 3, type: 'message' }, { index: 4, type: 'message' }] }), stores };
}

test('context variables carry provenance, survive through thread storage and appear in the request view', () => {
  const s = session();
  s.run('start');
  assert.equal(s.history('child'), null);
  assert.match(s.history().insert[0].text, /^Programmable context \(omd_programmable_context\), session harness v0\./);
  assert.match(s.tool('python_api').source, /^import json as _json/);
  const loaded = s.tool('load', { paths: ['a', 'missing'] }).files;
  assert.deepEqual([loaded.a.text.length, loaded.a.sha256, loaded.missing], [60_000, sha('a'), null]);
  assert.match(s.tool('load', { paths: ['a', 'bb'] }).error, /^load_limit: 180000 bytes/);
  const kept = s.tool('keep', { name: 'summary', value: 'three facts', sources: ['a@' + sha('a')] });
  assert.deepEqual(kept, { sha256: sha('three facts'), chars: 11, sources: ['a@' + sha('a')] });
  assert.deepEqual(s.tool('vars', { name: 'summary' }).value, 'three facts');
  assert.match(s.tool('keep', { name: 'bad name', value: 'x' }).error, /keep_invalid/);
  const [head, tail] = s.history().insert;
  assert.deepEqual([head.before, tail.before], [0, 4]);
  assert.doesNotMatch(head.text, /summary/);
  assert.match(tail.text, /- summary: 11 characters, sha256 [0-9a-f]{12}$/);
  s.run('start');
  assert.equal(s.history().insert.length, 1);
  s.run('resume', { thread_id: 'thread-1', last_turn: null, restarted: true });
  assert.match(s.history().insert[1].text, /- summary: 11 characters/);
});

test('keeping variables leaves the cached index-0 message unchanged and sends no sources', () => {
  const s = session();
  s.run('start');
  const before = s.history().insert[0].text;
  s.tool('keep', { name: 'one', value: 'x'.repeat(100), sources: ['a'.repeat(500)] });
  s.tool('keep', { name: 'two', value: 'y', sources: ['b'.repeat(500)] });
  const [head, tail] = s.history().insert;
  assert.equal(head.text, before);
  assert.ok(tail.text.length < 300 && !tail.text.includes('aaaa'));
});

test('kept variables preserve complete provenance when publication fails and verify restored content', () => {
  let fail = false;
  const s = session({}, 'accepted', args => { if (fail && args.key === 'vars') throw new Error('cancelled'); });
  s.tool('keep', { name: 'summary', value: 'old', sources: ['old-source'] });
  fail = true;
  assert.match(s.tool('keep', { name: 'summary', value: 'new', sources: ['new-source'] }).error, /cancelled/);
  assert.deepEqual(s.tool('vars', { name: 'summary' }), { value: 'old', sha256: sha('old'), chars: 3, sources: ['old-source'] });
  fail = false;
  assert.match(s.tool('keep', { name: 'large', value: '雪'.repeat(32768) }).error, /keep_limit/);
  s.stores.thread.vars.value.summary.chars = 1;
  assert.match(s.tool('vars', { name: 'summary' }).error, /provenance/);
  s.stores.thread.vars.value.summary.chars = 3;
  const record = Object.entries(s.stores.thread).find(([key, record]) => key.startsWith('var.') && record.value.value === 'old');
  assert.ok(record);
  record[1].value.value = 'tampered';
  assert.match(s.tool('vars', { name: 'summary' }).error, /provenance/);
});

test('failed variable publication preserves the old body and provenance', () => {
  const s = session();
  s.tool('keep', { name: 'summary', value: 'old', sources: ['old-source'] });
  const registry = s.stores.thread.vars;
  registry.value.padding = { sources: ['界'.repeat(16_300)] };
  const result = s.tool('keep', { name: 'summary', value: 'new', sources: ['界'.repeat(200)] });
  assert.match(result.error, /keep_limit: kept variable index/);
  registry.value.padding = { sources: ['x'.repeat(45_000)] };
  assert.match(s.tool('keep', { name: 'summary', value: '\n'.repeat(30_000) }).error, /keep_limit: the value and the kept variable index exceed one update/);
  const restored = s.tool('vars', { name: 'summary' });
  assert.equal(restored.value, 'old');
  assert.equal(restored.sha256, sha('old'));
  assert.deepEqual(restored.sources, ['old-source']);
});

test('overwriting a kept variable drops its unshared old record and keeps loaded-file provenance', () => {
  const s = session();
  const loaded = `${'d/'.repeat(200)}file.ts@${sha('x')}`;
  assert.deepEqual(s.tool('keep', { name: 'summary', value: 'v0', sources: [loaded, loaded] }).sources, [loaded]);
  s.tool('keep', { name: 'copy', value: 'v0', sources: [loaded] });
  for (let index = 1; index <= 3; index++) s.tool('keep', { name: 'summary', value: `v${index}` });
  const records = Object.values(s.stores.thread).filter(record => record.value?.value !== undefined).map(record => record.value.value).sort();
  assert.deepEqual(records, ['v0', 'v3']);
  assert.equal(s.tool('vars', { name: 'copy' }).value, 'v0');
});

test('restoring rejects corrupt content and keep measures UTF-8 bytes', () => {
  const s = session();
  s.tool('keep', { name: 'summary', value: 'original', sources: ['source'] });
  const key = s.stores.thread.vars.value.summary.key;
  const record = s.stores.thread[key];
  record.value.value = 'corrupt';
  assert.match(s.tool('vars', { name: 'summary' }).error, /provenance/);
  assert.match(s.tool('keep', { name: 'summary', value: 'original', sources: ['source'] }).error, /digest/);
  assert.equal(s.stores.thread[key].revision, record.revision);
  assert.equal(s.stores.thread[key].value.value, 'corrupt');
  assert.match(s.tool('keep', { name: 'large', value: '界'.repeat(12_000), sources: [] }).error, /keep_limit/);
});

test('child agents, completions and integration stay host-owned', () => {
  const s = session();
  s.tool('refine', { changes: [{ section: 'agents', name: 'reviewer', value: { role: 'review', prompt: 'Review the diff.', workspace: 'isolated_worktree' } }], reason: 'repeated review delegation', evidence: ['turn:1'] });
  s.command('apply');
  assert.deepEqual(s.tool('spawn', { prompt: 'Check a.ts', spec: 'reviewer' }), { handle: 'agent-1', route: 'worker', workspace: 'isolated_worktree' });
  assert.equal(s.tool('agent', { handle: 'agent-1', action: 'wait' }).text, 'done review');
  assert.match(s.tool('agent', { handle: 'agent-1', action: 'integrate' }).error, /workspace_candidate_stale/);
  assert.match(s.tool('spawn', { prompt: 'x', route: 'paid' }).error, /route_unavailable: paid/);
  assert.match(s.tool('spawn', { prompt: 'x', role: 'broke' }).error, /allowance_exhausted/);
  assert.match(s.tool('spawn', { prompt: 'x', spec: 'nobody' }).error, /unknown_agent_spec/);
  assert.deepEqual(s.tool('complete', { prompt: 'Summarize' }), { text: 'answer:worker' });
});

test('refinement is evidence-linked, policy-bound, versioned, reversible and promoted only after confirmation', () => {
  const s = session();
  const note = { section: 'notes', name: 'checks', value: 'Run the focused test before claiming a fix.' };
  assert.match(s.tool('refine', { changes: [note], reason: 'r', evidence: [] }).error, /evidence/);
  const pending = s.tool('refine', { changes: [note], reason: 'fix claimed twice without a test', evidence: ['turn:3', 'turn:5'] });
  assert.equal(pending.status, 'pending');
  assert.equal(pending.diff, '+ notes/checks: Run the focused test before claiming a fix.\nreason: fix claimed twice without a test\nevidence: turn:3, turn:5');
  assert.match(s.command(''), /Pending:\n\+ notes\/checks/);
  assert.doesNotMatch(s.history().insert[0].text, /Notes:/);
  assert.match(s.command('apply'), /^Applied v1:/);
  assert.match(s.history().insert[0].text, /session harness v1\.[\s\S]*Notes:\n- checks: Run the focused test/);
  s.tool('refine', { changes: [{ ...note, value: 'Run the full suite.' }], reason: 'scope', evidence: ['turn:6'] });
  assert.match(s.command('apply'), /~ notes\/checks: Run the focused test before claiming a fix\. -> Run the full suite\./);
  assert.equal(s.command('rollback v0'), 'Session harness v3 restores v0.');
  assert.doesNotMatch(s.history().insert[0].text, /Notes:/);
  assert.deepEqual(s.stores.thread['harness.v1'].value.notes, { checks: note.value });
  assert.deepEqual(s.stores.thread.harness.value.log.map(entry => entry.kind), ['refine', 'refine', 'rollback']);
  assert.match(s.command('rollback 5'), /^Choose a version/);
  s.command('rollback v1');
  const declined = session({ refine: 'auto' }, 'declined');
  declined.tool('refine', { changes: [note], reason: 'r', evidence: ['e'] });
  assert.equal(declined.command('promote project'), 'Promotion declined.');
  assert.match(s.command('promote project'), /^Promoted session harness v4 to project scope/);
  assert.deepEqual(s.stores.repository.harness.value.notes, { checks: note.value });
  s.run('start');
  assert.match(s.history().insert[0].text, /session harness v0\.[\s\S]*- checks: Run the focused test/);
  s.stores.thread = {};
  s.tool('refine', { changes: [{ section: 'notes', name: 'style', value: 'Prefer small diffs.' }], reason: 'r', evidence: ['e'] });
  s.command('apply');
  s.command('promote project');
  assert.deepEqual(s.stores.repository.harness.value.notes, { checks: note.value, style: 'Prefer small diffs.' });
  s.tool('refine', { changes: [{ ...note, value: null }], reason: 'r', evidence: ['e'] });
  assert.match(s.command('apply'), /^Applied v2:\n- notes\/checks\n/);
  assert.doesNotMatch(s.history().insert[0].text, /- checks:/);
  assert.match(session({ refine: 'off' }).tool('refine', { changes: [note], reason: 'r', evidence: ['e'] }).error, /refine_disabled/);
  assert.equal(session({ refine: 'auto' }).tool('refine', { changes: [note], reason: 'r', evidence: ['e'] }).status, 'applied');
  assert.throws(() => session({ refine: 'always' }).run('start'), /refine_policy_invalid/);
});
