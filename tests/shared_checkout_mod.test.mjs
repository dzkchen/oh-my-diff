import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const runner = readFileSync(new URL('../runtime/omd/src/mods/runner.mjs', import.meta.url), 'utf8');
const mod = new URL('../mods/first-party/omd_shared_checkout/', import.meta.url);
const source = readFileSync(new URL('index.ts', mod), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('mod.json', mod), 'utf8'));
const surface = { events: { terminal: 'terminal', start: 'lifecycle', resume: 'lifecycle', stop: 'lifecycle', tool_result: 'lifecycle', timer: 'events', channel: 'events', workspace_change: 'fs.read', approval_result: 'approvals' },
  replacements: [], middleware: ['approval'], state: 'store', contracts: 'contracts' };
const ROOT = '/work/repo';
const A = '019a0000-aaaa-7000-8000-000000000001';
const B = '019b0000-bbbb-7000-8000-000000000002';
const AGENT = '019c0000-cccc-7000-8000-000000000003';
const MINUTE = 60_000;

function harness() {
  const store = new Map();
  const calls = [];
  const host = { confirm: true, git: true };
  let state = null;
  let now = 1_800_000_000_000;
  const call = (thread, operation, args) => {
    calls.push({ thread, operation, args });
    switch (operation) {
      case 'exec.run': return args.program === 'git' && !host.git ? { exit_code: 128, stdout: '', stderr: 'fatal: not a git repository' } : { exit_code: 0, stdout: `${ROOT}\n`, stderr: '' };
      case 'store.get': return store.get(`${thread}:${args.key}`) ?? null;
      case 'store.put': {
        if (args.value == null) throw new Error('store_value_required');
        const revision = (store.get(`${thread}:${args.key}`)?.revision ?? 0) + 1;
        assert.equal(args.expected_revision, revision === 1 ? null : revision - 1);
        store.set(`${thread}:${args.key}`, { value: args.value, revision, provenance: { thread_id: thread } });
        return { revision };
      }
      case 'terminal.prompt': return host.confirm ? { status: 'accepted' } : { status: 'declined' };
      case 'builtins.invoke': return { invoked: true };
      case 'workspace.watch': return { watch_id: `w-${thread.slice(0, 4)}-${calls.length}` };
      case 'workspace.list': return { entries: [{ path: 'src', kind: 'dir' }, { path: 'README.md', kind: 'file' }], truncated: false };
      default: return { key: args.key, delay_ms: args.delay_ms };
    }
  };
  const invoke = (thread, event, payload, name) => {
    const receipts = [];
    for (;;) {
      const request = { source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, state, settings: {}, event, name, payload, receipts, surface, hook_budget_ms: 10000, virtual_time_ms: now };
      const output = JSON.parse(spawnSync(process.execPath, ['--no-warnings', '--experimental-vm-modules', '--input-type=module', '--eval', runner],
        { input: JSON.stringify(request), encoding: 'utf8', timeout: 20000 }).stdout);
      if (output.error) throw new Error(output.error);
      if (!output.host_call) {
        state = output.state;
        return output.value;
      }
      receipts.push({ call: output.host_call, value: call(thread, output.host_call.operation, output.host_call.arguments) });
    }
  };
  const share = (thread, text) => invoke(thread, 'command', `@${thread} ${text}`, 'share');
  const approve = (thread, kind, target, { agent = null, id = 'call' } = {}) => invoke(thread, 'approval', { id, kind, thread_id: thread, turn_id: 'turn', agent_id: agent, host_decision: 'skip', policy: 'never',
    details: kind === 'patch' ? { tool: 'apply_patch', cwd: `file://${ROOT}`, files: target.map(path => path.startsWith('/') ? `file://${path}` : `file://${ROOT}/${path}`), patch: '*** Begin Patch' }
      : { tool: 'exec_command', cwd: `file://${ROOT}`, command: ['/bin/zsh', '-lc', target] } });
  const view = thread => invoke(thread, 'terminal', { event: 'redraw', ledger: { thread_id: thread, cwd: ROOT, cost: null } });
  const text = (thread, site = 'omd_shared_checkout/checkout') => view(thread).sites[site].components
    .flatMap(item => [item.text ?? '', ...(item.rows ?? []).map(row => row.spans[0].text), ...(item.children ?? []).map(child => child.text ?? child.spans?.[0].text ?? '')]).join('\n');
  return { calls, host, invoke, share, approve, view, text, advance: minutes => now += minutes * MINUTE, entry: thread => state.sessions[thread], get state() { return state; }, set state(value) { state = value; } };
}

