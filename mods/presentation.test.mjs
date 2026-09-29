import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const runner = readFileSync(new URL('../runtime/omd/src/mods/runner.mjs', import.meta.url), 'utf8');
const surface = {
  events: { terminal: 'terminal', list: 'terminal', selection: 'terminal', selection_result: 'terminal', start: 'lifecycle', resume: 'lifecycle', turn_start: 'lifecycle', turn_end: 'lifecycle', idle: 'lifecycle', tool_result: 'lifecycle', agent_end: 'lifecycle', compaction_end: 'lifecycle' },
  replacements: ['terminal', 'list', 'selection'], middleware: [], state: 'store', contracts: 'contracts',
};
const source = name => readFileSync(new URL(`./${name === 'omd_theme' ? 'optional' : 'first-party'}/${name}/index.ts`, import.meta.url), 'utf8');
function run(name, input) {
  const result = spawnSync(process.execPath, ['--no-warnings', '--experimental-vm-modules', '--input-type=module', '--eval', runner], {
    input: JSON.stringify({ source: source(name), filename: 'index.ts', api: '0.2.0-experimental.3', surface, capabilities: [], settings: {}, state: null, event: 'inspect', ...input }),
    encoding: 'utf8', timeout: 5000,
  });
  assert.ifError(result.error);
  const output = JSON.parse(result.stdout);
  assert.equal(result.status, 0, `${result.stderr}\n${output.error ?? ''}`);
  assert.equal(output.error, undefined, output.error);
  return output;
}

test('model and reasoning lists use bounded generic components', () => {
  const payload = { view_id: 'model', title: 'Model', subtitle: 'Choose one', width: 40, selected: 1, items: [
    { label: 'A', description: null, current: true, disabled: false, order: 0 },
    { label: 'B', description: 'Reasoning model', current: false, disabled: false, order: 1 },
  ] };
  const output = run('omd_model_picker', { capabilities: ['terminal'], event: 'list', payload });
  assert.deepEqual(output.registrations.replacements, ['list']);
  assert.equal(output.value[0].text, 'oh my diff · Model');
  assert.equal(output.value[1].type, 'list');
  assert.equal(output.value[1].selected, '1');
  assert.deepEqual(output.value[1].rows.map(row => row.value), ['0', '1']);
  assert.match(output.value[1].rows[0].spans[0].text, /current/);
  assert.equal(JSON.stringify(output.value).includes('Reasoning model'), false);
  assert.match(output.value[2].text, /enter/);
  const wide = run('omd_model_picker', { capabilities: ['terminal'], event: 'list', payload: { ...payload, width: 100 } });
  assert.match(wide.value[2].rows[1].spans[0].text, /Reasoning model/);
  assert.equal(run('omd_model_picker', { capabilities: ['terminal'], event: 'list', payload: { ...payload, items: Array(201).fill(payload.items[0]) } }).value, null);
  assert.equal(run('omd_model_picker', { capabilities: ['terminal'], event: 'list', payload: { ...payload, view_id: 'unknown' } }).value, null);
});

test('optional theme owns width-preserving Unicode input glyphs', () => {
  const payload = { event: 'idle', ledger: null };
  const ascii = run('omd_theme', { capabilities: ['terminal'], event: 'terminal', payload });
  assert.deepEqual(ascii.value.theme.glyphs, {});
  const unicode = run('omd_theme', { capabilities: ['terminal'], settings: { symbols: 'unicode' }, event: 'terminal', payload });
  assert.deepEqual(unicode.value.theme.glyphs, { '===': '≡  ', '->': '→ ', '<=': '≤ ' });
});

