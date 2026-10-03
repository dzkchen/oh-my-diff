import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const runner = readFileSync(new URL('../runtime/omd/src/mods/runner.mjs', import.meta.url), 'utf8');
const source = readFileSync(new URL('../mods/first-party/omd_layout/index.ts', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../mods/first-party/omd_layout/mod.json', import.meta.url), 'utf8'));
const native = readFileSync(new URL('../runtime/omd/src/mods.rs', import.meta.url), 'utf8');
const events = native.match(/pub const MOD_EVENTS:[\s\S]*?= &\[([\s\S]*?)\];/)[1];
const surface = { events: Object.fromEntries([...events.matchAll(/\("([a-z_]+)", "([a-z_.]+)"\)/g)].map(match => [match[1], match[2]])), replacements: ['terminal'], middleware: [], state: 'store', contracts: 'contracts' };

const threads = [
  { id: 't1', name: 'Fix login', cwd: '/w/app', model: 'gpt-6', status: { type: 'active', activeFlags: [] }, updatedAt: 30, gitInfo: { branch: 'main', originUrl: 'git@host:me/app.git' } },
  { id: 't2', preview: 'Write docs', cwd: '/w/app.worktrees/omd-docs', model: 'gpt-6', status: { type: 'active', activeFlags: ['waitingOnApproval'] }, updatedAt: 20, gitInfo: { branch: 'omd/docs', originUrl: 'git@host:me/app.git' } },
  { id: 't3', name: 'Other project', cwd: '/w/site', status: { type: 'notLoaded' }, updatedAt: 10, gitInfo: null },
];

function fixture() {
  const repository = realpathSync(mkdtempSync(join(tmpdir(), 'omd-layout-')));
  const git = (...argv) => execFileSync('git', argv, { cwd: repository, encoding: 'utf8' });
  git('init', '--quiet');
  mkdirSync(join(repository, 'src'));
  writeFileSync(join(repository, '.gitignore'), 'build/\n');
  writeFileSync(join(repository, 'src/login.ts'), 'export const login = 1;\n');
  writeFileSync(join(repository, 'README.md'), '# app\n');
  git('add', '.');
  mkdirSync(join(repository, 'build'));
  writeFileSync(join(repository, 'build/login.js'), '');
  let composer = 'half-typed draft';
  const calls = [];
  const now = 1_800_000_000_000;
  const store = new Map([['s:t3', { value: { status: 'working', note: 'in another terminal', context: null, ports: [8080], at: now - 60_000 }, revision: 4 }],
    ['s:gone', { value: { status: 'done', note: null, context: null, ports: [], at: 0 }, revision: 2 }]]);
  const host = call => {
    const args = call.arguments;
    calls.push(call);
    switch (call.operation) {
      case 'app.request':
        if (args.method === 'thread/list') return { data: threads.map(thread => ({ ...thread })) };
        if (args.method === 'skills/list') return { data: [{ skills: [{ name: 'release-notes', description: 'Draft release notes' }] }] };
        if (args.method === 'model/list') return { data: [{ model: 'gpt-6', displayName: 'GPT-6' }, { model: 'hidden', hidden: true }] };
        if (args.method === 'thread/turns/list') return { data: [{ items: [{ type: 'agentMessage', text: 'Login fixed.\nlogin works' }] }, { items: [{ type: 'userMessage', content: [{ type: 'text', text: 'fix LOGIN' }] }] }] };
        if (args.method === 'thread/settings/update') throw new Error('app_route_unconfigured: gpt-6');
        return {};
      case 'terminal.commands': return { commands: [{ command: 'compact', description: 'summarize', owner: null }, { command: 'omd_git:status', description: 'Show changed files', owner: 'omd_git' }] };
      case 'workspace.list': throw new Error('workspace_path_unavailable');
      case 'sessions.ports': return { ports: [{ port: 5173, pid: 42, address: '*:5173' }] };
      case 'store.export': return { entries: Object.fromEntries(store) };
      case 'store.put':
        assert.equal(args.expected_revision, store.get(args.key)?.revision ?? null);
        store.set(args.key, { value: args.value, revision: (store.get(args.key)?.revision ?? 0) + 1 });
        return { revision: store.get(args.key).revision };
      case 'store.delete':
        store.delete(args.key);
        return { deleted: true };
      case 'exec.run': {
        const run = spawnSync(args.program, args.argv, { cwd: repository });
        return { exit_code: run.status, stdout: run.stdout.toString(), stderr: run.stderr.toString(), stdout_sha256: createHash('sha256').update(run.stdout).digest('hex'), stdout_preview_truncated: false };
      }
      case 'mods.service':
        if (args.name === 'omd.worktrees') return { worktrees: [{ path: '/w/app.worktrees/omd-docs', branch: 'omd/docs', task: 'Write docs', issue: '7' }] };
        if (args.name === 'omd.panes' && args.method === 'tabs') return { titles: ['Shell .', 'review'], active: 0 };
        if (args.name === 'omd.panes' && args.method === 'find') return { views: [{ path: 'src/login.ts', matches: 1 }] };
        if (args.name === 'omd.panes') return { display: null };
        throw new Error('optional_service_unavailable');
      case 'composer.read': return { text: composer, cursor: 0, attachments: [] };
      case 'composer.write':
        composer = args.text ?? `${composer}${args.insert ?? ''}`;
        return { text: composer, cursor: 0 };
      default: return { invoked: true };
    }
  };
  let state = null;
  const invoke = (event, payload, name) => {
    const receipts = [];
    for (let turn = 0; turn < 40; turn++) {
      const request = { source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, settings: {}, surface, state, event, name, payload, receipts, hook_budget_ms: 10000, virtual_time_ms: now };
      const reply = JSON.parse(spawnSync(process.execPath, ['--no-warnings', '--experimental-vm-modules', '--input-type=module', '--eval', runner], { input: JSON.stringify(request), encoding: 'utf8', timeout: 20000 }).stdout);
      if (reply.error) throw new Error(reply.error);
      if (!reply.host_call) {
        state = reply.state;
        return reply.value;
      }
      try { receipts.push({ call: reply.host_call, value: host(reply.host_call) }); }
      catch (error) { receipts.push({ call: reply.host_call, error: error.message }); }
    }
    throw new Error('host_call_limit');
  };
  return {
    repository, calls, store, composer: () => composer, state: () => state,
    command: (name, text = '') => invoke('command', text, name),
    event: (event, payload) => invoke(event, payload),
    view: (thread = 't1') => invoke('terminal', { event: 'redraw', ledger: { thread_id: thread, cwd: '/w/app', cost: null } }),
  };
}

test('session list groups projects with status, unread, worktree, context, ports and other processes\' shared status', () => {
  const { repository, store, command, event, view } = fixture();
  try {
    view();
    event('app_notification', { method: 'thread/tokenUsage/updated', params: { threadId: 't1', tokenUsage: { last: { totalTokens: 50 }, modelContextWindow: 200 } }, thread_id: 't1', coalesced: 1, dropped: 0 });
    command('sessions', 'refresh');
    const rows = () => view().sites['omd_layout/sessions'].components[1].rows.map(row => row.spans.map(span => span.text).join(''));
    assert.deepEqual(rows(), ['▾ app (2)', ' ● Fix login main  app · gpt-6 · ctx 25% · :5173', ' ◆ Write docs omd/docs #7  omd-docs · gpt-6', '▾ site (1)', ' ● Other project  site · :8080 · in another terminal']);
    assert.deepEqual(store.get('s:t1').value, { status: 'working', note: null, context: 25, ports: [5173], at: 1_800_000_000_000 });
    assert.equal(store.has('s:gone'), false);
    event('app_notification', { method: 'turn/completed', params: { threadId: 't2', turn: { status: 'completed' } }, thread_id: 't2', coalesced: 1, dropped: 0 });
    assert.deepEqual(rows()[2], '•✓ Write docs omd/docs #7  omd-docs · gpt-6 · turn completed');
    assert.deepEqual(view().status, ['2 working · 1 unread']);
    assert.equal(view().keybindings['Ctrl+Alt+p'].command, 'omd_layout:palette');
    assert.equal(command('sessions', 'list').display.split('\n')[0], '● Fix login  app/main  t1');
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test('palettes search nested pages, keep the composer draft, jump to sessions and tabs, quick open and find', () => {
  const { repository, calls, composer, command, event, view, state } = fixture();
  try {
    view();
    command('palette');
    const rows = () => view().sites.dialog.components[0].children[1].rows.map(row => row.value);
    assert.deepEqual(rows().slice(0, 6), ['page:models', 'page:sessions', 'page:actions', 'page:commands', 'page:skills', 'page:templates']);
    command('pick', 'query relnot');
    assert.deepEqual(rows(), ['skill:release-notes']);
    command('pick', 'query relnot');
    assert.equal(composer(), '$release-notes ');
    command('palette');
    assert.equal(rows()[0], 'restore');
    command('pick', 'run page:actions');
    assert.deepEqual(rows(), ['back', 'mod:omd_git:status']);
    command('pick', 'run mod:omd_git:status');
    assert.deepEqual(calls.filter(call => call.operation === 'builtins.invoke').at(-1).arguments, { command: 'omd_git:status' });
    assert.equal(composer(), '$release-notes ');
    command('palette');
    command('pick', 'run page:commands');
    command('pick', 'run cmd:compact');
    assert.deepEqual(calls.filter(call => call.operation === 'builtins.invoke').at(-1).arguments, { command: 'compact' });
    command('palette');
    assert.match(command('pick', 'run model:gpt-6').display, /not a configured route/);

    command('jump');
    assert.deepEqual(rows(), ['session:t1', 'session:t2', 'session:t3', 'worktree:/w/app.worktrees/omd-docs', 'tab:0', 'tab:1']);
    command('pick', 'run tab:1');
    assert.deepEqual(calls.filter(call => call.operation === 'mods.service').at(-1).arguments, { name: 'omd.panes', method: 'show_tab', input: { index: 1 } });
    command('jump');
    command('pick', 'run session:t2');
    assert.deepEqual(calls.filter(call => call.operation === 'builtins.invoke').at(-1).arguments, { command: 'resume', args: 't2' });
    assert.equal(state().drafts.t1, '$release-notes ');
    command('jump');
    command('pick', 'run worktree:/w/app.worktrees/omd-docs');
    assert.deepEqual(calls.filter(call => call.operation === 'builtins.invoke').at(-1).arguments, { command: 'resume', args: 't2' });
    calls.length = 0;
    event('resume', { thread_id: 't1', last_turn: null, restarted: false });
    assert.equal(calls.some(call => call.operation === 'composer.write'), false);

    command('quick_open', 'login');
    assert.deepEqual(rows(), ['file:src/login.ts', 'file:build/login.js']);
    assert.equal(view().sites.dialog.components[0].children[1].rows[1].spans[1].text, '  ignored');
    command('pick', 'run file:src/login.ts');
    assert.deepEqual(calls.filter(call => call.operation === 'mods.service').at(-1).arguments, { name: 'omd.panes', method: 'open', input: { path: 'src/login.ts' } });

    command('find', 'login');
    const find = () => view().sites.dialog.components[0].children;
    assert.equal(find().find(item => item.id === 'omd_layout_find_counts').text, 'transcript 3 · src/login.ts 1');
    command('pick', 'case match');
    assert.equal(find().find(item => item.id === 'omd_layout_find_counts').text, 'transcript 1 · src/login.ts 1');
    command('pick', 'mode regex');
    command('pick', 'query (');
    assert.match(find().find(item => item.id === 'omd_layout_find_counts').text, /^transcript invalid pattern/);
    assert.deepEqual(find().find(item => item.type === 'document').find, { query: '(', regex: true, case: true });
    command('pick', 'close');
    assert.equal(view().sites.dialog, undefined);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});
