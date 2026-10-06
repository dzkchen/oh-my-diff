import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { runnerSync } from './mod_runner.mjs';

const runner = readFileSync(new URL('../runtime/omd/src/mods/runner.mjs', import.meta.url), 'utf8');
const mod = new URL('../mods/first-party/omd_mcp/', import.meta.url);
const source = readFileSync(new URL('index.ts', mod), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('mod.json', mod), 'utf8'));
const surface = { events: { app_notification: 'threads', terminal: 'terminal', channel: 'events', timer: 'events' }, replacements: [], middleware: [], state: 'store', contracts: 'contracts' };

function invoke({ state = null, event, payload = null, name = '', reply = () => ({}), time = 0 }) {
  const receipts = [];
  const calls = [];
  for (;;) {
    const request = { source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, state, settings: {}, event, name, payload, receipts, surface, virtual_time_ms: time };
    const output = JSON.parse(runnerSync(request).stdout);
    if (output.error) throw new Error(output.error);
    if (!output.host_call) return { ...output, calls };
    calls.push(output.host_call);
    const value = reply(output.host_call);
    receipts.push(typeof value === 'string' ? { call: output.host_call, error: value } : { call: output.host_call, value });
  }
}
const startup = (threadId, name, status, extra = {}) => ({ event: 'app_notification', payload: { method: 'mcpServer/startupStatus/updated', params: { threadId, name, status, error: null, failureReason: null, ...extra }, thread_id: threadId, coalesced: 0, dropped: 0 } });
function deliver(state, notification, list = () => ({})) {
  const fixtures = {
    'config/read': { config: { mcp_servers: { notes: { command: 'notes', env: { TOKEN: '<redacted>' } }, off: { command: 'off', enabled: false }, web: { url: 'https://web.example/mcp' } }, plugins: { 'pkg@market': { mcp_servers: { pkgsrv: { enabled: false } } } } } },
    'plugin/installed': { marketplaces: [{ name: 'market', path: '/m', plugins: [{ id: 'pkg@market', name: 'pkg', installed: true, enabled: true }, { id: 'off@market', name: 'off', installed: true, enabled: false }] }] },
    'plugin/read': { plugin: { mcpServers: ['pkgsrv'] } },
  };
  const observed = invoke({ ...notification, state, reply: call => call.operation === 'events.publish' ? { delivered: 1, dropped: 0 } : fixtures[call.arguments.method] ?? list(call) });
  assert.deepEqual(observed.state, state);
  const published = observed.calls.find(call => call.operation === 'events.publish').arguments;
  return { calls: observed.calls, state: invoke({ state, event: 'channel', payload: { publisher: 'omd_mcp', channel: `omd_mcp/${published.channel}`, data: published.data, correlation: null, sequence: 1, dropped: 0 } }).state };
}
const listed = (name, extra) => ({ data: [{ name, runtimeStatus: 'connected', pluginId: null, httpOrigin: null, tools: {}, toolsError: null, authStatus: 'unsupported', ...extra }] });
const sidebar = (state, thread) => invoke({ state, event: 'terminal', payload: { event: 'idle', ledger: { thread_id: thread, cwd: '/repo', cost: null } } }).value?.sites.sidebar.components[1].children.map(child => child.text);

