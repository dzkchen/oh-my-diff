import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hostOperations, invoke, runScenario } from '@oh-my-diff/mod-api/testing';
import { callback } from '../../../tests/mod_runner.mjs';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('./mod.json', import.meta.url), 'utf8'));

function run(event, name, payload, { state = null, settings = {}, host = {} } = {}) {
  const calls = [];
  const output = callback({ source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, state, settings: { max_calls: 4, ...settings }, event, name, payload }, call => {
    calls.push(call);
    const reply = host[call.operation];
    if (!reply) assert.fail(`unexpected ${call.operation}`);
    return reply(call.arguments);
  });
  if (output.error) throw new Error(output.error);
  return { value: output.value, state: output.state, calls };
}

const exec = (cmd, extra = {}) => ({ tool: 'exec_command', arguments: { cmd, ...extra } });
const batch = (...calls) => run('tool_batch', '', { batch_id: 'b1', thread_id: 't', calls: calls.map((call, index) => ({ call_id: `c${index}`, parallel_safe: true, ...call })) }).value;

test('an all-read batch merges into one step and keeps identical calls together', () => {
  const merged = batch(exec('sed -n 1,40p src/a.ts'), exec('cat b.ts'), exec("rg -n 'fn main' src"), exec('sed -n 1,40p src/a.ts'));
  assert.deepEqual(merged.merge.map(merge => [merge.tool, merge.call_ids, merge.success_per_call]), [['batch', ['c0', 'c1', 'c2', 'c3'], true]]);
  assert.deepEqual(merged.merge[0].arguments.calls.map(call => call.call_id), ['c0', 'c1', 'c2', 'c3']);
  const large = batch(...Array.from({ length: 10 }, (_, index) => exec(`cat f${index}`)), exec('cat f9'));
  assert.deepEqual(large.merge.map(merge => merge.call_ids), [['c0', 'c1', 'c2', 'c3'], ['c4', 'c5', 'c6', 'c7'], ['c8', 'c9', 'c10']]);
});

test('a batch with any write, shell feature or unknown argument stays native', () => {
  const read = exec('cat a');
  for (const other of [
    exec('rm -rf build'), exec('cat a > b'), exec('cat a | head'), exec('cat a; rm b'), exec('cat $HOME/x'), exec('cat a\nrm b'), exec('cat a\rrm b'), exec('cat\u00a0a'), exec('cat "$(id)"'), exec('cat a*'),
    exec('tail -f log'), exec('tail -F log'), exec('sed -i s/a/b/ f'), exec("sed -n '1p;w out' f"), exec('rg --pre=sh x'), exec('rg -uz x'),
    exec('git push'), exec('git diff --output=x'), exec('git -C .. status'), exec('find . -delete'), exec('cat a', { tty: true }),
    exec('cat a', { sandbox_permissions: 'require_escalated' }), { tool: 'apply_patch', arguments: '*** Begin Patch' }, { tool: 'mcp__fs__read', arguments: {} }, { tool: 'read_file', arguments: { file_path: 'b.ts' } },
  ]) assert.equal(batch(read, other), null, JSON.stringify(other));
  for (const other of [
    exec('tail -1f log'), exec('tail --fol log'), exec('cat'), exec('cat -'), exec('cat /dev/zero'), exec('grep x'), exec('rg x'), exec('git blame --contents - f'),
    exec('git diff --ext x'), exec('git -c core.pager=x log'), exec('git log --output=x'), exec('ls --color=always'), exec('cat a', { shell: '/bin/zsh' }), exec('cat a', { login: true }),
    exec('nl a'), exec('sed -n 1p'), exec('rg --pre-glob x y .'),
  ]) assert.equal(batch(read, other), null, JSON.stringify(other));
  assert.equal(batch(read), null);
  for (const cmd of ['head -n 20 a', 'head -5 a', 'tail -n +5 a', 'wc -l a', 'git log --oneline -n 5', 'git diff --stat -- src', 'git status --short',
    "rg -n -g '*.ts' foo src", 'grep -rn foo src', 'ls -la src', 'ls', 'git show HEAD', 'git blame -L 1,5 a']) assert.ok(batch(read, exec(cmd)), cmd);
  assert.equal(run('tool_batch', '', { batch_id: 'b', thread_id: 't', calls: Array.from({ length: 70 }, (_, index) => ({ call_id: `c${index}`, parallel_safe: true, ...exec(`cat f${index}`) })) },
    { settings: { max_calls: 2 } }).value.merge.length, 32);
});

