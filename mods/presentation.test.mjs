import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runnerSync } from '../tests/mod_runner.mjs';

const runner = readFileSync(new URL('../runtime/omd/src/mods/runner.mjs', import.meta.url), 'utf8');
const surface = {
  events: { terminal: 'terminal', channel: 'events', timer: 'events', start: 'lifecycle', resume: 'lifecycle', turn_start: 'lifecycle', turn_end: 'lifecycle', idle: 'lifecycle', tool_result: 'lifecycle', agent_end: 'lifecycle', compaction_end: 'lifecycle', app_notification: 'threads' },
  replacements: [], intercept: { render: 'terminal' }, middleware: [], state: 'store', contracts: 'contracts',
};
const read = (name, file) => readFileSync(new URL(`./first-party/${name}/${file}`, import.meta.url), 'utf8');
const source = name => read(name, 'index.ts');
const assets = name => Object.fromEntries((JSON.parse(read(name, 'mod.json')).assets ?? []).map(asset => [asset, { text: read(name, asset) }]));
function run(name, input) {
  const result = runnerSync({ source: source(name), assets: assets(name), filename: 'index.ts', api: '0.2.0-experimental.5', surface, capabilities: [], settings: {}, state: null, event: 'inspect', ...input });
  assert.ifError(result.error);
  const output = JSON.parse(result.stdout);
  assert.equal(result.status, 0, `${result.stderr}\n${output.error ?? ''}`);
  assert.equal(output.error, undefined, output.error);
  return output;
}

test('model and reasoning lists use bounded generic components', () => {
  const props = { view_id: 'model', title: 'Model', subtitle: 'Choose one', selected: 1, items: [
    { label: 'A', description: null, current: true, disabled: false, order: 0 },
    { label: 'B', description: 'Reasoning model', current: false, disabled: false, order: 1 },
  ] };
  const capabilities = ['terminal', 'events', 'store'];
  const render = (overrides = {}, columns = 40, state = null) => {
    const input = { component: 'list', id: 'model', surface: 'inline', viewport: { columns, rows: 24 }, lifecycle: 'live', owner: null, props: { ...props, ...overrides } };
    return run('omd_model_picker', { capabilities, event: 'intercept', name: '0', payload: { surface: 'render', input, original: input, origin: { caller: 'engine' } }, state });
  };
  const output = render();
  assert.equal(output.registrations.interceptors[0].pattern, 'render');
  const tree = output.value.result.tree;
  assert.equal(tree[0].text, 'oh my diff · Model');
  assert.equal(tree[1].type, 'list');
  assert.equal(tree[1].selected, '1');
  assert.deepEqual(tree[1].rows.map(row => row.value), ['0', '1']);
  assert.match(tree[1].rows[0].spans[0].text, /current/);
  assert.equal(JSON.stringify(tree).includes('Reasoning model'), false);
  assert.match(tree[2].text, /enter/);
  assert.match(render({}, 100).value.result.tree[2].rows[1].spans[0].text, /Reasoning model/);
  assert.equal(render({ items: Array(201).fill(props.items[0]) }).host_call.operation, 'continuation.next');
  assert.equal(render({ view_id: 'unknown' }).host_call.operation, 'continuation.next');
  const profiles = { profiles: [{ name: 'work', model: 'work/gpt', billing: 'included_subscription', available: true }, { name: 'router', model: 'router/claude', billing: 'explicit_paid_api_grant', available: true }], current: 'work' };
  const listed = render({}, 40, profiles).value.result.tree;
  assert.deepEqual(listed.slice(-3, -1).map(row => row.text), ['● work · work/gpt', '○ router · router/claude · paid']);
});

test('logo follows host acceptance and installed identity without persistent task state', () => {
  const identity = { codex_version: '9.8.7', install_profile: 'full', mode: 'omd', mods: { installed: 6, enabled: 2, active: 0 } };
  const capabilities = ['terminal'];
  const presentation = { thread_id: 'fresh-thread', phase: 'fresh' };
  const payload = { event: 'start', identity, presentation, ledger: null };
  const logo = run('omd_logo', { capabilities, event: 'terminal', payload });
  assert.equal(logo.value.session_title_suffix, ' | OMD+');
  assert.equal(logo.value.greeting, '');
  assert.deepEqual(logo.value.welcome, { show_while_composing: true });
  assert.equal(logo.value.sites.welcome.components[0].children[0].spans[1].text, '╭─╮ ╭╮╭╮ ┌─╮');
  assert.match(JSON.stringify(logo.value), /v9.8.7/);
  assert.equal(logo.state, null);
  for (const event of ['idle', 'input_rejected', 'turn_end']) {
    const draft = run('omd_logo', { capabilities, event: 'terminal', payload: { ...payload, event } });
    assert.deepEqual(draft.value.sites, logo.value.sites);
  }
  for (const phase of ['started', 'resumed']) {
    for (const event of ['start', 'turn_start', 'turn_end', 'idle']) {
      const current = run('omd_logo', { capabilities, state: { settled: false }, event: 'terminal', payload: { ...payload, event, presentation: { ...presentation, phase } } });
      assert.deepEqual(current.value.sites, {});
      assert.equal(current.value.session_title_suffix, ' | OMD+');
    }
  }
  const core = run('omd_logo', { capabilities, settings: { icons: 'ascii' }, event: 'terminal', payload: { ...payload, identity: { ...identity, install_profile: 'platform_only', mods: { installed: 20, enabled: 15, active: 15 } } } });
  assert.equal(core.value.session_title_suffix, ' | OMD Core');
  assert.equal(core.value.sites.welcome.components[1].children[0].spans[1].text, '.-. |\\/| |-.');
  const unreported = run('omd_logo', { capabilities, event: 'terminal', payload: { ...payload, identity: undefined, presentation: undefined } });
  assert.equal(unreported.value.session_title_suffix, undefined);
  assert.deepEqual(unreported.value.sites, {});
});

