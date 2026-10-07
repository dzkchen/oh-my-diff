import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

const gitArgs = (argv, limit = argv[0] === 'for-each-ref' ? 16384 : 65536) => ({ operation: 'exec.run', arguments: { program: 'git', argv: ['--no-pager', '--literal-pathspecs', '-c', 'core.quotepath=false', '-c', 'color.ui=false', '-c', 'core.fsmonitor=false', ...argv], env: { GIT_OPTIONAL_LOCKS: '0' }, timeout_ms: 10000, max_output_bytes: limit, write: false, network: 'none' } });
const reply = stdout => ({ exit_code: 0, signal: null, stdout, stdout_sha256: createHash('sha256').update(stdout).digest('hex'), stderr: '', stdout_truncated: false, stderr_truncated: false, timed_out: false, duration_ms: 1, program: { path: '/usr/bin/git', sha256: 'd'.repeat(64) }, guards_verified: 0 });
const oid = 'a'.repeat(40);
const other = 'b'.repeat(40);
const status = `## main\0 M important.txt\0?? new.txt\0`;
const gitReceipts = [
  { call: gitArgs(['status', '--porcelain=v1', '-z', '-b', '--untracked-files=all']), value: reply(status) },
  { call: gitArgs(['rev-parse', '--verify', 'HEAD']), value: reply(`${oid}\n`) },
  { call: gitArgs(['log', '--max-count=6', '--format=%H%x00%P%x00%s%x00']), value: reply(`${oid}\0\0initial\0\n`) },
  { call: gitArgs(['for-each-ref', '--format=%(refname:short)', 'refs/heads']), value: reply('main\nfeature\n') },
];

test('Git sidebar bounds a 700-file status view and rejects oversized or truncated status', () => {
  const capabilities = ['commands', 'exec', 'fs.read', 'fs.write', 'store', 'lifecycle', 'terminal', 'events'];
  const many = `## main\0${Array.from({ length: 700 }, (_, index) => `?? file-${String(index).padStart(4, '0')}.txt\0`).join('')}`;
  const statusCall = gitReceipts[0].call;
  const accepted = run('omd_git', { capabilities, event: 'command', name: 'changes', payload: '', receipts: [
    { call: statusCall, value: reply(many) }, ...gitReceipts.slice(1),
  ] });
  assert.equal(accepted.state.total, 700);
  assert.equal(accepted.state.entries.length, 40);
  assert.match(accepted.value.display, /660 more/);
  assert.equal(accepted.calls[0].arguments.max_output_bytes, 65_536);
  const tooMany = `## main\0${Array.from({ length: 1_001 }, (_, index) => `?? file-${String(index).padStart(4, '0')}.txt\0`).join('')}`;
  const rejected = run('omd_git', { capabilities, event: 'command', name: 'changes', payload: '', receipts: [
    { call: statusCall, value: reply(tooMany) }, gitReceipts[1],
  ] });
  assert.match(rejected.value.display, /too many changes to preview safely/);
  const truncated = run('omd_git', { capabilities, event: 'command', name: 'changes', payload: '', receipts: [
    { call: statusCall, value: { ...reply(many), stdout_truncated: true } },
  ] });
  assert.match(truncated.value.display, /safe preview limit/);
  const oversized = run('omd_git', { capabilities, event: 'command', name: 'changes', payload: '', receipts: [
    { call: statusCall, value: reply(`## main\0?? ${'a'.repeat(65_536)}\0`) },
  ] });
  assert.match(oversized.value.display, /too many changes to preview safely/);
});

