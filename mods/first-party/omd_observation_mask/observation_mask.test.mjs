import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { callback } from '../../../tests/mod_runner.mjs';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('./mod.json', import.meta.url), 'utf8'));
const settings = { keep_recent: 2, min_bytes: 1000, batch_bytes: 10_000 };

function run(event, name, payload, { state = null, store = new Map(), host = {}, settings: overrideSettings = {}, now = 1_800_000_000_000 } = {}) {
  const calls = [];
  const output = callback({ source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, state, settings: { ...settings, ...overrideSettings }, virtual_time_ms: now, event, name, payload }, call => {
    assert.notEqual(event, 'history', 'history runs without a native task host');
    calls.push(call);
    if (call.operation === 'store.get') return store.has(call.arguments.key) ? { value: store.get(call.arguments.key), revision: 1, provenance: {} } : null;
    if (call.operation === 'store.put') return store.set(call.arguments.key, call.arguments.value), { revision: 1 };
    if (host[call.operation]) return host[call.operation](call.arguments);
    assert.fail(`unexpected ${call.operation}`);
  });
  if (output.error) throw new Error(output.error);
  return { value: output.value, state: output.state, calls, store };
}

const exec = (code, line) => `Chunk ID: a\nWall time: 0.1\nProcess exited with code ${code}\nOriginal token count: 9\nOutput:\n${line}\n`;
function view(sizes, { agent = null } = {}) {
  const items = sizes.flatMap((bytes, n) => [
    { index: 2 * n, type: 'function_call', role: null, call_id: `c${n}`, editable: true, images: 0, text: '{"cmd":"pytest"}', bytes: 16 },
    { index: 2 * n + 1, type: 'function_call_output', role: null, call_id: `c${n}`, editable: true, images: 0, text: exec(n % 2, `line ${n}`), bytes },
  ]);
  items.push({ index: items.length, type: 'message', role: 'user', call_id: null, editable: false, images: 0, text: 'go', bytes: 2 });
  return { thread_id: 't', agent_id: agent, model: 'm', items };
}
const replaced = value => Object.fromEntries((value?.replace ?? []).map(edit => [edit.index, edit.text]));

test('nothing is hidden until older large outputs reach a batch, then all of them are hidden at once', () => {
  const below = run('history', '', view([4000, 4000, 500, 4000, 4000]));
  assert.equal(below.value, null);
  assert.equal(below.state.pending_bytes, 8000);
  const calls = { c0: { tool: 'exec_command', reference: { reference: 'r0', sha256: 's' }, bytes: 4000, failed_edit: false } };
  const { value, state } = run('history', '', view([4000, 4000, 500, 4000, 4000, 4000]), { state: { ...below.state, calls } });
  const edits = replaced(value);
  assert.deepEqual(Object.keys(edits).map(Number), [1, 3, 7], 'short outputs and the newest two stay');
  assert.equal(edits[1], '[omd_observation_mask hid this older exec_command output (4000 bytes, exit 0, first line "line 0"). Read it with mod_omd_observation_mask_recall {"call_id":"c0"}.]');
  assert.match(edits[3], /older tool output \(4000 bytes, exit 1, first line "line 1"\)\. Its full text was not kept/);
  assert.deepEqual([state.advances, state.hidden_bytes, state.pending_bytes], [1, 12000, 0]);
  assert.equal(state.last_saved_bytes, 12000 - edits[1].length - edits[3].length - edits[7].length);
});

test('hidden outputs keep identical stubs and the boundary only moves at the next full batch', () => {
  const first = run('history', '', view([4000, 4000, 4000, 4000, 4000]));
  const stubs = replaced(first.value);
  assert.deepEqual(Object.keys(stubs).map(Number), [1, 3, 5]);
  const second = run('history', '', view([4000, 4000, 4000, 4000, 4000, 4000, 4000]), { state: first.state });
  assert.deepEqual(replaced(second.value), stubs, 'the prefix is unchanged while the new region is under a batch');
  assert.equal(second.state.advances, 1);
  assert.equal(second.state.pending_bytes, 8000);
  const third = run('history', '', view([4000, 4000, 4000, 4000, 4000, 4000, 4000, 4000]), { state: second.state });
  assert.deepEqual(Object.keys(replaced(third.value)).map(Number), [1, 3, 5, 7, 9, 11]);
  assert.equal(third.state.advances, 2);
});

