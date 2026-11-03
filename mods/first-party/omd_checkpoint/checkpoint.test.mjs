import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callback } from '../../../tests/mod_runner.mjs';

const mod = new URL('./', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('mod.json', mod), 'utf8'));
const source = readFileSync(new URL('index.ts', mod), 'utf8');

const sh = (cwd, ...argv) => {
  const run = spawnSync('git', argv, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'u', GIT_AUTHOR_EMAIL: 'u@x', GIT_COMMITTER_NAME: 'u', GIT_COMMITTER_EMAIL: 'u@x' } });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout;
};
const write = (root, path, data) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), data);
};
const text = (root, path) => existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : null;
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');

function repo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'omd-checkpoint-')));
  sh(root, 'init', '-q', '-b', 'main');
  write(root, '.gitignore', 'build/\n');
  write(root, 'a.txt', 'one\n');
  write(root, 'b.txt', 'bee\n');
  write(root, 'tool.sh', '#!/bin/sh\n');
  chmodSync(join(root, 'tool.sh'), 0o755);
  sh(root, 'add', '-A');
  sh(root, 'commit', '-qm', 'base');
  write(root, 'notes.txt', 'mine, untracked\n');
  write(root, 'build/out.txt', 'ignored\n');
  return root;
}

function host(root, world) {
  return ({ operation, arguments: args }) => {
    world.calls.push(operation);
    if (operation === 'session.info') assert.ok(manifest.capabilities.includes('inventory'), 'api.session() needs inventory');
    if (operation === 'session.info') return { thread_id: world.thread ?? 't1', root, cwd: world.cwd ?? root, codex_version: '0', model: 'm', provider: 'p', route: null, turns_started: 1, process_id: 'p' };
    if (operation === 'exec.run') {
      assert.equal(args.program, 'git');
      assert.equal(args.sandbox, 'none');
      for (const name of Object.keys(args.env ?? {})) assert.ok(manifest.exec_environment.includes(name), `env ${name} must be in exec_environment`);
      assert.ok(args.argv.length <= 128 && (args.stdin ?? '').length <= 65_536, 'exec.run limits');
      const run = spawnSync('git', args.argv, { cwd: args.cwd, input: args.stdin ?? '', encoding: 'utf8', timeout: args.timeout_ms * 20,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_GLOBAL: '/dev/null', ...args.env } });
      return { exit_code: run.status, signal: null, stdout: run.stdout, stderr: run.stderr, stdout_truncated: false, stdout_preview_truncated: false, timed_out: false };
    }
    if (operation === 'workspace.check_access') {
      if (world.readOnly) throw new Error('workspace_write_permission_denied');
      return { paths: args.paths, write: args.write };
    }
    if (operation === 'workspace.stat') {
      return { files: Object.fromEntries(args.paths.map(path => {
        const full = join(root, path);
        if (!existsSync(full)) return [path, null];
        const stat = lstatSync(full);
        const kind = stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'dir' : 'file';
        return [path, { kind, size: stat.size, mtime_ms: stat.mtimeMs, ...kind === 'file' && args.hash ? { sha256: sha(full) } : {} }];
      })) };
    }
    if (operation === 'workspace.transaction') {
      for (const [path, expected] of Object.entries(args.expected)) if (sha(join(root, path)) !== expected) throw new Error('workspace_stale');
      for (const path of args.deletes ?? []) unlinkSync(join(root, path));
      return { files: Object.fromEntries((args.deletes ?? []).map(path => [path, null])) };
    }
    throw new Error(`unexpected host operation ${operation}`);
  };
}

