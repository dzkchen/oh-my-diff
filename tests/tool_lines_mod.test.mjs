import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runnerSync } from './mod_runner.mjs';

const mod = new URL('../mods/first-party/omd_tool_lines/', import.meta.url);
const source = readFileSync(new URL('index.ts', mod), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('mod.json', mod), 'utf8'));
const surface = { events: {}, replacements: [], middleware: [], state: 'store', contracts: 'contracts', intercept: { render: 'terminal' } };

function render(props, columns = 100) {
  const input = { component: 'tool_call', id: props.call_id, surface: 'fullscreen', viewport: { columns, rows: 24 }, lifecycle: 'final', owner: null,
    props: { expanded: false, duration_ms: null, ...props } };
  const reply = JSON.parse(runnerSync({ source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, surface, state: null,
    settings: {}, event: 'intercept', name: '0', payload: { surface: 'render', input, original: input, origin: { caller: 'engine' } }, hook_budget_ms: 1000 }).stdout);
  if (reply.error) assert.fail(reply.error);
  return reply;
}

const lines = props => render(props).value.result.tree.map(node => {
  assert.equal(node.type, 'line');
  return node.spans.map(span => span.text).join('');
});

const exec = { call_id: 'c1', kind: 'exec', command: 'cargo test -p codex-omd', parsed: [{ type: 'unknown', cmd: 'cargo test -p codex-omd' }], status: 'completed',
  exit_code: 0, duration_ms: 41_300, output_lines: 214, output_tail: 'ok', user_shell: false };

test('tool lines draw every agent tool kind as one marked line per call', () => {
  assert.deepEqual(lines(exec), ['• Shell cargo test -p codex-omd · ok · 214 lines · 41.3s']);
  assert.deepEqual(lines({ ...exec, duration_ms: 0 }), ['• Shell cargo test -p codex-omd · ok · 214 lines']);
  assert.deepEqual(lines({ ...exec, status: 'failed', exit_code: 101, output_lines: 1, duration_ms: 900 }), ['✗ Shell cargo test -p codex-omd · exit 101 · 1 line · 900ms']);
  assert.deepEqual(lines({ ...exec, status: 'running', exit_code: null, duration_ms: null }), ['• Shell cargo test -p codex-omd · running']);
  const read = { ...exec, call_id: 'r1', command: 'cat a.rs', parsed: [{ type: 'read', cmd: 'cat a.rs', name: 'a.rs', path: '/repo/a.rs' }], output_lines: 3, duration_ms: 12 };
  const search = { ...exec, call_id: 'r2', command: 'rg foo src', parsed: [{ type: 'search', cmd: 'rg foo src', query: 'foo', path: 'src' }], status: 'failed', exit_code: 1, output_lines: 0, duration_ms: 5 };
  assert.deepEqual(lines({ call_id: 'r1', kind: 'explore', status: 'failed', duration_ms: 17, calls: [read, search] }),
    ['• Read a.rs · ok · 3 lines · 12ms', '✗ Search foo in src · exit 1 · 0 lines · 5ms']);
  assert.deepEqual(lines({ call_id: 'p1', kind: 'patch', status: 'completed', files: [{ path: 'src/lib.rs', change: 'update', added: 9, removed: 3 }], error: null }),
    ['• Edit src/lib.rs · +9 −3']);
  assert.deepEqual(lines({ call_id: 'p2', kind: 'patch', status: 'completed', files: [{ path: 'a', change: 'add', added: 2, removed: 0 }, { path: 'b', change: 'delete', added: 0, removed: 4 }], error: null }),
    ['• Edit 2 files · +2 −4']);
  assert.deepEqual(lines({ call_id: 'p3', kind: 'patch', status: 'failed', files: [], error: 'hunk 2 did not apply\nmore' }), ['✗ Patch hunk 2 did not apply · failed']);
  assert.deepEqual(lines({ call_id: 'w1', kind: 'web_search', status: 'completed', action: 'search', query: 'ratatui wrap' }), ['• Web search ratatui wrap · ok']);
  assert.deepEqual(lines({ call_id: 'a1', kind: 'agent', tool: 'spawn_agent', status: 'completed', agents: ['Ada'], prompt: 'check the docs' }), ['• Spawn agent Ada · check the docs · ok']);
  assert.deepEqual(lines({ call_id: 'm1', kind: 'mcp', server: 'docs', tool: 'search', arguments: { query: 'render hooks', limit: 3 }, status: 'completed', duration_ms: 220, output_lines: 3 }),
    ['• docs.search query: render hooks, limit: 3 · ok · 3 lines · 220ms']);
  assert.deepEqual(lines({ call_id: 'd1', kind: 'dynamic', tool: 'mod_notes_save', arguments: 'draft', status: 'interrupted', duration_ms: null, output_lines: null }),
    ['• mod_notes_save draft · interrupted']);
  assert.deepEqual(lines({ call_id: 'i1', kind: 'image', tool: 'view_image', status: 'completed', path: 'shot.png', prompt: null }), ['• View image shot.png · ok']);
});

test('tool lines leave expanded rows and user shell commands native and stay within the width and span limits', () => {
  for (const props of [{ ...exec, expanded: true }, { ...exec, user_shell: true }]) {
    assert.equal(render(props).host_call.operation, 'continuation.next');
  }
  for (const [command, columns, cells] of [[`echo ${'é'.repeat(400)}`, 60, 1], [`echo ${'x'.repeat(400)}`, 400, 1], [`echo ${'日'.repeat(100)}`, 80, 2]]) {
    const long = render({ ...exec, command }, columns).value.result.tree[0];
    const text = long.spans.map(span => span.text).join('');
    assert.ok([...text].length <= 256 && [...text].length + (cells - 1) * [...text].filter(char => char === command.at(-1)).length <= columns, text);
    assert.ok(long.spans.every(span => Buffer.byteLength(span.text) <= 256));
    assert.ok(Buffer.byteLength(long.label) <= 128);
  }
});