test('copy-on-highlight checks source and length before host clipboard action', () => {
  const capabilities = ['terminal', 'commands', 'store'];
  const state = run('omd_selection_copy', { capabilities, event: 'command', name: 'policy', payload: 'sources composer,pager' }).state;
  const limited = run('omd_selection_copy', { capabilities, state, event: 'command', name: 'policy', payload: 'min 5' }).state;
  assert.equal(run('omd_selection_copy', { capabilities, state: limited, event: 'selection', payload: { source: 'transcript', chars: 8, lines: 1 } }).value, null);
  assert.equal(run('omd_selection_copy', { capabilities, state: limited, event: 'selection', payload: { source: 'composer', chars: 4, lines: 1 } }).value, null);
  assert.deepEqual(run('omd_selection_copy', { capabilities, state: limited, event: 'selection', payload: { source: 'composer', chars: 5, lines: 1 } }).value, { copy: true });
  const reported = run('omd_selection_copy', { capabilities, state: limited, event: 'selection_result', payload: { source: 'composer', chars: 5, lines: 1, copied: false, reason: 'clipboard_failed' } });
  assert.equal(reported.state.last, 'copy failed');
  const tooShort = run('omd_selection_copy', { capabilities, state: limited, event: 'selection_result', payload: { source: 'composer', chars: 4, lines: 1, copied: false, reason: 'declined' } });
  assert.equal(tooShort.state.last, 'copy too short');
  assert.match(tooShort.state.detail, /too short.*composer/);
  const offHere = run('omd_selection_copy', { capabilities, state: limited, event: 'selection_result', payload: { source: 'transcript', chars: 8, lines: 1, copied: false, reason: 'declined' } });
  assert.equal(offHere.state.last, 'copy off here');
  const unclear = run('omd_selection_copy', { capabilities, state: limited, event: 'selection_result', payload: { source: 'composer', chars: 8, lines: 1, copied: false, reason: 'declined' } });
  assert.equal(unclear.state.last, 'copy skipped');
});

test('logo compacts after a completed turn while workspace uses the current ledger', () => {
  const identity = { codex_version: '0.157.0', install_profile: 'full', mode: 'omd', mods: { installed: 6, enabled: 2, active: 2 } };
  const capabilities = ['terminal', 'store'];
  const logo = run('omd_logo', { capabilities, event: 'terminal', payload: { event: 'start', identity, ledger: null } });
  assert.match(logo.value.sites.header.components[0].children[1].label, /OMD enabled/);
  const updatedLogo = run('omd_logo', { capabilities, event: 'terminal', payload: { event: 'idle', identity, ledger: null } });
  assert.equal(updatedLogo.value.sites.header.components[0].children[0].spans.at(-1).text, 'oh my diff');
  const completed = run('omd_logo', { capabilities, event: 'terminal', payload: { event: 'turn_end', identity, ledger: null } });
  assert.equal(completed.state.settled, true);
  assert.equal(completed.value.sites.header.components.length, 2);
  assert.match(completed.value.sites.header.components[0].children[0].label, /Full OMD/);
  const later = run('omd_logo', { capabilities, state: completed.state, event: 'terminal', payload: { event: 'idle', identity, ledger: null } });
  assert.equal(later.value.sites.header.components.length, 2);
  const newSession = run('omd_logo', { capabilities, state: completed.state, event: 'terminal', payload: { event: 'start', identity, ledger: null } });
  assert.equal(newSession.state.settled, false);
  assert.equal(newSession.value.sites.header.components[0].id, 'omd_logo_mark');
  const workspace = run('omd_workspace', { capabilities: ['terminal', 'commands', 'lifecycle', 'store'], event: 'terminal', payload: { event: 'idle', ledger: { thread_id: '1234567890abcdef', cost: null } } });
  assert.equal(workspace.value.sites.sidebar.components[0].title, 'Session');
  assert.equal(JSON.stringify(workspace.value).includes('No live workers'), false);
});

