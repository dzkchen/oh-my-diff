import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const runner = readFileSync(new URL('../runtime/omd/src/mods/runner.mjs', import.meta.url), 'utf8');
const root = new URL('../mods/', import.meta.url);
const surface = {
  events: { start: 'lifecycle', context: 'context', compaction: 'compaction', compaction_end: 'lifecycle', terminal: 'terminal' },
  replacements: ['compaction'], middleware: [], state: 'store', contracts: 'contracts',
};

function packageFile(name, file) {
  return new URL(`${name}/${file}`, root);
}

function run(name, event, payload = null, state = null, settings = {}, capabilities = null, command = '') {
  const manifest = JSON.parse(readFileSync(packageFile(name, 'mod.json'), 'utf8'));
  assert.equal(manifest.api, '0.2.0-experimental.5');
  const source = readFileSync(packageFile(name, 'index.ts'), 'utf8');
  const result = spawnSync(process.execPath,
    ['--no-warnings', '--experimental-vm-modules', '--input-type=module', '--eval', runner],
    { input: JSON.stringify({ source, filename: `${name}/index.ts`, api: manifest.api,
      capabilities: capabilities ?? manifest.capabilities, surface, state, settings, event,
      name: command, payload, hook_budget_ms: 1000 }), encoding: 'utf8', timeout: 5000 });
  assert.ifError(result.error);
  const reply = JSON.parse(result.stdout);
  if (reply.error) assert.fail(reply.error);
  return reply;
}

test('session anchor retains a bounded compaction count and never invents old checkpoint details', () => {
  const name = 'first-party/omd_session_anchor';
  const started = run(name, 'start', {});
  assert.equal(started.state, 0);
  const empty = run(name, 'context', { thread_id: 'task', turn_id: 'before', ledger: { thread_id: 'task', cost: null } }, started.state);
  assert.equal(empty.value, null);
  const decision = run(name, 'compaction', { token_limit: 20000, context_window: 30000 }, started.state);
  assert.equal(decision.value.threshold, 16000);
  assert.match(decision.value.prompt, /Revalidate each detail against available evidence/);
  const compacted = run(name, 'compaction_end', { turn_id: 'one', trigger: 'auto' }, started.state);
  assert.equal(compacted.state, 1);
  const resumed = run(name, 'context', { thread_id: 'task', turn_id: 'after', ledger: { thread_id: 'task', cost: null },
    checkpoint: { remaining_work: ['unverified legacy claim'] } }, compacted.state);
  assert.match(resumed.value.text, /Verified host checkpoint fields are unavailable/);
  assert.doesNotMatch(resumed.value.text, /unverified legacy claim/);
  const repeated = run(name, 'compaction_end', { turn_id: 'two', trigger: 'manual' }, resumed.state);
  assert.match(run(name, 'context', { thread_id: 'task', turn_id: 'reload', ledger: { thread_id: 'task', cost: null } }, repeated.state).value.text,
    /Checkpoint 2 compactions/);
});

test('session anchor requires the current store capability', () => {
  const name = 'first-party/omd_session_anchor';
  const manifest = JSON.parse(readFileSync(packageFile(name, 'mod.json'), 'utf8'));
  assert.ok(manifest.capabilities.includes('store'));
  assert.ok(!manifest.capabilities.includes('state'));
  const source = readFileSync(packageFile(name, 'index.ts'), 'utf8');
  const result = spawnSync(process.execPath,
    ['--no-warnings', '--experimental-vm-modules', '--input-type=module', '--eval', runner],
    { input: JSON.stringify({ source, filename: `${name}/index.ts`, api: manifest.api,
      capabilities: manifest.capabilities.filter(value => value !== 'store'), surface, state: null,
      settings: {}, event: 'start', payload: {} }), encoding: 'utf8', timeout: 5000 });
  assert.match(JSON.parse(result.stdout).error, /capability_denied: store/);
});

test('optional theme uses current terminal patches and respects explicit palette settings', () => {
  const name = 'optional/omd_theme';
  const defaultView = run(name, 'terminal', { event: 'idle', ledger: null }).value;
  assert.equal(defaultView.foreground, 255);
  assert.equal(defaultView.background, 235);
  assert.equal(defaultView.theme.icons, 'ascii');
  const paper = run(name, 'terminal', { event: 'idle', ledger: null }, null, { palette: 'paper', symbols: 'unicode' }).value;
  assert.equal(paper.foreground, 234);
  assert.equal(paper.background, 231);
  assert.equal(paper.theme.icons, 'unicode');
  assert.equal(paper.theme.accent, '#005f9e');
});

test('optional focus flow toggles only completed tool presentation and retains state', () => {
  const name = 'optional/omd_focus_flow';
  const initial = run(name, 'terminal', { event: 'idle', ledger: null });
  assert.deepEqual(initial.value, { completed_tools: 'compact', keybindings: { F9: { command: 'omd_focus_flow:toggle' } } });
  const toggled = run(name, 'command', null, initial.state, {}, null, 'toggle');
  assert.match(toggled.value.display, /expanded/);
  assert.equal(toggled.state, false);
  const resumed = run(name, 'terminal', { event: 'idle', ledger: null }, toggled.state);
  assert.equal(resumed.value.completed_tools, 'normal');
  const restored = run(name, 'command', null, resumed.state, {}, null, 'toggle');
  assert.match(restored.value.display, /compact/);
  assert.equal(restored.state, true);
});
