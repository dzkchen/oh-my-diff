import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { callback } from './mod_runner.mjs';

const root = new URL('../plugins/experimental/oh-my-diff-experimental/plugins/omd-browse/mod/', import.meta.url);
const source = readFileSync(new URL('index.ts', root), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('mod.json', root), 'utf8'));
const bridge = readFileSync(new URL('bridge.mjs', root), 'utf8');
const base = { source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, settings: {}, package: { id: manifest.id }, assets: { 'bridge.mjs': { text: bridge, sha256: '0'.repeat(64) } } };
const noHost = () => { throw new Error('no host call expected'); };

function run(event, payload, state, host = noHost, name) {
  const reply = callback({ ...base, state, event, ...(name === undefined ? {} : { name }), payload }, host);
  assert.equal(reply.error, undefined, reply.error);
  return { value: reply.value, state: reply.state === undefined ? state : reply.state };
}

function browse(command, output, state = null) {
  const input = { tool: 'mcp__omd_browse__browse', arguments: { command }, call_id: 'c', thread_id: 't', agent_id: null, schema: null, raw_arguments: '', batch: null };
  return run('intercept', { surface: 'tool', input, original: input, origin: { caller: 'model' } }, state, call => {
    assert.equal(call.operation, 'continuation.next');
    return { result: { output, success: true }, trace: [] };
  }, '0').state;
}

test('browse results feed a status line', () => {
  let state = browse('search --query kittens', '(untrusted)\n[t1] Shop — http://127.0.0.1:3000/\nChanged:\n+ Result for kittens\nlearned api: search — GET /api/search --q; `api search --help`');
  state = browse('rec start', 'Recording t1; `rec stop` saves it', state);
  assert.deepEqual(run('terminal', { ledger: null }, state).value.status, ['◍ t1 Shop', '● rec', 'api: search']);
  assert.equal(run('terminal', { ledger: null }, null).value, null);
});

test('browse calls render as one compact row until expanded', () => {
  const render = props => {
    const input = { component: 'tool_call', id: 'c', surface: 'inline', viewport: { columns: 80, rows: 40 }, lifecycle: 'final', owner: null, props };
    return run('intercept', { surface: 'render', input, original: input, origin: { caller: 'engine' } }, null, () => ({ result: { tree: [{ type: 'native' }] }, trace: [] }), '1').value.result;
  };
  const props = { call_id: 'c', kind: 'mcp', server: 'omd_browse', tool: 'browse', arguments: { command: 'open news.ycombinator.com;  cat | head 5' }, output_lines: 12, status: 'completed', duration_ms: 1234, expanded: false };
  assert.equal(render(props).tree[0].spans.map(span => span.text).join(''), '◍ Browse open news.ycombinator.com; cat | head 5 · ok · 12 lines · 1.2s');
  assert.deepEqual(render({ ...props, expanded: true }).tree, [{ type: 'native' }]);
  assert.deepEqual(render({ ...props, server: 'other' }).tree, [{ type: 'native' }]);
});

test('/browse docks the live browser beside the chat with input bound to the page', () => {
  const calls = [];
  const opened = run('command', '', null, call => {
    calls.push(call);
    if (call.operation === 'process.which') return { found: [{ name: 'node', path: '/usr/bin/node', sha256: 'a'.repeat(64) }] };
    if (call.operation === 'process.start') return { session: call.arguments.session, running: true };
    return { session: 'live1', messages: [], running: true };
  }, 'browse');
  assert.match(opened.value.display, /Browser pane open/);
  const start = calls.find(call => call.operation === 'process.start').arguments;
  assert.equal(start.sandbox, 'none');
  assert.equal(start.raster, 'omd_browse_live');
  assert.equal(start.keys, 'omd_browse_keys');
  assert.equal(calls.at(-1).arguments.send[0].src, bridge);

  const status = run('process_event', { session: 'live1', kind: 'output', bytes: 10 }, opened.state, () => ({ session: 'live1', running: true,
    messages: [{ status: { tab: 't1', title: 'Shop', url: 'http://x/', user: true, reason: 'Sign in' } }] }));
  const view = run('terminal', { ledger: null }, status.state).value;
  assert.equal(view.layout.split, 'horizontal');
  assert.equal(view.layout.children[1].title, 'Browser · your turn');
  const [line, pane] = view.sites['omd_browse/live'].components;
  assert.equal(line.spans.map(span => span.text).join(''), '● your turn t1 Shop — http://x/');
  assert.deepEqual([pane.keys, pane.children[0].type, pane.children[0].pointer], [true, 'raster', true]);

  const stopped = [];
  const closed = run('command', '', status.state, call => stopped.push(call.operation) && { stopped: true }, 'browse');
  assert.deepEqual(stopped, ['process.stop']);
  assert.equal(run('terminal', { ledger: null }, closed.state).value, null);
});
