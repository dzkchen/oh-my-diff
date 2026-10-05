import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runnerSync } from './mod_runner.mjs';

const runner = readFileSync(new URL('../runtime/omd/src/mods/runner.mjs', import.meta.url), 'utf8');
const mod = new URL('../mods/first-party/omd_preview/', import.meta.url);
const source = readFileSync(new URL('index.ts', mod), 'utf8');
const renderer = readFileSync(new URL('render.mjs', mod), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('mod.json', mod), 'utf8'));
const surface = { events: { terminal: 'terminal', channel: 'events', timer: 'events', start: 'lifecycle', resume: 'lifecycle' },
  replacements: [], middleware: [], state: 'store', contracts: 'contracts' };
const responses = ['Latest **answer** with <script>alert(1)</script> and [x](javascript:alert(1))', 'Earlier answer'];

function invoke(repository, state, event, payload, name) {
  const receipts = [];
  const calls = [];
  for (;;) {
    const request = { source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, state, settings: {}, event, name, payload,
      receipts, surface, hook_budget_ms: 10000, assets: { 'render.mjs': { text: renderer, sha256: '0' } } };
    const output = JSON.parse(runnerSync(request).stdout);
    if (output.error) throw new Error(output.error);
    if (!output.host_call) return { value: output.value, state: output.state, calls };
    const { operation, arguments: args } = output.host_call;
    calls.push(output.host_call);
    let value;
    if (operation === 'store.get') value = calls.some(call => call.operation === 'store.put') ? { value: null, revision: 1, provenance: { thread_id: 'thread-1' } } : null;
    else if (operation === 'store.put') {
      assert.notEqual(args.value, null, 'store_value_required');
      value = { revision: 1 };
    }
    else if (operation === 'app.request') {
      assert.deepEqual(args, { method: 'thread/turns/list', params: { threadId: 'thread-1', limit: args.params.limit, itemsView: 'summary' } });
      value = { data: responses.slice(0, args.params.limit).map(text => ({ items: [{ type: 'userMessage' }, { type: 'agentMessage', text }] })) };
    } else if (operation === 'workspace.stat') {
      const path = join(repository, args.paths[0]);
      value = { files: { [args.paths[0]]: statSync(path, { throwIfNoEntry: false })?.isFile() ? { kind: 'file', size: statSync(path).size, mtime_ms: 0, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') } : null } };
    } else if (operation === 'workspace.read') value = { files: { [args.paths[0]]: { text: readFileSync(join(repository, args.paths[0]), 'utf8'), sha256: '0' } } };
    else if (operation === 'exec.run') {
      assert.equal(args.write, true);
      const run = spawnSync(args.program, args.argv, { cwd: repository, input: args.stdin, encoding: 'utf8' });
      value = { exit_code: run.status, stdout: run.stdout, stderr: run.stderr };
    } else if (operation === 'terminal.open') value = { opened: true };
    else if (operation === 'sessions.ports') value = { ports: [{ port: 3000, pid: 7, address: '127.0.0.1:3000' }, { port: 5173, pid: 8, address: '*:5173' }] };
    else value = { delivered: 1, dropped: 0 };
    receipts.push({ call: output.host_call, value });
  }
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
    assert.equal(command('list').value.display, '1. Latest **answer** with <script>alert(1)</script> and [x](javascript:alert(1))\n2. Earlier answer');
    assert.equal(command('missing.md').value.display, 'No file missing.md in the workspace');

    const watched = command('docs/a.md --watch');
    assert.equal(watched.value.display, 'Opened docs/a.md in the browser');
    assert.deepEqual(watched.state.watch, ['docs/a.md']);
    const page = readFileSync(join(repository, '.omd/preview/docs__a.md.html'), 'utf8');
    assert.match(page, /data-watch="1"/);
    assert.match(page, /src="\.\.\/\.\.\/docs\/pic\.png"/);
    assert.match(page, /<span class="math">\\\(x\^2\\\)<\/span>/);
    assert.match(page, /mermaid@12\.0\.0\/dist\/mermaid\.min\.js" integrity="sha384-/);

    const synced = invoke(repository, watched.state, 'channel', { channel: 'omd_preview/watch', data: null });
    assert.deepEqual(synced.calls.at(-1).arguments, { key: 'poll', delay_ms: 2000 });
    writeFileSync(join(repository, 'docs/a.md'), '# Changed [[Other note|see]]\n');
    const polled = invoke(repository, synced.state, 'timer', { key: 'poll' });
    assert.equal(polled.calls.filter(call => call.operation === 'exec.run').length, 1);
    assert.match(readFileSync(join(repository, '.omd/preview/docs__a.md.html'), 'utf8'), /<h1 id="[^"]*">Changed <a href="\.\.\/\.\.\/docs\/Other%20note\.md">see<\/a><\/h1>/);
    assert.deepEqual(command('unwatch', synced.state).state.watch, []);

    const inline = command('docs/a.md --inline');
    const view = invoke(repository, inline.state, 'terminal', { event: 'redraw', ledger: null }).value;
    const dialog = view.sites.dialog.components[0];
    assert.equal(dialog.title, 'docs/a.md');
    assert.deepEqual(dialog.children[0].children[0], { type: 'markdown', id: 'omd_preview_body_1', label: 'docs/a.md', text: '# Changed [[Other note|see]]\n' });
    assert.equal(command('close', inline.state).state.inline, null);
    assert.equal(invoke(repository, { ...inline.state, inline: null }, 'terminal', { event: 'redraw', ledger: null }).value, null);
    assert.match(command('--bogus').value.display, /^usage:/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test('preview server opens a port the session is listening on', () => {
  const repository = realpathSync(mkdtempSync(join(tmpdir(), 'omd-preview-')));
  try {
    assert.equal(invoke(repository, null, 'command', 'server', 'preview').value.display, 'Listening: 3000, 5173; use /preview server PORT');
    const opened = invoke(repository, null, 'command', 'server 5173', 'preview');
    assert.equal(opened.value.display, 'Opened http://localhost:5173');
    assert.deepEqual(opened.calls.at(-1).arguments, { url: 'http://localhost:5173' });
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});
