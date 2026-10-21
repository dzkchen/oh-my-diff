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
  const merged = batch(exec('sed -n 1,40p src/a.ts'), { tool: 'read_file', arguments: { file_path: 'b.ts' } }, exec("rg -n 'fn main' src"), exec('sed -n 1,40p src/a.ts'));
  assert.deepEqual(merged.merge.map(merge => [merge.tool, merge.call_ids]), [['batch', ['c0', 'c1', 'c2', 'c3']]]);
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
    exec('cat a', { sandbox_permissions: 'require_escalated' }), { tool: 'apply_patch', arguments: '*** Begin Patch' }, { tool: 'mcp__fs__read', arguments: {} },
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
  assert.equal(value.c0, 'Exit code: 0\nOutput:\ncat a');
  assert.equal(value.c1, 'Exit code: 1\nOutput:\ncat missing');
  assert.match(value.c2, /ran, but its output did not fit in the merged result\. Call it again on its own/);
  assert.match(value.c3, /^Same call as c0 in this response .* see the output for c0\.$/);
  assert.equal(value.c4, 'exec_command failed: mod_tool_denied: guard: no');
  assert.match(value.c5, /did not run exec_command: it only runs read-only calls/);
  assert.deepEqual(Object.keys(value), ['c0', 'c1', 'c2', 'c3', 'c4', 'c5']);
  assert.deepEqual(state.recent[0].invoked, { c0: 'mod-omd_tool_absorb-1', c1: 'mod-omd_tool_absorb-2' });
  assert.deepEqual([state.batches, state.absorbed, state.deduplicated, state.overflowed], [1, 6, 1, 1]);
  const many = Array.from({ length: 10 }, (_, index) => ({ call_id: `d${index}`, ...exec(`cat f${index}`) }));
  const capped = run('tool', 'batch', { batch: 'b2', calls: many }, { host: { 'tools.invoke': () => ({ call_id: 'x', output: 'ok', success: true, truncated: false }) } });
  assert.equal(capped.calls.length, 8);
  assert.match(capped.value.d8, /runs at most 8 distinct reads/);
});

test('a cancelled merged step fails instead of returning partial results', { skip: !process.env.OMD_MOD_BIN && 'needs the omd-mod engine in OMD_MOD_BIN' }, () => {
  const directory = fileURLToPath(new URL('.', import.meta.url));
  const calls = [{ call_id: 'c0', ...exec('cat a') }, { call_id: 'c1', ...exec('cat b') }];
  const reply = { result: { call_id: 'mod-1', output: 'ok', success: true, truncated: false } };
  const step = options => invoke('omd_tool_absorb', 'tool', 'batch', { batch: 'b', calls }, { threadId: 't', ...options });
  assert.deepEqual(runScenario(directory, hostOperations({ 'tools.invoke': [reply, reply] }), { steps: [step()] }).steps[0].value, { c0: 'ok', c1: 'ok' });
  assert.throws(() => runScenario(directory, hostOperations({ 'tools.invoke': [reply, reply] }), { steps: [step({ cancelled: true })] }), /callback_cancelled/);
});

test('/absorb reports merged calls and their host call IDs', () => {
  const state = { batches: 1, absorbed: 3, deduplicated: 1, overflowed: 0, saved_bytes: 120, recent: [{ batch: 'b1', calls: 3, ran: 2, invoked: { c0: 'mod-omd_tool_absorb-1', c1: 'mod-omd_tool_absorb-2' } }] };
  const { value } = run('command', 'absorb', null, { state });
  assert.equal(value.display, 'Tool-call absorption: 1 merged batches · 3 calls · 1 duplicate calls run once · 0 outputs too large to merge · about 120 bytes not repeated\nb1: 3 calls, 2 ran · c0→mod-omd_tool_absorb-1, c1→mod-omd_tool_absorb-2');
});
