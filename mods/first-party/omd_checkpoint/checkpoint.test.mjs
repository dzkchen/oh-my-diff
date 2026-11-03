import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
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
      if (args.argv.length > 128 || Buffer.byteLength(args.stdin ?? '') > 65_536) throw new Error('exec_arguments_invalid');
      if (world.failRestore && args.argv.includes('restore')) {
        world.failRestore = false;
        return { exit_code: 1, signal: null, stdout: '', stderr: 'simulated failure', stdout_truncated: false, stdout_preview_truncated: false, timed_out: false };
      }
      const run = spawnSync('git', args.argv, { cwd: args.cwd ?? root, input: args.stdin ?? '', timeout: args.timeout_ms * 20,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_GLOBAL: '/dev/null', ...args.env } });
      const out = run.stdout;
      const base = { exit_code: run.status, signal: null, stderr: run.stderr.toString(), timed_out: false, stdout_bytes: out.length };
      if (args.output_artifact) {
        if (out.length > (args.max_output_bytes ?? 16 << 20)) throw new Error('exec_output_artifact_limit');
        world.artifacts.push(out);
        return { ...base, stdout: out.subarray(0, 4096).toString(), stdout_truncated: false, stdout_preview_truncated: out.length > 4096,
          output_artifact: { reference: String(world.artifacts.length - 1), sha256: '0'.repeat(64) } };
      }
      const kept = out.subarray(0, args.max_output_bytes ?? 1 << 20);
      return { ...base, stdout: kept.subarray(0, 65_536).toString(), stdout_truncated: kept.length < out.length, stdout_preview_truncated: kept.length > 65_536 };
    }
    if (operation === 'exec.output_page') {
      const all = world.artifacts[Number(args.artifact.reference)];
      const end = Math.min(all.length, args.cursor + args.max_bytes);
      return { text: all.subarray(args.cursor, end).toString(), cursor: end < all.length ? end : null, bytes: end - args.cursor, sha256: '0'.repeat(64) };
    }
    if (operation === 'workspace.list') {
      const entries = [];
      const walk = relative => {
        for (const name of readdirSync(join(root, relative))) {
          const path = relative ? `${relative}/${name}` : name;
          const stat = lstatSync(join(root, path));
          entries.push({ path, kind: stat.isDirectory() ? 'dir' : stat.isSymbolicLink() ? 'symlink' : 'file', size: stat.size, mtime_ms: stat.mtimeMs });
          if (stat.isDirectory() && args.recursive) walk(path);
        }
      };
      walk(args.path ?? '');
      return { entries, truncated: false };
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
      for (const [path, expected] of Object.entries(args.expected)) if (!existsSync(join(root, path)) || sha(join(root, path)) !== expected) throw new Error('workspace_stale');
      for (const path of args.deletes ?? []) unlinkSync(join(root, path));
      return { files: Object.fromEntries((args.deletes ?? []).map(path => [path, null])) };
    }
    throw new Error(`unexpected host operation ${operation}`);
  };
}

function session(root, world = {}) {
  const box = { state: null, world: { calls: [], artifacts: [], ...world } };
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

test('turns step back one at a time, redo survives a later turn, and a running turn or no changes leave nothing to undo', () => {
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
    assert.match(s.command('undo', 'list'), /^Checkpoints in this repository, newest first:\n1\. .* 1 file: b\.txt\n2\. .*\(undone; \/redo restores it\)/);
    assert.match(s.command('redo'), /Restored 1 file\./);
    assert.deepEqual([text(root, 'a.txt'), text(root, 'b.txt')], ['two\n', 'changed\n'], 'a later turn keeps redo safe: it only touches its own files');
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

test('a turn that touches hundreds of long paths is read in full and undone in full', () => {
  const root = repo();
  try {
    const s = session(root);
    const names = Array.from({ length: 700 }, (_, index) => `generated/${'segment-'.repeat(10)}${String(index).padStart(4, '0')}.txt`);
    s.turn('big', () => names.forEach(name => write(root, name, `${name}\n`)));
    assert.match(s.command('undo', 'list'), /700 files/);
    assert.ok(s.box.world.calls.includes('exec.output_page'), 'the diff is paged, not cut at the preview');
    assert.match(s.command('undo'), /Deleted 700 files\./);
    assert.equal(names.filter(name => existsSync(join(root, name))).length, 0);
    assert.match(s.command('redo'), /Restored 700 files\./);
    assert.equal(names.filter(name => existsSync(join(root, name))).length, 700);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a file the turn replaced with a directory comes back only when nothing else lives in that directory', () => {
  const root = repo();
  try {
    const s = session(root);
    s.turn('t-1', () => {
      unlinkSync(join(root, 'a.txt'));
      write(root, 'a.txt/inner.txt', 'agent\n');
    });
    write(root, 'a.txt/mine.txt', 'my untracked file\n');
    write(root, '.gitignore', 'build/\n*.log\n');
    sh(root, 'add', '.gitignore');
    sh(root, 'commit', '-qm', 'ignore logs');
    write(root, 'a.txt/debug.log', 'ignored\n');
    for (const args of ['', 'force']) {
      assert.match(s.command('undo', args), /^Not done: a\.txt is now a directory that also holds a\.txt\/debug\.log, a\.txt\/mine\.txt/);
    }
    assert.deepEqual([text(root, 'a.txt/mine.txt'), text(root, 'a.txt/debug.log'), text(root, 'a.txt/inner.txt')], ['my untracked file\n', 'ignored\n', 'agent\n']);
    unlinkSync(join(root, 'a.txt/mine.txt'));
    unlinkSync(join(root, 'a.txt/debug.log'));
    assert.match(s.command('undo'), /Restored 1 file and deleted 1 file\./);
    assert.equal(text(root, 'a.txt'), 'one\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an undo that fails halfway finishes on the next /undo without force', () => {
  const root = repo();
  try {
    const s = session(root);
    s.turn('t-1', agent(root));
    s.box.world.failRestore = true;
    assert.match(s.command('undo'), /^Checkpoints are unavailable here: simulated failure/);
    assert.equal(text(root, 'new.txt'), null, 'the deletes already ran');
    assert.equal(text(root, 'a.txt'), 'two\n');
    assert.match(s.command('undo'), /^Undid the .* turn: Restored 4 files\./);
    assert.deepEqual(['a.txt', 'b.txt', 'notes.txt', 'new.txt'].map(path => text(root, path)), ['one\n', 'bee\n', 'mine, untracked\n', null]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a turn still marked running after three hours no longer blocks undo, and force-added ignored files are covered', () => {
  const root = repo();
  try {
    write(root, 'build/keep.txt', 'tracked though ignored\n');
    sh(root, 'add', '-f', 'build/keep.txt');
    sh(root, 'commit', '-qm', 'force-add');
    const s = session(root);
    s.turn('t-1', () => write(root, 'build/keep.txt', 'agent edit\n'));
    assert.match(s.command('undo', 'list'), /1 file: build\/keep\.txt/);
    s.box.state.pending = { crashed: { turn: 'x', before: s.box.state.entries[0].before, at: Date.now() - 4 * 3600 * 1000 } };
    assert.match(s.command('undo'), /Restored 1 file\./);
    assert.equal(text(root, 'build/keep.txt'), 'tracked though ignored\n');
    s.box.state.pending = { live: { turn: 'y', before: s.box.state.entries[0].before, at: Date.now() } };
    assert.match(s.command('redo'), /A turn is running/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