test('the merged step runs each read once through the host, in order, keeping each result', () => {
  const invoked = [];
  const host = {
    'tools.invoke': ({ tool, arguments: args }) => {
      invoked.push([tool, args]);
      if (args.cmd === 'cat big') throw new Error('host_result_limit: the 90000-byte result exceeds the 41000 bytes left in this callback');
      if (args.cmd === 'cat denied') throw new Error('mod_tool_denied: guard: no');
      return { call_id: `mod-omd_tool_absorb-${invoked.length}`, output: `Exit code: ${args.cmd === 'cat missing' ? 1 : 0}\nOutput:\n${args.cmd}`, success: true, truncated: false };
    },
  };
  const calls = [exec('cat a'), exec('cat missing'), exec('cat big'), exec('cat a'), exec('cat denied'), exec('rm x')]
    .map((call, index) => ({ call_id: `c${index}`, ...call }));
  const { value, state } = run('tool', 'batch', { batch: 'b1', calls }, { host });
  assert.deepEqual(invoked.map(([, args]) => args.cmd), ['cat a', 'cat missing', 'cat big', 'cat denied']);
  assert.deepEqual(value.c0, { output: 'Exit code: 0\nOutput:\ncat a', success: true });
  assert.deepEqual(value.c1, { output: 'Exit code: 1\nOutput:\ncat missing', success: true });
  assert.match(value.c2.output, /ran, but its output did not fit in the merged result\. Call it again on its own/);
  assert.match(value.c3.output, /^Same call as c0 in this response .* see the output for c0\.$/);
  assert.equal(value.c3.success, true);
  assert.deepEqual(value.c4, { output: 'exec_command failed: mod_tool_denied: guard: no', success: false });
  assert.match(value.c5.output, /did not run exec_command: it only runs read-only calls/);
  assert.deepEqual([value.c2.success, value.c5.success], [false, false]);
  assert.deepEqual(Object.keys(value), ['c0', 'c1', 'c2', 'c3', 'c4', 'c5']);
  assert.deepEqual(state.recent[0].invoked, { c0: 'mod-omd_tool_absorb-1', c1: 'mod-omd_tool_absorb-2' });
  assert.deepEqual([state.batches, state.absorbed, state.deduplicated, state.overflowed], [1, 6, 1, 1]);
  const many = Array.from({ length: 10 }, (_, index) => ({ call_id: `d${index}`, ...exec(`cat f${index}`) }));
  const capped = run('tool', 'batch', { batch: 'b2', calls: many }, { host: { 'tools.invoke': () => ({ call_id: 'x', output: 'ok', success: true, truncated: false }) } });
  assert.equal(capped.calls.length, 8);
  assert.match(capped.value.d8.output, /runs at most 8 distinct reads/);
});

const fnv = (text, seed) => {
  let hash = seed;
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0;
  return hash.toString(16).padStart(8, '0');
};
const hash = text => `${fnv(text, 0x811c9dc5)}${fnv(text, 0x9e3779b9)}`;
const thread = hash('t');
const flightOf = (cellId = 'cell-1') => `flight:${thread}:${hash(cellId)}:`;

