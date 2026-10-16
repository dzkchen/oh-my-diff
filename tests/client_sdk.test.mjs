import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from '../mods/author/client.mjs';
import { encodeFrame, frameReader } from '../mods/author/frames.mjs';

const renderer = { kind: 'text', formats: ['text'], pointer: 'none', reducedMotion: true };

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

function fakeHost({ padding = '', view = {} } = {}) {
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
    if (message.method === 'initialize') reply({ userAgent: 'fake' });
    else if (message.method === 'omd/client/attach') {
      reply({ clientId: `client-${host.epoch}`, protocol: 'omd-client/1', epoch: host.epoch, roster: [], features: [], delegable: [] });
      host.send({ method: 'omd/view/updated', params: { epoch: host.epoch, revision: 1, snapshot: { view, padding }, actionToken: host.token } });
    } else if (message.method === 'omd/action') {
      if (message.params.actionToken !== host.token) host.send({ id: message.id, error: { code: -32600, message: 'action_replayed' } });
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
