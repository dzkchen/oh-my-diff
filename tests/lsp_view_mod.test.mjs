import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runnerSync } from './mod_runner.mjs';

const runner = readFileSync(new URL('../runtime/omd/src/mods/runner.mjs', import.meta.url), 'utf8');
const mod = new URL('../mods/first-party/omd_lsp_view/', import.meta.url);
const source = readFileSync(new URL('index.ts', mod), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('mod.json', mod), 'utf8'));
const surface = { events: { terminal: 'terminal', component_event: 'terminal', channel: 'events' }, replacements: [], middleware: [], state: 'store', contracts: 'contracts' };

test('code-intelligence view asks omd_lsp_sync through a channel hop, jumps to results and shows server state', () => {
  const repository = realpathSync(mkdtempSync(join(tmpdir(), 'omd-lsp-view-')));
  writeFileSync(join(repository, 'box.py'), 'value = 1\nclass Box:\n    size = 2\n');
  writeFileSync(join(repository, 'tab.py'), 'a\tb\r\n\u0001c\n');
  const calls = [];
  let answer = { status: 'ready', message: '', items: [{ label: 'box.py:2:7', value: 'box.py:2' }], text: null, action: 'open' };
  const invoke = (state, event, payload, name) => {
    const receipts = [];
    for (;;) {
      const request = { source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, state, settings: {}, event, name, payload, receipts, surface, hook_budget_ms: 10000 };
      const output = JSON.parse(runnerSync(request).stdout);
      if (output.error) throw new Error(output.error);
      if (!output.host_call) return output;
      const { operation, arguments: args } = output.host_call;
      calls.push({ operation, args });
      if (operation === 'mods.service' && typeof answer === 'string') receipts.push({ call: output.host_call, error: answer });
      else if (operation === 'exec.run') {
        const run = spawnSync(args.program, args.argv ?? [], { cwd: repository, encoding: 'utf8' });
        receipts.push({ call: output.host_call, value: { exit_code: run.status, stdout: run.stdout, stderr: run.stderr } });
      } else receipts.push({ call: output.host_call, value: operation === 'mods.service' ? answer : { delivered: 1, dropped: 0 } });
    }
  };
  try {
    let state = invoke(null, 'command', 'definition box.py:2:7', 'lsp').state;
    assert.equal(state.view.status, 'working');
    const request = calls.at(-1).args;
    assert.deepEqual(request, { channel: 'request', data: { op: 'definition', path: 'box.py', line: 2, character: 7, request: 1 } });
    state = invoke(state, 'channel', { publisher: 'omd_lsp_view', channel: 'omd_lsp_view/request', data: request.data, correlation: null, sequence: 1, dropped: 0 }).state;
    assert.deepEqual(calls.at(-1), { operation: 'mods.service', args: { name: 'omd.lsp', method: 'query', input: { op: 'definition', path: 'box.py', line: 2, character: 7 } } });
    let view = invoke(state, 'terminal', { event: 'redraw', ledger: null }).value.sites.dialog.components;
    assert.deepEqual(view[1], { type: 'slot' });
    assert.deepEqual(view[0].children[1].rows, [{ value: 'box.py:2', label: 'box.py:2:7', spans: [{ text: 'box.py:2:7' }] }]);
    assert.deepEqual(view[0].children[1].action, { command: 'omd_lsp_view:lsp', args: 'open' });
    assert.equal(invoke(state, 'component_event', { component: view[0].children[1].id, events: [{ key: 'Esc' }] }).state.view, null);
    assert.equal(invoke(state, 'terminal', { event: 'startup' }).state.view, null);
    state = invoke(state, 'command', 'open box.py:2', 'lsp').state;
    assert.deepEqual(state.view.excerpt, { path: 'box.py', line: 2, start: 1, lines: ['value = 1', 'class Box:', '    size = 2'], errors: [] });
    assert.deepEqual(calls.at(-1).args, { channel: 'request', data: { op: 'diagnostics', path: 'box.py', request: 2 } });
    answer = { status: 'ready', message: '', items: [{ label: 'box.py:3:5 bad size', value: 'box.py:3' }, { label: 'other.py:1:1 broken', value: 'other.py:1' }], text: null, action: 'open' };
    state = invoke(state, 'channel', { publisher: 'omd_lsp_view', channel: 'omd_lsp_view/request', data: calls.at(-1).args.data, correlation: null, sequence: 2, dropped: 0 }).state;
    state = invoke(state, 'channel', { publisher: 'omd_lsp_sync', channel: 'omd_lsp_sync/status', correlation: null, sequence: 1, dropped: 0,
      data: [{ adapter: 'python', server: 'pylsp', status: 'synced', reason: '', documents: 2, errors: ['box.py:3:5 bad size'] }, { adapter: 'rust', server: null, status: 'fallback', reason: 'rust_server_absent', documents: 0, errors: [] }] }).state;
    state = invoke(state, 'command', 'pane', 'lsp').state;
    assert.equal(invoke(state, 'terminal', { event: 'startup' }).state.view.pane, true);
    let patch = invoke(state, 'terminal', { event: 'redraw', ledger: null }).value;
    assert.deepEqual([Object.keys(patch), Object.keys(patch.sites)], [['sites'], ['above_composer']]);
    assert.equal(patch.sites.above_composer.components[1].type, 'box');
    view = patch.sites.above_composer.components[1].children;
    assert.equal(view[0].text, 'box.py:2 · 1 errors');
    assert.deepEqual(view[2].rows.map(row => row.value), ['box.py:3']);
    assert.deepEqual(view[3].children.map(button => button.action.args), ['editor box.py:2', 'back', 'pane', 'close']);
    state = invoke(state, 'command', 'servers', 'lsp').state;
    const servers = invoke(state, 'terminal', { event: 'redraw', ledger: null }).value.sites.above_composer.components[2].children;
    const text = box => box.children.map(child => child.spans ? child.spans.map(span => span.text).join('') : child.text);
    assert.deepEqual(servers.map(text), [['python pylsp', '2 open · 1 errors', 'box.py:3:5 bad size'], ['rust rust server absent']]);
    assert.deepEqual(invoke(state, 'command', 'back', 'lsp').state.view.items.map(item => item.value), ['box.py:2']);
    answer = { status: 'ready', message: '', items: [{ label: 'first', value: 'box.py:2' }, { label: 'second', value: 'box.py:2' }, { label: 'é'.repeat(300), value: 'box.py:3' }], text: `a\r\nb${'x'.repeat(20000)}${'"\\'.repeat(10000)}`, action: 'open' };
    state = invoke(state, 'command', 'back', 'lsp').state;
    state = invoke(state, 'command', 'definition box.py:2:7', 'lsp').state;
    state = invoke(state, 'channel', { publisher: 'omd_lsp_view', channel: 'omd_lsp_view/request', data: calls.at(-1).args.data, correlation: null, sequence: 4, dropped: 0 }).state;
    view = invoke(state, 'terminal', { event: 'redraw', ledger: null }).value.sites.above_composer.components[1].children;
    const details = JSON.stringify(view[1].children[0].text).length - 2;
    assert.ok(details <= 32_768 && details > 32_760, String(details));
    assert.ok(!view[1].children[0].text.includes('\r'));
    assert.deepEqual(view[2].rows.map(row => row.value), ['box.py:2', 'box.py:3']);
    assert.ok(Buffer.byteLength(view[2].rows[1].label) <= 256);
    state = invoke(state, 'command', 'open tab.py:1', 'lsp').state;
    view = invoke(state, 'terminal', { event: 'redraw', ledger: null }).value.sites.above_composer.components[1].children;
    assert.deepEqual(view[1].lines.map(line => line[1].text), ['a    b', 'c']);
    answer = 'service_provider_missing: omd.lsp';
    state = invoke(state, 'channel', { publisher: 'omd_lsp_view', channel: 'omd_lsp_view/request', data: calls.at(-1).args.data, correlation: null, sequence: 3, dropped: 0 }).state;
    assert.equal(state.view.message, 'enable omd_lsp_sync, which runs the language servers');
    state = invoke(state, 'command', 'close', 'lsp').state;
    const closed = invoke(state, 'terminal', { event: 'redraw', ledger: null }).value;
    assert.deepEqual([Object.keys(closed), Object.keys(closed.sites)], [['sites'], ['above_composer']]);
    state = invoke(state, 'channel', { publisher: 'omd_lsp_sync', channel: 'omd_lsp_sync/status', data: [], correlation: null, sequence: 2, dropped: 0 }).state;
    assert.equal(invoke(state, 'terminal', { event: 'redraw', ledger: null }).value.sites.above_composer.components[1].children[0].text, 'No server running; /lsp open PATH starts one');
    state = invoke(state, 'command', 'servers', 'lsp').state;
    assert.equal(invoke(state, 'terminal', { event: 'redraw', ledger: null }).value, null);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test('answers for a closed view or a superseded request are dropped without asking the language server', () => {
  const services = [];
  const invoke = (state, event, payload, name) => {
    const receipts = [];
    for (;;) {
      const output = JSON.parse(runnerSync({ source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, state, settings: {}, event, name, payload, receipts, surface, hook_budget_ms: 10000 }).stdout);
      if (output.error) throw new Error(output.error);
      if (!output.host_call) return output;
      if (output.host_call.operation === 'mods.service') services.push(output.host_call.arguments.input);
      receipts.push({ call: output.host_call, value: output.host_call.operation === 'mods.service' ? { status: 'ready', message: '', items: [], text: `answer ${output.host_call.arguments.input.line}`, action: 'open' } : { delivered: 1, dropped: 0 } });
    }
  };
  const command = (state, text) => invoke(state, 'command', text, 'lsp').state;
  const deliver = (state, data) => invoke(state, 'channel', { publisher: 'omd_lsp_view', channel: 'omd_lsp_view/request', data, correlation: null, sequence: 1, dropped: 0 }).state;
  const opened = command(null, 'hover box.py:1');
  const asked = { op: 'hover', path: 'box.py', line: 1, character: 1, request: 1 };
  const closed = command(opened, 'close');
  assert.equal(deliver(closed, asked).view, null);
  const second = command(closed, 'hover box.py:2');
  const third = command(second, 'hover box.py:3');
  assert.deepEqual(deliver(third, { ...asked, line: 2, request: 2 }).view, third.view);
  assert.deepEqual(services, []);
  const answered = deliver(third, { ...asked, line: 3, request: 3 });
  assert.deepEqual([answered.view.title, answered.view.text, answered.view.request], ['hover box.py:3', 'answer 3', 0]);
  assert.deepEqual(services, [{ op: 'hover', path: 'box.py', line: 3, character: 1 }]);
  assert.deepEqual(deliver(answered, { ...asked, line: 3, request: 3 }), answered);
});