function memoryStore() {
  const entries = new Map();
  let revision = 0;
  const record = (value, at = Date.now()) => ({ value, revision: ++revision, provenance: { mod: 'omd_tool_absorb', source_sha256: '', thread_id: 't', origin: 'tool', at } });
  return {
    entries, record,
    ops: {
      'store.put': ({ key, value, expected_revision }) => {
        if ((entries.get(key)?.revision ?? null) !== expected_revision) throw new Error('store_revision_conflict');
        entries.set(key, record(value));
        return { revision };
      },
      'store.get': ({ key }) => entries.get(key) ?? null,
      'store.delete': ({ key, expected_revision }) => {
        if (entries.get(key)?.revision !== expected_revision) throw new Error('store_revision_conflict');
        entries.delete(key);
        return { deleted: true };
      },
      'store.list': ({ prefix: start }) => ({ keys: [...entries].filter(([key]) => key.startsWith(start ?? '')).map(([key, entry]) => ({ key, revision: entry.revision, bytes: 1, provenance: entry.provenance })), cursor: null, generation: 1 }),
    },
  };
}

function cell(call, { cellId = 'cell-1', caller = 'code_mode', sha = 'a'.repeat(64), shaAfter = sha, next = () => native, state = null, cwd = '/repo', size = 1, store = memoryStore(), onSleep = () => {}, sleep = true } = {}) {
  let hashed = 0;
  const input = { ...call, call_id: 'k', thread_id: 't', agent_id: null, schema: null, raw_arguments: JSON.stringify(call.arguments), batch: null };
  const host = {
    ...store.ops,
    'session.info': () => ({ thread_id: 't', root: '/repo', cwd, codex_version: '0.163.0', model: null, provider: 'openai', route: null, turns_started: 1 }),
    'workspace.stat': ({ paths, hash: withHash }) => ({ files: Object.fromEntries(paths.map(path => [path, { kind: 'file', size, mtime_ms: 1, ...(withHash ? { sha256: hashed++ ? shaAfter : sha } : {}) }])) }),
    'time.sleep': ({ ms }) => { if (!sleep) throw new Error('time_sleep_unavailable'); onSleep(); return { slept_ms: ms, cancelled: false }; },
    'continuation.next': () => ({ result: next(), trace: [] }),
  };
  const origin = { caller, cell_id: cellId, thread_id: 't' };
  const out = run('intercept', '0', { surface: 'tool', input, original: input, origin }, { state, host });
  return { ...out, store, ran: out.calls.some(entry => entry.operation === 'continuation.next'), stats: out.calls.filter(entry => entry.operation === 'workspace.stat' && entry.arguments.hash).map(entry => entry.arguments).slice(0, 1) };
}
const native = { output: 'Exit code: 0\nOutput:\nx', success: true, value: { chunk_id: 'c1', wall_time_seconds: 0.01, exit_code: 0, original_token_count: 1, output: 'x' } };
const read = exec('sed -n 1,20p src/a.ts');

test('a code-mode cell reuses an identical read with its structured result while every source file is unchanged', () => {
  const first = cell(read);
  assert.ok(first.ran);
  assert.deepEqual(first.stats, [{ paths: ['src/a.ts'], hash: true }]);
  assert.equal(first.store.entries.get([...first.store.entries.keys()].find(key => key.startsWith(flightOf()))).value.status, 'done');
  const second = cell(read, { store: first.store, state: first.state });
  assert.equal(second.ran, false);
  assert.deepEqual(second.value.result, native, 'the cell gets the same structured value it got the first time');
  assert.deepEqual(first.store.entries.get(`meta:${thread}:reuse`).value, { reused: 1, saved_bytes: Buffer.byteLength(native.output) });
  assert.equal(second.state, null, 'the interceptor never writes api.state, so concurrent reads cannot lose a state race');
  assert.ok(cell(read, { store: first.store, sha: 'b'.repeat(64) }).ran, 'changed file');
  assert.ok(cell(read, { store: first.store, cellId: 'cell-2' }).ran, 'another cell');
  const model = cell(read, { store: first.store, caller: 'model' });
  assert.ok(model.ran);
  assert.deepEqual(model.stats, []);
  assert.deepEqual(cell(exec('cat -n a b')).stats, [{ paths: ['a', 'b'], hash: true }]);
  assert.deepEqual(cell(exec('wc -c a')).stats, [{ paths: ['a'], hash: true }]);
  assert.deepEqual(cell(exec('cat a ./b /repo/c')).stats, [{ paths: ['a', 'b', 'c'], hash: true }]);
  assert.deepEqual(cell(exec('cat a'), { cwd: '/repo/sub' }).stats, [{ paths: ['sub/a'], hash: true }], 'paths resolve against the turn cwd');
  for (const [call, options] of [[exec('cat a'), { cwd: '/elsewhere' }], [exec('cat ../a'), {}], [exec('cat /etc/hosts'), {}], [exec('cat a'), { size: 2_000_000 }]]) {
    const out = cell(call, options);
    assert.ok(out.ran);
    assert.deepEqual(out.stats, [], `${call.arguments.cmd} ${JSON.stringify(options)} is never hashed`);
  }
});