test('workspace uses the current ledger', () => {
  const workspace = run('omd_workspace', { capabilities: ['terminal', 'commands', 'lifecycle', 'store', 'threads', 'config'], event: 'terminal', payload: { event: 'idle', ledger: { thread_id: '1234567890abcdef', cost: null } } });
  assert.equal(workspace.value.sites.sidebar.components[0].title, 'Activity');
  assert.doesNotMatch(JSON.stringify(workspace.value), /1234567890|"schema"/);
  assert.equal(JSON.stringify(workspace.value).includes('No live workers'), false);
  assert.deepEqual(workspace.value.sites.header.components[0].spans.map(span => span.text), ['Ready', '  Tab panels · Enter folds · F6 review · F7 layout']);
  const capabilities = ['terminal', 'commands', 'lifecycle', 'store', 'threads', 'config'];
  const notify = (state, thread, method, params) => run('omd_workspace', { capabilities, state, event: 'app_notification', payload: { method, params, thread_id: thread, coalesced: 0, dropped: 0 } }).state;
  let state = notify(null, 'main', 'thread/settings/updated', { threadSettings: { model: 'gpt-6.1-sol', effort: 'high' } });
  state = notify(state, 'main', 'thread/tokenUsage/updated', { tokenUsage: { last: { totalTokens: 200000 }, modelContextWindow: 258000 } });
  state = notify(state, 'child', 'thread/settings/updated', { threadSettings: { model: 'helper' } });
  const session = run('omd_workspace', { capabilities, state, event: 'terminal', payload: { event: 'idle', ledger: { thread_id: 'main', cost: { settled_task_charge_microusd: 1_500_000 } } } }).value.sites.sidebar.components[0];
  assert.deepEqual(session.children.map(line => [line.text, line.tone]), [['gpt-6.1-sol · high', 'normal'], ['Context 78% of 258k', 'attention'], ['Paid API $1.50', 'muted']]);
});

test('inspector opens from live host status and fails visibly when status is unavailable', () => {
  const capabilities = ['agents', 'commands', 'contracts', 'store', 'terminal', 'events'];
  const receipts = [
    { call: { operation: 'task.status', arguments: null }, value: { ledger: { thread_id: 'thread-1', cost: { settled_task_charge_microusd: 2_000_000 } }, limits: { turns: 4 }, worker_limits: { active: 1 } } },
    { call: { operation: 'contract.status', arguments: null }, value: { status: 'active', active: { id: 'review', version: 2, assurance: 'local' } } },
  ];
  const published = [{ call: { operation: 'events.publish', arguments: { channel: 'refresh', data: null } }, value: { delivered: 1, dropped: 0 } }];
  const opened = run('omd_inspector', { capabilities, event: 'command', name: 'inspect', payload: '', receipts: published });
  assert.equal(opened.state.open, true);
  const refresh = { publisher: 'omd_inspector', channel: 'omd_inspector/refresh', data: null, correlation: null, sequence: 1, dropped: 0 };
  const refreshed = run('omd_inspector', { capabilities, event: 'channel', state: opened.state, payload: refresh, receipts });
  const identity = { codex_version: '0.157.0', install_profile: 'full', mode: 'omd', mods: { installed: 7, enabled: 6, active: 5 } };
  const view = run('omd_inspector', { capabilities, event: 'terminal', state: refreshed.state, payload: { event: 'idle', identity, ledger: null } });
  const children = view.value.sites.dialog.components[0].children;
  assert.match(JSON.stringify(children), /review@2/);
  assert.match(JSON.stringify(children), /5 active/);
  assert.match(JSON.stringify(children), /\$2\.00 paid API/);
  assert.ok(children.every(child => !String(child.text ?? '').includes('{')));
  const closed = run('omd_inspector', { capabilities, event: 'command', name: 'inspect', payload: 'close', state: refreshed.state });
  assert.equal(run('omd_inspector', { capabilities, event: 'terminal', state: closed.state, payload: { event: 'idle', identity, ledger: null } }).value, null);
  const failed = run('omd_inspector', { capabilities, event: 'channel', state: opened.state, payload: refresh, receipts: [
    { call: receipts[0].call, error: 'unavailable' },
    { call: receipts[1].call, error: 'unavailable' },
  ] });
  assert.match(failed.state.error, /unavailable/);
});
