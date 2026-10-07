import { test } from 'node:test';
import assert from 'node:assert/strict';
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
  assert.equal(run('terminal', { event: 'idle', ledger: null }, denied.state).value.status[0], 'Advisor on demand · observer unavailable');
  state = end('d', () => ({ handle: 'h4', route: 'astra', permissions: 'read_only' })).state;
  assert.equal(finish('h4', 'not json').state.observer.status, 'invalid_result');
  const superseded = run('turn_start', { turn_id: 'turn-e' }, state, ({ operation, arguments: input }) => { assert.deepEqual([operation, input], ['agents.cancel', { handle: 'h4' }]); return { cancelled: true }; });
  assert.equal(superseded.state.observer.status, 'superseded');
  assert.equal(run('resume', null, state).state.observer.status, 'interrupted', 'resume never relaunches an observer');
});
