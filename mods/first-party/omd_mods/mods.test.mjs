import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { callback } from '../../../tests/mod_runner.mjs';

const root = new URL('./', import.meta.url);
const source = readFileSync(new URL('index.ts', root), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('mod.json', root), 'utf8'));
const mod = (id, extra = {}) => ({ id, scope: 'user', description: null, installed: true, enabled: true, effective: true, pending: null, failed: null, blocked: null,
  version: '1.0.0', source: 'npm', compatible: true, conflicts: [], settings: {}, settings_schema: null, ...extra });
const logo = mod('omd_logo', { description: 'The OMD mark', settings: { size: 'big' }, settings_schema: { properties: { size: { type: 'string', enum: ['big', 'small'] }, 'max tokens': { type: 'number' } } } });

function invoke(payload, { packages = [logo], generation = 1, ui_state, ...answers } = {}) {
  const calls = [];
  const reply = callback({ source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, state: null, settings: {}, event: 'command', name: 'mods', payload, ui_state }, call => {
    calls.push(call);
    if (call.operation in answers) return answers[call.operation](call.arguments);
    if (call.operation === 'packages.list') return { generation, reload_error: null, packages };
    if (call.operation === 'packages.index') return { packages: [] };
    if (call.operation === 'terminal.panel') return { shown: true };
    assert.fail(`unexpected host call ${call.operation}`);
  });
  assert.equal(reply.error, undefined, reply.error);
  return { ...reply, calls, ui: reply.ui_state === undefined ? null : JSON.parse(reply.ui_state), panels: calls.filter(call => call.operation === 'terminal.panel').map(call => call.arguments) };
}
const operations = reply => reply.calls.map(call => call.operation);

test('a toggle leaves redrawing to the host after a change and corrects the panel when it is declined', () => {
  const opened = invoke('');
  assert.deepEqual(opened.panels[0].tabs.map(tab => tab.id), ['installed', 'settings', 'directory']);
  assert.equal(opened.panels[0].items.find(item => item.id === 'user:omd_logo').value, true);
  const declined = invoke('panel user user:omd_logo false', { ui_state: opened.ui, 'packages.apply': () => ({ status: 'declined' }) });
  assert.deepEqual(operations(declined), ['packages.list', 'packages.apply', 'packages.list', 'terminal.panel']);
  assert.equal(declined.panels[0].items.find(item => item.id === 'user:omd_logo').value, true);
  assert.match(declined.panels[0].subtitle, /Turning off Logo was declined/);
  const applied = invoke('panel user user:omd_logo false', { ui_state: opened.ui, 'packages.apply': () => ({ status: 'applied', generation: 2 }) });
  assert.deepEqual(operations(applied), ['packages.list', 'packages.apply']);
  const redrawn = invoke('panel user', { ui_state: applied.ui, generation: 2, packages: [{ ...logo, enabled: false, effective: false }] });
  assert.match(redrawn.panels[0].subtitle, /0 of 1 on\nLogo is off from your next message/);
});

test('Apply sends the generation the change was reviewed at', () => {
  const reviewed = invoke('update omd_logo', { 'packages.preview': () => ({ action: 'update', id: 'omd_logo', changes: {}, grants_added: [] }) });
  let sent;
  invoke('apply', { ui_state: reviewed.ui, generation: 2, 'packages.apply': args => { sent = args; return { status: 'declined' }; } });
  assert.equal(sent.expected_generation, 1);
});

test('a panel action after its UI state was cleared keeps the chosen scope and finds the directory again', () => {
  const index = () => ({ packages: [{ id: 'omd_preview', description: 'Previews', latest: '1.2.0', installed: null, versions: [{ version: '1.2.0', blocked: null }] }] });
  let previewed;
  invoke('panel project get:omd_preview', { ui_state: null, 'packages.index': index, 'packages.preview': args => { previewed = args; return { action: 'install', id: 'omd_preview', changes: {}, grants_added: [] }; } });
  assert.deepEqual([previewed.reference, previewed.scope], ['omd_preview@1.2.0', 'project']);
});

test('a mod panel skips settings it cannot address, tells same-named mods apart and reports a removed mod', () => {
  const opened = invoke('omd_logo', { packages: [logo, mod('logo')] });
  assert.equal(opened.panels[0].title, 'omd_logo (user)');
  assert.deepEqual(opened.panels[0].items.map(item => item.id), ['enabled', 'setting:size', 'do:update', 'do:rollback', 'do:remove']);
  const removed = invoke('mod user:omd_gone', { packages: [logo] });
  assert.equal(removed.panels[0].title, 'Gone (user)');
  assert.match(removed.panels[0].subtitle, /Gone is no longer installed/);
});