test('inspector opens from live host status and fails visibly when status is unavailable', () => {
  const capabilities = ['agents', 'commands', 'contracts', 'store', 'terminal'];
  const receipts = [
    { call: { operation: 'task.status', arguments: null }, value: { ledger: { thread_id: 'thread-1', cost: { observed: 2 } }, limits: { turns: 4 }, worker_limits: { active: 1 } } },
    { call: { operation: 'contract.status', arguments: null }, value: { status: 'active', active: { id: 'review', version: 2, assurance: 'local' } } },
  ];
  const opened = run('omd_inspector', { capabilities, event: 'command', name: 'omd', payload: '', receipts });
  assert.equal(opened.state.open, true);
  const identity = { codex_version: '0.157.0', install_profile: 'full', mode: 'omd', mods: { installed: 7, enabled: 6, active: 5 } };
  const view = run('omd_inspector', { capabilities, event: 'terminal', state: opened.state, payload: { event: 'idle', identity, ledger: null } });
  const children = view.value.sites.dialog.components[0].children;
  assert.match(JSON.stringify(children), /review@2/);
  assert.match(JSON.stringify(children), /5 active/);
  const closed = run('omd_inspector', { capabilities, event: 'command', name: 'close', payload: '', state: opened.state });
  assert.equal(run('omd_inspector', { capabilities, event: 'terminal', state: closed.state, payload: { event: 'idle', identity, ledger: null } }).value, null);
  const failed = run('omd_inspector', { capabilities, event: 'command', name: 'open', payload: '', receipts: [
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
  const capabilities = ['commands', 'exec', 'fs.read', 'fs.write', 'store', 'lifecycle', 'terminal'];
  const many = `## main\0${Array.from({ length: 700 }, (_, index) => `?? file-${String(index).padStart(4, '0')}.txt\0`).join('')}`;
  const statusCall = gitReceipts[0].call;
  const accepted = run('omd_git', { capabilities, event: 'command', name: 'status', payload: '', receipts: [
    { call: statusCall, value: reply(many) }, ...gitReceipts.slice(1),
  ] });
  assert.equal(accepted.state.total, 700);
  assert.equal(accepted.state.entries.length, 40);
  assert.match(accepted.value.display, /660 more/);
  assert.equal(accepted.calls[0].arguments.max_output_bytes, 65_536);
  const tooMany = `## main\0${Array.from({ length: 1_001 }, (_, index) => `?? file-${String(index).padStart(4, '0')}.txt\0`).join('')}`;
  const rejected = run('omd_git', { capabilities, event: 'command', name: 'status', payload: '', receipts: [
    { call: statusCall, value: reply(tooMany) }, gitReceipts[1],
  ] });
  assert.match(rejected.value.display, /too many changes to preview safely/);
  const truncated = run('omd_git', { capabilities, event: 'command', name: 'status', payload: '', receipts: [
    { call: statusCall, value: { ...reply(many), stdout_truncated: true } },
  ] });
  assert.match(truncated.value.display, /safe preview limit/);
  const oversized = run('omd_git', { capabilities, event: 'command', name: 'status', payload: '', receipts: [
    { call: statusCall, value: reply(`## main\0?? ${'a'.repeat(65_536)}\0`) },
  ] });
  assert.match(oversized.value.display, /too many changes to preview safely/);
});

test('Git status and branch preview use sandboxed reads while protected index writes are denied', () => {
  const capabilities = ['commands', 'exec', 'fs.read', 'fs.write', 'store', 'lifecycle', 'terminal'];
  const inspected = run('omd_git', { capabilities, event: 'command', name: 'status', payload: '', receipts: gitReceipts });
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
  const blocked = run('omd_git', { capabilities, event: 'command', name: 'stage', payload: '', state: inspected.state, receipts: [
    gitReceipts[0], gitReceipts[1], scope,
    { call: { operation: 'workspace.check_access', arguments: { paths: ['important.txt'], write: true } }, error: 'workspace_write_permission_denied' },
  ] });
  assert.match(blocked.value.display, /permission_denied/);
  assert.equal(blocked.calls.some(call => call.operation === 'exec.run' && call.arguments.write === true), false);
  const trackedDiscard = run('omd_git', { capabilities, event: 'command', name: 'discard', payload: '', state: inspected.state, receipts: [
    ...gitReceipts,
    { call: { operation: 'workspace.stat', arguments: { paths: ['important.txt'], hash: true } }, value: { files: { 'important.txt': { kind: 'file', size: 12, mtime_ms: 1, sha256: 'e'.repeat(64) } } } },
    { call: { operation: 'workspace.check_access', arguments: { paths: ['important.txt'], write: true } }, error: 'workspace_write_permission_denied' },
  ] });
  assert.match(trackedDiscard.value.display, /permission_denied/);
  assert.equal(trackedDiscard.calls.some(call => call.operation === 'workspace.transaction'), false);
  const preview = run('omd_git', { capabilities, event: 'command', name: 'switch', payload: '', state: inspected.state, receipts: [
    ...gitReceipts,
    { call: gitArgs(['show-ref', '--verify', '--hash', 'refs/heads/feature'], 256), value: reply(`${other}\n`) },
    { call: gitArgs(['diff', '--name-status', '-z', '--no-ext-diff', '--no-textconv', oid, other], 16384), value: reply('M\0important.txt\0') },
  ] });
  assert.equal(preview.state.preview.destination, other);
  assert.equal(preview.calls.filter(call => call.operation === 'exec.run').every(call => call.arguments.write === false), true);
  const moved = run('omd_git', { capabilities, event: 'command', name: 'status', payload: '', state: preview.state, receipts: [
    ...gitReceipts,
    { call: gitArgs(['show-ref', '--verify', '--hash', 'refs/heads/feature'], 256), value: reply(`${'c'.repeat(40)}\n`) },
  ] });
  assert.equal(moved.state.preview, null);
});

test('stage binds exact path access, status, HEAD, index, and file content to one write', () => {
  const capabilities = ['commands', 'exec', 'fs.read', 'fs.write', 'store', 'lifecycle', 'terminal'];
  const inspected = run('omd_git', { capabilities, event: 'command', name: 'status', payload: '', receipts: gitReceipts });
  const fileHash = 'e'.repeat(64);
  const scope = { call: gitArgs(['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'important.txt']), value: reply('important.txt\0') };
  const index = { call: gitArgs(['ls-files', '-s', '-z']), value: reply(`100644 ${'f'.repeat(40)} 0\timportant.txt\0`) };
  const file = { call: { operation: 'workspace.stat', arguments: { paths: ['important.txt'], hash: true } }, value: { files: { 'important.txt': { kind: 'file', size: 12, mtime_ms: 1, sha256: fileHash } } } };
  const content = { call: gitArgs(['hash-object', '--no-filters', '--', 'important.txt'], 256), value: reply(`${'c'.repeat(40)}\n`) };
  const guards = [gitReceipts[0], gitReceipts[1], index, content].map(item => ({ program: 'git', sha256: 'd'.repeat(64), argv: item.call.arguments.argv, env: { GIT_OPTIONAL_LOCKS: '0' }, stdout_sha256: item.value.stdout_sha256 }));
  const write = { operation: 'exec.run', arguments: { program: 'git', sha256: 'd'.repeat(64), argv: ['--no-pager', '--literal-pathspecs', '-c', 'core.quotepath=false', '-c', 'color.ui=false', '-c', 'core.fsmonitor=false', 'add', '-A', '--', 'important.txt'], timeout_ms: 30000, max_output_bytes: 65536, write: true, network: 'none', guards, required_access: { write: ['important.txt'] } } };
  const staged = run('omd_git', { capabilities, event: 'command', name: 'stage', payload: '', state: inspected.state, receipts: [
    gitReceipts[0], gitReceipts[1], scope,
    { call: { operation: 'workspace.check_access', arguments: { paths: ['important.txt'], write: true } }, value: { paths: ['important.txt'], write: true } },
    index, file, content,
    { call: write, value: { ...reply(''), guards_verified: 4 } },
    { call: gitReceipts[0].call, value: reply(`## main\0M  important.txt\0?? new.txt\0`) }, ...gitReceipts.slice(1),
  ] });
  assert.match(staged.value.display, /staged important\.txt/);
  assert.equal(staged.calls.find(call => call.arguments.write === true && call.operation === 'exec.run').arguments.guards.length, 4);
  const stale = run('omd_git', { capabilities, event: 'command', name: 'stage', payload: '', state: inspected.state, receipts: [
    { call: gitReceipts[0].call, value: reply(`## main\0 M important.txt\0`) }, gitReceipts[1],
  ] });
  assert.match(stale.value.display, /Changed since/);
  assert.equal(stale.calls.some(call => call.arguments.write === true), false);
});

test('commit preview fingerprints the full index and rejects stale index views', () => {
  const capabilities = ['commands', 'exec', 'fs.read', 'fs.write', 'store', 'lifecycle', 'terminal'];
  const stagedReceipts = [{ call: gitReceipts[0].call, value: reply(`## main\0M  important.txt\0?? new.txt\0`) }, ...gitReceipts.slice(1)];
  const inspected = run('omd_git', { capabilities, event: 'command', name: 'status', payload: '', receipts: stagedReceipts });
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
  const stale = run('omd_git', { capabilities, event: 'command', name: 'status', payload: '', state: preview.state, receipts: [
    ...stagedReceipts,
    { call: indexCall, value: reply(`100644 ${'f'.repeat(40)} 0\timportant.txt\0`) },
  ] });
  assert.equal(stale.state.preview, null);
});

test('commit confirmation lists every staged path and refuses an oversized exact preview', () => {
  const capabilities = ['commands', 'exec', 'fs.read', 'fs.write', 'store', 'lifecycle', 'terminal'];
  const paths = Array.from({ length: 12 }, (_, index) => `staged-${String(index).padStart(2, '0')}.txt`);
  const stagedStatus = `## main\0${paths.map(path => `M  ${path}\0`).join('')}`;
  const statusReceipts = [{ call: gitReceipts[0].call, value: reply(stagedStatus) }, ...gitReceipts.slice(1)];
  const inspected = run('omd_git', { capabilities, event: 'command', name: 'status', receipts: statusReceipts });
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
  const hugeInspected = run('omd_git', { capabilities, event: 'command', name: 'status', receipts: hugeStatus });
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
  const capabilities = ['commands', 'exec', 'fs.read', 'fs.write', 'store', 'lifecycle', 'terminal'];
  const inspected = run('omd_git', { capabilities, event: 'command', name: 'status', payload: '', receipts: gitReceipts });
  const selected = run('omd_git', { capabilities, event: 'command', name: 'file', payload: 'new.txt', state: inspected.state });
  const fileHash = 'e'.repeat(64);
  const candidate = run('omd_git', { capabilities, event: 'command', name: 'discard', payload: '', state: selected.state, receipts: [
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
  const capabilities = ['commands', 'exec', 'fs.read', 'fs.write', 'store', 'lifecycle', 'terminal'];
  const inspected = run('omd_git', { capabilities, event: 'command', name: 'status', payload: '', receipts: gitReceipts });
  const beforeHash = 'e'.repeat(64);
  const before = { call: { operation: 'workspace.stat', arguments: { paths: ['important.txt'], hash: true } }, value: { files: { 'important.txt': { kind: 'file', size: 12, mtime_ms: 1, sha256: beforeHash } } } };
  const access = { call: { operation: 'workspace.check_access', arguments: { paths: ['important.txt'], write: true } }, value: { paths: ['important.txt'], write: true } };
  const preview = run('omd_git', { capabilities, event: 'command', name: 'discard', payload: '', state: inspected.state, receipts: [
    ...gitReceipts, before, access,
    { call: gitArgs(['diff', '--binary', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', '--', 'important.txt']), value: reply('diff --git a/important.txt b/important.txt\n') },
    { call: gitArgs(['ls-files', '-s', '-z']), value: reply(`100644 ${'f'.repeat(40)} 0\timportant.txt\0`) },
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
    { call: before.call, value: { files: { 'important.txt': { kind: 'file', size: 10, mtime_ms: 2, sha256: 'a'.repeat(64) } } } },
    { call: gitReceipts[0].call, value: reply('## main\0?? new.txt\0') }, ...gitReceipts.slice(1),
  ] });
  assert.match(written.value.display, /discarded important\.txt; backup/);
  assert.equal(written.state.backup.expected, 'a'.repeat(64));
  assert.deepEqual(written.calls.find(call => call.operation === 'exec.run' && call.arguments.write === true).arguments.required_access, { write: ['important.txt'] });
});

test('clean branch switch binds destination and affected paths and preserves ignored files', () => {
  const capabilities = ['commands', 'exec', 'fs.read', 'fs.write', 'store', 'lifecycle', 'terminal'];
  const clean = [
    { call: gitReceipts[0].call, value: reply('## main\0') },
    gitReceipts[1], gitReceipts[2], gitReceipts[3],
  ];
  const inspected = run('omd_git', { capabilities, event: 'command', name: 'status', payload: '', receipts: clean });
  const target = { call: gitArgs(['show-ref', '--verify', '--hash', 'refs/heads/feature'], 256), value: reply(`${other}\n`) };
  const delta = { call: gitArgs(['diff', '--name-status', '-z', '--no-ext-diff', '--no-textconv', oid, other], 16384), value: reply('M\0important.txt\0') };
  const version = { 'important.txt': 'a'.repeat(64) };
  const preview = run('omd_git', { capabilities, event: 'command', name: 'switch', payload: '', state: inspected.state, receipts: [
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
  const capabilities = ['commands', 'exec', 'fs.read', 'fs.write', 'store', 'lifecycle', 'terminal'];
  const clean = [{ call: gitReceipts[0].call, value: reply('## main\0') }, ...gitReceipts.slice(1)];
  const inspected = run('omd_git', { capabilities, event: 'command', name: 'status', receipts: clean });
  const target = { call: gitArgs(['show-ref', '--verify', '--hash', 'refs/heads/feature'], 256), value: reply(`${other}\n`) };
  const paths = Array.from({ length: 12 }, (_, index) => `changed-${String(index).padStart(2, '0')}.txt`);
  const diffCall = gitArgs(['diff', '--name-status', '-z', '--no-ext-diff', '--no-textconv', oid, other], 16384);
  const preview = run('omd_git', { capabilities, event: 'command', name: 'switch', state: inspected.state, receipts: [
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
  const denied = run('omd_git', { capabilities, event: 'command', name: 'switch', state: inspected.state, receipts: [
    ...clean, target, { call: diffCall, value: reply(`M\0${huge}\0`) },
    { call: { operation: 'workspace.check_access', arguments: { paths: [huge], write: true } }, value: { paths: [huge], write: true } },
    { call: { operation: 'workspace.stat', arguments: { paths: [huge], hash: true } }, value: { files: { [huge]: { kind: 'file', sha256: 'a'.repeat(64) } } } },
  ] });
  assert.match(denied.value.display, /exact switch preview limit/);
  assert.equal(denied.state.preview, null);
  assert.equal(denied.calls.some(call => call.operation === 'exec.run' && call.arguments.write === true), false);
});

test('graph navigator uses live source service and rejects stale or mismatched evidence', () => {
  const capabilities = ['commands', 'services', 'store', 'terminal'];
  const digest = '9'.repeat(64);
  const node = 'module:src/lib.rs';
  const provenance = { workspace_snapshot: false, validation: 'double_list_and_hash' };
  const search = { schema: 1, generator: 'omd-repository-analysis-five-language-v3', repository_identity: 'fixture/repo', revision: 'live-source', source_digest: digest,
    rows: [{ id: node, label: 'src/lib.rs', detail: 'module · 1 extracted' }], count: 1, page: 0, page_size: 32, provenance };
  const packet = { schema: 1, graph_generator: search.generator, repository_identity: search.repository_identity, revision: search.revision, source_digest: digest,
    nodes: [{ id: node }], relationships: [], coverage: [], guidance: 'Verify relationships against source.', provenance };
  const call = (method, input) => ({ operation: 'mods.service', arguments: { name: 'omd.repository_analysis', method, input } });
  const openReceipt = { call: call('search', { query: '', page: 0, root: '' }), value: search };
  const opened = run('omd_graph_navigator', { capabilities, event: 'command', name: 'open', payload: '', receipts: [openReceipt] });
  const alias = run('omd_graph_navigator', { capabilities, event: 'command', name: 'graph', payload: '', receipts: [openReceipt] });
  assert.equal(alias.state.count, opened.state.count);
  assert.ok(alias.registrations.commands.some(command => command.name === 'graph'));
  const view = run('omd_graph_navigator', { capabilities, event: 'terminal', state: opened.state, payload: { event: 'idle' } });
  const row = view.value.sites.dialog.components[0].children.find(item => item.id === 'omd_graph_nodes').rows[0];
  assert.match(row.value, /^graph-row:[0-9a-f]{64}:\d+:\d+:\d+$/);
  assert.ok(Buffer.byteLength(row.value) < 128);
  assert.notEqual(row.value, node);
  const selected = run('omd_graph_navigator', { capabilities, event: 'command', name: 'select', payload: row.value, state: opened.state, receipts: [
    { call: call('select', { node_id: node, expected_source_digest: digest, root: '' }), value: packet },
  ] });
  assert.match(selected.value.insert, /live source code-graph evidence/);
  assert.equal(selected.state.open, false);
  assert.deepEqual(selected.calls.map(item => item.operation), ['mods.service']);
  const stale = spawnSync(process.execPath, ['--no-warnings', '--experimental-vm-modules', '--input-type=module', '--eval', runner], {
    input: JSON.stringify({ source: source('omd_graph_navigator'), filename: 'index.ts', api: '0.2.0-experimental.3', surface, capabilities,
      settings: {}, state: opened.state, event: 'command', name: 'search', payload: 'entry', receipts: [
        { call: call('search', { query: 'entry', page: 0, root: '', expected_source_digest: digest }), error: 'analysis_source_digest_stale' },
      ] }), encoding: 'utf8', timeout: 5000,
  });
  assert.equal(stale.status, 1);
  assert.match(JSON.parse(stale.stdout).error, /source_digest_stale/);
  const mismatched = run('omd_graph_navigator', { capabilities, event: 'command', name: 'select', payload: row.value, state: opened.state, receipts: [
    { call: call('select', { node_id: node, expected_source_digest: digest, root: '' }), value: { ...packet, source_digest: 'e'.repeat(64) } },
  ] });
  assert.match(mismatched.value.display, /does not match/);
  assert.equal(mismatched.state.open, true);
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