test('failed edits and pinned outputs are never hidden, and a pin restores a hidden output', () => {
  const calls = { c1: { tool: 'apply_patch', reference: null, bytes: 6000, failed_edit: true } };
  const first = run('history', '', view([6000, 6000, 6000, 1, 1]), { state: { calls } });
  assert.deepEqual(Object.keys(replaced(first.value)).map(Number), [1, 5]);
  assert.deepEqual(first.state.kept, ['c1']);
  const pinned = run('tool', 'recall', { call_id: 'c0', pin: true }, { state: first.state });
  assert.deepEqual(pinned.value, { call_id: 'c0', pinned: true });
  const after = run('history', '', view([6000, 6000, 6000, 1, 1, 9000, 9000, 1, 1]), { state: pinned.state });
  assert.deepEqual(Object.keys(replaced(after.value)).map(Number), [5, 11, 13]);
});

test('no more than 400 outputs are hidden at once', () => {
  const masked = Object.fromEntries(Array.from({ length: 400 }, (_, n) => [`c${n}`, 'stub']));
  const { value, state } = run('history', '', view(Array(405).fill(4000)), { state: { masked, advances: 1 } });
  assert.deepEqual([Object.keys(replaced(value)).length, state?.advances ?? 1], [400, 1]);
});

test('recall reads the kept original in pages and names a missing one', () => {
  const state = { calls: { c0: { tool: 'exec_command', reference: { reference: 'r0', sha256: 's' }, bytes: 70000, failed_edit: false } } };
  const host = { 'evidence.read': ({ reference, cursor, max_bytes }) => ({ reference, text: `page ${cursor ?? 0}/${max_bytes}`, cursor: 32768, bytes: 70000 }) };
  assert.deepEqual(run('tool', 'recall', { call_id: 'c0' }, { state, host }).value,
    { call_id: 'c0', tool: 'exec_command', bytes: 70000, text: 'page 0/32768', next_cursor: 32768 });
  assert.throws(() => run('tool', 'recall', { call_id: 'c9' }), /recall_unavailable: no kept output for c9/);
});

test('large outputs of the thread\'s own calls are kept for recall; small, subagent and code-mode ones are not', () => {
  const call = (bytes, { agent = null, caller = 'model', success = true, cmd = 'pytest', state = null } = {}) => {
    const input = { tool: 'exec_command', arguments: { cmd }, call_id: 'k', thread_id: 't', agent_id: agent, schema: null, raw_arguments: '{}', batch: null };
    const host = {
      'continuation.next': () => ({ result: { output: 'x', success, bytes }, trace: [] }),
      'tools.original': ({ call_id }) => ({ reference: { reference: `ref-${call_id}`, sha256: 's' }, sha256: 's', bytes }),
    };
    const after = run('intercept', '0', { surface: 'tool', input, original: input, origin: { caller } }, { host, state }).state;
    return state ? after.calls : after?.calls?.k;
  };
  assert.deepEqual(call(5000, { success: false }), { tool: 'exec_command', reference: { reference: 'ref-k', sha256: 's' }, bytes: 5000, failed_edit: false });
  assert.equal(call(5000, { success: false, cmd: "sed -i 's/a/b/' a.py" }).failed_edit, true);
  assert.equal(call(5000, { success: false, cmd: 'pytest 2>&1 | tee out.log' }).failed_edit, false, 'a failing run saved to a log can still be hidden');
  assert.equal(call(999), undefined);
  assert.equal(call(5000, { agent: 'sub' }), undefined);
  assert.equal(call(5000, { caller: 'code_mode' }), undefined);
  const record = { tool: 'exec_command', reference: { reference: 'r', sha256: 's' }, bytes: 5000, failed_edit: false };
  const calls = Object.fromEntries(Array.from({ length: 401 }, (_, n) => [`c${n}`, record]));
  const kept = call(5000, { state: { masked: { c0: 'stub' }, calls } });
  assert.deepEqual([Object.keys(kept).length, Object.keys(kept).slice(0, 2), Object.keys(kept).at(-1)], [401, ['c0', 'c2'], 'k'], 'a hidden output keeps its record');
});

