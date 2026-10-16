import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, unsupported } from '../mods/author/client.mjs';
import { encodeFrame, frameReader } from '../mods/author/frames.mjs';

const renderer = { kind: 'text', formats: ['text'], pointer: 'none', reducedMotion: true };

test('frame reader assembles chunked large payloads with linear copying', t => {
  const payload = Buffer.alloc(2_097_152, 0x61);
  for (const masked of [false, true]) {
    const frame = encodeFrame(1, payload, masked);
    const received = [];
    const read = frameReader((opcode, body) => received.push([opcode, body]));
    const concat = Buffer.concat;
    let copied = 0;
    t.mock.method(Buffer, 'concat', (chunks, length) => {
      copied += length ?? chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      return concat(chunks, length);
    });
    try {
      for (let at = 0; at < frame.length; at += 65_536) read(frame.subarray(at, at + 65_536));
    } finally {
      t.mock.restoreAll();
    }
    assert.equal(received.length, 1);
    assert.equal(received[0][0], 1);
    assert.deepEqual(received[0][1], payload);
    assert.ok(copied <= frame.length * 2, `${copied} copied bytes for ${frame.length} input bytes`);
    t.diagnostic(`${masked ? 'masked' : 'unmasked'}: ${copied} concatenated bytes for ${frame.length} input bytes`);
  }
});

test('frame reader handles split headers, fragments, controls and coalesced frames', () => {
  for (const masked of [false, true]) {
    const first = encodeFrame(1, Buffer.from('start'), masked);
    first[0] &= 0x7f;
    const frames = [first, encodeFrame(9, Buffer.from('ping'), masked),
      encodeFrame(0, Buffer.alloc(130, 0x62), masked), encodeFrame(2, Buffer.alloc(70_000, 0x63), masked),
      encodeFrame(1, Buffer.alloc(0), masked), encodeFrame(8, Buffer.from([3, 232]), masked)];
    const wire = Buffer.concat(frames);
    const expected = [[9, Buffer.from('ping')], [1, Buffer.concat([Buffer.from('start'), Buffer.alloc(130, 0x62)])],
      [2, Buffer.alloc(70_000, 0x63)], [1, Buffer.alloc(0)], [8, Buffer.from([3, 232])]];
    for (const width of [1, 3, wire.length]) {
      const received = [];
      const read = frameReader((opcode, body) => received.push([opcode, Buffer.from(body)]));
      for (let at = 0; at < wire.length; at += width) read(new Uint8Array(wire.subarray(at, at + width)));
      read(Buffer.alloc(0));
      assert.deepEqual(received, expected);
    }
  }
});