test('startup updates build a per-thread inventory from the thread connection and surface actionable failures', () => {
  let state = deliver(null, startup('t1', 'docs', 'starting')).state;
  const ready = deliver(state, startup('t1', 'docs', 'ready'), () => listed('docs', { httpOrigin: 'https://docs.example', pluginId: 'docs@market', authStatus: 'notLoggedIn', tools: { search: {}, fetch: {} } }));
  assert.deepEqual(ready.calls[0].arguments, { method: 'mcpServerStatus/list', params: { threadId: 't1', serverName: 'docs', detail: 'toolsAndAuthOnly' } });
  state = deliver(ready.state, startup('t1', 'notes', 'failed', { error: 'OAuth token expired', failureReason: 'reauthenticationRequired' }), () => listed('notes', { runtimeStatus: 'authenticationRequired', authStatus: 'notLoggedIn' })).state;
  state = deliver(state, startup('t2', 'other', 'failed', { error: 'spawn ENOENT' }), () => 'app_request_failed').state;
  assert.deepEqual(sidebar(state, 't1'), ['docs · 2 tools', 'notes · login required', '  /mcps login notes', 'off · disabled', 'pkgsrv · disabled', 'web · starting']);
  assert.deepEqual(sidebar(state, 't2'), ['notes · starting', 'off · disabled', 'other · failed', '  spawn ENOENT', 'pkgsrv · disabled', 'web · starting']);
  const failedCall = { event: 'app_notification', payload: { method: 'item/completed', params: { threadId: 't1', turnId: 'u', item: { type: 'mcpToolCall', id: 'c', server: 'docs', tool: 'search', status: 'failed', error: { message: 'tool call failed\n\nCaused by:\n    Transport closed' } } }, thread_id: 't1', coalesced: 0, dropped: 0 } };
  const polled = invoke({ state, event: 'timer', payload: { key: 'poll:t1' }, reply: call => call.operation === 'events.schedule' ? { scheduled: true } : listed(call.arguments.params.serverName, { runtimeStatus: call.arguments.params.serverName === 'docs' ? 'failed' : 'authenticationRequired' }) });
  assert.deepEqual(polled.calls.map(call => call.arguments.params?.serverName ?? call.operation).sort(), ['docs', 'events.schedule', 'notes']);
  assert.deepEqual(sidebar(polled.state, 't1').slice(0, 2), ['docs · failed', '  connection closed; /mcps reload restarts it']);
  assert.equal(invoke({ state, event: 'timer', payload: { key: 'poll:gone' }, reply: () => 'app_request_failed: thread not found: gone' }).calls.length, 0);
  const crashed = deliver(state, failedCall).state;
  assert.deepEqual(sidebar(crashed, 't1').slice(0, 2), ['docs · last call failed', '  tool call failed Caused by: Transport closed']);
  const recovered = deliver(crashed, { ...failedCall, payload: { ...failedCall.payload, params: { ...failedCall.payload.params, item: { ...failedCall.payload.params.item, status: 'completed', error: null } } } }).state;
  assert.equal(sidebar(recovered, 't1')[0], 'docs · 2 tools');
  assert.deepEqual(invoke({ ...failedCall, state: recovered, payload: { ...failedCall.payload, params: { ...failedCall.payload.params, item: { ...failedCall.payload.params.item, status: 'completed', error: null } } } }).calls, []);
  assert.equal(sidebar(state, 'none'), undefined);
  state = invoke({ state, event: 'command', name: 'mcps', payload: '' }).state;
  assert.deepEqual(sidebar(state, 't1').slice(0, 2), ['docs · 2 tools · HTTP https://docs.example · plugin docs@market', '  fetch, search']);

  const writes = [];
  const switched = (op, server, answer = { status: 'ok' }) => invoke({ state, event: 'command', name: 'mcps', payload: `${op} ${server}`, reply: call => (writes.push(call.arguments), call.arguments.method === 'config/value/write' ? answer : {}) });
  const disabled = switched('disable', 'notes');
  assert.deepEqual(writes.splice(0), [{ method: 'config/value/write', params: { keyPath: 'mcp_servers.notes.enabled', value: false, mergeStrategy: 'replace' } }, { method: 'config/mcpServer/reload', params: {} }]);
  assert.equal(sidebar(disabled.state, 't1')[2], 'notes · disabled · stdio');
  const restarted = deliver(disabled.state, startup('t1', 'fresh', 'starting')).state;
  assert.deepEqual(sidebar(restarted, 't1').slice(0, 2), ['fresh · starting · stdio', 'notes · disabled · stdio']);
  assert.deepEqual(sidebar(restarted, 't1').slice(2), ['off · disabled · stdio', 'pkgsrv · disabled · stdio · plugin pkg@market', 'web · starting · HTTP']);
  assert.deepEqual(sidebar(restarted, 't2'), ['notes · disabled · stdio', 'off · disabled · stdio', 'other · failed · stdio', '  spawn ENOENT', 'pkgsrv · disabled · stdio · plugin pkg@market', 'web · starting · HTTP']);
  switched('enable', 'docs');
  assert.equal(writes[0].params.keyPath, 'plugins.docs@market.mcp_servers.docs.enabled');
  writes.length = 0;
  assert.equal(switched('disable', 'notes', { status: 'declined' }).value.display, 'Kept the configuration unchanged.');
  assert.equal(writes.length, 1);
});

test('setup drafts reviewed upstream commands in the composer and refuses legacy SSE', () => {
  const composer = { text: '', cursor: 0, selection: null, revision: 1, attachments: [], suggestion: null };
  const drafted = payload => invoke({ event: 'command', name: 'mcps', payload, reply: call => call.operation === 'composer.read' ? composer : { ...composer, text: call.arguments.edit.text, revision: 2 } })
    .calls.filter(call => call.operation === 'composer.write').map(call => call.arguments.edit.text);
  assert.deepEqual(drafted('add docs --url https://mcp.example/v1 --bearer-token-env-var DOCS_TOKEN'), ['!codex mcp add docs --url https://mcp.example/v1 --bearer-token-env-var DOCS_TOKEN']);
  assert.deepEqual(drafted("add fs --env ROOT=/tmp/a -- npx -y @scope/server it's"), ["!codex mcp add fs --env ROOT=/tmp/a -- npx -y @scope/server 'it'\\''s'"]);
  assert.deepEqual(drafted('login docs'), ['!codex mcp login docs']);
  assert.deepEqual(drafted('remove docs'), ['!codex mcp remove docs']);
  for (const payload of ['add docs --sse https://old.example/sse', 'add docs --url ftp://x', 'add docs --env NOEQUALS -- run', 'add bad.name --url https://x', 'add docs --url https://x --header Authorization']) assert.deepEqual(drafted(payload), [], payload);
  assert.match(invoke({ event: 'command', name: 'mcps', payload: 'add docs --sse https://old.example/sse' }).value.display, /Legacy SSE servers are unsupported/);
});
