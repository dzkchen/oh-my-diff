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

function invoke(repository, state, event, payload, name, settings = {}, modSource = source) {
  const calls = [];
  const host = call => {
    const { operation, arguments: args } = call;
    calls.push(call);
    const key = `${repository}\0${args?.key}`;
    if (operation === 'session.info') return { thread_id: 'thread-1' };
    if (operation === 'store.get') return stores.get(key) ?? null;
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
      assert.deepEqual(args, { method: 'thread/turns/list', params: { threadId: 'thread-1', limit: args.params.limit, itemsView: 'summary' } });
      return { data: responses.slice(0, args.params.limit).map(text => ({ items: [{ type: 'userMessage' }, { type: 'agentMessage', text }] })) };
    }
    if (operation === 'workspace.stat') {
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

test('preview harness rejects unhandled host operations', () => {
  assert.throws(() => invoke(tmpdir(), null, 'command', '', 'fixture', {},
    "export default api => api.command('fixture', () => api.host.tryCall('events.cancel', { key: 'poll' }));"),
  /unexpected preview host operation: events.cancel/);
});

test('preview dismisses its popup on owned Escape or resume with thumbnails off', () => {
  const state = { inline: { title: 'Preview', kind: 'markdown', text: 'Content' }, revision: 1, images: [] };
  const escaped = invoke(tmpdir(), state, 'component_event', { component: 'omd_preview_dialog', kind: 'close', origin: 'user' }, undefined, { thumbnails: false });
  assert.equal(escaped.state.inline, null);
  assert.equal(invoke(tmpdir(), escaped.state, 'terminal', { event: 'idle' }, undefined, { thumbnails: false }).value, null);
  assert.equal(invoke(tmpdir(), state, 'resume', { thread_id: 'thread-1', last_turn: null, restarted: false }, undefined, { thumbnails: false }).state.inline, null);
  assert.ok(invoke(tmpdir(), state, 'terminal', null, undefined, { thumbnails: false }).value.sites.dialog);
  assert.deepEqual(invoke(tmpdir(), state, 'component_event', { component: 'other_dialog', kind: 'close', origin: 'user' }, undefined, { thumbnails: false }).state.inline, state.inline);
});

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
    assert.deepEqual(watching(repository).watch, ['docs/a.md']);
    assert.ok(watched.calls.findIndex(call => call.operation === 'events.publish') > watched.calls.findIndex(call => call.operation === 'terminal.open'));
    assert.equal(watching(repository).hashes['docs/a.md'], createHash('sha256').update(readFileSync(join(repository, 'docs/a.md'))).digest('hex'));
    const early = invoke(repository, null, 'channel', { channel: 'omd_preview/watch', data: null });
    assert.deepEqual(early.calls.at(-1).arguments, { key: 'poll', delay_ms: 2000 });
    const page = readFileSync(join(repository, '.omd/preview/files/docs/a.md.html'), 'utf8');
    assert.match(page, /data-watch="1"/);
    assert.match(page, /src="\.\.\/\.\.\/\.\.\/\.\.\/docs\/pic\.png"/);
    assert.match(page, /<span class="math">\\\(x\^2\\\)<\/span>/);
    assert.match(page, /mermaid@12\.0\.0\/dist\/mermaid\.min\.js" integrity="sha384-/);

    writeFileSync(join(repository, 'docs/a.md'), '# First change before polling\n');
    const synced = invoke(repository, watched.state, 'timer', { key: 'poll' });
    assert.match(readFileSync(join(repository, '.omd/preview/files/docs/a.md.html'), 'utf8'), /First change before polling/);
    assert.deepEqual(synced.calls.at(-1).arguments, { key: 'poll', delay_ms: 2000 });
    writeFileSync(join(repository, 'docs/a.md'), '# Changed [[Other note|see]]\n');
    const polled = invoke(repository, synced.state, 'timer', { key: 'poll' });
    assert.equal(polled.calls.filter(call => call.operation === 'exec.run').length, 1);
    assert.match(readFileSync(join(repository, '.omd/preview/files/docs/a.md.html'), 'utf8'), /<h1 id="[^"]*">Changed <a href="\.\.\/\.\.\/\.\.\/\.\.\/docs\/Other%20note\.md">see<\/a><\/h1>/);
    command('unwatch');
    assert.deepEqual(watching(repository).watch, []);
    assert.deepEqual(invoke(repository, null, 'timer', { key: 'poll' }).calls.map(call => call.operation), ['store.get']);

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
  } finally {
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

test('watched previews keep one page per source and repository and retry a failed render after the next change', () => {
  const [first, second] = [0, 1].map(() => realpathSync(mkdtempSync(join(tmpdir(), 'omd-preview-watch-'))));
  const page = name => readFileSync(join(first, '.omd/preview/files', name), 'utf8');
  const poll = repository => invoke(repository, null, 'timer', { key: 'poll' }).calls;
  const renders = calls => calls.filter(call => call.operation === 'exec.run').length;
  try {
    for (const repository of [first, second]) {
      mkdirSync(join(repository, 'docs'));
      writeFileSync(join(repository, 'docs/a.md'), '# Nested\n');
      writeFileSync(join(repository, 'docs__a.md'), '# Flat\n');
      writeFileSync(join(repository, 'response'), 'plain');
    }
    for (const text of ['docs/a.md --watch', 'docs__a.md --watch', 'response']) invoke(first, null, 'command', text, 'preview');
    assert.match(page('docs/a.md.html'), /Nested/);
    assert.match(page('docs__a.md.html'), /Flat/);
    assert.match(page('response.html'), /plain/);
    assert.equal(statSync(join(first, '.omd/preview/response.html'), { throwIfNoEntry: false }), undefined);
    assert.deepEqual(poll(second).map(call => call.operation), ['store.get']);
    assert.equal(statSync(join(second, '.omd'), { throwIfNoEntry: false }), undefined);

    rmSync(join(first, '.omd/preview/files'), { recursive: true });
    mkdirSync(join(first, 'elsewhere'));
    symlinkSync('../../elsewhere', join(first, '.omd/preview/files'));
    writeFileSync(join(first, 'docs/a.md'), '# Nested again\n');
    assert.equal(renders(poll(first)), 1);
    assert.equal(renders(poll(first)), 0);
    rmSync(join(first, '.omd/preview/files'));
    writeFileSync(join(first, 'docs/a.md'), '# Nested once more\n');
    assert.equal(renders(poll(first)), 1);
    assert.match(page('docs/a.md.html'), /Nested once more/);
    assert.equal(renders(poll(first)), 0);

    const deep = `${'d'.repeat(100)}/${'雪'.repeat(80)}/${'f'.repeat(240)}.md`;
    mkdirSync(join(first, deep, '..'), { recursive: true });
    writeFileSync(join(first, deep), '# Deep\n');
    assert.equal(invoke(first, null, 'command', deep, 'preview').value.display, `Opened ${deep} in the browser`);
    assert.match(page(`${deep}.html`), /Deep/);
  } finally {
    for (const repository of [first, second]) rmSync(repository, { recursive: true, force: true });
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

test('a watch that loses its save race says it is not watched', () => {
  const repository = realpathSync(mkdtempSync(join(tmpdir(), 'omd-preview-race-')));
  try {
    writeFileSync(join(repository, 'a.md'), '# A\n');
    racing = key => stores.set(key, { value: { watch: ['b.md'], hashes: {} }, revision: 9 });
    const { value, calls } = invoke(repository, null, 'command', 'a.md --watch', 'preview');
    assert.equal(value.display, 'Opened a.md in the browser; not watched: store_revision_conflict');
    assert.deepEqual(watching(repository).watch, ['b.md']);
    assert.ok(!calls.some(call => call.operation === 'events.publish'));
  } finally {
    racing = null;
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

test('draft image thumbnails show every image aspect-sized in one row that fits above the composer and open a preview', () => {
  const image = (n, width, height, resource = { reference: `omd-resource:${n}`, sha256: String(n).repeat(64) }) => ({ id: `img-${n}`, kind: 'image', label: `[Image #${n}]`, owner: 'user', resource, width, height });
  draft = { ...draft, revision: 2, attachments: [image(1, 1600, 900), image(2, undefined, undefined, null), image(3, 900, 1600), image(4, 1000, 1000)] };
  const changed = invoke(null, null, 'composer', { kind: 'change', revision: 2, attachments_revision: 1, origin: 'user' });
  assert.deepEqual(changed.state.images.map(item => item.id), ['img-1', 'img-2', 'img-3', 'img-4']);
  assert.deepEqual(invoke(null, changed.state, 'composer', { kind: 'change', revision: 3, attachments_revision: 1, origin: 'user' }).calls, [], 'typing does not reread the draft');
  const strip = (columns, state = changed.state) => {
    const site = invoke(null, state, 'terminal', { event: 'redraw', ledger: null, client: { kind: 'terminal', graphics: 'kitty', pointer: 'cell', reduced_motion: false, cell_px: { width: 10, height: 20 }, columns, rows: 40 } }).value.sites.above_composer;
    assert.equal(site.mode, 'wrap');
    assert.deepEqual(site.components[0], { type: 'slot' });
    assert.equal(site.components[1].title, `Draft images (${state.images.length})`);
    const tiles = site.components[1].children[0].children[0];
    const flexible = tiles.children.filter(child => child.type === 'box');
    const room = tiles.max_width - (tiles.children.length - 1) - tiles.children.filter(child => child.type === 'text').reduce((sum, child) => sum + Math.max(...child.text.split('\n').map(line => [...line].length)), 0);
    assert.ok(tiles.max_width <= columns - 4, 'the row fits the terminal');
    const weight = flexible.reduce((sum, child) => sum + child.flex, 0);
    flexible.forEach(child => assert.ok(Math.floor(room * child.flex / weight) >= child.max_width, `${child.id} gets its width`));
    return tiles;
  };
  const wide = strip(100);
  const absent = '[Image #2]: no preview\nonly PNG and JPEG up to 8 MiB';
  assert.equal(wide.max_width, 88);
  assert.deepEqual(wide.children.map(child => `${child.type}:${child.id}:${child.max_width ?? child.text}`), ['box:omd_preview_tile_0:29', `text:omd_preview_thumb_1:${absent}`,
    'box:omd_preview_tile_2:9', 'box:omd_preview_tile_3:16']);
  assert.deepEqual(wide.children[0].children[0], { type: 'image', id: 'omd_preview_thumb_0', label: '[Image #1] thumbnail', image: image(1).resource, alt: '[Image #1]', height: 8, pointer: true });
  assert.deepEqual(wide.children[0].children[1], { type: 'button', id: 'omd_preview_open_0', label: 'Preview [Image #1]', text: '#1', action: { command: 'omd_preview:preview', args: 'image 1' } });
  const medium = strip(60);
  assert.deepEqual(medium.children.map(child => child.max_width ?? child.text), [8, absent, 7, 7], 'tiles shrink together to fit the width');
  assert.equal(medium.children[0].children[0].height, 2);
  assert.deepEqual(strip(40).children.map(child => `${child.id}:${child.text}`), ['omd_preview_more:/preview image 1 to 4'], 'hidden images keep the command that opens them');
  draft = { ...draft, revision: 2, attachments: [image(1, 4000, 400), image(2, 4000, 400)] };
  const banners = invoke(null, null, 'composer', { kind: 'change', revision: 2, attachments_revision: 1, origin: 'user' }).state;
  assert.deepEqual(strip(60, banners).children.map(child => child.max_width ?? child.text), [25, '+1 more: /preview image 2 to 2'], 'a wide tile leaves room for the note');
  assert.deepEqual(strip(40, banners).children.map(child => child.text), ['/preview image 1 to 2']);
  draft = { ...draft, revision: 2, attachments: [image(1, 1600, 900), image(2, undefined, undefined, null), image(3, 900, 1600), image(4, 1000, 1000)] };

  const clicked = invoke(null, changed.state, 'component_event', { component: 'omd_preview_thumb_2', kind: 'pointer', pointer: { column: 0, row: 0, action: 'down', button: 'left' } });
  const dialog = invoke(null, clicked.state, 'terminal', { event: 'redraw', ledger: null }).value.sites.dialog.components[0];
  assert.deepEqual(dialog.children[0], { type: 'image', id: 'omd_preview_image_1', label: '[Image #3] preview', image: image(3).resource, alt: '[Image #3]', height: 16 });
  assert.equal(invoke(null, changed.state, 'command', 'image 2', 'preview').value.display, '[Image #2] has no preview: only PNG and JPEG images up to 8 MiB do');

  draft = { ...draft, revision: 3, attachments: [image(1)] };
  const removed = invoke(null, clicked.state, 'composer', { kind: 'change', revision: 3, attachments_revision: 2, origin: 'user' });
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
  const draw = (text, settings = {}, columns = 100, truncated = false) => {
    const input = { component: 'assistant_message', id: 'one', surface: 'fullscreen', viewport: { columns, rows: 40 }, lifecycle: 'final', owner: null, props: { text, first: true, truncated } };
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
  const long = draw(`${'Long answer. '.repeat(320)}\n${state}`, {}, 100, true);
  assert.deepEqual(long.value.result.tree[0], { type: 'native' }, 'a message past the 4 KiB prop keeps its native drawing');
  assert.equal(long.value.result.tree[1].children[0].type, 'text');
  const whole = draw(`${'x'.repeat(4_090 - state.length)}\n${state}`);
  assert.equal(whole.value.result.tree[0].id, 'omd_preview_response', 'a complete message near 4 KiB is drawn in place');

  const lines = (source, columns) => flat(draw(`\`\`\`mermaid\n${source}\n\`\`\``, {}, columns).value.result.tree)[0].text;
  assert.equal(lines('graph TD; A-->B; B-->A'), '┌───┐\n│ A │\n└───┘\n  ▲\n  ▼\n┌───┐\n│ B │\n└───┘', 'opposite edges keep both arrowheads');
  assert.match(lines('graph BT; A o--o B'), /○\n  ○/);
  assert.match(lines('classDiagram\nAnimal<|--Duck'), /│ Animal │[\s\S]*△[\s\S]*│ Duck │/);
  assert.match(lines('graph TD; A["#toString;"]'), /│ #toString; │/);
  assert.equal(lines('graph TD; A["❤️ 👨‍👩‍👧 🇨🇦"]'), '┌──────────┐\n│ ❤️ 👨‍👩‍👧 🇨🇦 │\n└──────────┘', 'emoji sequences take two cells');
  const chart = lines('xychart-beta\nx-axis [a, b]\ny-axis 0 --> 10\nbar [5, 10]\nline [5, 10]').split('\n');
  assert.deepEqual([chart[0], chart[5], chart[10]], ['10 ┤     █●', ' 5 ┤ █●  ██', ' 0 └─────────'], 'line points sit on the bar tops and 0 labels the axis');
  assert.deepEqual(invoke(null, null, 'terminal', { event: 'redraw', ledger: null }, undefined, { diagrams: 'off' }).registrations.interceptors, []);

  responses = [`Done\n${state}`, 'Earlier answer'];
  assert.equal(invoke(null, null, 'command', 'diagrams', 'preview').value.display, '1. stateDiagram-v2 in response 1\nUse /preview diagrams N to inspect, expand or copy one');
  const opened = invoke(null, null, 'command', 'diagrams 1', 'preview');
  const view = invoke(null, opened.state, 'terminal', { event: 'redraw', ledger: null }).value.sites.dialog.components[0];
  assert.equal(view.title, 'Diagram 1 (response 1)');
  assert.ok(view.children[0].children[0].text.includes('Idle'));
  assert.deepEqual(view.children[1].action, { copy: state.split('\n').slice(1, -1).join('\n'), label: 'Mermaid source' });
  responses = ['```mermaid\nflowchart LR\n  A[a first long node] --> B[a second long node] --> C[a third long node]\n```'];
  const wideState = invoke(null, null, 'command', 'diagrams 1', 'preview').state;
  const fitted = columns => invoke(null, wideState, 'terminal', { event: 'redraw', ledger: null, client: { columns, rows: 40 } }).value.sites.dialog.components[0].children[0].children[0].text;
  assert.ok(fitted(160).split('\n').length < 5 && fitted(160).includes('►'), 'a dialog wide enough keeps the left-to-right layout');
  assert.ok(Math.max(...fitted(60).split('\n').map(line => line.length)) <= 53 && fitted(60).includes('▼'), 'a narrow terminal turns the diagram to fit the dialog');
});
