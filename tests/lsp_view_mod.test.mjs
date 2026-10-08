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
const surface = { events: { terminal: 'terminal', channel: 'events' }, replacements: [], middleware: [], state: 'store', contracts: 'contracts' };

test('code-intelligence view asks omd_lsp_sync through a channel hop, jumps to results and shows server state', () => {
  const repository = realpathSync(mkdtempSync(join(tmpdir(), 'omd-lsp-view-')));
  writeFileSync(join(repository, 'box.py'), 'value = 1\nclass Box:\n    size = 2\n');
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
    assert.deepEqual(request, { channel: 'request', data: { op: 'definition', path: 'box.py', line: 2, character: 7 } });
    state = invoke(state, 'channel', { publisher: 'omd_lsp_view', channel: 'omd_lsp_view/request', data: request.data, correlation: null, sequence: 1, dropped: 0 }).state;
    assert.deepEqual(calls.at(-1), { operation: 'mods.service', args: { name: 'omd.lsp', method: 'query', input: request.data } });
    let view = invoke(state, 'terminal', { event: 'redraw', ledger: null }).value.sites.dialog.components;
    assert.deepEqual(view[1], { type: 'slot' });
    assert.deepEqual(view[0].children[1].rows, [{ value: 'box.py:2', label: 'box.py:2:7', spans: [{ text: 'box.py:2:7' }] }]);
    assert.deepEqual(view[0].children[1].action, { command: 'omd_lsp_view:lsp', args: 'open' });
    state = invoke(state, 'command', 'open box.py:2', 'lsp').state;
    assert.deepEqual(state.view.excerpt, { path: 'box.py', line: 2, start: 1, lines: ['value = 1', 'class Box:', '    size = 2'], errors: [] });
    assert.deepEqual(calls.at(-1).args, { channel: 'request', data: { op: 'diagnostics', path: 'box.py' } });
    answer = { status: 'ready', message: '', items: [{ label: 'box.py:3:5 bad size', value: 'box.py:3' }, { label: 'other.py:1:1 broken', value: 'other.py:1' }], text: null, action: 'open' };
    state = invoke(state, 'channel', { publisher: 'omd_lsp_view', channel: 'omd_lsp_view/request', data: calls.at(-1).args.data, correlation: null, sequence: 2, dropped: 0 }).state;
    state = invoke(state, 'channel', { publisher: 'omd_lsp_sync', channel: 'omd_lsp_sync/status', correlation: null, sequence: 1, dropped: 0,
      data: [{ adapter: 'python', server: 'pylsp', status: 'synced', reason: '', documents: 2, errors: ['box.py:3:5 bad size'] }, { adapter: 'rust', server: null, status: 'fallback', reason: 'rust_server_absent', documents: 0, errors: [] }] }).state;
    state = invoke(state, 'command', 'pane', 'lsp').state;
    const sites = invoke(state, 'terminal', { event: 'redraw', ledger: null }).value.sites;
    view = sites['omd_lsp_view/lsp'].components;
    assert.equal(view[0].text, 'box.py:2 · 1 errors');
    assert.deepEqual(view[2].action, { command: 'omd_lsp_view:lsp', args: 'editor box.py:2' });
    assert.deepEqual(view[4].rows.map(row => row.value), ['box.py:3']);
    assert.deepEqual(sites.sidebar.components[1].children.map(item => item.text), ['python pylsp · 2 open · 1 errors', '  box.py:3:5 bad size', 'rust: rust server absent']);
    assert.deepEqual(invoke(state, 'command', 'back', 'lsp').state.view.items.map(item => item.value), ['box.py:2']);
    answer = 'service_provider_missing: omd.lsp';
    state = invoke(state, 'channel', { publisher: 'omd_lsp_view', channel: 'omd_lsp_view/request', data: request.data, correlation: null, sequence: 3, dropped: 0 }).state;
    assert.equal(state.view.message, 'enable omd_lsp_sync, which runs the language servers');
    state = invoke(state, 'command', 'close', 'lsp').state;
    assert.deepEqual(Object.keys(invoke(state, 'terminal', { event: 'redraw', ledger: null }).value.sites), ['sidebar']);
    state = invoke(state, 'channel', { publisher: 'omd_lsp_sync', channel: 'omd_lsp_sync/status', data: [], correlation: null, sequence: 2, dropped: 0 }).state;
    assert.equal(invoke(state, 'terminal', { event: 'redraw', ledger: null }).value, null);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});
