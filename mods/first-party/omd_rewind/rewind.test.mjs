import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { callback } from '../../../tests/mod_runner.mjs';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('./mod.json', import.meta.url), 'utf8'));
const sha = text => createHash('sha256').update(text).digest('hex');
const ROOT = '/repo';

function workspace(files, head) {
  const fs = { ...files };
  const backups = {};
  const ops = [];
  const stat = paths => ({ files: Object.fromEntries(paths.map(path => [path, path in fs ? { kind: 'file', size: fs[path].length, mtime_ms: 1, sha256: sha(fs[path]) } : null])) });
  const check = expected => {
    for (const [path, hash] of Object.entries(expected)) assert.equal(path in fs ? sha(fs[path]) : null, hash, `stale ${path}`);
  };
  const host = ({ operation, arguments: args }) => {
    ops.push(operation);
    switch (operation) {
      case 'session.info': return { thread_id: 't', root: ROOT, cwd: ROOT, codex_version: '0.166.0', model: 'm', provider: 'p', route: null, turns_started: 1, process_id: 'p' };
      case 'workspace.stat': return stat(args.paths);
      case 'workspace.backup': {
        check(args.expected);
        const saved = Object.fromEntries(Object.keys(args.expected).map(path => [path, fs[path] ?? null]));
        const ref = sha(JSON.stringify(saved));
        backups[ref] = saved;
        return { backup: { reference: ref, sha256: ref } };
      }
      case 'workspace.restore': {
        check(args.expected);
        const saved = backups[args.backup.sha256];
        assert.deepEqual(Object.keys(saved).sort(), Object.keys(args.expected).sort());
        for (const [path, text] of Object.entries(saved)) if (text === null) delete fs[path]; else fs[path] = text;
        return { files: {} };
      }
      case 'workspace.transaction':
        check(args.expected);
        for (const path of args.deletes ?? []) delete fs[path];
        return { files: {}, backup: null };
      case 'exec.run': {
        assert.equal(args.cwd, undefined, 'exec.run runs at the repository root; an absolute cwd is refused');
        const script = args.argv[1];
        if (script.includes('ls-files')) {
          const dirty = Object.keys(fs).filter(path => head[path] !== fs[path]);
          const deleted = Object.keys(head).filter(path => !(path in fs));
          return { exit_code: 0, timed_out: false, stdout: `h1\n--\n${[...dirty, ...deleted].join('\n')}\n`, stderr: '' };
        }
        assert.equal(args.write, true);
        const [, , , commit, path] = args.argv;
        assert.equal(commit, 'h1');
        fs[path] = head[path];
        return { exit_code: 0, timed_out: false, stdout: '', stderr: '' };
      }
      case 'continuation.next': return { result: { output: 'ok', success: true }, trace: [] };
      default: assert.fail(`unexpected ${operation}`);
    }
  };
  return { fs, ops, host };
}

function session(ws) {
  let state = null;
  const run = (event, name, payload) => {
    const result = callback({ source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, state, settings: {}, event, name, payload, hook_budget_ms: 5000 }, ws.host);
    assert.equal(result.error, undefined, result.error);
    state = result.state ?? state;
    return result.value;
  };
  const tool = (name, args) => {
    const input = { tool: name, arguments: args, call_id: 'c', thread_id: 't', agent_id: null, schema: null, raw_arguments: '', batch: null };
    return run('intercept', '1', { surface: 'tool', input, original: input, origin: { caller: 'model' } });
  };
  const edit = (path, text) => {
    const before = path in ws.fs ? sha(ws.fs[path]) : null;
    if (text === null) delete ws.fs[path]; else ws.fs[path] = text;
    return { path, before, after: text === null ? null : sha(text) };
  };
  return {
    get state() { return state; },
    prompt: text => run('intercept', '0', { surface: 'input', input: { thread_id: 't', text, revision: null, attachments: [], elements: [] }, original: null, origin: { caller: 'user' } }),
    start: id => run('turn_start', '', { turn_id: id }),
    end: id => run('turn_end', '', { turn_id: id, outcome: 'completed' }),
    tool,
    changed: changes => run('workspace_change', '', { repository: ROOT, source: 'tool', call_id: 'c', changes, status: 'observed', reason: null }),
    edit,
    rewind: args => run('command', 'rewind', args),
  };
}

const HEAD = { 'a.txt': 'one', 'b.txt': 'orig', 'gone.txt': 'kept' };

