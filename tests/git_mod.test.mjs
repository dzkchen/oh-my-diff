import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const runner = readFileSync(new URL('../runtime/omd/src/mods/runner.mjs', import.meta.url), 'utf8');
const source = readFileSync(new URL('../mods/first-party/omd_git/index.ts', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../mods/first-party/omd_git/mod.json', import.meta.url), 'utf8'));
const native = readFileSync(new URL('../runtime/omd/src/mods.rs', import.meta.url), 'utf8');
const events = native.match(/pub const MOD_EVENTS:[\s\S]*?= &\[([\s\S]*?)\];/)[1];
const surface = { events: Object.fromEntries([...events.matchAll(/\("([a-z_]+)", "([a-z_.]+)"\)/g)].map(match => [match[1], match[2]])), replacements: ['terminal', 'list'], middleware: [], state: 'store', contracts: 'contracts' };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const gitPath = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim();
const gitSha256 = digest(readFileSync(realpathSync(gitPath)));

function repositoryHost(repository) {
  const git = (argv, env = {}, stdin) => spawnSync(gitPath, argv, { cwd: repository, env: { ...process.env, ...env }, input: stdin });
  return call => {
    const args = call.arguments;
    switch (call.operation) {
      case 'exec.run': {
        assert.equal(args.program, 'git');
        for (const guard of args.guards ?? []) {
          assert.equal(guard.program, 'git');
          if (digest(git(guard.argv, guard.env).stdout) !== guard.stdout_sha256) throw new Error('exec_guard_stale');
        }
        const result = git(args.argv, args.env, args.stdin);
        return { exit_code: result.status, signal: null, timed_out: false, stdout: result.stdout.toString(), stderr: result.stderr.toString(),
          stdout_sha256: digest(result.stdout), stdout_truncated: false, stderr_truncated: false, duration_ms: 1,
          program: { path: gitPath, sha256: gitSha256 }, guards_verified: args.guards?.length ?? 0 };
      }
      case 'workspace.check_access': return { paths: args.paths };
      case 'workspace.stat': return { files: Object.fromEntries(args.paths.map(path => {
        try {
          const bytes = readFileSync(join(repository, path));
          return [path, { kind: 'file', size: bytes.length, mtime_ms: statSync(join(repository, path)).mtimeMs, ...(args.hash ? { sha256: digest(bytes) } : {}) }];
        } catch { return [path, null]; }
      })) };
      default: throw new Error(`unexpected_operation: ${call.operation}`);
    }
  };
}

function command(host, name, payload, state) {
  const receipts = [];
  for (let turn = 0; turn < 64; turn++) {
    const request = { source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, settings: {}, surface,
      state, event: 'command', name, payload, receipts, hook_budget_ms: 5000 };
    const child = spawnSync(process.execPath, ['--no-warnings', '--experimental-vm-modules', '--input-type=module', '--eval', runner], { input: JSON.stringify(request), encoding: 'utf8', timeout: 10000 });
    assert.ifError(child.error);
    const reply = JSON.parse(child.stdout);
    if (reply.error) throw new Error(reply.error);
    if (!reply.host_call) return reply;
    try { receipts.push({ call: reply.host_call, value: host(reply.host_call) }); }
    catch (error) { receipts.push({ call: reply.host_call, error: error.message }); }
  }
  throw new Error('host_call_limit');
}

test('Git mod stages, unstages and commits through real git argument lists', () => {
  const repository = realpathSync(mkdtempSync(join(tmpdir(), 'omd-git-mod-')));
  try {
    const git = (...argv) => execFileSync(gitPath, argv, { cwd: repository, encoding: 'utf8' });
    git('init', '--quiet');
    git('config', 'user.email', 'fixture@example.com');
    git('config', 'user.name', 'Fixture');
    writeFileSync(join(repository, 'a.txt'), 'one\n');
    git('add', 'a.txt');
    git('commit', '--quiet', '-m', 'initial');
    writeFileSync(join(repository, 'a.txt'), 'two\n');
    const host = repositoryHost(repository);
    let state = null;
    const run = (name, payload = '') => {
      const reply = command(host, name, payload, state);
      state = reply.state;
      return reply.value;
    };
    run('refresh');
    assert.deepEqual(run('act', 'stage'), { display: 'staged a.txt' });
    assert.equal(git('diff', '--cached', '--name-only'), 'a.txt\n');
    assert.deepEqual(run('act', 'unstage'), { display: 'unstaged a.txt' });
    assert.equal(git('diff', '--cached', '--name-only'), '');
    run('act', 'stage');
    run('message', 'Change a');
    assert.equal(run('commit'), null);
    assert.match(run('confirm').display, /^committed [0-9a-f]{7}$/);
    assert.equal(git('log', '-1', '--format=%s'), 'Change a\n');
    assert.equal(git('status', '--porcelain'), '');
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});