test('a concurrent identical read waits for the first one and reuses its result', () => {
  const store = memoryStore();
  let twin;
  const first = cell(read, { store, next: () => {
    const [id, claim] = [...store.entries].find(([key]) => key.startsWith('flight:'));
    assert.equal(claim.value.status, 'running');
    twin = cell(read, { store, onSleep: () => store.entries.set(id, store.record({ key: claim.value.key, status: 'done', output: native.output, value: native.value })) });
    return native;
  } });
  assert.ok(first.ran);
  assert.equal(twin.ran, false);
  assert.deepEqual(twin.value.result, native);
});

test('a twin that waits too long runs itself, and failed or unfinished reads are never shared', () => {
  const stuck = memoryStore();
  cell(read, { store: stuck, next: () => {
    const late = cell(read, { store: stuck });
    assert.ok(late.ran, 'a claim that never finishes is dropped after the wait');
    assert.equal(late.calls.filter(entry => entry.operation === 'time.sleep').length, 9);
    assert.ok(late.calls.length <= 30, `a waiter stays far below the 128-call limit (${late.calls.length})`);
    return native;
  } });
  const asleep = memoryStore();
  cell(read, { store: asleep, next: () => {
    const twin = cell(read, { store: asleep, sleep: false });
    assert.ok(twin.ran, 'without time.sleep the twin runs on its own');
    assert.equal([...asleep.entries.values()].filter(entry => entry.value.status === 'running').length, 1, 'and leaves the first read\'s claim alone');
    return native;
  } });
  const raced = cell(read, { shaAfter: 'b'.repeat(64) });
  assert.ok(![...raced.store.entries.keys()].some(key => key.startsWith('flight:')), 'a file that changed during the read is not published');
  for (const result of [
    { ...native, value: { ...native.value, exit_code: 1 } }, { ...native, value: { chunk_id: 'c1', session_id: 3, output: '' } }, { ...native, truncated: true },
    { ...native, output: 'x'.repeat(17_000) }, { output: 'Exit code: 0\nOutput:\nx', success: true }, { ...native, success: false },
  ]) assert.ok(![...cell(exec('cat a'), { next: () => result }).store.entries.keys()].some(key => key.startsWith('flight:')), JSON.stringify(result).slice(0, 80));
  const cancelled = memoryStore();
  assert.throws(() => cell(exec('cat a'), { store: cancelled, next: () => { throw new Error('callback_cancelled'); } }));
  assert.ok(![...cancelled.entries.keys()].some(key => key.startsWith('flight:')), 'a cancelled read releases its claim');
  for (const call of [exec("rg -n 'x' src"), exec('ls src'), exec('git diff'), exec('cat a', { workdir: '/elsewhere' })]) {
    const out = cell(call);
    assert.ok(out.ran);
    assert.deepEqual(out.stats, [], call.arguments.cmd);
  }
});

