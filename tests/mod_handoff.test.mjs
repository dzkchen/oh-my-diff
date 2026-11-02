import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { claim, handoff } from '../mods/first-party/omd_cursor/handoff.mjs';

const MODS = ['omd_profiles', 'omd_claude_cli', 'omd_cursor'];

test('the port hand-off is the same file in every provider mod that ships it', () => {
  const [first, ...rest] = MODS.map(mod => readFileSync(new URL(`../mods/first-party/${mod}/handoff.mjs`, import.meta.url)));
  for (const [index, copy] of rest.entries()) assert.ok(copy.equals(first), `${MODS[index + 1]}/handoff.mjs differs from ${MODS[0]}/handoff.mjs`);
  for (const mod of MODS) assert.ok(JSON.parse(readFileSync(new URL(`../mods/first-party/${mod}/mod.json`, import.meta.url))).assets.includes('handoff.mjs'), mod);
});

test('a slow nonce answer still lets the claimant see the owner serve its readiness nonce', async () => {
  const owner = createServer((request, response) => {
    if (request.url === '/_omd/ready') response.end('OMD_READY:nonce-a');
  });
  await new Promise(resolve => owner.listen(0, '127.0.0.1', resolve));
  const { port } = owner.address();
  const claimant = createServer();
  const claimed = claim(claimant, port, 'local-token-'.repeat(4), 'nonce-a', ['route']).then(() => null, error => error);
  await new Promise(resolve => setTimeout(resolve, 3_600));
  owner.closeAllConnections();
  owner.close();
  assert.equal(await claimed, null);
  assert.equal(claimant.address().port, port);
  claimant.close();
});

test('an owner refuses a replayed hand-off and yields to a fresh one', async () => {
  const token = 'local-token-'.repeat(4);
  const seal = text => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(`omd-handoff\0${token}`).digest(), iv);
    const data = Buffer.concat([cipher.update(text), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
  };
  let stopped = 0;
  const handle = handoff(token, 'nonce-a', ['route-a'], () => { stopped += 1; });
  const owner = createServer(async (request, response) => { if (!await handle(request, response)) response.writeHead(404).end(); });
  await new Promise(resolve => owner.listen(0, '127.0.0.1', resolve));
  const post = body => fetch(`http://127.0.0.1:${owner.address().port}/_omd/nonce`, { method: 'POST', body }).then(reply => reply.status);
  try {
    assert.equal(await post(seal(`nonce-b other ${Date.now() - 60_000}`)), 401);
    assert.equal(stopped, 0);
    assert.equal(await post(seal(`nonce-b other ${Date.now()}`)), 204);
    assert.equal(stopped, 1);
  } finally {
    owner.closeAllConnections();
    owner.close();
  }
});
