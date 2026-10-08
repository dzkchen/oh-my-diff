import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classify, isTracker, startGuard, vet } from '../plugins/optional/plugins/omd-browser/scripts/network.mjs';
import { openVault } from '../plugins/optional/plugins/omd-browser/scripts/vault.mjs';
import { startLive } from '../plugins/optional/plugins/omd-browser/scripts/live.mjs';
import { decodePng, halfBlocks } from '../plugins/optional/plugins/omd-browser/scripts/pane.mjs';
import { locate } from '../plugins/optional/plugins/omd-browser/scripts/design.mjs';
import { geometry, jpegSize, keyEvents, startViewer } from '../plugins/optional/plugins/omd-browser/scripts/viewer.mjs';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { deflateSync } from 'node:zlib';

test('network policy refuses private and tracker destinations and never allows cloud metadata', async () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.0.9', '100.64.0.1', '::1', 'fd12::1', '::ffff:10.0.0.1']) {
    assert.equal(classify(address), 'private', address);
  }
  for (const address of ['169.254.169.254', 'fd00:ec2::254', '100.100.100.200']) assert.equal(classify(address), 'metadata', address);
  assert.equal(classify('93.184.216.34'), null);
  assert.deepEqual(await vet('localhost', 3000), { denied: 'private' });
  assert.deepEqual(await vet('127.0.0.1', 3000, { allow: ['127.0.0.1:3000'] }), { address: '127.0.0.1' });
  assert.deepEqual(await vet('127.0.0.1', 3001, { allow: ['127.0.0.1:3000'] }), { denied: 'private' });
  assert.deepEqual(await vet('169.254.169.254', 80, { allow: ['169.254.169.254:80'] }), { denied: 'metadata' });
  assert.deepEqual(await vet('stats.doubleclick.net', 443), { denied: 'tracker' });
  assert.deepEqual(await vet('93.184.216.34', 443), { address: '93.184.216.34' });
  assert.equal(isTracker('notdoubleclick.net'), false);

  const site = createServer((_, response) => response.end('ok'));
  await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
  const allowed = `127.0.0.1:${site.address().port}`;
  const guard = await startGuard({ allow: [allowed] });
  const fetchVia = target => new Promise(resolve => request({ host: '127.0.0.1', port: guard.port, path: `http://${target}/` }, response => {
    response.resume().on('end', () => resolve(response.statusCode));
  }).end());
  const tunnel = target => new Promise(resolve => {
    const socket = connect(guard.port, '127.0.0.1', () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    socket.once('data', chunk => resolve(chunk.toString().split('\r\n')[0])).on('end', () => socket.destroy());
  });
  try {
    assert.equal(await fetchVia(allowed), 200);
    assert.equal(await fetchVia('127.0.0.1:9'), 403);
    assert.equal(await tunnel('169.254.169.254:443'), 'HTTP/1.1 403 Forbidden');
    assert.equal(await tunnel('ads.doubleclick.net:443'), 'HTTP/1.1 403 Forbidden');
    assert.deepEqual(guard.drain(), { denied: ['127.0.0.1:9 (private)', '169.254.169.254:443 (metadata)'], trackers: 1 });
  } finally {
    guard.close();
    site.close();
  }
});

