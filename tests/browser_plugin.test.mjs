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