test('subagent requests are left alone and other prompt-prefix changes are counted', () => {
  assert.equal(run('history', '', view([9000, 9000, 9000, 1, 1], { agent: 'sub' })).value, null);
  const input = { scope: { thread_id: 't', agent_id: null, kind: 'main' } };
  const next = from => ({ 'continuation.next': () => ({ result: { route: 'r', effort: null, cache: { from } }, trace: [] }) });
  const store = new Map();
  run('intercept', '1', { surface: 'model_request', input, original: input, origin: { caller: 'engine' } }, { store, host: next(null) });
  assert.equal(store.has('breaks'), false);
  run('intercept', '1', { surface: 'model_request', input, original: input, origin: { caller: 'engine' } }, { store, host: next('instructions') });
  run('intercept', '1', { surface: 'model_request', input, original: input, origin: { caller: 'engine' } }, { store, host: next('tools') });
  assert.deepEqual(store.get('breaks'), { count: 2, last: 'tools' });
});

const NOW = 1_800_000_000_000;
const minute = 60_000;
const session = { thread_id: 't', root: '/repo', cwd: '/repo', model: 'm', provider: 'claude', route: 'r', codex_version: '0.166.0', turns_started: 1 };
const cached = (patch = {}) => ({ request_id: 'req', scope: { kind: 'main', thread_id: 't', agent_id: null }, synthetic: null,
  status: 'completed', provider: 'claude', route: 'r', credential: 'profile', requested_model: 'm', served_model: 'm',
  usage: { omd_cache_ttl_seconds: 300 }, cache: { read_tokens: 50000, write_tokens: 0 }, cost: { basis: 'provider' },
  timing: { started_at_ms: NOW }, ...patch });
const records = () => Object.fromEntries(Array.from({ length: 6 }, (_, n) => [`c${n}`, {
  tool: 'exec_command', reference: { reference: `r${n}`, sha256: 's' }, bytes: 6000, failed_edit: false,
}]));
function continuation(event, name, payload, options = {}) {
  return run(event, name, payload, { ...options, settings: { mode: 'continue', ...options.settings }, host: {
    'session.info': () => { assert.notEqual(event, 'history', 'history has no live session host'); return session; }, 'evidence.read': () => ({ text: 'x', cursor: 1, bytes: 6000 }), ...options.host,
  } });
}
function requestContinue(state, { args = '', now = NOW + 6 * minute, result = { submit: 'Resume task' }, owner = 'omd_continue', active_turn = false, host = {} } = {}) {
  state = state && { visible: Object.keys(state.calls ?? {}), ...state };
  const input = { command: 'continue', args, owner, active_turn, immediate: false };
  const response = continuation('intercept', '0', { surface: 'command', input, original: input, origin: { caller: 'engine' } }, {
    state, now, host: { 'continuation.next': ({ input: forwarded }) => ({ result: { result: typeof result === 'function' ? result(forwarded) : result }, trace: [] }), ...host },
  });
  return { ...response, value: response.value.result };
}
function continueView(prompt = 'Resume task', sizes = [6000, 6000, 6000, 6000, 6000, 6000]) {
  const event = view(sizes);
  event.items.at(-1).text = prompt;
  return event;
}

test('continue mode hides only after a successful cold continuation and freezes the boundary afterwards', () => {
  let state = continuation('model_response', '', cached()).state;
  state = { ...state, calls: records(), visible: Object.keys(records()) };
  const ordinary = continuation('history', '', continueView(), { state, now: NOW + 6 * minute });
  assert.equal(ordinary.value, null);
  const warm = requestContinue(state, { now: NOW + minute });
  assert.equal(warm.value.result.submit, 'Resume task', JSON.stringify(warm));
  assert.equal(warm.state?.continuation ?? null, null);
  const command = requestContinue(state);
  assert.match(command.value.result.submit, /smallest relevant page/);
  const first = continuation('history', '', continueView(command.value.result.submit), { state: command.state, now: NOW + 6 * minute });
  assert.deepEqual(Object.keys(replaced(first.value)).map(Number), [1, 3, 5, 7]);
  assert.equal(first.state.continuation, null);
  const later = continuation('history', '', continueView('ordinary follow-up', Array(9).fill(6000)), { state: first.state, now: NOW + 20 * minute });
  assert.deepEqual(replaced(later.value), replaced(first.value));
  assert.equal(later.state.advances, 1);
  assert.equal(later.calls.some(call => call.operation === 'evidence.read'), false);
  const resumed = continuation('resume', '', {}, { state: later.state });
  assert.deepEqual(replaced(continuation('history', '', continueView(), { state: resumed.state }).value), replaced(first.value));
});

