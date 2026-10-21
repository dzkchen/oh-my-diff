import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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
let draft = { text: '', cursor: 0, selection: null, revision: 1, attachments: [], suggestion: null };

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
    if (operation === 'workspace.watch') {
      if (live.size >= 16) throw new Error('watch_limit');
      live.set(`w${watchIds + 1}`, thread);
      return { watch_id: `w${++watchIds}` };
    }
    if (operation === 'workspace.unwatch') return { stopped: live.delete(args.watch_id) };
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
        return [name, statSync(path, { throwIfNoEntry: false })?.isFile() ? { kind: 'file', size: statSync(path).size, mtime_ms: 0, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') } : null];
      })) };
    }
    if (operation === 'exec.run') {
      assert.equal(Boolean(args.write), args.program === 'node');
      const run = spawnSync(args.program, args.argv, { cwd: repository, input: args.stdin, encoding: 'utf8' });
      return { exit_code: run.status, stdout: run.stdout, stderr: run.stderr };
    }
    if (operation === 'terminal.open') return { opened: true };
    if (operation === 'composer.read') return draft;
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
    assert.equal(last.value.display, 'Opened response 1 in the browser');
    const opened = last.calls.find(call => call.operation === 'terminal.open').arguments.path;
    const html = readFileSync(opened, 'utf8');
    assert.equal(opened, join(repository, '.omd/preview/response.html'));
    assert.match(html, /<strong>answer<\/strong> with &#60;script&#62;alert\(1\)&#60;\/script&#62; and x<\/p>/);
    assert.doesNotMatch(html, /javascript:|<script>alert/);
    const [, init] = /<script>([\s\S]*?)<\/script><\/body>/.exec(html);
    assert.ok(html.includes(`'sha256-${createHash('sha256').update(init).digest('base64')}'`));
    assert.doesNotMatch(html, /npm\/(katex|mermaid|@highlightjs)/);
    assert.equal(command('3').value.display, 'No response 3 in this session');
    for (unborn of ['thread', 'turns']) {
      assert.equal(command('').value.display, 'No response 1 in this session');
      assert.equal(command('list').value.display, 'No responses in this session yet');
    }
    unborn = null;
    assert.equal(command('list').value.display, '1. Latest **answer** with <script>alert(1)</script> and [x](javascript:alert(1))\n2. Earlier answer');
    assert.equal(command('missing.md').value.display, 'No file missing.md in the workspace');

    const watched = command('docs/a.md --watch');
    assert.equal(watched.value.display, 'Opened docs/a.md in the browser');
    assert.deepEqual(watching(repository).watch, ['docs/a.md']);
    assert.ok(watched.calls.findIndex(call => call.operation === 'events.publish') > watched.calls.findIndex(call => call.operation === 'terminal.open'));
    assert.equal(watching(repository).hashes['docs/a.md'], createHash('sha256').update(readFileSync(join(repository, 'docs/a.md'))).digest('hex'));
    const early = invoke(repository, null, 'channel', { channel: 'omd_preview/watch', data: null });
    assert.deepEqual(early.calls.filter(call => call.operation.startsWith('workspace.') && call.operation !== 'workspace.stat').map(call => [call.operation, call.arguments]),
      [['workspace.watch', { paths: ['docs/a.md'], include_ignored: true }]]);
    assert.equal(early.calls.some(call => call.operation === 'events.schedule'), false);
    const page = readFileSync(join(repository, '.omd/preview/files/docs/a.md.html'), 'utf8');
    assert.match(page, /data-watch="1"/);
    assert.match(page, /src="\.\.\/\.\.\/\.\.\/\.\.\/docs\/pic\.png"/);
    assert.match(page, /<span class="math">\\\(x\^2\\\)<\/span>/);
    assert.match(page, /mermaid@12\.0\.0\/dist\/mermaid\.min\.js" integrity="sha384-/);

    const change = path => ({ repository, source: 'external', call_id: null, watch_id: 'w1', changes: [{ path, before: null, after: null }], status: 'observed' });
    writeFileSync(join(repository, 'docs/a.md'), '# First change\n');
    assert.deepEqual(invoke(repository, watched.state, 'workspace_change', change('docs/other.md')).calls.map(call => call.operation), ['session.info', 'store.get', 'store.get']);
    const synced = invoke(repository, watched.state, 'workspace_change', change('docs/a.md'));
    assert.match(readFileSync(join(repository, '.omd/preview/files/docs/a.md.html'), 'utf8'), /First change/);
    assert.equal(synced.calls.some(call => ['events.schedule', 'workspace.watch'].includes(call.operation)), false);
    writeFileSync(join(repository, 'docs/a.md'), '# Changed [[Other note|see]]\n');
    const polled = invoke(repository, synced.state, 'workspace_change', change('docs/a.md'));
    assert.equal(polled.calls.filter(call => call.operation === 'exec.run').length, 1);
    assert.match(readFileSync(join(repository, '.omd/preview/files/docs/a.md.html'), 'utf8'), /<h1 id="[^"]*">Changed <a href="\.\.\/\.\.\/\.\.\/\.\.\/docs\/Other%20note\.md">see<\/a><\/h1>/);
    command('unwatch');
    assert.deepEqual(watching(repository).watch, []);
    const stopped = invoke(repository, null, 'channel', { channel: 'omd_preview/watch', data: null });
    assert.deepEqual(stopped.calls.map(call => call.operation), ['store.get', 'session.info', 'store.get', 'workspace.unwatch', 'store.delete']);
    assert.deepEqual(invoke(repository, null, 'timer', { key: 'poll' }).calls.map(call => call.operation), ['store.get', 'session.info', 'store.get']);

    const inline = command('docs/a.md --inline');
    const view = invoke(repository, inline.state, 'terminal', { event: 'redraw', ledger: null }).value;
    const dialog = view.sites.dialog.components[0];
    assert.equal(dialog.title, 'docs/a.md');
    assert.deepEqual(dialog.children[0].children[0], { type: 'markdown', id: 'omd_preview_body_1', label: 'docs/a.md', text: '# Changed [[Other note|see]]\n' });
    writeFileSync(join(repository, 'image'), 'not a draft image');
    assert.equal(command('./image --inline').state.inline.text, 'not a draft image', './ names a file that shadows a subcommand');
    assert.equal(command('close', inline.state).state.inline, null);
    assert.equal(invoke(repository, { ...inline.state, inline: null }, 'terminal', { event: 'redraw', ledger: null }).value, null);
    assert.match(command('--bogus').value.display, /^usage:/);
    assert.equal(command('docs/a.md --watch --inline').value.display, '/preview: --watch re-renders the browser page; drop --inline to watch it');
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

test('one watch serves the whole process: threads replace it, a displaced watch ends at its first event, and retries only stat', () => {
  const repository = watchedRepository();
  const renders = run => run.calls.filter(call => call.operation === 'exec.run').length;
  const change = id => ({ repository, source: 'external', call_id: null, watch_id: id, changes: [{ path: 'docs/a.md', before: null, after: null }], status: 'observed' });
  try {
    for (let index = 0; index < 20; index += 1) lifecycle(repository, 'start', `thread-${index}`);
    assert.deepEqual([...live].map(([, owner]) => owner), ['thread-19']);
    lifecycle(repository, 'resume', 'thread-3', true);
    assert.deepEqual([...live].map(([, owner]) => owner), ['thread-3']);

    restart();
    lifecycle(repository, 'start', 'thread-1');
    enter('B');
    watchIds = 2;
    const other = lifecycle(repository, 'start', 'thread-1');
    assert.equal(other.calls.some(call => call.operation === 'workspace.unwatch'), false);
    assert.deepEqual([...live.keys()], ['w3']);
    enter('A');
    assert.deepEqual([...live.keys()], ['w1']);
    live.set('w9', 'thread-0');
    writeFileSync(join(repository, 'docs/a.md'), '# Edited once\n');
    const leaked = invoke(repository, null, 'workspace_change', change('w9'));
    assert.equal(leaked.calls.some(call => call.operation === 'workspace.unwatch' && call.arguments.watch_id === 'w9'), true);
    assert.equal(renders(leaked), 0);
    const first = invoke(repository, null, 'workspace_change', change('w1'));
    enter('B');
    const second = invoke(repository, null, 'workspace_change', change('w3'));
    assert.equal(renders(first) + renders(second), 1);
    assert.deepEqual([...live.keys()], ['w3']);
    enter('A');
    delete stores.get(`${repository}\0watch_id`).value.A;
    invoke(repository, null, 'workspace_change', change('w1'));
    assert.deepEqual([...live.keys()], ['w2']);

    restart();
    writeFileSync(join(repository, 'docs/b.md'), '# B\n');
    invoke(repository, null, 'command', 'docs/b.md --watch', 'preview');
    lifecycle(repository, 'start', 'thread-1');
    rmSync(join(repository, 'docs/b.md'));
    let state = null;
    const delays = [];
    const poll = () => {
      const run = invoke(repository, state, 'timer', { key: 'poll' });
      state = run.state;
      delays.push(...run.calls.filter(call => call.operation === 'events.schedule').map(call => call.arguments.delay_ms));
      return run.calls.map(call => call.operation);
    };
    assert.ok(poll().includes('workspace.watch'));
    for (let pass = 0; pass < 3; pass += 1) assert.deepEqual(poll(), ['store.get', 'workspace.stat', 'session.info', 'store.get', 'store.put', 'events.schedule']);
    writeFileSync(join(repository, 'docs/b.md'), '# B\n');
    assert.ok(poll().includes('workspace.watch'));
    assert.equal(poll().includes('events.schedule'), false);
    assert.deepEqual(delays, [4000, 8000, 16000, 32000]);
    assert.equal(state.retry, 2000);
  } finally {
    restart();
    processes.B = undefined;
    rmSync(repository, { recursive: true, force: true });
  }
});

test('a failed stat or a missing file keeps the watch and retries until it is placed', () => {
  const repository = watchedRepository();
  const poll = () => invoke(repository, null, 'timer', { key: 'poll' });
  const retried = run => run.calls.some(call => call.operation === 'events.schedule' && call.arguments.key === 'poll');
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
    assert.equal(retried(poll()), true);
    assert.equal(live.size, 0);
    writeFileSync(join(repository, 'docs/a.md'), '# Back\n');
    assert.equal(retried(poll()), false);
    assert.equal(live.size, 1);
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
    assert.equal(command(), 'Opened README.md in the browser');
    assert.equal(readFileSync(join(repository, 'victim.txt'), 'utf8'), 'keep me\n');
    assert.match(readFileSync(join(repository, '.omd/preview/files/README.md.html'), 'utf8'), /Readme/);
    assert.ok(lstatSync(join(repository, '.omd/preview/files/README.md.html')).isFile());
    rmSync(join(repository, '.omd/preview/files'), { recursive: true });
    mkdirSync(join(repository, 'elsewhere'));
    symlinkSync('../../elsewhere', join(repository, '.omd/preview/files'));
    assert.equal(command(), '/preview: .omd/preview/files is a link or file, not a directory; remove it to preview here');
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
    assert.equal(big.value.display, 'Showing the first 4 KB inline; /preview without --inline opens all of it in the browser');
    assert.equal(big.state.inline.text, 'x'.repeat(4_000));
    assert.equal(command('quotes.diff --inline').state.inline.text, '"'.repeat(48_000));
    const control = command('control.diff --inline');
    assert.equal(control.value.display, 'Cannot show control.diff inline (host_result_limit); /preview control.diff opens it in the browser');
    assert.equal(control.state, null);
    writeFileSync(join(repository, 'crlf.md'), 'line\r\n'.repeat(1_000));
    const crlf = command('crlf.md --inline');
    assert.equal(crlf.value.display, 'Showing the first 4 KB inline; /preview without --inline opens all of it in the browser');
    assert.equal(crlf.state.inline.text, `${'line\n'.repeat(667)}li`);
    writeFileSync(join(repository, 'snow.md'), '雪'.repeat(2_000));
    assert.equal(command('snow.md --inline').state.inline.text, '雪'.repeat(1_333));
    writeFileSync(join(repository, 'image.md'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00, 0x41]));
    const binary = command('image.md --inline');
    assert.equal(binary.value.display, 'Cannot show image.md inline (not UTF-8 text); /preview image.md opens it in the browser');
    assert.equal(binary.state, null);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

