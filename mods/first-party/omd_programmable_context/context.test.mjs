import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runnerSync } from '../../../tests/mod_runner.mjs';

const read = name => readFileSync(new URL(name, import.meta.url), 'utf8');
const source = read('./index.ts');
const manifest = JSON.parse(read('./mod.json'));
const runner = readFileSync(new URL('../../../runtime/omd/src/mods/runner.mjs', import.meta.url), 'utf8');
const surface = { events: { start: 'lifecycle', resume: 'lifecycle', history: 'history' }, replacements: ['history'], middleware: [], state: 'store', contracts: 'contracts' };
const sha = text => createHash('sha256').update(text).digest('hex');

function session(settings = {}, prompt = 'accepted') {
  const stores = { thread: {}, repository: {}, user: {} };
  const agents = {};
  let state = null;
  const host = ({ operation, arguments: args }) => {
    const store = stores[args?.scope ?? 'repository'];
    switch (operation) {
      case 'task.status': return { ledger: { thread_id: 'thread-1', cwd: '/repo', cost: null }, limits: {}, worker_limits: {} };
      case 'store.get': return store[args.key] ?? null;
      case 'store.put': {
        if ((store[args.key]?.revision ?? null) !== args.expected_revision) throw new Error('store_revision_conflict');
        store[args.key] = { value: args.value, revision: (store[args.key]?.revision ?? 0) + 1 };
        return { revision: store[args.key].revision };
      }
      case 'store.delete': delete store[args.key]; return { deleted: true };
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
    const receipts = [];
    for (;;) {
      const request = { source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, environment: manifest.environment, state, settings,
        event, name, payload, receipts, surface, hook_budget_ms: 2000 };
      const result = runnerSync(request);
      const output = JSON.parse(result.stdout);
      if (output.error) throw new Error(output.error.split('\n')[0]);
      if (!output.host_call) {
        state = output.state;
        return output.value;
      }
      let receipt;
      try { receipt = { call: output.host_call, value: host(output.host_call) }; }
      catch (error) { receipt = { call: output.host_call, error: error.message }; }
      receipts.push(JSON.stringify([...receipts, receipt]).length > 131_072 ? { call: output.host_call, error: 'host_result_limit' } : receipt);
    }
  };
  return { run, tool: (name, args = {}) => run('tool', args, name), command: text => run('command', text, 'refine').display, history: (agent = null) => run('history', { thread_id: 'thread-1', agent_id: agent, model: 'm', items: [] }), stores };
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
  assert.match(s.history().insert[0].text, /- summary: 11 characters, sha256 [0-9a-f]{12}, sources a@/);
  s.run('start');
  assert.doesNotMatch(s.history().insert[0].text, /summary/);
  s.run('resume', { thread_id: 'thread-1', last_turn: null, restarted: true });
  assert.match(s.history().insert[0].text, /- summary: 11 characters/);
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