async function until(find) {
  for (let waited = 0; waited < 5000; waited += 10) {
    const found = find();
    if (found) return found;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('timed out');
}

function fakeHost({ padding = '', pushes = true, view = {}, staleActions = 0, refuseResumes = false, overloadedResumes = 0, refuseInitialize = false } = {}) {
  const seen = [];
  const protocols = [];
  const sockets = new Set();
  let epoch = 0;
  const server = createServer();
  server.on('upgrade', (request, socket) => {
    epoch += 1;
    const accept = createHash('sha1').update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    protocols.push(request.headers['sec-websocket-protocol']);
    socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`,
      ...(protocols.at(-1) ? ['Sec-WebSocket-Protocol: codex-app-server'] : []), '', ''].join('\r\n'));
    const host = { epoch: String(epoch), token: 'token-0', used: 0, send: message => socket.write(encodeFrame(1, Buffer.from(JSON.stringify(message)), false)) };
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('data', frameReader((opcode, payload) => {
      if (opcode === 1) handle(host, JSON.parse(payload.toString()));
      else if (opcode === 10) seen.push({ epoch: host.epoch, pong: payload.toString() });
      else if (opcode === 8) socket.end();
    }));
  });
  function handle(host, message) {
    seen.push({ epoch: host.epoch, ...message });
    const reply = result => host.send({ id: message.id, result });
    if (message.method === 'initialize' && refuseInitialize && host.epoch !== '1') host.send({ id: message.id, error: { code: -32600, message: 'not_ready' } });
    else if (message.method === 'initialize') reply({ userAgent: 'fake' });
    else if (message.method === 'omd/client/attach') {
      reply({ clientId: `client-${host.epoch}`, protocol: 'omd-client/1', epoch: host.epoch, roster: [], features: [], delegable: [] });
      if (pushes) host.send({ method: 'omd/view/updated', params: { epoch: host.epoch, revision: 1, snapshot: { view, padding }, actionToken: host.token } });
    } else if (message.method === 'thread/resume' && refuseResumes && host.epoch !== '1') host.send({ id: message.id, error: { code: -32600, message: 'thread_gone' } });
    else if (message.method === 'thread/resume' && host.epoch !== '1' && overloadedResumes > 0 && overloadedResumes--) host.send({ id: message.id, error: { code: -32001, message: 'Server overloaded; retry later.' } });
    else if (message.method === 'omd/action') {
      if (staleActions > 0 && staleActions--) host.send({ id: message.id, error: { code: -32600, message: 'action_stale' } });
      else if (message.params.actionToken !== host.token) host.send({ id: message.id, error: { code: -32600, message: 'action_replayed' } });
      else {
        const spent = (host.token = `token-${++host.used}`);
        if (message.params.component === 'redraws') {
          host.token = 'token-view';
          host.send({ method: 'omd/view/updated', params: { epoch: host.epoch, revision: 2, snapshot: { view: {} }, actionToken: host.token } });
        }
        if (message.params.component === 'gone') host.send({ id: message.id, error: { code: -32600, message: 'action_unavailable: gone' } });
        else reply({ status: 'completed', outcome: { display: `ran ${message.params.component}` }, actionToken: spent });
      }
    } else if (message.method === 'omd/view/read') reply({ epoch: host.epoch, revision: 1, snapshot: { view }, actionToken: host.token });
    else if (message.method && message.id !== undefined) reply({});
  }
  const push = message => [...sockets].at(-1).write(encodeFrame(1, Buffer.from(JSON.stringify(message)), false));
  return { server, seen, protocols, sockets, push };
}

test('ws client initializes with the experimental API, tracks views, serializes rotating action tokens and answers server requests', async () => {
  const host = fakeHost();
  await new Promise(resolve => host.server.listen(0, '127.0.0.1', resolve));
  const views = [];
  const session = await connect({
    url: `ws://127.0.0.1:${host.server.address().port}`, token: 'secret', name: 'sdk-test', renderer, operations: ['terminal.prompt'], reconnect: false,
    onView: view => views.push(view), onRoster() {}, onMirrored() {},
    onSurfaceCall: call => ({ status: 'accepted', operation: call.operation }),
  });
  try {
    assert.deepEqual(host.protocols, ['codex-app-server, codex.bearer.secret']);
    const initialize = host.seen.find(message => message.method === 'initialize');
    assert.equal(initialize.params.capabilities.experimentalApi, true);
    assert.ok(host.seen.some(message => message.method === 'initialized' && message.id === undefined));
    assert.deepEqual(host.seen.find(message => message.method === 'omd/client/attach').params, { name: 'sdk-test', renderer, operations: ['terminal.prompt'] });
    await until(() => views.length);
    assert.equal(session.actionToken, 'token-0');

    const results = await Promise.all([session.action({ component: 'rows', row: 0 }), session.action({ component: 'rows', row: 1 })]);
    assert.deepEqual(results.map(result => [result.status, result.outcome]), [['completed', { display: 'ran rows' }], ['completed', { display: 'ran rows' }]]);
    assert.deepEqual(host.seen.filter(message => message.method === 'omd/action').map(message => message.params.actionToken), ['token-0', 'token-1']);
    assert.equal(session.actionToken, 'token-2');
    await session.action({ component: 'redraws' });
    assert.equal(session.actionToken, 'token-view', 'a view pushed while the action ran carries the newer token');
    await assert.rejects(session.action({ component: 'gone' }), /action_unavailable/);
    assert.equal(host.seen.at(-1).method, 'omd/view/read', 'a failed action spends the token, so the client re-reads the view');
    assert.equal((await session.action({ component: 'rows', row: 0 })).status, 'completed');

    host.push({ id: 'surface', method: 'omd/surface/call', params: { caller: 'example', operation: 'terminal.prompt', arguments: {} } });
    host.push({ id: 'other', method: 'item/tool/requestUserInput', params: {} });
    const answer = await until(() => host.seen.find(message => message.id === 'surface' && !message.method));
    assert.deepEqual(answer.result, { status: 'accepted', operation: 'terminal.prompt' });
    assert.equal(host.seen.some(message => message.id === 'other' && !message.method), false, 'a request the client does not handle stays unanswered');

    await session.event('rows', { kind: 'focus' });
    assert.deepEqual(host.seen.findLast(message => message.method === 'omd/client/event').params, { epoch: '1', component: 'rows', event: { kind: 'focus' } });
  } finally {
    session.close();
    host.server.close();
  }
});