test('forced continuation works without cache evidence and forwards the note without the option', () => {
  const forced = requestContinue({ calls: records() }, { args: '--compact check tests', result: input => {
    assert.equal(input.args, 'check tests');
    return { submit: 'Resume task: check tests' };
  } });
  const hidden = continuation('history', '', continueView(forced.value.result.submit), { state: forced.state });
  assert.equal(Object.keys(replaced(hidden.value)).length, 4);
  for (const options of [{ result: { display: 'No work' } }, { owner: 'other' }, { active_turn: true }]) {
    const declined = requestContinue(null, { args: '--compact', ...options });
    assert.equal(declined.state?.continuation ?? null, null);
  }
});

test('continuation checks originals before entering the history hook without a native task host', () => {
  for (const args of ['', '--compact']) {
    const observed = continuation('model_response', '', cached()).state;
    const calls = { ...records(), absent: { ...records().c0, reference: { reference: 'absent', sha256: 's' } } };
    const ordinary = continuation('history', '', continueView(), { state: { ...observed, calls } });
    const command = requestContinue(ordinary.state, { args });
    const hidden = continuation('history', '', continueView(command.value.result.submit), { state: command.state, now: NOW + 6 * minute,
      host: { 'evidence.read': () => { throw new Error('host_operation_unavailable: requires a native task'); } } });
    assert.equal(Object.keys(replaced(hidden.value)).length, 4);
    assert.ok(command.calls.some(call => call.operation === 'evidence.read'));
    assert.equal(command.calls.some(call => call.arguments?.reference?.reference === 'absent'), false);
    assert.equal(hidden.calls.length, 0);
    assert.deepEqual(hidden.state.calls, command.state.calls);
  }
});

test('continuation cannot hide missing or unreadable originals, failed edits, pinned or recent outputs', () => {
  const calls = records();
  calls.c0.reference = null;
  calls.c1.failed_edit = true;
  const forced = requestContinue({ calls, pinned: ['c2'] }, { args: '--compact',
    host: { 'evidence.read': () => { throw new Error('evidence expired'); } } });
  const hidden = continuation('history', '', continueView(forced.value.result.submit), { state: forced.state, settings: { batch_bytes: 0 } });
  assert.equal(hidden.value, null);
  assert.equal(hidden.state.hidden_bytes, 0);
  const again = requestContinue({ calls: records() }, { args: '--compact' });
  assert.equal(continuation('history', '', continueView('different user input'), { state: again.state }).value, null);
  const resumed = continuation('resume', '', {}, { state: again.state });
  assert.equal(resumed.state.continuation, null);
});

test('cache estimates skip subscriptions, local and unknown providers and do not mix route identities', () => {
  for (const patch of [
    { provider: 'openai', cost: { basis: 'included_subscription' } },
    { provider: 'openai', cost: { basis: 'unpriced' } },
    { provider: 'ollama' },
    { provider: 'unknown', usage: {} },
  ]) {
    const state = continuation('model_response', '', cached(patch)).state;
    assert.equal(state.cache.ttl, 0);
    assert.equal(requestContinue(state).value.result.submit, 'Resume task');
  }
  const state = continuation('model_response', '', cached()).state;
  for (const patch of [{ credential: 'other' }, { provider: 'other' }, { route: 'other' }, { requested_model: 'other' }, { served_model: 'other' }]) {
    const changed = continuation('model_response', '', cached({ ...patch, usage: {} }), { state }).state;
    assert.equal(changed.cache.ttl, 0);
  }
  for (const changed of [{ ...session, model: 'other' }, { ...session, provider: 'other' }, { ...session, route: 'other' }]) {
    assert.equal(requestContinue(state, { host: { 'session.info': () => changed } }).value.result.submit, 'Resume task');
  }
});

test('reported cache reads refresh matching estimates; stale and worker responses cannot overwrite them', () => {
  const state = continuation('model_response', '', cached()).state;
  const refreshed = continuation('model_response', '', cached({ usage: {}, timing: { started_at_ms: NOW + minute } }), { state, now: NOW + minute }).state;
  assert.equal(refreshed.cache.expires, NOW + 6 * minute);
  for (const patch of [{ synthetic: 'fixture' }, { scope: { kind: 'subagent', agent_id: 'a' } }, { status: 'failed' }, { timing: { started_at_ms: NOW - minute } }]) {
    const ignored = continuation('model_response', '', cached(patch), { state: refreshed, now: NOW + minute });
    assert.deepEqual(ignored.state ?? refreshed, refreshed);
  }
  const overridden = continuation('model_response', '', cached({ provider: 'openai', cost: { basis: 'included_subscription' } }), { settings: { cache_ttl_minutes: '10' } });
  assert.equal(overridden.state.cache.ttl, 10 * minute);
  const compacted = continuation('compaction_end', '', { outcome: 'compacted' }, { state });
  assert.equal(compacted.state.cache, null);
});

