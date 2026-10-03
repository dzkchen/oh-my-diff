import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const runner = readFileSync(new URL('../runtime/omd/src/mods/runner.mjs', import.meta.url), 'utf8');
const mod = new URL('../mods/first-party/omd_mini/', import.meta.url);
const source = readFileSync(new URL('index.ts', mod), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('mod.json', mod), 'utf8'));
const surface = { events: { start: 'lifecycle', resume: 'lifecycle', turn_start: 'lifecycle', turn_end: 'lifecycle', app_notification: 'threads', terminal: 'terminal' }, replacements: [], middleware: [], state: 'store', contracts: 'contracts' };
const thread = '019a0000-0000-7000-8000-000000000001';
const launch = '0123456789abcdef';
const ledger = (cost = null) => ({ thread_id: thread, cwd: '/repo', cost });

function session(env) {
  const store = {};
  const calls = [];
  let state = null;
  const invoke = (event, payload = null, name = '', time = 1790000000000) => {
    const receipts = [];
    for (;;) {
      const request = { source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, state, settings: {}, event, name, payload, receipts, surface, virtual_time_ms: time };
      const output = JSON.parse(spawnSync(process.execPath, ['--no-warnings', '--experimental-vm-modules', '--input-type=module', '--eval', runner],
        { input: JSON.stringify(request), encoding: 'utf8', timeout: 20000 }).stdout);
      if (output.error) throw new Error(output.error);
      if (!output.host_call) { state = output.state; return output.value; }
      const { operation, arguments: args } = output.host_call;
      calls.push({ operation, args });
      const key = `${args.scope ?? 'repository'}:${args.key}`;
      let value = null;
      if (operation === 'exec.run') value = { exit_code: 0, stdout: env, stderr: '', signal: null, stdout_truncated: false, stderr_truncated: false, timed_out: false, duration_ms: 3, program: { path: '/usr/bin/env', sha256: 'a'.repeat(64) } };
      if (operation === 'store.get') value = store[key] ?? null;
      if (operation === 'store.put') { store[key] = { value: args.value, revision: (store[key]?.revision ?? 0) + 1, provenance: { thread_id: thread } }; value = { revision: store[key].revision }; }
      if (operation === 'store.delete') { value = { deleted: key in store }; delete store[key]; }
      receipts.push({ call: output.host_call, value });
    }
  };
  return { invoke, store, calls };
}

const notify = (method, params, threadId = thread) => ({ method, params, thread_id: threadId, coalesced: 0, dropped: 0 });

test('outside an omd mini launch the mod stays inert and points to the launcher', () => {
  const { invoke, calls } = session('PATH=/usr/bin\n');
  invoke('start', {});
  assert.deepEqual(calls.map(call => call.operation), ['exec.run']);
  assert.equal(invoke('terminal', { event: 'turn_end', ledger: ledger() }), null);
  invoke('app_notification', notify('thread/settings/updated', { threadId: thread, threadSettings: { model: 'x' } }));
  assert.equal(calls.length, 1);
  assert.equal(invoke('command', '', 'switch').display, `This session was not started by \`omd mini\`. Quit, then run \`omd mini resume ${thread}\`.`);
});

test('a mini session shows compact tools, a simple prompt and one bounded status line', () => {
  const { invoke } = session(`OH_MY_DIFF_PRESENTATION=mini\nOH_MY_DIFF_LAUNCH=${launch}.0\n`);
  invoke('start', {});
  assert.deepEqual(invoke('terminal', { event: 'start', ledger: ledger() }),
    { inline_sites: 'hidden', completed_tools: 'compact', placeholder: 'Ask anything · /omd_mini:switch opens the full UI', status: [] });
  invoke('turn_start', { turn_id: 't1' }, '', 1790000000000);
  assert.deepEqual(invoke('terminal', { event: 'turn_start', ledger: ledger() }).status, ['working']);
  invoke('turn_end', { turn_id: 't1', outcome: 'completed' }, '', 1790000065000);
  invoke('app_notification', notify('thread/tokenUsage/updated', { threadId: thread, tokenUsage: { last: { totalTokens: 88000 }, modelContextWindow: 258000 } }));
  invoke('app_notification', notify('thread/tokenUsage/updated', { threadId: 'child', tokenUsage: { last: { totalTokens: 1000 }, modelContextWindow: 258000 } }, 'child'));
  invoke('app_notification', notify('account/rateLimits/updated', { rateLimits: { primary: { usedPercent: 23, windowDurationMins: 300 } } }, null));
  assert.deepEqual(invoke('terminal', { event: 'turn_end', ledger: ledger() }).status, ['1m05s · ctx 34% · 5h 23%']);
  assert.match(invoke('terminal', { event: 'turn_end', ledger: ledger({ settled_task_charge_microusd: 120000 }) }).status[0], / · \$0\.12$/);
});

test('switching records a request for this launch run, refuses mid-turn and can be cancelled', () => {
  const { invoke, store, calls } = session(`OH_MY_DIFF_PRESENTATION=mini\nOH_MY_DIFF_LAUNCH=${launch}.2\n`);
  store[`user:switch_${launch}`] = { value: { run: 1, target: 'mini', thread }, revision: 4, provenance: { thread_id: thread } };
  invoke('resume', { thread_id: thread, last_turn: null, restarted: false });
  assert.equal(store[`user:switch_${launch}`], undefined);
  invoke('turn_start', { turn_id: 't1' });
  assert.match(invoke('command', '', 'switch').display, /^A turn is running/);
  invoke('turn_end', { turn_id: 't1', outcome: 'aborted' });
  assert.match(invoke('command', '', 'switch').display, /reopens this session in the full interface/);
  assert.deepEqual(store[`user:switch_${launch}`].value, { run: 2, target: 'full', thread });
  assert.match(invoke('command', '', 'switch').display, /^Switch cancelled/);
  assert.equal(store[`user:switch_${launch}`], undefined);
  assert.ok(calls.every(call => call.operation !== 'exec.run' || call.args.program === 'env'));
});

test('a full session started by the launcher switches back to mini', () => {
  const { invoke, store } = session(`OH_MY_DIFF_PRESENTATION=full\nOH_MY_DIFF_LAUNCH=${launch}.1\n`);
  invoke('resume', { thread_id: thread, last_turn: null, restarted: false });
  assert.equal(invoke('terminal', { event: 'resume', ledger: ledger() }), null);
  invoke('command', '', 'switch');
  assert.deepEqual(store[`user:switch_${launch}`].value, { run: 1, target: 'mini', thread });
});