test('vault records are encrypted and bound to the origin they were saved for', () => {
  const directory = mkdtempSync(join(tmpdir(), 'omd-vault-'));
  try {
    const file = join(directory, 'vault.json');
    const key = randomBytes(32);
    const vault = openVault(file, () => key);
    const id = vault.add('https://example.com', 'ada', 'hunter22');
    assert.deepEqual(vault.list(), [{ id, origin: 'https://example.com', username: 'ada' }]);
    assert.deepEqual(vault.idsFor('https://example.com'), [id]);
    assert.deepEqual(vault.idsFor('https://example.com.evil.test'), []);
    assert.equal(vault.get(id).password, 'hunter22');
    assert.doesNotMatch(readFileSync(file, 'utf8'), /hunter22|ada/);
    const stored = JSON.parse(readFileSync(file, 'utf8'));
    stored.records[0].origin = 'https://evil.test';
    writeFileSync(file, JSON.stringify(stored));
    assert.throws(() => vault.get(id));
    assert.equal(vault.remove(id), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('pane endpoint serves only pane-enabled sessions and shows handoffs in the attached pane', async () => {
  const acted = [];
  const live = startLive({ frame: async () => Buffer.alloc(0), input: async () => {}, pane: {
    allowed: name => name === 'work',
    status: async (_, full) => ({ url: 'https://example.com/', title: 'Example', ...(full ? { text: '- link "Docs" [ref=e1]' } : {}) }),
    routes: { act: async (name, body) => (acted.push([name, body]), { ok: true }) },
    frame: async () => Buffer.from('png'),
  } });
  const base = await live.listen();
  const call = (path, body) => fetch(`${base}/pane/${path}`, body ? { method: 'POST', body: JSON.stringify(body) } : undefined);
  try {
    assert.equal((await call('personal/state')).status, 404);
    assert.equal((await fetch(`${base.replace(/[^/]+$/, 'wrong')}/pane/work/state`)).status, 404);
    assert.deepEqual(await (await call('work/state')).json(), { url: 'https://example.com/', title: 'Example', text: '- link "Docs" [ref=e1]', handoff: null });
    assert.deepEqual(await (await call('work/act', { action: 'click', ref: 'e1' })).json(), { ok: true });
    assert.deepEqual(acted, [['work', { action: 'click', ref: 'e1' }]]);
    assert.equal((await call('work/frame')).headers.get('content-type'), 'image/png');
    const handed = live.handoff('work', 'Sign in please');
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal((await (await call('work/status')).json()).handoff, 'Sign in please');
    await call('work/done', { note: 'signed in' });
    assert.deepEqual(await handed, { note: 'signed in' });
  } finally {
    live.close();
  }
});

test('pane screenshots decode filtered PNG rows into half-block cells', () => {
  const sized = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    return Buffer.concat([length, Buffer.from(type), data, Buffer.alloc(4)]);
  };
  const header = Buffer.from([0, 0, 0, 2, 0, 0, 0, 2, 8, 2, 0, 0, 0]);
  const rows = Buffer.from([1, 10, 20, 30, 5, 5, 5, 2, 1, 1, 1, 2, 2, 2]);
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), sized('IHDR', header), sized('IDAT', deflateSync(rows)), sized('IEND', Buffer.alloc(0))]);
  const image = decodePng(png);
  assert.deepEqual([image.pixel(0, 0), image.pixel(1, 0), image.pixel(0, 1), image.pixel(1, 1)], [[10, 20, 30], [15, 25, 35], [11, 21, 31], [17, 27, 37]]);
  assert.deepEqual(halfBlocks(image, 2, 1), ['\x1b[38;2;10;20;30m\x1b[48;2;11;21;31m▀\x1b[38;2;15;25;35m\x1b[48;2;17;27;37m▀\x1b[0m']);
});

test('source maps resolve a generated rule position to its original file and line', () => {
  const map = { version: 3, sources: ['button.scss'], sourceRoot: 'src/', mappings: 'AAAA;AAEA,KAAC' };
  assert.deepEqual(locate(map, 1, 0), { source: 'src/button.scss', line: 3 });
  assert.deepEqual(locate(map, 1, 9), { source: 'src/button.scss', line: 3 });
  assert.equal(locate(map, 4, 0), null);
  assert.equal(locate({ mappings: 'A!' , sources: ['x'] }, 0, 0), null);
});

test('the viewer sizes pages to the terminal, maps keys to DevTools input and reads JPEG sizes', () => {
  assert.deepEqual(geometry({ columns: 106, rows: 40, cell_px: { width: 14, height: 25 } }, 1, 'kitty'),
    { css: { width: 950, height: 640 }, frame: { width: 1484, height: 1000 }, deviceScaleFactor: 1484 / 950 });
  assert.deepEqual(geometry({ columns: 106, rows: 40, cell_px: { width: 8, height: 16 } }, 1, 'iip').frame, { width: 848, height: 640 });
  assert.deepEqual(geometry({ columns: 216, rows: 60, cell_px: { width: 14, height: 25 } }, 1, 'kitty').frame, { width: 2048, height: 1016 });
  assert.deepEqual(geometry({ columns: 100, rows: 40, cell_px: { width: 8, height: 16 } }, 1, 'cells').frame, { width: 400, height: 320 });
  assert.deepEqual(keyEvents([{ key: 'Shift+a', text: 'A' }, { key: 'Enter', text: null }, { key: 'Ctrl+a', text: null }, { key: 'Alt+Left', text: null }, { paste: 'p q' }]), [
    { key: { key: 'A', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 8, text: 'A' } },
    { key: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 0, text: '\r' } },
    { key: { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2, text: '' } },
    { command: 'back' }, { text: 'p q' }]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 17, 8, 0x01, 0xf4, 0x03, 0x20, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(jpegSize(jpeg.toString('base64')), { width: 800, height: 500 });
});