test('the real continue command keeps interruption checks and notes through the masking interceptor', () => {
  const continueSource = readFileSync(new URL('../omd_continue/index.ts', import.meta.url), 'utf8');
  const continueManifest = JSON.parse(readFileSync(new URL('../omd_continue/mod.json', import.meta.url), 'utf8'));
  const invoke = (args, outcome = 'interrupted') => {
    const output = callback({ source: continueSource, filename: 'index.ts', api: continueManifest.api,
      capabilities: continueManifest.capabilities, event: 'command', name: 'continue', payload: args }, call => {
      assert.equal(call.operation, 'turns.activity');
      return { recording: true, turns: [{ outcome, reason: 'cancelled', error: null, tool_calls: [], processes: [], files: [], truncated: false }] };
    });
    assert.equal(output.error, undefined);
    return output.value;
  };
  const command = requestContinue({ calls: records() }, { args: '--compact verify the build', result: input => invoke(input.args) });
  assert.match(command.value.result.submit, /Note: verify the build/);
  assert.doesNotMatch(command.value.result.submit, /Note: --compact/);
  const hidden = continuation('history', '', continueView(command.value.result.submit), { state: command.state });
  assert.equal(Object.keys(replaced(hidden.value)).length, 4);
  for (const outcome of ['running', 'completed']) {
    const refused = requestContinue(null, { args: '--compact', result: input => invoke(input.args, outcome) });
    assert.equal(typeof refused.value.result.display, 'string');
    assert.equal(refused.state?.continuation ?? null, null);
  }
  assert.match(invoke('--compact').display, /Enable omd_observation_mask/);
});

test('expired originals cannot block later readable outputs across continuations', () => {
  const calls = Object.fromEntries(Array.from({ length: 20 }, (_, n) => [`c${n}`, {
    tool: 'exec_command', reference: { reference: `r${n}`, sha256: 's' }, bytes: 6000, failed_edit: false,
  }]));
  let state = { calls };
  const reads = [];
  const host = { 'evidence.read': ({ reference }) => {
    reads.push(reference.reference);
    if (Number(reference.reference.slice(1)) < 16) throw new Error('resource_not_found');
    return { text: 'ok', cursor: null, bytes: 6000 };
  } };
  let hidden;
  for (let n = 0; n < 2; n++) {
    const command = requestContinue(state, { args: '--compact', host });
    hidden = continuation('history', '', continueView(command.value.result.submit, Array(20).fill(6000)), { state: command.state });
    state = hidden.state;
    assert.equal(state.pending_bytes, n === 0 ? 12_000 : 0);
    assert.equal(state.calls.c0.reference, null);
  }
  assert.deepEqual(Object.keys(replaced(hidden.value)).map(Number), [33, 35]);
  assert.deepEqual(reads, Array.from({ length: 20 }, (_, n) => `r${n}`));
});

test('readability probes allow an original beginning with a multi-byte character', () => {
  const command = requestContinue({ calls: records() }, { args: '--compact',
    host: { 'evidence.read': ({ max_bytes }) => {
      if (max_bytes < Buffer.byteLength('😀')) throw new Error('resource_page_too_small');
      return { text: '😀', cursor: 4, bytes: 6000 };
    } } });
  const hidden = continuation('history', '', continueView(command.value.result.submit), { state: command.state });
  assert.equal(Object.keys(replaced(hidden.value)).length, 4);
});

test('the default session route cannot reuse a named route cache estimate', () => {
  const host = { 'session.info': () => ({ ...session, route: null }) };
  const named = continuation('model_response', '', cached()).state;
  assert.equal(requestContinue(named, { host }).state?.continuation ?? null, null);
  const implicit = continuation('model_response', '', cached({ route: 'session' })).state;
  assert.match(requestContinue(implicit, { host }).value.result.submit, /smallest relevant page/);
});
