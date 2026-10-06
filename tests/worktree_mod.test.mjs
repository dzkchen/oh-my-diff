import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callback } from './mod_runner.mjs';

const runner = readFileSync(new URL('../runtime/omd/src/mods/runner.mjs', import.meta.url), 'utf8');
const source = readFileSync(new URL('../mods/first-party/omd_worktree/index.ts', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../mods/first-party/omd_worktree/mod.json', import.meta.url), 'utf8'));
const native = readFileSync(new URL('../runtime/omd/src/mods.rs', import.meta.url), 'utf8');
const events = native.match(/pub const MOD_EVENTS:[\s\S]*?= &\[([\s\S]*?)\];/)[1];
const surface = { events: Object.fromEntries([...events.matchAll(/\("([a-z_]+)", "([a-z_.]+)"\)/g)].map(match => [match[1], match[2]])), replacements: ['terminal'], middleware: [], state: 'store', contracts: 'contracts' };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function fixture(settings = {}, inventory = () => ({ data: [], nextCursor: null })) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'omd-worktree-')));
  const repository = join(parent, 'repo');
  const git = (...argv) => execFileSync('git', argv, { cwd: repository, encoding: 'utf8' });
  execFileSync('git', ['init', '--quiet', '-b', 'main', repository]);
  git('config', 'user.email', 'fixture@example.com');
  git('config', 'user.name', 'Fixture');
  writeFileSync(join(repository, 'a.txt'), 'one\n');
  writeFileSync(join(repository, '.gitignore'), '.env\nnode_modules/\n');
  git('add', '.');
  git('commit', '--quiet', '-m', 'initial');
  writeFileSync(join(repository, '.env'), 'SECRET=1\n');
  execFileSync('mkdir', ['-p', join(repository, 'node_modules/dep')]);
  const answers = [];
  const calls = [];
  const store = {};
  const host = call => {
    const args = call.arguments;
    calls.push(call);
    switch (call.operation) {
      case 'exec.run': {
        for (const guard of args.guards ?? []) if (digest(spawnSync(guard.program, guard.argv, { cwd: repository }).stdout) !== guard.stdout_sha256) throw new Error('exec_guard_changed');
        const run = spawnSync(args.program, args.argv, { cwd: repository });
        return { exit_code: run.status, stdout: run.stdout.toString(), stderr: run.stderr.toString(), stdout_sha256: digest(run.stdout), stdout_preview_truncated: false };
      }
      case 'terminal.prompt': {
        const answer = answers.shift();
        return answer === false ? { status: 'declined' } : { status: 'accepted', ...(typeof answer === 'string' ? { value: answer } : {}) };
      }
      case 'store.get': return store[args.key] ?? null;
      case 'store.put': {
        if ((store[args.key]?.revision ?? null) !== args.expected_revision) throw new Error('store_conflict');
        store[args.key] = { value: args.value, revision: (store[args.key]?.revision ?? 0) + 1 };
        return { revision: store[args.key].revision };
      }
      case 'app.request':
        if (args.method === 'thread/start') return { thread: { id: `thread-${args.params.cwd.split('/').at(-1)}` } };
        if (args.method === 'thread/list') return inventory(args.params);
        return {};
      default: return { shown: true };
    }
  };
  let state = null;
  const invoke = (event, name, payload) => {
    const receipts = [];
    for (let turn = 0; turn < 40; turn++) {
      const request = { source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, settings, surface, state, event, name, payload, receipts, hook_budget_ms: 10000 };
      const reply = callback(request, host, receipts);
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
  const command = (name, payload = '') => invoke('command', name, payload);
  return { parent, repository, git, answers, calls, command, invoke, state: () => state };
}

test('task worktrees are created from a base with opt-in setup, launched, reused only on request and integrated after review', () => {
  const { parent, repository, git, answers, calls, command, invoke, state } = fixture({ shared: [{ path: 'node_modules', mode: 'symlink' }], copy: ['.env'] });
  try {
    const path = `${repository}.worktrees/omd-42-fix-login`;
    answers.push(true, false);
    assert.match(command('task', 'Fix login --issue 42 --base main').display, /^Created .*omd-42-fix-login on omd\/42-fix-login$/);
    assert.equal(git('rev-parse', 'omd/42-fix-login'), git('rev-parse', 'main'));
    assert.ok(lstatSync(join(path, 'node_modules')).isSymbolicLink());
    assert.equal(existsSync(join(path, '.env')), false);
    assert.match(calls.find(call => call.arguments?.kind === 'confirm').arguments.message, /symlink node_modules from the main checkout[\s\S]*copy \.env \(asked separately\)/);
    assert.deepEqual(calls.filter(call => call.operation === 'app.request').map(call => call.arguments.method), ['thread/start', 'thread/name/set']);
    assert.equal(calls.find(call => call.operation === 'terminal.show_thread').arguments.thread_id, 'thread-omd-42-fix-login');
    assert.match(command('task', 'Fix login --issue 42').display, /already checked out .*add --reuse/);
    assert.equal(command('task', 'Other --base nope').display, 'Unknown base nope; use a branch, remote branch or commit');
    assert.deepEqual(invoke('service', 'omd.worktrees.list', null).worktrees.map(tree => [tree.branch, tree.task, tree.main]), [['main', null, true], ['omd/42-fix-login', 'Fix login', false]]);

    writeFileSync(join(path, 'a.txt'), 'two\n');
    writeFileSync(join(path, 'new.txt'), 'new\n');
    writeFileSync(join(repository, 'a.txt'), 'dirty\n');
    assert.match(command('integrate', 'omd/42-fix-login').display, /destination checkout has uncommitted changes/);
    git('checkout', '--quiet', 'a.txt');
    assert.equal(command('integrate', 'omd/42-fix-login'), null);
    assert.match(state().preview.summary, /\(2 paths, 1 new\) are committed as "Fix login" first/);
    assert.match(state().preview.diff, /-one\n\+two[\s\S]*\+\+\+ b\/new\.txt\n@@ -0,0 \+1 @@\n\+new/);
    writeFileSync(join(path, 'a.txt'), 'three\n');
    assert.match(command('merge').display, /task worktree changed since the preview/);
    writeFileSync(join(path, 'a.txt'), 'two\n');
    command('integrate', 'omd/42-fix-login');
    writeFileSync(join(repository, 'b.txt'), 'later\n');
    git('add', 'b.txt');
    git('commit', '--quiet', '-m', 'moved on');
    assert.match(command('merge').display, /changed since the preview/);
    assert.equal(git('show', 'HEAD:a.txt'), 'one\n');
    assert.equal(execFileSync('git', ['-C', path, 'log', '-1', '--format=%s'], { encoding: 'utf8' }), 'Fix login\n');
    command('integrate', 'omd/42-fix-login');
    assert.equal(state().preview.commit, null);
    assert.equal(command('merge').display, 'Integrated omd/42-fix-login');
    assert.equal(readFileSync(join(repository, 'new.txt'), 'utf8'), 'new\n');
    assert.equal(git('ls-tree', 'HEAD', '--name-only').includes('node_modules'), false);

    answers.push(true, true);
    assert.match(command('remove', 'omd/42-fix-login').display, /^Removed .*; deleted omd\/42-fix-login$/);
    assert.equal(existsSync(path), false);
    assert.equal(git('branch', '--list', 'omd/42-fix-login'), '');
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('worktree cleanup keeps dirty and unmerged work, and failed integrations restore the checkout', () => {
  const { parent, repository, git, answers, command } = fixture();
  try {
    answers.push(true);
    command('task', 'conflict --branch task/conflict');
    const path = `${repository}.worktrees/task-conflict`;
    writeFileSync(join(path, 'a.txt'), 'theirs\n');
    execFileSync('git', ['-C', path, 'commit', '--quiet', '-am', 'theirs']);
    writeFileSync(join(repository, 'a.txt'), 'ours\n');
    git('commit', '--quiet', '-am', 'ours');
    command('integrate', 'task/conflict');
    assert.match(command('merge').display, /^Integration failed and the checkout was restored/);
    assert.equal(git('status', '--porcelain'), '');
    assert.equal(readFileSync(join(repository, 'a.txt'), 'utf8'), 'ours\n');

    writeFileSync(join(path, 'scratch.txt'), 'keep\n');
    assert.match(command('remove', 'task/conflict').display, /uncommitted or untracked changes; they are kept/);
    rmSync(join(path, 'scratch.txt'));
    answers.push(true);
    assert.match(command('remove', 'task/conflict').display, /task\/conflict has unmerged commits and was kept/);
    assert.match(git('branch', '--list', 'task/conflict'), /task\/conflict/);

    answers.push(true);
    command('task', 'gone --branch task/gone');
    rmSync(`${repository}.worktrees/task-gone`, { recursive: true, force: true });
    answers.push(true);
    assert.equal(command('prune').display, 'Pruned 1 records');
    assert.doesNotMatch(git('worktree', 'list'), /task-gone/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('worktree removal requires complete session inventory before and after confirmation', () => {
  for (const mode of ['failed', 'later-active', 'incomplete', 'became-active']) {
    let calls = 0;
    const f = fixture({}, params => {
      calls++;
      if (mode === 'failed') throw new Error('unavailable');
      if (mode === 'incomplete') return { data: [], nextCursor: `page-${calls}` };
      if (mode === 'later-active' && !params.cursor) return { data: [], nextCursor: 'later' };
      return { data: mode === 'became-active' && calls === 1 ? [] : [{ status: { type: 'active' } }], nextCursor: null };
    });
    try {
      f.command('task', 'inventory --branch task/inventory');
      const path = `${f.repository}.worktrees/task-inventory`;
      assert.match(f.command('park', 'task/inventory').display, /session|inventory/i);
      assert.ok(existsSync(path), mode);
      assert.equal(f.calls.some(call => call.arguments?.argv?.includes('--force')), false);
    } finally { rmSync(f.parent, { recursive: true, force: true }); }
  }
});

test('integration refuses staged shared setup files and preserves their index entries', () => {
  const f = fixture({ shared: [{ path: 'node_modules', mode: 'symlink' }] });
  try {
    f.command('task', 'staged --branch task/staged');
    const path = `${f.repository}.worktrees/task-staged`;
    execFileSync('git', ['-C', path, 'add', '-f', 'node_modules']);
    writeFileSync(join(path, 'a.txt'), 'changed\n');
    const staged = () => execFileSync('git', ['-C', path, 'diff', '--cached', '--raw'], { encoding: 'utf8' });
    const before = staged();
    assert.match(f.command('integrate', 'task/staged').display, /shared setup.*staged/i);
    assert.equal(staged(), before);
    assert.equal(execFileSync('git', ['-C', path, 'show', 'HEAD:a.txt'], { encoding: 'utf8' }), 'one\n');
  } finally { rmSync(f.parent, { recursive: true, force: true }); }
});