function session(root, world = {}) {
  const box = { state: null, world: { calls: [], ...world } };
  const run = (event, payload, name) => {
    const output = callback({ source, filename: fileURLToPath(new URL('index.ts', mod)), entrypoint: 'index.ts', assets: {}, api: manifest.api,
      capabilities: manifest.capabilities, settings: {}, state: box.state, event, name, payload, hook_budget_ms: 30_000 }, host(root, box.world));
    if (output.error) throw new Error(output.error);
    box.state = output.state ?? box.state;
    return output.value;
  };
  return {
    box,
    turn(id, edit) {
      run('turn_start', { turn_id: id });
      edit();
      run('turn_end', { turn_id: id, outcome: 'completed' });
    },
    start: id => run('turn_start', { turn_id: id }),
    end: id => run('turn_end', { turn_id: id, outcome: 'completed' }),
    command: (name, args = '') => run('command', args, name)?.display ?? null,
  };
}

const agent = root => () => {
  write(root, 'a.txt', 'two\n');
  unlinkSync(join(root, 'b.txt'));
  write(root, 'new.txt', 'brand new\n');
  write(root, 'deep/dir/blob.bin', Buffer.from([0, 255, 1, 254, 0, 10]));
  write(root, 'notes.txt', 'agent rewrote my notes\n');
  write(root, 'build/out.txt', 'agent rebuilt\n');
  chmodSync(join(root, 'tool.sh'), 0o644);
};