test('shared checkout keeps sessions read-only until they reserve paths and pauses overlapping edits and Git writes for review', () => {
  const fx = harness();
  const { calls, host, invoke, share, approve, text, entry, advance } = fx;
  invoke(A, 'start', null);
  invoke(B, 'resume', { thread_id: B, last_turn: null, restarted: false });
  assert.deepEqual([entry(A).write, entry(B).write], [false, false]);
  assert.deepEqual(calls.filter(item => item.operation === 'events.schedule').map(item => item.args.key), ['beat', 'beat']);

  assert.match(approve(A, 'patch', ['src/parser/x.ts']).deny, /^This session is a read-only participant in the shared checkout \/work\/repo/);
  assert.equal(approve(A, 'exec', 'rg parser src && git status'), null);
  assert.match(approve(A, 'exec', 'git stash').deny, /git stash changes the shared index/);
  assert.match(approve(AGENT, 'patch', ['src/x.ts'], { agent: `agent:${AGENT}` }).deny, new RegExp(`^Agent thread ${AGENT} .*-- TASK @${AGENT}`));
  assert.match(approve(A, 'exec', `GIT_AUTHOR_NAME=x command git -C . commit -m "fix; done"`).deny, /git commit changes the shared index/);
  assert.match(approve(A, 'exec', `bash -c 'cd src && git checkout -- parser'`).deny, /git checkout changes/);
  assert.equal(approve(A, 'exec', `echo "git commit later"; git log --oneline 2>&1 >/dev/null`), null);
  assert.match(approve(A, 'exec', `echo hi > notes.md`).ask, /^this read-only session's command writes notes\.md; \/share write PATH\.\.\. -- TASK assigns paths\. Approve only after coordinating/);
  assert.equal(approve(A, 'patch', ['/elsewhere/file.ts']), null);

  const before = JSON.parse(JSON.stringify(fx.state));
  assert.match(share(A, 'write src/parser -- fix the parser').display, /^Writing src\/parser for fix the parser\. Agent patches, Git commands and recognizable shell writes in sessions running this mod are checked/);
  const hop = calls.filter(item => item.operation === 'events.publish').at(-1).args;
  const committed = fx.state;
  fx.state = before;
  invoke(A, 'channel', { publisher: 'omd_shared_checkout', channel: `omd_shared_checkout/${hop.channel}`, data: hop.data, correlation: null, sequence: 1, dropped: 0 });
  assert.deepEqual(calls.filter(item => item.operation === 'events.schedule').at(-1).args, { key: 'arm', delay_ms: 1000 });
  fx.state = committed;
  invoke(A, 'timer', { key: 'arm' });
  assert.deepEqual(calls.filter(item => item.operation === 'workspace.watch').at(-1).args, { paths: ['src/parser'], recursive: true, debounce_ms: 500, include_ignored: true });
  const watch = entry(A).watches[0];
  assert.equal(approve(A, 'patch', ['src/parser/x.ts']), null);
  const changed = path => invoke(A, 'workspace_change', { repository: ROOT, source: 'external', call_id: null, watch_id: watch, changes: [{ path, before: null, after: 'h' }], status: 'observed' });
  const own = (path, source, call_id) => invoke(A, 'workspace_change', { repository: ROOT, source, call_id, changes: [{ path, before: null, after: 'h' }], status: 'observed' });
  const settle = () => {
    advance(0.1);
    invoke(A, 'timer', { key: 'settle' });
  };
  changed('src/parser/x.ts');
  changed('docs/other.md');
  changed('src/parser/y.ts');
  assert.deepEqual([entry(A).warnings, entry(A).pending.map(item => item.path)], [[], ['src/parser/x.ts', 'src/parser/y.ts']]);
  settle();
  assert.deepEqual(entry(A).warnings, ["src/parser/y.ts changed outside this session"]);
  share(A, 'dismiss');
  approve(A, 'patch', ['src/parser/z.ts', 'README.md'], { id: 'outside' });
  invoke(A, 'approval_result', { id: 'outside', kind: 'patch', decision: 'denied', source: 'user', mod: 'omd_shared_checkout' });
  changed('src/parser/z.ts');
  settle();
  assert.deepEqual(entry(A).warnings, ["src/parser/z.ts changed outside this session"]);
  share(A, 'dismiss');
  assert.equal(approve(A, 'exec', 'npm run format', { id: 'format' }), null);
  changed('src/parser/formatted.ts');
  changed('src/parser/meanwhile.ts');
  settle();
  assert.deepEqual(entry(A).warnings, []);
  invoke(A, 'tool_result', { call_id: 'format', agent_id: null, thread_id: A, tool: 'exec_command', outcome: 'succeeded', call_sha256: null, result_sha256: null, result_complete: true });
  own('src/parser/formatted.ts', 'tool', 'format');
  settle();
  assert.deepEqual(entry(A).warnings, ["src/parser/meanwhile.ts changed outside this session"]);
  own('src/parser/meanwhile.ts', 'transaction', null);
  assert.deepEqual(entry(A).warnings, []);
  assert.match(approve(A, 'patch', ['src/parser/x.ts', 'README.md']).ask, /README\.md is outside this session's assignment \(src\/parser\)/);

  host.confirm = false;
  assert.match(share(B, 'write src/parser/lexer.ts -- lexer tweak').display, /^Not reserved\. Run the task in a worktree/);
  assert.equal(entry(B).write, false);
  assert.match(calls.filter(item => item.operation === 'terminal.prompt').at(-1).args.message, /src\/parser\/lexer\.ts is reserved by fix the parser \(019a0000\), active now/);
  host.confirm = true;
  share(B, 'write src/parser/lexer.ts docs -- lexer tweak');
  assert.deepEqual(entry(A).warnings, ['lexer tweak (019b0000) also reserved src/parser/lexer.ts']);
  assert.match(approve(B, 'patch', ['src/parser/lexer.ts']).ask, /^src\/parser\/lexer\.ts is reserved by fix the parser \(019a0000\)\. Approve only after coordinating/);
  assert.equal(approve(B, 'patch', ['docs/guide.md']), null);
  assert.match(text(A), /fix the parser \(019a0000\) and lexer tweak \(019b0000\) overlap on src\/parser/);
  assert.match(text(A), /Reservations are advisory\. .*other writes and programs outside OMD are not blocked/);
  assert.match(approve(A, 'exec', 'printf x > src/parser/gen.ts && rm -f docs/old.md 2>&1').ask,
    /^docs\/old\.md is reserved by lexer tweak \(019b0000\); docs\/old\.md is outside this session's assignment \(src\/parser\)\. Approve only after coordinating/);
  assert.equal(approve(A, 'exec', `sh -c 'sed -i.bak s/a/b/ src/parser/x.ts >/dev/null'`), null);
  assert.equal(approve(A, 'exec', `sed -i -e 's/a b/c/' -e s/x/y/ src/parser/x.ts`), null);
  assert.match(approve(A, 'exec', `sudo -u root nice -n 5 rm docs/old.md`).ask, /^docs\/old\.md is reserved by lexer tweak/);

  assert.match(approve(A, 'exec', 'git add src/parser && git commit -m parser', { id: 'commit' }).ask, /^git add affects the whole checkout while lexer tweak \(019b0000\) also write here/);
  assert.match(approve(B, 'exec', 'git -C . commit -m docs').ask, /^git add by fix the parser \(019a0000\) may still be running/);
  invoke(A, 'tool_result', { call_id: 'commit', agent_id: null, thread_id: A, tool: 'exec_command', outcome: 'aborted', call_sha256: null, result_sha256: null, result_complete: false });
  assert.match(approve(B, 'exec', 'git commit -m docs', { id: 'docs' }).ask, /^git commit affects the whole checkout while fix the parser/);
  advance(3);
  assert.match(approve(A, 'exec', 'git branch topic').ask, /^git branch affects the whole checkout/);
});

test('shared checkout hands off paths, recovers stale registrations and releases sessions that stop', () => {
  const fx = harness();
  const { calls, host, invoke, share, approve, view, text, entry, advance } = fx;
  host.git = false;
  share(A, 'write . -- refactor');
  assert.deepEqual([fx.state.root, calls.filter(item => item.operation === 'exec.run').map(item => item.args.program)], [ROOT, ['pwd', 'git']]);
  const hop = calls.filter(item => item.operation === 'events.publish').at(-1).args;
  invoke(A, 'channel', { publisher: 'omd_shared_checkout', channel: `omd_shared_checkout/${hop.channel}`, data: hop.data, correlation: null, sequence: 1, dropped: 0 });
  assert.deepEqual(calls.filter(item => item.operation === 'workspace.watch').at(-1).args.paths, ['src', 'README.md']);
  share(A, 'read');
  share(A, 'write src -- refactor');
  share(B, '');
  assert.equal(view(B).sites.dialog.components[0].title, 'Shared checkout');
  assert.deepEqual(view(B).status, ['shared: read-only']);
  assert.match(share(A, 'handoff 019b0000 src -- finish the tests').display, /^Offered src to read-only session \(019b0000\)/);
  const pending = view(B).sites['omd_shared_checkout/checkout'].components.find(item => item.id === 'omd_shared_checkout_handoffs');
  assert.deepEqual(pending.options.map(option => option.value), ['accept 0', 'decline 0']);
  share(B, 'accept 0');
  assert.deepEqual([entry(A).write, entry(B).write, entry(B).paths, entry(B).task], [false, true, ['src'], 'finish the tests']);
  assert.deepEqual(entry(A).warnings, ['finish the tests (019b0000) accepted src']);
  assert.equal(approve(B, 'patch', ['src/a.ts']), null);

  advance(11);
  invoke(A, 'timer', { key: 'beat' });
  assert.match(text(A), /finish the tests \(019b0000\) · src · stale since 11m ago/);
  share(A, 'write src/a.ts -- hotfix');
  assert.match(calls.filter(item => item.operation === 'terminal.prompt').at(-1).args.message, /src\/a\.ts is reserved by finish the tests \(019b0000\), stale since 11m ago/);
  assert.match(approve(A, 'patch', ['src/a.ts']).ask, /reserved by finish the tests \(019b0000\), stale since 11m ago/);
  host.confirm = false;
  assert.equal(share(A, `release ${B}`), null);
  assert.ok(entry(B));
  host.confirm = true;
  assert.match(share(A, 'release 019b0000').display, /^Released finish the tests \(019b0000\)/);
  assert.equal(entry(B), undefined);
  assert.equal(approve(A, 'patch', ['src/a.ts']), null);

  assert.deepEqual(share(A, 'worktree'), null);
  assert.deepEqual(calls.filter(item => item.operation === 'builtins.invoke').map(item => item.args), [{ command: 'worktree' }]);
  advance(25 * 60);
  invoke(B, 'resume', { thread_id: B, last_turn: null, restarted: true });
  assert.equal(entry(A), undefined);
  assert.deepEqual(entry(B).paths, []);
  invoke(B, 'stop', null);
  assert.equal(view(B), null);
});