test('unix client answers pings, reads large views and reconnects with attach, update and resumed threads', async () => {
  const host = fakeHost({ padding: 'x'.repeat(70_000) });
  const path = join(mkdtempSync(join(tmpdir(), 'omd-client-')), 'host.sock');
  await new Promise(resolve => host.server.listen(path, resolve));
  const views = [];
  let reconnected;
  const session = await connect({
    url: `unix://${path}`, name: 'sdk-test', renderer,
    onView: view => views.push(view), onRoster() {}, onMirrored() {},
    onReconnect: change => { reconnected = change; },
  });
  try {
    await until(() => views.length);
    assert.equal(views[0].snapshot.padding.length, 70_000);
    [...host.sockets][0].write(encodeFrame(9, Buffer.from('alive'), false));
    await until(() => host.seen.find(message => message.pong === 'alive'));

    await session.request('thread/resume', { threadId: 'thread-1' });
    await session.update({ viewport: { width: 80, height: 24, unit: 'cell' } });
    for (const socket of host.sockets) socket.destroy();
    await until(() => reconnected);
    assert.deepEqual(reconnected, { epoch: '2', previousEpoch: '1' });
    const second = host.seen.filter(message => message.epoch === '2' && message.method).map(message => message.method);
    assert.deepEqual(second, ['initialize', 'initialized', 'omd/client/attach', 'omd/client/update', 'thread/resume']);
    assert.equal(host.seen.findLast(message => message.method === 'thread/resume').params.threadId, 'thread-1');
    await until(() => views.some(view => view.epoch === '2'));
    assert.equal(session.actionToken, 'token-0');
  } finally {
    session.close();
    host.server.close();
  }
});

test('a resume the host refuses after a reconnect is dropped and the client keeps reconnecting', async () => {
  const host = fakeHost({ refuseResumes: true });
  const path = join(mkdtempSync(join(tmpdir(), 'omd-client-')), 'host.sock');
  await new Promise(resolve => host.server.listen(path, resolve));
  let reconnected = 0;
  let closed = false;
  const session = await connect({ url: `unix://${path}`, name: 'sdk-test', renderer, onView() {}, onRoster() {}, onMirrored() {}, onReconnect: () => { reconnected++; }, onClose: () => { closed = true; } });
  try {
    await session.request('thread/resume', { threadId: 'thread-1' });
    for (const socket of host.sockets) socket.destroy();
    await until(() => reconnected);
    for (const socket of host.sockets) socket.destroy();
    await until(() => reconnected > 1);
    assert.equal(closed, false);
    assert.equal(host.seen.filter(message => message.method === 'thread/resume').length, 2, 'the refused resume is not replayed again');
  } finally {
    session.close();
    host.server.close();
  }
});

test('a resume refused as overloaded after a reconnect is retried, not dropped', async () => {
  const host = fakeHost({ overloadedResumes: 1 });
  const path = join(mkdtempSync(join(tmpdir(), 'omd-client-')), 'host.sock');
  await new Promise(resolve => host.server.listen(path, resolve));
  let reconnected;
  const session = await connect({ url: `unix://${path}`, name: 'sdk-test', renderer, onView() {}, onRoster() {}, onMirrored() {}, onReconnect: change => { reconnected = change; } });
  try {
    await session.request('thread/resume', { threadId: 'thread-1' });
    for (const socket of host.sockets) socket.destroy();
    await until(() => reconnected);
    assert.deepEqual(reconnected, { epoch: '3', previousEpoch: '1' });
    assert.deepEqual(host.seen.filter(message => message.method === 'thread/resume').map(message => message.epoch), ['1', '2', '3']);
  } finally {
    session.close();
    host.server.close();
  }
});