const viewers = new Set();
function watchViewer(url, session) {
  const input = new PassThrough();
  const out = [];
  const waiters = new Set();
  const viewer = startViewer({ url, session, input, exit: () => {}, write: message => {
    out.push(message);
    for (const check of waiters) check();
  } });
  const until = predicate => new Promise((resolve, reject) => {
    const timer = setTimeout(() => (waiters.delete(check), reject(new Error(`viewer timeout: ${predicate}`))), 20_000);
    const check = () => {
      const index = out.findIndex(predicate);
      if (index < 0) return;
      clearTimeout(timer);
      waiters.delete(check);
      resolve(out[index]);
    };
    waiters.add(check);
    check();
  });
  const poll = setInterval(() => waiters.forEach(check => check()), 50);
  const close = () => (clearInterval(poll), input.end());
  viewers.add(close);
  return { viewer, until, count: () => out.length, send: message => input.write(`${JSON.stringify(message)}\n`), close };
}

const bundle = process.env.OMD_BROWSER_BUNDLE;
test('managed Chromium streams exact-size frames to the viewer, takes its input and design-mode picks, and keeps user-only sessions from agents', { skip: !bundle && 'set OMD_BROWSER_BUNDLE to a provisioned browser bundle' }, async () => {
  let color = 'rgb(255, 0, 0)';
  const pages = {
    '/': ['text/html', `<!doctype html><link rel=stylesheet href=/button.css><div class=wrap><h1>Fixture</h1>
<button class=cta style="position:absolute;left:40px;top:120px;width:200px;height:60px">Buy</button>
<input id=field style="position:absolute;left:40px;top:220px" onkeyup="document.getElementById('echo').textContent=this.value"><p id=echo></p><p class=note>Note</p><section id=big>${'<span>large page content </span>'.repeat(2000)}</section></div>
<script>const s=document.createElement('style');s.textContent='.note{font-weight:700}\\n/*# sourceMappingURL=data:application/json;base64,'+btoa(JSON.stringify({version:3,sources:['src/note.css'],mappings:'AAAA'}))+' */';document.head.append(s)</script>`],
    '/button.css': ['text/css', () => `.wrap{padding:4px}\n.cta{color:${color};padding:12px}\n/*# sourceMappingURL=button.css.map */`],
    '/button.css.map': ['application/json', JSON.stringify({ version: 3, sources: ['src/button.scss'], mappings: 'AAAA;AAEA' })],
  };
  const site = createServer((request, response) => {
    const [type, body] = pages[request.url] ?? ['text/plain', 'missing'];
    response.writeHead(pages[request.url] ? 200 : 404, { 'content-type': type, 'cache-control': 'no-store' }).end(typeof body === 'function' ? body() : body);
  });
  await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
  const origin = `127.0.0.1:${site.address().port}`;
  const directory = mkdtempSync(join(tmpdir(), 'omd-browser-'));
  writeFileSync(join(directory, 'config.json'), JSON.stringify({ bundle, data: join(directory, 'data'), profiles: {
    default: { pane: true, allow: [origin] }, chess: { pane: true, user_only: true, allow: [origin] } } }));
  const server = spawn(process.execPath, [new URL('../plugins/optional/plugins/omd-browser/scripts/server.mjs', import.meta.url).pathname],
    { env: { ...process.env, OMD_BROWSER_CONFIG: join(directory, 'config.json') }, stdio: ['pipe', 'pipe', 'inherit'] });
  const replies = new Map();
  createInterface({ input: server.stdout }).on('line', line => {
    const message = JSON.parse(line);
    replies.get(message.id)?.(message);
  });
  let id = 0;
  const rpc = (method, params) => new Promise(resolve => {
    replies.set(++id, resolve);
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  try {
    await rpc('initialize', {});
    const refused = await rpc('tools/call', { name: 'browser_navigate', arguments: { session: 'chess', url: `http://${origin}/` } });
    assert.match(refused.result.content[0].text, /user-only/);
    assert.equal((await rpc('tools/call', { name: 'browser_sessions', arguments: { close: 'chess' } })).result.isError, true);
    let endpoint;
    for (let attempt = 0; attempt < 50 && !endpoint; attempt++) {
      try {
        endpoint = JSON.parse(readFileSync(join(directory, 'data', 'pane.json'), 'utf8')).url;
      } catch {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    const pane = async (path, body) => (await fetch(`${endpoint}/pane/${path}`, { method: 'POST', body: JSON.stringify(body ?? {}) })).json();
    assert.equal((await pane('default/act', { action: 'navigate', url: `http://${origin}/` })).ok, true);
    const view = watchViewer(endpoint, 'default');
    view.send({ box: { columns: 80, rows: 30, cell_px: { width: 10, height: 20 } } });
    const sized = (width, height) => message => message.blit && JSON.stringify(jpegSize(message.blit.base64)) === JSON.stringify({ width, height });
    const first = await view.until(sized(800, 600));
    assert.ok(first.blit.base64.length <= 250_000);
    assert.deepEqual(view.viewer.state().frame.css, { width: 640, height: 480 });
    assert.equal((await view.until(message => message.meta)).meta.url, `http://${origin}/`);
    assert.match((await view.viewer.call('Runtime.evaluate', { expression: '1' }).catch(error => error)).message, /not allowed/);
    const generation = (await (await fetch(`${endpoint}/pane/default/status`)).json()).generation;

    const note = await pane('default/pick', { x: 140, y: 150, generation });
    assert.equal(note.selector, 'html > body > div > button');
    assert.match(note.html, /^<button class="cta"/);
    assert.equal(note.styles.color, 'rgb(255, 0, 0)');
    assert.deepEqual(note.sources, [{ rule: '.cta', source: 'src/button.scss:3' }]);
    assert.ok(Buffer.from(note.crop, 'base64').length > 100);
    assert.match(note.context, /previous: <h1>/);
    assert.equal(note.origin, `http://${origin}`);
    assert.deepEqual((await pane('default/pick', { selector: 'p.note' })).sources, [{ rule: '.note', source: 'src/note.css:1' }]);
    assert.equal((await pane('default/pick', { x: 140, y: 150, generation: generation - 1 })).error, 'stale_generation');

    color = 'rgb(0, 0, 255)';
    assert.equal((await pane('default/act', { action: 'reload' })).ok, true);
    const again = await pane('default/pick', { selector: note.selector });
    assert.equal(again.styles.color, 'rgb(0, 0, 255)');
    assert.ok(again.generation > note.generation);
    await view.until(() => view.viewer.state().generation === again.generation);
    const before = view.count();
    view.send({ pointer: { action: 'down', button: 'left', x: 75, y: 287.5, inside: true } });
    view.send({ pointer: { action: 'up', button: 'left', x: 75, y: 287.5, inside: true } });
    view.send({ input: [...'e4e5'].map(text => ({ key: text, text })) });
    view.send({ input: [{ key: 'Backspace', text: null }] });
    const typed = async () => (await (await fetch(`${endpoint}/pane/default/state`)).json()).text;
    for (let attempt = 0; attempt < 150 && !/paragraph \[ref=\w+\]: e4e\n/.test(await typed()); attempt++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.match(await typed(), /paragraph \[ref=\w+\]: e4e\n/);
    await view.until((message, index) => index >= before && message.blit);
    view.send({ input: [{ key: 'Alt+Up', text: null }] });
    assert.equal((await view.until(message => message.meta?.zoom === 1.25)).meta.zoom, 1.25);
    await view.until(() => view.viewer.state().frame?.css.width === 512);
    view.close();
    assert.deepEqual((await pane('default/pick', { selector: 'h1' })).sources, []);
    const big = await pane('default/pick', { selector: 'section#big' });
    assert.deepEqual([big.truncated, big.html.length, big.selector], [true, 4000, 'section#big']);
    assert.ok(!big.crop || Buffer.from(big.crop, 'base64').length <= 30_000);

    assert.equal((await pane('chess/act', { action: 'navigate', url: `http://${origin}/` })).ok, true);
    const chess = watchViewer(endpoint, 'chess');
    chess.send({ box: { columns: 40, rows: 20, cell_px: { width: 8, height: 16 } } });
    await chess.until(sized(320, 320));
    chess.close();
    assert.equal((await (await fetch(`${endpoint}/pane/chess/state`)).json()).text, null);
    assert.match((await pane('chess/pick', { selector: 'button' })).error, /user-only/);
    assert.equal((await (await fetch(`${endpoint}/pane/chess/status`)).json()).user_only, true);
    assert.deepEqual(await pane('chess/close'), { closed: true });
    assert.equal((await (await fetch(`${endpoint}/pane/chess/status`)).json()).url, null);
  } finally {
    viewers.forEach(close => close());
    server.stdin.end();
    await new Promise(resolve => server.on('exit', resolve));
    site.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