test('/undo restores modified, deleted and untracked files, removes new ones, and leaves the index, HEAD and ignored files alone', () => {
  const root = repo();
  try {
    write(root, 'staged.txt', 'staged by me\n');
    sh(root, 'add', 'staged.txt');
    const index = sh(root, 'diff', '--cached', '--name-status');
    const head = sh(root, 'rev-parse', 'HEAD');
    const s = session(root);
    s.turn('t-1', agent(root));
    assert.equal(sh(root, 'diff', '--cached', '--name-status'), index, 'snapshots never touch the real index');
    assert.match(s.command('undo', 'list'), /1\. .* completed turn, 6 files: /);

    const done = s.command('undo');
    assert.match(done, /^Undid the .* turn: Restored 4 files and deleted 2 files\. \/redo puts it back\./);
    assert.deepEqual(['a.txt', 'b.txt', 'notes.txt', 'new.txt', 'deep/dir/blob.bin'].map(path => text(root, path)), ['one\n', 'bee\n', 'mine, untracked\n', null, null]);
    assert.equal(lstatSync(join(root, 'tool.sh')).mode & 0o777, 0o755);
    assert.equal(text(root, 'build/out.txt'), 'agent rebuilt\n', 'ignored files are not tracked');
    assert.equal(sh(root, 'diff', '--cached', '--name-status'), index);
    assert.equal(sh(root, 'rev-parse', 'HEAD'), head);
    assert.equal(sh(root, 'branch', '--list').trim(), '* main');

    assert.match(s.command('undo'), /already undone/);
    assert.match(s.command('redo'), /^Redid the .* turn: Restored 5 files and deleted 1 file\./);
    assert.deepEqual(['a.txt', 'b.txt', 'new.txt', 'notes.txt'].map(path => text(root, path)), ['two\n', null, 'brand new\n', 'agent rewrote my notes\n']);
    assert.deepEqual([...readFileSync(join(root, 'deep/dir/blob.bin'))], [0, 255, 1, 254, 0, 10]);
    assert.match(s.command('redo'), /Nothing to redo/);
    assert.match(s.command('undo'), /^Undid/);
    assert.equal(text(root, 'a.txt'), 'one\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('edits made after the turn block /undo until force, and force keeps them for /redo', () => {
  const root = repo();
  try {
    const s = session(root);
    s.turn('t-1', agent(root));
    write(root, 'a.txt', 'my fix after the turn\n');
    const refused = s.command('undo');
    assert.match(refused, /^Not done: 1 file changed since: a\.txt\. Undoing would overwrite those edits\. Run \/undo force/);
    assert.equal(text(root, 'new.txt'), 'brand new\n', 'a refused undo changes nothing');
    write(root, 'new.txt', 'I kept working on it\n');
    assert.match(s.command('undo'), /2 files changed since: a\.txt, new\.txt\./);
    assert.match(s.command('undo', 'force'), /^Undid/);
    assert.deepEqual([text(root, 'a.txt'), text(root, 'new.txt')], ['one\n', null]);
    assert.match(s.command('redo'), /^Redid/);
    assert.deepEqual([text(root, 'a.txt'), text(root, 'new.txt')], ['my fix after the turn\n', 'I kept working on it\n']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('turns step back one at a time, a new turn drops redo, and a running turn or no changes leave nothing to undo', () => {
  const root = repo();
  try {
    const s = session(root);
    s.turn('t-0', () => {});
    assert.match(s.command('undo'), /No turn with file changes recorded in this repository/);
    s.turn('t-1', () => write(root, 'a.txt', 'two\n'));
    s.turn('t-2', () => write(root, 'a.txt', 'three\n'));
    s.start('t-3');
    assert.match(s.command('undo'), /A turn is running/);
    s.end('t-3');
    assert.match(s.command('undo'), /Restored 1 file\./);
    assert.equal(text(root, 'a.txt'), 'two\n');
    assert.match(s.command('undo'), /Restored 1 file\./);
    assert.equal(text(root, 'a.txt'), 'one\n');
    assert.match(s.command('undo'), /already undone/);
    s.turn('t-4', () => write(root, 'b.txt', 'changed\n'));
    assert.match(s.command('redo'), /Nothing to redo/);
    assert.match(s.command('undo', 'list'), /^Checkpoints in this repository, newest first:\n1\. .* 1 file: b\.txt$/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('agent commits stay, a later session can undo the checkout\'s last turn, and old checkpoints release their refs', () => {
  const root = repo();
  try {
    const s = session(root);
    s.turn('t-1', () => {
      write(root, 'a.txt', 'committed by the agent\n');
      sh(root, 'commit', '-qam', 'agent commit');
    });
    const head = sh(root, 'rev-parse', 'HEAD');
    assert.match(s.command('undo'), /Restored 1 file\. \/redo puts it back\. Commits and branches are unchanged\./);
    assert.equal(sh(root, 'rev-parse', 'HEAD'), head);
    assert.equal(text(root, 'a.txt'), 'one\n');

    s.box.world.thread = 't2';
    s.turn('other-session', () => write(root, 'b.txt', 'from a later session\n'));
    assert.match(s.command('undo'), /Restored 1 file\./);
    assert.equal(text(root, 'b.txt'), 'bee\n');
    s.box.world.thread = 't1';
    for (let index = 0; index < 13; index += 1) s.turn(`many-${index}`, () => write(root, 'c.txt', `${index}\n`));
    const refs = sh(root, 'for-each-ref', '--format=%(refname)', 'refs/omd/checkpoints/').trim().split('\n');
    const wanted = new Set(s.box.state.entries.flatMap(entry => [entry.before, entry.after, ...entry.undone ? [entry.undone.before, entry.undone.after] : []]));
    assert.equal(s.box.state.entries.length, 10);
    assert.deepEqual(new Set(refs.map(ref => ref.split('/').at(-1))), wanted);
    assert.equal(sh(root, 'log', '--oneline', 'main').trim().split('\n').length, 2, 'checkpoints never appear on a branch');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('outside a Git repository or without write access it explains itself and changes nothing', () => {
  const plain = realpathSync(mkdtempSync(join(tmpdir(), 'omd-checkpoint-plain-')));
  const root = repo();
  try {
    const outside = session(plain);
    outside.turn('t-1', () => write(plain, 'x.txt', 'x\n'));
    assert.match(outside.command('undo'), /No turn with file changes recorded in this repository yet\. Last problem: .*(not a git repository|Not a git repository)/i);

    const s = session(root, { readOnly: true });
    s.turn('t-1', agent(root));
    assert.match(s.command('undo'), /^Not done: this session can't write /);
    assert.equal(text(root, 'a.txt'), 'two\n');
    assert.match(s.command('undo', 'nonsense'), /^Usage: \/undo \[force\|list\]/);
  } finally {
    rmSync(plain, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