test('a host that refuses initialize after a restart ends the session instead of retrying forever', async () => {
  const host = fakeHost({ refuseInitialize: true });
  const path = join(mkdtempSync(join(tmpdir(), 'omd-client-')), 'host.sock');
  await new Promise(resolve => host.server.listen(path, resolve));
  let closed = false;
  const session = await connect({ url: `unix://${path}`, name: 'sdk-test', renderer, onView() {}, onRoster() {}, onMirrored() {}, onClose: () => { closed = true; } });
  try {
    for (const socket of host.sockets) socket.destroy();
    await until(() => closed);
  } finally {
    session.close();
    host.server.close();
  }
});

test('unix client fails a handshake the peer closes and reads a token when acting before the first view', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'omd-client-'));
  const closing = createNetServer(socket => socket.end());
  await new Promise(resolve => closing.listen(join(directory, 'closing.sock'), resolve));
  await assert.rejects(connect({ url: `unix://${join(directory, 'closing.sock')}`, name: 'sdk-test', renderer }), /closed during handshake/);
  closing.close();

  const host = fakeHost({ pushes: false });
  await new Promise(resolve => host.server.listen(join(directory, 'host.sock'), resolve));
  const session = await connect({ url: `unix://${join(directory, 'host.sock')}`, name: 'sdk-test', renderer, reconnect: false, onView() {}, onRoster() {}, onMirrored() {} });
  try {
    assert.equal((await session.action({ component: 'rows', row: 0 })).status, 'completed');
    assert.deepEqual(host.seen.filter(message => message.method?.startsWith('omd/')).map(message => message.method), ['omd/client/attach', 'omd/view/read', 'omd/action']);
  } finally {
    session.close();
    host.server.close();
  }
});

test('unsupported names the element, the reason and its fallback', () => {
  const gui = { kind: 'gui', formats: ['svg'], pointer: 'pixel', reducedMotion: false };
  const raster = { type: 'raster', id: 'meter', alt: 'A meter', width: 8, height: 1 };
  assert.equal(unsupported({ type: 'image', id: 'badge', alt: 'Badge' }, gui, ['image', 'raster']), null);
  assert.equal(unsupported(raster, gui, ['raster']).message, "unsupported_element: raster 'meter': a raster needs the 'cells' format; drawing its fallback \"A meter\"");
  const missing = unsupported({ type: 'input', id: 'note', label: 'Note' }, renderer, ['text']);
  assert.deepEqual([missing.code, missing.component, missing.fallback], ['unsupported_element', 'note', 'Note']);
});

test('server requests are answered only through onServerRequest, and undefined leaves them to the terminal', async () => {
  const host = fakeHost();
  await new Promise(resolve => host.server.listen(0, '127.0.0.1', resolve));
  const session = await connect({
    url: `ws://127.0.0.1:${host.server.address().port}`, name: 'sdk-test', renderer, reconnect: false, onView() {}, onRoster() {}, onMirrored() {},
    onServerRequest: method => (method === 'item/commandExecution/requestApproval' ? { decision: 'accept' } : undefined),
  });
  try {
    host.push({ id: 'input', method: 'item/tool/requestUserInput', params: {} });
    host.push({ id: 'approval', method: 'item/commandExecution/requestApproval', params: {} });
    const answer = await until(() => host.seen.find(message => message.id === 'approval' && !message.method));
    assert.deepEqual(answer.result, { decision: 'accept' });
    assert.equal(host.seen.some(message => message.id === 'input' && !message.method), false);
  } finally {
    session.close();
    host.server.close();
  }
});

