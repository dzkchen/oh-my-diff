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
const surface = { events: { terminal: 'terminal', channel: 'events', timer: 'events', start: 'lifecycle', resume: 'lifecycle', composer: 'composer', component_event: 'terminal' },
  intercept: { render: 'terminal' }, replacements: [], middleware: [], state: 'store', contracts: 'contracts' };
let responses = ['Latest **answer** with <script>alert(1)</script> and [x](javascript:alert(1))', 'Earlier answer'];
let draft = { text: '', cursor: 0, selection: null, revision: 1, attachments: [], suggestion: null };

function invoke(repository, state, event, payload, name, settings = {}) {
  const receipts = [];
  const calls = [];
  for (;;) {
    const request = { source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, state, settings, event, name, payload,
      receipts, surface, hook_budget_ms: 10000, assets: { 'render.mjs': { text: renderer, sha256: '0' } } };
    const output = JSON.parse(runnerSync(request).stdout);
    if (output.error) throw new Error(output.error);
    if (!output.host_call) return { value: output.value, state: output.state, calls, registrations: output.registrations };
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
    else if (operation === 'composer.read') value = draft;
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

test('draft image thumbnails follow the composer draft above the composer and open a preview', () => {
  const image = (n, resource = { reference: `omd-resource:${n}`, sha256: String(n).repeat(64) }) => ({ id: `img-${n}`, kind: 'image', label: `[Image #${n}]`, owner: 'user', resource });
  draft = { ...draft, revision: 2, attachments: [image(1), image(2, null), image(3), image(4)] };
  const changed = invoke(null, null, 'composer', { kind: 'change', revision: 2, origin: 'user' });
  assert.deepEqual(changed.state.images.map(item => item.id), ['img-1', 'img-2', 'img-3', 'img-4']);
  const site = invoke(null, changed.state, 'terminal', { event: 'redraw', ledger: null }).value.sites.above_composer;
  assert.equal(site.mode, 'wrap');
  assert.deepEqual(site.components[0], { type: 'slot' });
  const box = site.components[1];
  assert.equal(box.title, 'Draft images (4)');
  assert.deepEqual(box.children.map(child => `${child.type}:${child.id}`), ['image:omd_preview_thumb_0', 'button:omd_preview_open_0', 'text:omd_preview_thumb_1',
    'image:omd_preview_thumb_2', 'button:omd_preview_open_2', 'text:omd_preview_more']);
  assert.deepEqual(box.children[0], { type: 'image', id: 'omd_preview_thumb_0', label: '[Image #1] thumbnail', image: image(1).resource, alt: '[Image #1]', height: 3, pointer: true });
  assert.deepEqual(box.children[1].action, { command: 'omd_preview:preview', args: 'image 1' });
  assert.match(box.children[2].text, /no preview/);
  assert.equal(box.children[5].text, '+1 more: /preview image 4 to 4');

  const clicked = invoke(null, changed.state, 'component_event', { component: 'omd_preview_thumb_2', kind: 'pointer', pointer: { column: 0, row: 0, action: 'down', button: 'left' } });
  const dialog = invoke(null, clicked.state, 'terminal', { event: 'redraw', ledger: null }).value.sites.dialog.components[0];
  assert.deepEqual(dialog.children[0], { type: 'image', id: 'omd_preview_image_1', label: '[Image #3] preview', image: image(3).resource, alt: '[Image #3]', height: 16 });
  assert.equal(invoke(null, changed.state, 'command', 'image 2', 'preview').value.display, '[Image #2] has no preview: only PNG and JPEG images up to 8 MiB do');

  draft = { ...draft, revision: 3, attachments: [image(1)] };
  const removed = invoke(null, clicked.state, 'composer', { kind: 'change', revision: 3, origin: 'user' });
  assert.equal(removed.state.inline, null, 'a preview of a removed image closes');
  draft = { ...draft, revision: 4, attachments: [] };
  const submitted = invoke(null, removed.state, 'resume', null);
  assert.deepEqual(submitted.state.images, []);
  assert.equal(invoke(null, submitted.state, 'terminal', { event: 'redraw', ledger: null }).value, null);

  const disabled = invoke(null, changed.state, 'terminal', { event: 'redraw', ledger: null }, undefined, { thumbnails: false });
  assert.equal(disabled.value, null);
  assert.equal(disabled.registrations.events.includes('composer'), false);
});

test('assistant messages draw closed Mermaid fences in place and fall back to their source', () => {
  const draw = (text, settings = {}, columns = 100) => {
    const input = { component: 'assistant_message', id: 'one', surface: 'fullscreen', viewport: { columns, rows: 40 }, lifecycle: 'final', owner: null, props: { text, first: true } };
    return invoke(null, null, 'intercept', { surface: 'render', input, original: input, origin: { caller: 'engine' } }, '0', settings);
  };
  const flat = nodes => nodes.flatMap(node => node.children ? flat(node.children) : [node]);
  const state = '```mermaid\nstateDiagram-v2\n  [*] --> Idle\n  Idle --> Busy : start\n  Busy --> [*] : done\n```';
  const drawn = draw(`Intro\n\n${state}\n\n\`\`\`mermaid\ngantt\n  title Plan\n\`\`\`\nTail\n\`\`\`mermaid\ngraph TD\n  A-->B`);
  const [matcher] = drawn.registrations.interceptors.map(item => item.match ?? item.matcher);
  assert.deepEqual(matcher, { component: 'assistant_message', lifecycle: 'final', props: { text: [{ $glob: '*```mermaid*' }, { $glob: '*~~~mermaid*' }] } });
  const nodes = flat(drawn.value.result.tree);
  assert.deepEqual(nodes.map(node => node.type), ['markdown', 'text', 'text', 'markdown', 'text', 'markdown']);
  assert.equal(nodes[0].text, 'Intro\n');
  const picture = nodes[1].text;
  for (const part of ['●', '◉', 'Idle', 'Busy', 'start', 'done']) assert.ok(picture.includes(part), `${part} is drawn`);
  assert.ok(picture.indexOf('●') < picture.indexOf('Idle') && picture.indexOf('Busy') < picture.indexOf('◉'), 'start and end states keep their places');
  assert.equal(nodes[2].text, 'mermaid state · /preview diagrams shows the source');
  assert.equal(nodes[3].text, '```mermaid\ngantt\n  title Plan\n```');
  assert.equal(nodes[4].text, 'mermaid not drawn: "gantt" diagrams are not supported; showing the source');
  assert.equal(nodes[5].text, 'Tail\n```mermaid\ngraph TD\n  A-->B', 'an unclosed fence stays as written');

  const wide = draw('```mermaid\nflowchart LR\n  A[漢字] --> B[café]\n```');
  const [box] = flat(wide.value.result.tree);
  assert.match(box.text, /^┌──────┐   ┌──────┐\n│ 漢字 │──►│ café │\n└──────┘   └──────┘$/);
  const plain = flat(draw(state, { diagrams: 'ascii' }).value.result.tree)[0].text;
  assert.match(plain, /\(\*\)/);
  assert.doesNotMatch(plain, /[^\x20-\x7e\n]/);
  const narrow = flat(draw('```mermaid\ngraph TD\n  R --> A[first child] & B[second child] & C[third child]\n```', {}, 40).value.result.tree);
  assert.match(narrow.at(-1).text, /turned to fit/);
  const tooWide = flat(draw('```mermaid\nsequenceDiagram\n  A->>B: a message that needs far more room than this terminal has\n```', {}, 30).value.result.tree);
  assert.match(tooWide.at(-1).text, /^mermaid not drawn: it needs \d+ columns; showing the source$/);
  const long = draw(`${'Long answer. '.repeat(320)}\n${state}`);
  assert.deepEqual(long.value.result.tree[0], { type: 'native' }, 'a message past the 4 KiB prop keeps its native drawing');
  assert.equal(long.value.result.tree[1].children[0].type, 'text');
  assert.deepEqual(invoke(null, null, 'terminal', { event: 'redraw', ledger: null }, undefined, { diagrams: 'off' }).registrations.interceptors, []);

  responses = [`Done\n${state}`, 'Earlier answer'];
  assert.equal(invoke(null, null, 'command', 'diagrams', 'preview').value.display, '1. stateDiagram-v2 in response 1\nUse /preview diagrams N to inspect, expand or copy one');
  const opened = invoke(null, null, 'command', 'diagrams 1', 'preview');
  const view = invoke(null, opened.state, 'terminal', { event: 'redraw', ledger: null }).value.sites.dialog.components[0];
  assert.equal(view.title, 'Diagram 1 (response 1)');
  assert.ok(view.children[0].children[0].text.includes('Idle'));
  assert.deepEqual(view.children[1].action, { copy: state.split('\n').slice(1, -1).join('\n'), label: 'Mermaid source' });
});