test('a new cell sweeps this thread\'s older cells and other threads\' stale entries, and a turn end clears this thread', () => {
  const store = memoryStore();
  store.entries.set(`meta:${thread}:cell`, store.record(hash('cell-0')));
  store.entries.set(`${flightOf('cell-0')}x`, store.record({ key: 'old', status: 'done', output: '', value: null }));
  store.entries.set('flight:00000000:cell-9:y', store.record({ key: 'stale', status: 'done', output: '', value: null }, 0));
  store.entries.set('flight:00000000:cell-9:z', store.record({ key: 'fresh', status: 'running' }));
  store.entries.set('meta:00000000:reuse', store.record({ reused: 1 }, 0));
  store.entries.set('meta:00000001:reuse', store.record({ reused: 1 }));
  cell(read, { store });
  assert.deepEqual([...store.entries.keys()].filter(key => !key.startsWith(flightOf())).sort(),
    [`meta:${thread}:cell`, 'flight:00000000:cell-9:z', 'meta:00000001:reuse'].sort());
  assert.equal(store.entries.get(`meta:${thread}:cell`).value, hash('cell-1'));
  run('turn_end', '', { turn_id: 'turn-1', outcome: 'completed' }, { host: {
    ...store.ops,
    'session.info': () => ({ thread_id: 't', root: '/repo', cwd: '/repo', codex_version: '0.163.0', model: null, provider: 'openai', route: null, turns_started: 1 }),
  } });
  assert.deepEqual([...store.entries.keys()].filter(key => key.startsWith('flight:')), ['flight:00000000:cell-9:z'], 'file contents do not outlive the turn');
});

test('a cancelled merged step fails instead of returning partial results', { skip: !process.env.OMD_MOD_BIN && 'needs the omd-mod engine in OMD_MOD_BIN' }, () => {
  const directory = fileURLToPath(new URL('.', import.meta.url));
  const calls = [{ call_id: 'c0', ...exec('cat a') }, { call_id: 'c1', ...exec('cat b') }];
  const reply = { result: { call_id: 'mod-1', output: 'ok', success: true, truncated: false } };
  const step = options => invoke('omd_tool_absorb', 'tool', 'batch', { batch: 'b', calls }, { threadId: 't', ...options });
  assert.deepEqual(runScenario(directory, hostOperations({ 'tools.invoke': [reply, reply] }), { steps: [step()] }).steps[0].value, { c0: { output: 'ok', success: true }, c1: { output: 'ok', success: true } });
  assert.throws(() => runScenario(directory, hostOperations({ 'tools.invoke': [reply, reply] }), { steps: [step({ cancelled: true })] }), /callback_cancelled/);
});

test('/absorb reports merged calls and their host call IDs', () => {
  const state = { batches: 1, absorbed: 3, deduplicated: 1, overflowed: 0, saved_bytes: 120, recent: [{ batch: 'b1', calls: 3, ran: 2, invoked: { c0: 'mod-omd_tool_absorb-1', c1: 'mod-omd_tool_absorb-2' } }] };
  const { value } = run('command', 'absorb', null, { state, host: {
    'session.info': () => ({ thread_id: 't', root: '/repo', cwd: '/repo', codex_version: '0.163.0', model: null, provider: 'openai', route: null, turns_started: 1 }),
    'store.get': ({ key }) => key === `meta:${hash('t')}:reuse` ? { value: { reused: 2, saved_bytes: 30 }, revision: 1, provenance: { mod: 'omd_tool_absorb', source_sha256: '', thread_id: 't', origin: 'tool', at: 0 } } : null,
  } });
  assert.equal(value.display, 'Tool-call absorption: 1 merged batches · 3 calls · 1 duplicate calls run once · 2 repeated code-mode reads reused · 0 outputs too large to merge · about 150 bytes not repeated\nb1: 3 calls, 2 ran · c0→mod-omd_tool_absorb-1, c1→mod-omd_tool_absorb-2');
});