test('server replies stay with the connection that requested them', async t => {
  for (const [method, handler] of [['item/commandExecution/requestApproval', 'onServerRequest'], ['omd/surface/call', 'onSurfaceCall']]) {
    for (const failed of [false, true]) await t.test(`${handler} ${failed ? 'error' : 'result'}`, async () => {
      const host = fakeHost();
      await new Promise(resolve => host.server.listen(0, '127.0.0.1', resolve));
      const pending = [];
      let reconnected = false;
      const session = await connect({
        url: `ws://127.0.0.1:${host.server.address().port}`, name: 'sdk-test', renderer,
        [handler]: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
        onReconnect: () => { reconnected = true; },
      });
      try {
        host.push({ id: 0, method, params: {} });
        await until(() => pending.length === 1);
        for (const socket of host.sockets) socket.destroy();
        await until(() => reconnected);
        host.push({ id: 0, method, params: {} });
        await until(() => pending.length === 2);
        if (failed) pending[0].reject(new Error('expired request'));
        else pending[0].resolve({ decision: 'accept' });
        await new Promise(resolve => setImmediate(resolve));
        await session.request('thread/list', {});
        assert.equal(host.seen.some(message => message.epoch === '2' && message.id === 0 && !message.method), false);
        pending[1].resolve({ decision: 'decline' });
        const reply = await until(() => host.seen.find(message => message.epoch === '2' && message.id === 0 && !message.method));
        assert.deepEqual(reply.result, { decision: 'decline' });
      } finally {
        session.close();
        for (const socket of host.sockets) socket.destroy();
        host.server.close();
      }
    });
  }
});

test('close during a reconnect ends the session instead of reattaching', async () => {
  const host = fakeHost();
  const path = join(mkdtempSync(join(tmpdir(), 'omd-client-')), 'host.sock');
  await new Promise(resolve => host.server.listen(path, resolve));
  let closes = 0;
  const session = await connect({ url: `unix://${path}`, name: 'sdk-test', renderer, onView() {}, onRoster() {}, onMirrored() {}, onClose: () => { closes += 1; } });
  host.server.once('upgrade', () => session.close());
  for (const socket of host.sockets) socket.destroy();
  await until(() => closes);
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(closes, 1);
  assert.equal(host.seen.some(message => message.epoch === '2' && message.method === 'omd/client/attach'), false);
  host.server.close();
});

test('stdio client survives a child that closes its stdin', async () => {
  const script = `process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => { for (const line of chunk.split('\\n').filter(Boolean)) {
    const message = JSON.parse(line);
    if (message.id !== undefined) process.stdout.write(JSON.stringify({ id: message.id, result: { epoch: '1' } }) + '\\n');
    if (message.method === 'omd/client/attach') { setTimeout(() => require('fs').closeSync(0), 100); setTimeout(() => {}, 5000); }
  } });`;
  let closed = false;
  const session = await connect({ url: 'stdio', command: ['node', '-e', script], name: 'sdk-test', renderer, reconnect: false, onView() {}, onRoster() {}, onMirrored() {}, onClose: () => { closed = true; } });
  await new Promise(resolve => setTimeout(resolve, 300));
  await session.request('thread/list', {}).catch(() => {});
  await until(() => closed);
});

test('the external client example picks itself again after a stale action', async () => {
  const view = { sites: { sidebar: { components: [{ type: 'list', id: 'external_clients', rows: [{ value: 'client-1', label: 'this client' }] }] } } };
  const host = fakeHost({ view, staleActions: 1 });
  await new Promise(resolve => host.server.listen(0, '127.0.0.1', resolve));
  const example = new URL('../mods/examples/external_client/client.mjs', import.meta.url);
  const child = spawn(process.execPath, [example.pathname, `ws://127.0.0.1:${host.server.address().port}`], { stdio: ['ignore', 'ignore', 'pipe'] });
  let log = '';
  child.stderr.on('data', chunk => { log += chunk; });
  const exited = new Promise(resolve => child.on('exit', resolve));
  try {
    await until(() => log.includes('action action_stale'));
    host.push({ method: 'omd/view/updated', params: { epoch: '1', revision: 2, snapshot: { view }, actionToken: 'token-0' } });
    await until(() => log.includes('action completed: ran external_clients'));
    assert.equal(host.seen.filter(message => message.method === 'omd/action').length, 2);
  } finally {
    child.kill();
    await exited;
    host.server.close();
  }
});
