import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const runner = readFileSync(new URL('../runtime/omd/src/mods/runner.mjs', import.meta.url), 'utf8');
const mod = new URL('../mods/first-party/omd_herdr/', import.meta.url);
const source = readFileSync(new URL('index.ts', mod), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('mod.json', mod), 'utf8'));
const surface = { events: { app_notification: 'threads', stop: 'lifecycle' }, replacements: [], middleware: [], state: 'store', contracts: 'contracts' };
const thread = '019a0000-0000-7000-8000-000000000001';
const herdrEnv = 'PATH=/usr/bin\nHERDR_ENV=1\nHERDR_PANE_ID=w1-p2\nHERDR_BIN_PATH=/opt/herdr/bin/herdr\nHERDR_SOCKET_PATH=/Users/me/.herdr/herdr.sock\n';

function invoke({ state = null, event, payload = null, name = '', env = herdrEnv, reply = () => ({ exit_code: 0, stdout: '', stderr: '' }) }) {
  const receipts = [];
  const calls = [];
  for (;;) {
    const request = { source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, state, settings: {}, event, name, payload, receipts, surface, virtual_time_ms: 1790000000000 };
    const output = JSON.parse(spawnSync(process.execPath, ['--no-warnings', '--experimental-vm-modules', '--input-type=module', '--eval', runner],
      { input: JSON.stringify(request), encoding: 'utf8', timeout: 20000 }).stdout);
    if (output.error) throw new Error(output.error);
    if (!output.host_call) return { ...output, calls };
    const args = output.host_call.arguments;
    calls.push(args);
    const value = args.program === 'env' ? { exit_code: 0, stdout: env, stderr: '' } : reply(args);
    receipts.push({ call: output.host_call, value: { signal: null, stdout_truncated: false, stderr_truncated: false, timed_out: false, duration_ms: 3, program: { path: args.program, sha256: 'a'.repeat(64) }, ...value } });
  }
}
const status = (status, threadId = thread) => ({ event: 'app_notification', payload: { method: 'thread/status/changed', params: { threadId, status }, thread_id: threadId, coalesced: 0, dropped: 0 } });
const report = state => ['pane', 'report-agent', 'w1-p2', '--source', 'omd', '--agent', 'codex', '--state', ...state, '--agent-session-id', thread, '--seq', '1790000000000', '--', 'codex', 'resume', thread];

test('thread status maps to Herdr states with the resume command through the granted socket', () => {
  const working = invoke(status({ type: 'active', activeFlags: [] }));
  assert.deepEqual(working.calls[0], { program: 'env', timeout_ms: 2000, max_output_bytes: 8192 });
  assert.deepEqual(working.calls[1], { program: '/opt/herdr/bin/herdr', argv: report(['working']), unix_sockets: ['HERDR_SOCKET_PATH'], timeout_ms: 2000, max_output_bytes: 4096 });
  assert.deepEqual(invoke(status({ type: 'active', activeFlags: ['waitingOnUserInput', 'waitingOnApproval'] })).calls[1].argv, report(['blocked', '--message', 'waiting for approval']));
  assert.deepEqual(invoke(status({ type: 'idle' })).calls[1].argv, report(['idle']));
  assert.deepEqual(invoke(status({ type: 'notLoaded' })).calls, []);


  const child = invoke({ event: 'app_notification', payload: { method: 'thread/started', params: { thread: { id: 'child', parentThreadId: thread, ephemeral: false } }, thread_id: 'child', coalesced: 0, dropped: 0 } });
  assert.deepEqual(invoke({ ...status({ type: 'idle' }, 'child'), state: child.state }).calls, []);

  assert.deepEqual(invoke({ event: 'stop' }).calls[1].argv, ['pane', 'release-agent', 'w1-p2', '--source', 'omd', '--agent', 'codex', '--seq', '1790000000000']);
});

test('outside Herdr or with malformed metadata the mod only reads its declared variables', () => {
  for (const env of ['PATH=/usr/bin\n', herdrEnv.replace('HERDR_ENV=1', 'HERDR_ENV=0'), herdrEnv.replace('/opt/herdr/bin/herdr', 'herdr'), herdrEnv.replace('HERDR_PANE_ID=w1-p2', "HERDR_PANE_ID=w1'p2")]) {
    assert.deepEqual(invoke({ ...status({ type: 'active', activeFlags: [] }), env }).calls.map(call => call.program), ['env']);
    assert.deepEqual(invoke({ event: 'stop', env }).calls.map(call => call.program), ['env']);
  }
  assert.match(invoke({ event: 'command', name: 'herdr', env: 'PATH=/usr/bin\n' }).value.display, /stays inert/);
});
