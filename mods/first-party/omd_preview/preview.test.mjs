import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callback } from '../../../tests/mod_runner.mjs';

const mod = new URL('./', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('mod.json', mod), 'utf8'));
const read = name => readFileSync(new URL(name, mod), 'utf8');
const source = read('index.ts');
const assets = Object.fromEntries(manifest.assets.map(name => [name, { text: read(name), sha256: '0'.repeat(64) }]));
let responses = ['Latest **answer** with <script>alert(1)</script> and [x](javascript:alert(1))', 'Earlier answer'];

const stores = new Map();
const watching = repository => stores.get(`${repository}\0watch`)?.value;
let racing = null;
let unborn = null;
let watchIds = 0;
let thread = 'thread-1';
let statFails = false;
let live = new Map();
let current = 'A';
const processes = {};
const enter = name => {
  processes[current] = { live, ids: watchIds };
  current = name;
  ({ live, ids: watchIds } = processes[name] ?? { live: new Map(), ids: 0 });
};
const slot = (repository, args) => `${repository}\0${args?.scope === 'thread' ? `${thread}\0` : ''}${args?.key}`;
const restart = () => {
  enter('A');
  live.clear();
  watchIds = 0;
};

function invoke(repository, state, event, payload, name, settings = {}, modSource = source) {
  const calls = [];
  const host = call => {
    const { operation, arguments: args } = call;
    calls.push(call);
    const key = slot(repository, args);
    if (operation === 'session.info') {
      if (unborn === 'thread') throw new Error('model_call_requires_a_session_thread');
      return { thread_id: 'thread-1', process_id: current };
    }
    if (operation === 'store.get') return stores.get(key) ?? null;
    if (operation === 'store.delete') {
      assert.equal(stores.get(key)?.revision, args.expected_revision);
      return { deleted: stores.delete(key) };
    }
    const keyed = () => [...live].find(([, watch]) => args.key && watch.key === args.key)?.[0];
    if (operation === 'workspace.watch') {
      for (const path of args.paths) assert.ok(existsSync(join(repository, path)), `watch_path_missing: ${path}`);
      const previous = keyed();
      if (previous) live.delete(previous);
      else if (live.size >= 16) throw new Error('watch_limit');
      live.set(`w${++watchIds}`, { thread, key: args.key });
      return { watch_id: `w${watchIds}` };
    }
    if (operation === 'workspace.unwatch') return { stopped: live.delete(args.watch_id ?? keyed()) };
    if (operation === 'store.put') {
      assert.notEqual(args.value, null, 'store_value_required');
      racing?.(key);
      racing = null;
      const revision = (stores.get(key)?.revision ?? null);
      if (revision !== args.expected_revision) throw new Error('store_revision_conflict');
      stores.set(key, { value: args.value, revision: (revision ?? 0) + 1 });
      return { revision: (revision ?? 0) + 1 };
    }
    if (operation === 'app.request') {
      if (unborn === 'turns') throw new Error('thread/turns/list failed: thread thread-1 is not materialized yet; thread/turns/list is unavailable before first user message');
      assert.deepEqual(args, { method: 'thread/turns/list', params: { threadId: 'thread-1', limit: args.params.limit, itemsView: 'summary' } });
      return { data: responses.slice(0, args.params.limit).map(text => ({ items: [{ type: 'userMessage' }, { type: 'agentMessage', text }] })) };
    }
    if (operation === 'workspace.stat') {
      if (statFails) throw new Error('workspace_busy');
      assert.ok(args.paths.every(path => !path.split('/').includes('.')), 'the host rejects . path parts');
      return { files: Object.fromEntries(args.paths.map(name => {
        const path = join(repository, name);
        if (statSync(path, { throwIfNoEntry: false })?.isDirectory()) return [name, { kind: 'dir', size: 0, mtime_ms: 0 }];
        return [name, statSync(path, { throwIfNoEntry: false })?.isFile() ? { kind: 'file', size: statSync(path).size, mtime_ms: 0, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') } : null];
      })) };
    }
    if (operation === 'exec.run') {
      assert.equal(Boolean(args.write), args.program === 'node');
      const run = spawnSync(args.program, args.argv, { cwd: repository, input: args.stdin, encoding: 'utf8' });
      return { exit_code: run.status, stdout: run.stdout, stderr: run.stderr };
    }
    if (operation === 'terminal.open') return { opened: true };
    if (operation === 'sessions.ports') return { ports: [{ port: 3000, pid: 7, address: '127.0.0.1:3000' }, { port: 5173, pid: 8, address: '*:5173' }] };
    if (operation === 'events.publish') return { delivered: 1, dropped: 0 };
    if (operation === 'events.schedule') return { key: args.key, delay_ms: args.delay_ms };
    assert.fail(`unexpected preview host operation: ${operation}`);
  };
  const request = { source: modSource, filename: fileURLToPath(new URL('index.ts', mod)), entrypoint: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, state, settings, event, name, payload,
    hook_budget_ms: 10000, assets };
  const output = callback(request, host);
  if (output.error) throw new Error(output.error);
  return { value: output.value, state: output.state, calls, registrations: output.registrations };
}

test('preview renders sanitized HTML for responses and files, keeps watched files fresh and shows inline dialogs', () => {
  const repository = realpathSync(mkdtempSync(join(tmpdir(), 'omd-preview-')));
  try {
    mkdirSync(join(repository, 'docs'));
    writeFileSync(join(repository, 'docs/a.md'), '# Doc\n\n![pic](pic.png) $x^2$\n\n```mermaid\ngraph TD; A-->B;\n```\n');
    const command = (text, state = null) => invoke(repository, state, 'command', text, 'preview');

    const last = command('');
    const opened = last.calls.find(call => call.operation === 'terminal.open').arguments.path;
    const html = readFileSync(opened, 'utf8');
    assert.equal(opened, join(repository, '.omd/preview/response.html'));
    assert.match(html, /<strong>answer<\/strong> with &#60;script&#62;alert\(1\)&#60;\/script&#62; and x<\/p>/);
    assert.doesNotMatch(html, /javascript:|<script>alert/);
    const [, init] = /<script>([\s\S]*?)<\/script><\/body>/.exec(html);
    assert.ok(html.includes(`'sha256-${createHash('sha256').update(init).digest('base64')}'`));
    assert.doesNotMatch(html, /npm\/(katex|mermaid|@highlightjs)/);
    for (unborn of ['thread', 'turns']) {
      assert.match(command('').value.display, /^No response/);
      assert.match(command('list').value.display, /^No responses/);
    }
    unborn = null;
    assert.match(command('list').value.display, /Latest \*\*answer\*\*.*\n2\. Earlier answer/);
    assert.match(command('missing.md').value.display, /^No file missing\.md/);
    assert.equal(command('--inline docs/my  report.md').value.display, 'No file docs/my  report.md in the workspace');
    writeFileSync(join(repository, 'docs/my  report.md'), 'spaced');
    assert.equal(command('docs/my  report.md --inline').state.inline.text, 'spaced');

    const watched = command('docs/a.md --watch');
    assert.deepEqual(watching(repository).watch, ['docs/a.md']);
    const page = readFileSync(join(repository, '.omd/preview/files/docs/a.md.html'), 'utf8');
    assert.match(page, /data-watch="1"/);
    assert.match(page, /src="\.\.\/\.\.\/\.\.\/\.\.\/docs\/pic\.png"/);
    assert.match(page, /<span class="math">\\\(x\^2\\\)<\/span>/);
    assert.match(page, /mermaid@[\d.]+\/dist\/mermaid\.min\.js" integrity="sha384-/);

    const change = path => ({ repository, source: 'external', call_id: null, watch_id: 'w1', changes: [{ path, before: null, after: null }], status: 'observed' });
    writeFileSync(join(repository, 'docs/a.md'), '# First change\n');
    assert.equal(invoke(repository, watched.state, 'workspace_change', change('docs/other.md')).calls.some(call => call.operation === 'exec.run'), false);
    const synced = invoke(repository, watched.state, 'workspace_change', change('docs/a.md'));
    assert.match(readFileSync(join(repository, '.omd/preview/files/docs/a.md.html'), 'utf8'), /First change/);
    writeFileSync(join(repository, 'docs/a.md'), '# Changed [[Other note|see]]\n');
    const polled = invoke(repository, synced.state, 'workspace_change', change('docs/a.md'));
    assert.equal(polled.calls.filter(call => call.operation === 'exec.run').length, 1);
    assert.match(readFileSync(join(repository, '.omd/preview/files/docs/a.md.html'), 'utf8'), /Changed <a href="[^"]*docs\/Other%20note\.md">see<\/a>/);
    command('unwatch');
    assert.deepEqual(watching(repository).watch, []);
    const stopped = invoke(repository, null, 'channel', { channel: 'omd_preview/watch', data: null });
    assert.deepEqual(stopped.calls.find(call => call.operation === 'workspace.unwatch').arguments, { key: 'files' });
    assert.ok(invoke(repository, null, 'timer', { key: 'poll' }).calls.some(call => call.operation === 'workspace.unwatch'));

    const inline = command('docs/a.md --inline');
    const view = invoke(repository, inline.state, 'terminal', { event: 'redraw', ledger: null }).value;
    const dialog = view.sites.dialog.components[0];
    assert.equal(dialog.children[0].children[0].text, '# Changed [[Other note|see]]\n');
    writeFileSync(join(repository, 'server'), 'not a server');
    assert.equal(command('./server --inline').state.inline.text, 'not a server', './ names a file that shadows a subcommand');
    assert.equal(command('close', inline.state).state.inline, null);
    assert.equal(invoke(repository, { ...inline.state, inline: null }, 'terminal', { event: 'redraw', ledger: null }).value, null);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

const watchedRepository = () => {
  const repository = realpathSync(mkdtempSync(join(tmpdir(), 'omd-preview-watch-')));
  mkdirSync(join(repository, 'docs'));
  writeFileSync(join(repository, 'docs/a.md'), '# Doc\n');
  invoke(repository, null, 'command', 'docs/a.md --watch', 'preview');
  restart();
  thread = 'thread-1';
  return repository;
};
const lifecycle = (repository, event, owner, restarted = false) => {
  thread = owner;
  return invoke(repository, null, event, event === 'resume' ? { thread_id: owner, last_turn: null, restarted } : null);
};

test('one keyed watch serves each process: threads replace it, processes keep their own, and retries re-place it with backoff', () => {
  const repository = watchedRepository();
  const renders = run => run.calls.filter(call => call.operation === 'exec.run').length;
  const change = id => ({ repository, source: 'external', call_id: null, watch_id: id, changes: [{ path: 'docs/a.md', before: null, after: null }], status: 'observed' });
  try {
    for (let index = 0; index < 20; index += 1) lifecycle(repository, 'start', `thread-${index}`);
    assert.deepEqual([...live].map(([, watch]) => watch.thread), ['thread-19']);
    lifecycle(repository, 'resume', 'thread-3', true);
    assert.deepEqual([...live].map(([, watch]) => watch.thread), ['thread-3']);

    restart();
    lifecycle(repository, 'start', 'thread-1');
    enter('B');
    watchIds = 2;
    const other = lifecycle(repository, 'start', 'thread-1');
    assert.equal(other.calls.some(call => call.operation === 'workspace.unwatch'), false);
    assert.deepEqual([...live.keys()], ['w3']);
    enter('A');
    assert.deepEqual([...live.keys()], ['w1']);
    writeFileSync(join(repository, 'docs/a.md'), '# Edited once\n');
    const first = invoke(repository, null, 'workspace_change', change('w1'));
    enter('B');
    const second = invoke(repository, null, 'workspace_change', change('w3'));
    assert.equal(renders(first) + renders(second), 1);
    assert.deepEqual([...live.keys()], ['w3']);
    enter('A');

    restart();
    writeFileSync(join(repository, 'b.md'), '# B\n');
    invoke(repository, null, 'command', 'b.md --watch', 'preview');
    lifecycle(repository, 'start', 'thread-1');
    rmSync(join(repository, 'b.md'));
    let state = null;
    const delays = [];
    const poll = () => {
      const run = invoke(repository, state, 'timer', { key: 'poll' });
      state = run.state;
      delays.push(...run.calls.filter(call => call.operation === 'events.schedule').map(call => call.arguments.delay_ms));
      return run.calls.map(call => call.operation);
    };
    assert.ok(poll().includes('workspace.watch'));
    for (let pass = 0; pass < 3; pass += 1) {
      const operations = poll();
      assert.ok(operations.includes('workspace.watch') && operations.includes('events.schedule'));
    }
    assert.deepEqual([...live].map(([, watch]) => watch.key), ['files']);
    writeFileSync(join(repository, 'b.md'), '# B\n');
    assert.ok(poll().includes('workspace.watch'));
    assert.equal(poll().includes('events.schedule'), false);
    assert.deepEqual(delays, [4000, 8000, 16000, 32000]);
  } finally {
    restart();
    processes.B = undefined;
    rmSync(repository, { recursive: true, force: true });
  }
});

test('a failed stat keeps the watch and retries; a missing file waits on its parent directory instead of polling', () => {
  const repository = watchedRepository();
  const poll = () => invoke(repository, null, 'timer', { key: 'poll' });
  const retried = run => run.calls.some(call => call.operation === 'events.schedule' && call.arguments.key === 'poll');
  const change = path => ({ repository, source: 'external', call_id: null, watch_id: 'w1', changes: [{ path, before: null, after: null }], status: 'observed' });
  try {
    lifecycle(repository, 'start', 'thread-1');
    assert.deepEqual([...live.keys()], ['w1']);
    statFails = true;
    const failed = poll();
    statFails = false;
    assert.deepEqual([...live.keys()], ['w1']);
    assert.equal(retried(failed), true);
    assert.equal(failed.calls.some(call => call.operation === 'workspace.unwatch'), false);
    rmSync(join(repository, 'docs/a.md'));
    const missing = poll();
    assert.equal(retried(missing), false);
    assert.deepEqual(missing.calls.filter(call => call.operation === 'workspace.watch').map(call => call.arguments.paths), [['docs']]);
    assert.equal(live.size, 1);
    writeFileSync(join(repository, 'docs/a.md'), '# Back\n');
    const back = invoke(repository, null, 'workspace_change', change('docs/a.md'));
    assert.equal(back.calls.some(call => call.operation === 'exec.run'), true);
    assert.equal(retried(back), false);
  } finally {
    statFails = false;
    restart();
    rmSync(repository, { recursive: true, force: true });
  }
});

test('preview replaces a planted page link and refuses a linked output directory without touching their targets', () => {
  const repository = realpathSync(mkdtempSync(join(tmpdir(), 'omd-preview-links-')));
  try {
    writeFileSync(join(repository, 'README.md'), '# Readme\n');
    writeFileSync(join(repository, 'victim.txt'), 'keep me\n');
    mkdirSync(join(repository, '.omd/preview/files'), { recursive: true });
    symlinkSync('../../../victim.txt', join(repository, '.omd/preview/files/README.md.html'));
    const command = () => invoke(repository, null, 'command', 'README.md', 'preview').value.display;
    command();
    assert.equal(readFileSync(join(repository, 'victim.txt'), 'utf8'), 'keep me\n');
    assert.match(readFileSync(join(repository, '.omd/preview/files/README.md.html'), 'utf8'), /Readme/);
    assert.ok(lstatSync(join(repository, '.omd/preview/files/README.md.html')).isFile());
    rmSync(join(repository, '.omd/preview/files'), { recursive: true });
    mkdirSync(join(repository, 'elsewhere'));
    symlinkSync('../../elsewhere', join(repository, '.omd/preview/files'));
    assert.doesNotMatch(command(), /^Opened/);
    assert.deepEqual(readdirSync(join(repository, 'elsewhere')), []);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test('inline file previews read a bounded prefix and refuse content whose JSON escaping exceeds the callback budget', () => {
  const repository = realpathSync(mkdtempSync(join(tmpdir(), 'omd-preview-inline-')));
  try {
    writeFileSync(join(repository, 'big.txt'), 'x'.repeat(200_000));
    writeFileSync(join(repository, 'quotes.diff'), '"'.repeat(60_000));
    writeFileSync(join(repository, 'control.diff'), '\u0001'.repeat(60_000));
    const command = text => invoke(repository, null, 'command', text, 'preview');
    const big = command('big.txt --inline');
    assert.equal(big.state.inline.text, 'x'.repeat(4_000));
    const quotes = command('quotes.diff --inline');
    assert.ok(quotes.state.inline.text.length > 25_000 && JSON.stringify(quotes.state.inline.text).length <= 60_000);
    assert.match(quotes.value.display, /^Showing only the start inline/);
    writeFileSync(join(repository, 'lock.diff'), Array.from({ length: 12_000 }, (_, index) => `+${index}`).join('\n'));
    const lock = command('lock.diff --inline');
    assert.equal(lock.state.inline.text.split('\n').length, 2_000);
    assert.match(lock.value.display, /^Showing only the start inline/);
    const control = command('control.diff --inline');
    assert.match(control.value.display, /host_result_limit/);
    assert.equal(control.state, null);
    writeFileSync(join(repository, 'snow.md'), '雪'.repeat(2_000));
    assert.equal(command('snow.md --inline').state.inline.text, '雪'.repeat(1_333));
    writeFileSync(join(repository, 'image.md'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00, 0x41]));
    const binary = command('image.md --inline');
    assert.match(binary.value.display, /not UTF-8/);
    assert.equal(binary.state, null);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