function twoTurns() {
  const ws = workspace({ 'a.txt': 'one', 'b.txt': 'wip', 'gone.txt': 'kept' }, HEAD);
  const s = session(ws);
  s.prompt('fix the login bug');
  s.start('u1');
  s.tool('exec_command', { cmd: 'sed -i s/o/O/ a.txt b.txt; echo new > c.txt; rm gone.txt' });
  s.changed([s.edit('a.txt', 'ONE'), s.edit('b.txt', 'WIP'), s.edit('c.txt', 'new'), s.edit('gone.txt', null)]);
  s.end('u1');
  s.prompt('now add tests');
  s.start('u2');
  s.tool('apply_patch', '*** Begin Patch\n*** Update File: a.txt\n@@\n-ONE\n+TWO\n*** Add File: d.txt\n+d\n*** End Patch');
  s.changed([s.edit('a.txt', 'TWO'), s.edit('d.txt', 'd')]);
  s.end('u2');
  return { ws, s };
}

test('rewinding to the first turn restores shell and patch edits, deletes created files and empties the list', () => {
  const { ws, s } = twoTurns();
  const listed = s.rewind('');
  assert.match(listed.display, /#2 .*"now add tests"  2 files: a\.txt, d\.txt/);
  assert.match(listed.display, /#1 .*"fix the login bug"  4 files: a\.txt, b\.txt, c\.txt \+1/);
  assert.ok(listed.display.indexOf('#2') < listed.display.indexOf('#1'), 'newest first');
  const done = s.rewind('1');
  assert.deepEqual(ws.fs, { 'a.txt': 'one', 'b.txt': 'wip', 'gone.txt': 'kept' });
  assert.match(done.display, /Restored: a\.txt, b\.txt, gone\.txt/);
  assert.match(done.display, /Deleted \(created after the checkpoint\): c\.txt, d\.txt/);
  assert.match(done.insert, /before "fix the login bug"/);
  assert.equal(s.rewind('').display.startsWith('No checkpoints yet'), true);
});

test('rewinding one turn keeps the earlier turn and its checkpoint', () => {
  const { ws, s } = twoTurns();
  s.rewind('2');
  assert.deepEqual(ws.fs, { 'a.txt': 'ONE', 'b.txt': 'WIP', 'c.txt': 'new' });
  assert.match(s.rewind('list').display, /#1 /);
  assert.doesNotMatch(s.rewind('list').display, /#2 /);
});

test('a file edited after the agent needs force, and nothing changes without it', () => {
  const { ws, s } = twoTurns();
  ws.fs['a.txt'] = 'mine';
  const refused = s.rewind('1');
  assert.match(refused.display, /needs `\/rewind 1 force`/);
  assert.match(refused.display, /a\.txt changed after the agent last edited it/);
  assert.equal(ws.fs['a.txt'], 'mine');
  assert.equal(ws.fs['c.txt'], 'new');
  s.rewind('1 force');
  assert.deepEqual(ws.fs, { 'a.txt': 'one', 'b.txt': 'wip', 'gone.txt': 'kept' });
});

test('turns that change nothing leave no checkpoint, a running turn refuses, and bad input shows usage', () => {
  const ws = workspace({ 'a.txt': 'one' }, { 'a.txt': 'one' });
  const s = session(ws);
  s.prompt('just look around');
  s.start('u1');
  s.tool('exec_command', { cmd: 'ls' });
  s.end('u1');
  assert.match(s.rewind('').display, /^No checkpoints yet/);
  s.start('u2');
  assert.match(s.rewind('1').display, /A turn is running/);
  s.end('u2');
  assert.match(s.rewind('x y').display, /^Usage/);
  assert.match(s.rewind('9').display, /no checkpoint #9/);
});

test('an unchanged uncommitted file is backed up once and reused by later turns', () => {
  const ws = workspace({ 'a.txt': 'one', 'b.txt': 'wip' }, { 'a.txt': 'one', 'b.txt': 'orig' });
  const s = session(ws);
  for (const turn of ['u1', 'u2', 'u3']) {
    s.start(turn);
    s.tool('exec_command', { cmd: 'touch a.txt' });
    s.changed([s.edit('a.txt', `${turn}`)]);
    s.end(turn);
  }
  const backups = ws.ops.filter(op => op === 'workspace.backup').length;
  assert.equal(backups, 3, 'b.txt once, then a.txt in turns two and three');
  s.rewind('1');
  assert.deepEqual(ws.fs, { 'a.txt': 'one', 'b.txt': 'wip' });
});