test('Git status and branch preview use sandboxed reads while protected index writes are denied', () => {
  const capabilities = ['commands', 'exec', 'fs.read', 'fs.write', 'store', 'lifecycle', 'terminal', 'events'];
  const inspected = run('omd_git', { capabilities, event: 'command', name: 'changes', payload: '', receipts: gitReceipts });
  assert.match(inspected.value.display, /important\.txt/);
  const rendered = run('omd_git', { capabilities, event: 'terminal', state: inspected.state, payload: { event: 'idle' } });
  const components = rendered.value.sites.sidebar.components;
  const ids = [];
  const visit = items => items.forEach(item => { if (item.id) ids.push(item.id); if (item.children) visit(item.children); });
  visit(components);
  assert.ok(ids.every(id => /^[a-z0-9_]{1,48}$/.test(id)));
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes('omd_git_unstaged') && ids.includes('omd_git_untracked'));
  assert.equal(inspected.calls.every(call => call.operation === 'exec.run' && call.arguments.write === false && call.arguments.network === 'none'), true);
  const scope = { call: gitArgs(['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'important.txt']), value: reply('important.txt\0') };
  const blocked = run('omd_git', { capabilities, event: 'command', name: 'act', payload: 'stage', state: inspected.state, receipts: [
    gitReceipts[0], gitReceipts[1], scope,
    { call: { operation: 'workspace.check_access', arguments: { paths: ['important.txt'], write: true } }, error: 'workspace_write_permission_denied' },
  ] });
  assert.match(blocked.value.display, /permission_denied/);
  assert.equal(blocked.calls.some(call => call.operation === 'exec.run' && call.arguments.write === true), false);
  const trackedDiscard = run('omd_git', { capabilities, event: 'command', name: 'act', payload: 'discard', state: inspected.state, receipts: [
    ...gitReceipts,
    { call: { operation: 'workspace.stat', arguments: { paths: ['important.txt'], hash: true } }, value: { files: { 'important.txt': { kind: 'file', size: 12, mtime_ms: 1, sha256: 'e'.repeat(64) } } } },
    { call: { operation: 'workspace.check_access', arguments: { paths: ['important.txt'], write: true } }, error: 'workspace_write_permission_denied' },
  ] });
  assert.match(trackedDiscard.value.display, /permission_denied/);
  assert.equal(trackedDiscard.calls.some(call => call.operation === 'workspace.transaction'), false);
  const preview = run('omd_git', { capabilities, event: 'command', name: 'checkout', payload: '', state: inspected.state, receipts: [
    ...gitReceipts,
    { call: gitArgs(['show-ref', '--verify', '--hash', 'refs/heads/feature'], 256), value: reply(`${other}\n`) },
    { call: gitArgs(['diff', '--name-status', '-z', '--no-ext-diff', '--no-textconv', oid, other], 16384), value: reply('M\0important.txt\0') },
  ] });
  assert.equal(preview.state.preview.destination, other);
  assert.equal(preview.calls.filter(call => call.operation === 'exec.run').every(call => call.arguments.write === false), true);
  const moved = run('omd_git', { capabilities, event: 'command', name: 'changes', payload: '', state: preview.state, receipts: [
    ...gitReceipts,
    { call: gitArgs(['show-ref', '--verify', '--hash', 'refs/heads/feature'], 256), value: reply(`${'c'.repeat(40)}\n`) },
  ] });
  assert.equal(moved.state.preview, null);
});

test('stage binds exact path access, status, HEAD, index, and file content to one write', () => {
  const capabilities = ['commands', 'exec', 'fs.read', 'fs.write', 'store', 'lifecycle', 'terminal', 'events'];
  const inspected = run('omd_git', { capabilities, event: 'command', name: 'changes', payload: '', receipts: gitReceipts });
  const fileHash = 'e'.repeat(64);
  const scope = { call: gitArgs(['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'important.txt']), value: reply('important.txt\0') };
  const index = { call: gitArgs(['ls-files', '-s', '-z']), value: reply(`100644 ${'f'.repeat(40)} 0\timportant.txt\0`) };
  const file = { call: { operation: 'workspace.stat', arguments: { paths: ['important.txt'], hash: true } }, value: { files: { 'important.txt': { kind: 'file', size: 12, mtime_ms: 1, sha256: fileHash } } } };
  const content = { call: gitArgs(['hash-object', '--no-filters', '--', 'important.txt'], 256), value: reply(`${'c'.repeat(40)}\n`) };
  const guards = [gitReceipts[0], gitReceipts[1], index, content].map(item => ({ program: 'git', sha256: 'd'.repeat(64), argv: item.call.arguments.argv, env: { GIT_OPTIONAL_LOCKS: '0' }, stdout_sha256: item.value.stdout_sha256 }));
  const write = { operation: 'exec.run', arguments: { program: 'git', sha256: 'd'.repeat(64), argv: ['--no-pager', '--literal-pathspecs', '-c', 'core.quotepath=false', '-c', 'color.ui=false', '-c', 'core.fsmonitor=false', 'add', '-A', '--', 'important.txt'], timeout_ms: 30000, max_output_bytes: 65536, write: true, network: 'none', guards, required_access: { write: ['important.txt'] } } };
  const staged = run('omd_git', { capabilities, event: 'command', name: 'act', payload: 'stage', state: inspected.state, receipts: [
    gitReceipts[0], gitReceipts[1], scope,
    { call: { operation: 'workspace.check_access', arguments: { paths: ['important.txt'], write: true } }, value: { paths: ['important.txt'], write: true } },
    index, file, content,
    { call: write, value: { ...reply(''), guards_verified: 4 } },
    { call: gitReceipts[0].call, value: reply(`## main\0M  important.txt\0?? new.txt\0`) }, ...gitReceipts.slice(1),
  ] });
  assert.match(staged.value.display, /staged important\.txt/);
  assert.equal(staged.calls.find(call => call.arguments.write === true && call.operation === 'exec.run').arguments.guards.length, 4);
  const stale = run('omd_git', { capabilities, event: 'command', name: 'act', payload: 'stage', state: inspected.state, receipts: [
    { call: gitReceipts[0].call, value: reply(`## main\0 M important.txt\0`) }, gitReceipts[1],
  ] });
  assert.match(stale.value.display, /Changed since/);
  assert.equal(stale.calls.some(call => call.arguments.write === true), false);
});

test('commit preview fingerprints the full index and rejects stale index views', () => {
  const capabilities = ['commands', 'exec', 'fs.read', 'fs.write', 'store', 'lifecycle', 'terminal', 'events'];
  const stagedReceipts = [{ call: gitReceipts[0].call, value: reply(`## main\0M  important.txt\0?? new.txt\0`) }, ...gitReceipts.slice(1)];
  const inspected = run('omd_git', { capabilities, event: 'command', name: 'changes', payload: '', receipts: stagedReceipts });
  const message = run('omd_git', { capabilities, event: 'command', name: 'message', payload: 'Reviewable commit', state: inspected.state });
  const indexCall = gitArgs(['ls-files', '-s', '-z']);
  const index = `100644 ${'e'.repeat(40)} 0\timportant.txt\0`;
  const preview = run('omd_git', { capabilities, event: 'command', name: 'commit', payload: '', state: message.state, receipts: [
    ...stagedReceipts,
    stagedReceipts[0], stagedReceipts[1],
    { call: { operation: 'workspace.check_access', arguments: { paths: ['important.txt'], write: true } }, value: { paths: ['important.txt'], write: true } },
    { call: indexCall, value: reply(index) },
  ] });
  assert.equal(preview.state.preview.kind, 'commit');
  assert.deepEqual(preview.state.preview.paths, ['important.txt']);
  assert.equal(preview.state.preview.guards.at(-1).stdout_sha256, createHash('sha256').update(index).digest('hex'));
  assert.equal(preview.calls.filter(call => call.operation === 'exec.run').every(call => call.arguments.write === false), true);
  const blocked = run('omd_git', { capabilities, event: 'command', name: 'confirm', payload: '', state: preview.state, receipts: [
    stagedReceipts[0], stagedReceipts[1],
    { call: { operation: 'exec.run', arguments: { program: 'git', sha256: 'd'.repeat(64), argv: ['--no-pager', '--literal-pathspecs', '-c', 'core.quotepath=false', '-c', 'color.ui=false', '-c', 'core.fsmonitor=false', 'commit', '--file=-', '--cleanup=strip'], stdin: 'Reviewable commit', timeout_ms: 120000, max_output_bytes: 65536, write: true, network: 'none', guards: preview.state.preview.guards, required_access: { write: ['important.txt'] } } }, error: 'exec_guard_changed' },
    stagedReceipts[0], stagedReceipts[1],
  ] });
  assert.match(blocked.value.display, /exec_guard_changed/);
  assert.equal(blocked.calls.some(call => call.operation === 'exec.run' && call.arguments.write === true), true);
  const writeCall = blocked.calls.find(call => call.operation === 'exec.run' && call.arguments.write === true);
  const rejectedHook = run('omd_git', { capabilities, event: 'command', name: 'confirm', payload: '', state: preview.state, receipts: [
    stagedReceipts[0], stagedReceipts[1],
    { call: writeCall, value: { ...reply(''), guards_verified: 3, exit_code: 1, stderr: 'hook denied: review required\n' } },
    stagedReceipts[0], stagedReceipts[1],
  ] });
  assert.match(rejectedHook.value.display, /Commit did not complete; hook denied: review required; preview index/);
  const timedOut = run('omd_git', { capabilities, event: 'command', name: 'confirm', payload: '', state: preview.state, receipts: [
    stagedReceipts[0], stagedReceipts[1],
    { call: writeCall, value: { ...reply(''), guards_verified: 3, timed_out: true } },
    stagedReceipts[0], stagedReceipts[1],
  ] });
  assert.match(timedOut.value.display, /Git command timed out; preview index/);
  const cancelled = run('omd_git', { capabilities, event: 'command', name: 'confirm', payload: '', state: preview.state, receipts: [
    stagedReceipts[0], stagedReceipts[1], { call: writeCall, error: 'exec_cancelled' },
    stagedReceipts[0], stagedReceipts[1],
  ] });
  assert.match(cancelled.value.display, /exec_cancelled; preview index/);
  const treeCall = gitArgs(['ls-tree', '-r', '--full-tree', '-z', '--format=%(objectmode) %(objectname) 0%x09%(path)', 'HEAD']);
  const changedByHook = run('omd_git', { capabilities, event: 'command', name: 'confirm', payload: '', state: preview.state, receipts: [
    stagedReceipts[0], stagedReceipts[1],
    { call: writeCall, value: { ...reply('[main] commit\n'), guards_verified: 3 } },
    { call: treeCall, value: reply(`100644 ${'f'.repeat(40)} 0\timportant.txt\0${`100644 ${'c'.repeat(40)} 0\textra.txt\0`}`) },
    { call: stagedReceipts[0].call, value: reply('## main\0?? new.txt\0') },
    { call: stagedReceipts[1].call, value: reply(`${other}\n`) },
    { call: stagedReceipts[2].call, value: reply(`${other}\0${oid}\0commit\0\n`) },
    stagedReceipts[3],
  ] });
  assert.match(changedByHook.value.display, /committed tree could not be matched/);
  assert.equal(changedByHook.state.head.oid, other);
  const stale = run('omd_git', { capabilities, event: 'command', name: 'changes', payload: '', state: preview.state, receipts: [
    ...stagedReceipts,
    { call: indexCall, value: reply(`100644 ${'f'.repeat(40)} 0\timportant.txt\0`) },
  ] });
  assert.equal(stale.state.preview, null);
});

test('commit confirmation lists every staged path and refuses an oversized exact preview', () => {
  const capabilities = ['commands', 'exec', 'fs.read', 'fs.write', 'store', 'lifecycle', 'terminal', 'events'];
  const paths = Array.from({ length: 12 }, (_, index) => `staged-${String(index).padStart(2, '0')}.txt`);
  const stagedStatus = `## main\0${paths.map(path => `M  ${path}\0`).join('')}`;
  const statusReceipts = [{ call: gitReceipts[0].call, value: reply(stagedStatus) }, ...gitReceipts.slice(1)];
  const inspected = run('omd_git', { capabilities, event: 'command', name: 'changes', receipts: statusReceipts });
  const message = run('omd_git', { capabilities, event: 'command', name: 'message', payload: 'Exact preview', state: inspected.state });
  const check = { call: { operation: 'workspace.check_access', arguments: { paths, write: true } }, value: { paths, write: true } };
  const index = { call: gitArgs(['ls-files', '-s', '-z']), value: reply(paths.map(path => `100644 ${'e'.repeat(40)} 0\t${path}\0`).join('')) };
  const preview = run('omd_git', { capabilities, event: 'command', name: 'commit', state: message.state, receipts: [
    ...statusReceipts, statusReceipts[0], statusReceipts[1], check, index,
  ] });
  assert.equal(preview.state.preview.kind, 'commit');
  for (const path of paths) assert.match(preview.state.preview.lines.join('\n'), new RegExp(path));
  assert.doesNotMatch(preview.state.preview.lines.join('\n'), /more/);
  const commitView = run('omd_git', { capabilities, event: 'terminal', state: preview.state, payload: { event: 'idle' } });
  const commitPane = commitView.value.sites.dialog.components[0].children[0];
  assert.equal(commitPane.type, 'pane');
  assert.match(commitPane.children[0].text, /staged-11\.txt/);
  const huge = `${'x'.repeat(4_100)}.txt`;
  const hugeStatus = [{ call: gitReceipts[0].call, value: reply(`## main\0M  ${huge}\0`) }, ...gitReceipts.slice(1)];
  const hugeInspected = run('omd_git', { capabilities, event: 'command', name: 'changes', receipts: hugeStatus });
  const hugeMessage = run('omd_git', { capabilities, event: 'command', name: 'message', payload: 'Exact preview', state: hugeInspected.state });
  const denied = run('omd_git', { capabilities, event: 'command', name: 'commit', state: hugeMessage.state, receipts: [
    ...hugeStatus, hugeStatus[0], hugeStatus[1],
    { call: { operation: 'workspace.check_access', arguments: { paths: [huge], write: true } }, value: { paths: [huge], write: true } },
    { call: gitArgs(['ls-files', '-s', '-z']), value: reply(`100644 ${'e'.repeat(40)} 0\t${huge}\0`) },
  ] });
  assert.match(denied.value.display, /exact commit preview limit/);
  assert.equal(denied.state.preview, null);
  assert.equal(denied.calls.some(call => call.operation === 'exec.run' && call.arguments.write === true), false);
});

test('untracked discard requires exact status and an atomic outside-repository backup', () => {
  const capabilities = ['commands', 'exec', 'fs.read', 'fs.write', 'store', 'lifecycle', 'terminal', 'events'];
  const inspected = run('omd_git', { capabilities, event: 'command', name: 'changes', payload: '', receipts: gitReceipts });
  const selected = run('omd_git', { capabilities, event: 'command', name: 'choose', payload: 'new.txt', state: inspected.state });
  const fileHash = 'e'.repeat(64);
  const candidate = run('omd_git', { capabilities, event: 'command', name: 'act', payload: 'discard', state: selected.state, receipts: [
    ...gitReceipts,
    { call: { operation: 'workspace.stat', arguments: { paths: ['new.txt'], hash: true } }, value: { files: { 'new.txt': { kind: 'file', size: 7, mtime_ms: 1, sha256: fileHash } } } },
  ] });
  assert.equal(candidate.state.preview.kind, 'discard');
  assert.deepEqual(candidate.state.preview.expected, { 'new.txt': fileHash });
  const stale = run('omd_git', { capabilities, event: 'command', name: 'confirm', payload: '', state: candidate.state, receipts: [
    { call: gitReceipts[0].call, value: reply(`## main\0 M important.txt\0`) },
    gitReceipts[1],
  ] });
  assert.match(stale.value.display, /Changed since/);
  assert.equal(stale.calls.some(call => call.operation === 'workspace.transaction'), false);
  const confirmed = run('omd_git', { capabilities, event: 'command', name: 'confirm', payload: '', state: candidate.state, receipts: [
    gitReceipts[0], gitReceipts[1],
    { call: { operation: 'workspace.transaction', arguments: { expected: { 'new.txt': fileHash }, deletes: ['new.txt'], backup: true } }, value: { files: { 'new.txt': null }, backup: { reference: 'f'.repeat(64), sha256: 'f'.repeat(64) } } },
    { call: gitReceipts[0].call, value: reply(`## main\0 M important.txt\0`) },
    ...gitReceipts.slice(1),
  ] });
  assert.match(confirmed.value.display, /discarded new\.txt; backup/);
  assert.equal(confirmed.calls.filter(call => call.operation === 'workspace.transaction').length, 1);
  assert.deepEqual(confirmed.state.backup, { path: 'new.txt', reference: { reference: 'f'.repeat(64), sha256: 'f'.repeat(64) }, expected: null });
  const backup = confirmed.state.backup.reference;
  const restored = run('omd_git', { capabilities, event: 'command', name: 'restore', payload: '', state: confirmed.state, receipts: [
    { call: { operation: 'workspace.restore', arguments: { backup, expected: { 'new.txt': null } } }, value: { files: { 'new.txt': fileHash } } },
    ...gitReceipts,
  ] });
  assert.match(restored.value.display, /restored new\.txt/);
  assert.equal(restored.state.backup, null);
  const conflicting = run('omd_git', { capabilities, event: 'command', name: 'restore', payload: '', state: confirmed.state, receipts: [
    { call: { operation: 'workspace.restore', arguments: { backup, expected: { 'new.txt': null } } }, error: 'stale: new.txt exists' },
  ] });
  assert.match(conflicting.value.display, /stale/);
  assert.deepEqual(conflicting.state.backup, confirmed.state.backup);
});

test('tracked discard keeps a scoped backup and rejects a changed precondition', () => {
  const capabilities = ['commands', 'exec', 'fs.read', 'fs.write', 'store', 'lifecycle', 'terminal', 'events'];
  const inspected = run('omd_git', { capabilities, event: 'command', name: 'changes', payload: '', receipts: gitReceipts });
  const beforeHash = 'e'.repeat(64);
  const restoredHash = createHash('sha256').update('original\n').digest('hex');
  const restored = reply(`${restoredHash}\n`);
  const fingerprint = read('omd_git', 'fingerprint.mjs');
  const before = { call: { operation: 'workspace.stat', arguments: { paths: ['important.txt'], hash: true } }, value: { files: { 'important.txt': { kind: 'file', size: 12, mtime_ms: 1, sha256: beforeHash } } } };
  const access = { call: { operation: 'workspace.check_access', arguments: { paths: ['important.txt'], write: true } }, value: { paths: ['important.txt'], write: true } };
  const preview = run('omd_git', { capabilities, event: 'command', name: 'act', payload: 'discard', state: inspected.state, receipts: [
    ...gitReceipts, before, access,
    { call: gitArgs(['diff', '--binary', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', '--', 'important.txt']), value: reply('diff --git a/important.txt b/important.txt\n') },
    { call: gitArgs(['ls-files', '-s', '-z']), value: reply(`100644 ${'f'.repeat(40)} 0\timportant.txt\0`) },
    { call: { operation: 'exec.run', arguments: { program: 'node', argv: ['--input-type=module', '-', '/usr/bin/git', 'd'.repeat(64), ...gitArgs(['cat-file', '--filters', '--path=important.txt', 'f'.repeat(40)]).arguments.argv], stdin: fingerprint, timeout_ms: 10000, max_output_bytes: 65536, write: false, network: 'none' } }, value: restored },
    { call: gitArgs(['hash-object', '--no-filters', '--', 'important.txt'], 256), value: reply(`${'c'.repeat(40)}\n`) },
  ] });
  assert.equal(preview.state.preview.tracked, true);
  assert.equal(preview.state.preview.guards.length, 4);
  const backup = { reference: 'b'.repeat(64), sha256: 'b'.repeat(64) };
  const stale = run('omd_git', { capabilities, event: 'command', name: 'confirm', payload: '', state: preview.state, receipts: [
    gitReceipts[0], gitReceipts[1],
    { call: { operation: 'workspace.backup', arguments: { expected: { 'important.txt': beforeHash } } }, error: 'stale expected version for important.txt' },
  ] });
  assert.match(stale.value.display, /stale/);
  assert.equal(stale.calls.some(call => call.operation === 'exec.run' && call.arguments.write === true), false);
  const written = run('omd_git', { capabilities, event: 'command', name: 'confirm', payload: '', state: preview.state, receipts: [
    gitReceipts[0], gitReceipts[1],
    { call: { operation: 'workspace.backup', arguments: { expected: { 'important.txt': beforeHash } } }, value: { backup } },
    { call: { operation: 'exec.run', arguments: { program: 'git', sha256: 'd'.repeat(64), argv: ['--no-pager', '--literal-pathspecs', '-c', 'core.quotepath=false', '-c', 'color.ui=false', '-c', 'core.fsmonitor=false', 'restore', '--worktree', '--', 'important.txt'], timeout_ms: 30000, max_output_bytes: 65536, write: true, network: 'none', guards: preview.state.preview.guards, required_access: { write: ['important.txt'] } } }, value: { ...reply(''), guards_verified: 4 } },
    { call: gitReceipts[0].call, value: reply('## main\0?? new.txt\0') }, ...gitReceipts.slice(1),
  ] });
  assert.match(written.value.display, /discarded important\.txt; backup/);
  assert.equal(written.state.backup.expected, restoredHash);
  assert.deepEqual(written.calls.find(call => call.operation === 'exec.run' && call.arguments.write === true).arguments.required_access, { write: ['important.txt'] });
});

test('clean branch switch binds destination and affected paths and preserves ignored files', () => {
  const capabilities = ['commands', 'exec', 'fs.read', 'fs.write', 'store', 'lifecycle', 'terminal', 'events'];
  const clean = [
    { call: gitReceipts[0].call, value: reply('## main\0') },
    gitReceipts[1], gitReceipts[2], gitReceipts[3],
  ];
  const inspected = run('omd_git', { capabilities, event: 'command', name: 'changes', payload: '', receipts: clean });
  const target = { call: gitArgs(['show-ref', '--verify', '--hash', 'refs/heads/feature'], 256), value: reply(`${other}\n`) };
  const delta = { call: gitArgs(['diff', '--name-status', '-z', '--no-ext-diff', '--no-textconv', oid, other], 16384), value: reply('M\0important.txt\0') };
  const version = { 'important.txt': 'a'.repeat(64) };
  const preview = run('omd_git', { capabilities, event: 'command', name: 'checkout', payload: '', state: inspected.state, receipts: [
    ...clean, target, delta,
    { call: { operation: 'workspace.check_access', arguments: { paths: ['important.txt'], write: true } }, value: { paths: ['important.txt'], write: true } },
    { call: { operation: 'workspace.stat', arguments: { paths: ['important.txt'], hash: true } }, value: { files: { 'important.txt': { kind: 'file', size: 10, mtime_ms: 1, sha256: version['important.txt'] } } } },
  ] });
  assert.deepEqual(preview.state.preview.expected, version);
  assert.equal(preview.state.preview.guards.length, 4);
  const backup = { reference: 'b'.repeat(64), sha256: 'b'.repeat(64) };
  const write = { operation: 'exec.run', arguments: { program: 'git', sha256: 'd'.repeat(64), argv: ['--no-pager', '--literal-pathspecs', '-c', 'core.quotepath=false', '-c', 'color.ui=false', '-c', 'core.fsmonitor=false', 'switch', '--no-overwrite-ignore', '--', 'feature'], timeout_ms: 30000, max_output_bytes: 65536, write: true, network: 'none', guards: preview.state.preview.guards, required_access: { write: ['important.txt'] } } };
  const switched = run('omd_git', { capabilities, event: 'command', name: 'confirm', payload: '', state: preview.state, receipts: [
    clean[0], clean[1], target,
    { call: { operation: 'workspace.backup', arguments: { expected: version } }, value: { backup } },
    { call: write, value: { ...reply(''), guards_verified: 4 } },
    { call: clean[0].call, value: reply('## feature\0') },
    { call: clean[1].call, value: reply(`${other}\n`) },
    { call: clean[2].call, value: reply(`${other}\0${oid}\0feature\0\n`) },
    clean[3],
  ] });
  assert.match(switched.value.display, /switched to feature; backup/);
  assert.equal(switched.state.head.branch, 'feature');
  const stale = run('omd_git', { capabilities, event: 'command', name: 'confirm', payload: '', state: preview.state, receipts: [
    clean[0], clean[1], { call: target.call, value: reply(`${'c'.repeat(40)}\n`) },
  ] });
  assert.match(stale.value.display, /Changed since/);
  assert.equal(stale.calls.some(call => call.operation === 'workspace.backup'), false);
});

test('switch confirmation lists every affected path and refuses an oversized exact preview', () => {
  const capabilities = ['commands', 'exec', 'fs.read', 'fs.write', 'store', 'lifecycle', 'terminal', 'events'];
  const clean = [{ call: gitReceipts[0].call, value: reply('## main\0') }, ...gitReceipts.slice(1)];
  const inspected = run('omd_git', { capabilities, event: 'command', name: 'changes', receipts: clean });
  const target = { call: gitArgs(['show-ref', '--verify', '--hash', 'refs/heads/feature'], 256), value: reply(`${other}\n`) };
  const paths = Array.from({ length: 12 }, (_, index) => `changed-${String(index).padStart(2, '0')}.txt`);
  const diffCall = gitArgs(['diff', '--name-status', '-z', '--no-ext-diff', '--no-textconv', oid, other], 16384);
  const preview = run('omd_git', { capabilities, event: 'command', name: 'checkout', state: inspected.state, receipts: [
    ...clean, target, { call: diffCall, value: reply(paths.map(path => `M\0${path}\0`).join('')) },
    { call: { operation: 'workspace.check_access', arguments: { paths, write: true } }, value: { paths, write: true } },
    { call: { operation: 'workspace.stat', arguments: { paths, hash: true } }, value: { files: Object.fromEntries(paths.map(path => [path, { kind: 'file', sha256: 'a'.repeat(64) }])) } },
  ] });
  assert.equal(preview.state.preview.kind, 'switch');
  for (const path of paths) assert.match(preview.state.preview.lines.join('\n'), new RegExp(path));
  assert.doesNotMatch(preview.state.preview.lines.join('\n'), /more/);
  const switchView = run('omd_git', { capabilities, event: 'terminal', state: preview.state, payload: { event: 'idle' } });
  const switchPane = switchView.value.sites.dialog.components[0].children[0];
  assert.equal(switchPane.type, 'pane');
  assert.match(switchPane.children[0].text, /changed-11\.txt/);
  const huge = `${'x'.repeat(4_100)}.txt`;
  const denied = run('omd_git', { capabilities, event: 'command', name: 'checkout', state: inspected.state, receipts: [
    ...clean, target, { call: diffCall, value: reply(`M\0${huge}\0`) },
    { call: { operation: 'workspace.check_access', arguments: { paths: [huge], write: true } }, value: { paths: [huge], write: true } },
    { call: { operation: 'workspace.stat', arguments: { paths: [huge], hash: true } }, value: { files: { [huge]: { kind: 'file', sha256: 'a'.repeat(64) } } } },
  ] });
  assert.match(denied.value.display, /exact switch preview limit/);
  assert.equal(denied.state.preview, null);
  assert.equal(denied.calls.some(call => call.operation === 'exec.run' && call.arguments.write === true), false);
});

test('Git hooks run on commit; rejection preserves HEAD and mutation changes the committed tree', () => {
  const root = mkdtempSync(join(tmpdir(), 'omd-git-hooks-'));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
  const git = (args, input) => spawnSync('git', ['--no-pager', '--literal-pathspecs', '-c', 'core.quotepath=false', '-c', 'color.ui=false', '-c', 'core.fsmonitor=false', ...args], { cwd: root, env, input, encoding: 'utf8' });
  try {
    assert.equal(git(['init', '-q']).status, 0);
    assert.equal(git(['config', 'user.name', 'Fixture']).status, 0);
    assert.equal(git(['config', 'user.email', 'fixture@example.invalid']).status, 0);
    writeFileSync(join(root, 'tracked.txt'), 'initial\n');
    assert.equal(git(['add', '--', 'tracked.txt']).status, 0);
    assert.equal(git(['commit', '-q', '-m', 'initial']).status, 0);
    const prior = git(['rev-parse', 'HEAD']).stdout.trim();
    writeFileSync(join(root, 'tracked.txt'), 'changed\n');
    assert.equal(git(['add', '--', 'tracked.txt']).status, 0);
    const hook = join(root, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, '#!/bin/sh\nprintf "hook denied: review required\\n" >&2\nexit 1\n');
    chmodSync(hook, 0o755);
    const denied = git(['commit', '--file=-', '--cleanup=strip'], 'reviewed\n');
    assert.notEqual(denied.status, 0);
    assert.match(denied.stderr, /hook denied: review required/);
    assert.equal(git(['rev-parse', 'HEAD']).stdout.trim(), prior);
    assert.match(git(['status', '--porcelain=v1']).stdout, /tracked\.txt/);
    writeFileSync(hook, '#!/bin/sh\nprintf "hook permitted\\n" >&2\nexit 0\n');
    chmodSync(hook, 0o755);
    const permitted = git(['commit', '--file=-', '--cleanup=strip'], 'reviewed\n');
    assert.equal(permitted.status, 0, permitted.stderr);
    assert.match(permitted.stderr, /hook permitted/);
    assert.notEqual(git(['rev-parse', 'HEAD']).stdout.trim(), prior);
    writeFileSync(join(root, 'tracked.txt'), 'changed again\n');
    assert.equal(git(['add', '--', 'tracked.txt']).status, 0);
    const previewIndex = createHash('sha256').update(git(['ls-files', '-s', '-z']).stdout).digest('hex');
    writeFileSync(hook, '#!/bin/sh\nprintf "extra from hook\\n" > extra.txt\ngit add -- extra.txt\n');
    chmodSync(hook, 0o755);
    const mutated = git(['commit', '--file=-', '--cleanup=strip'], 'reviewed\n');
    assert.equal(mutated.status, 0, mutated.stderr);
    const committedTree = createHash('sha256').update(git(['ls-tree', '-r', '--full-tree', '-z', '--format=%(objectmode) %(objectname) 0%x09%(path)', 'HEAD']).stdout).digest('hex');
    assert.notEqual(committedTree, previewIndex);
    assert.equal(git(['branch', 'feature']).status, 0);
    assert.equal(git(['switch', '--no-overwrite-ignore', '--', 'feature']).status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
