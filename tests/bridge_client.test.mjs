import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BridgeClient } from '../bridge/client.mjs';

test('a failed state reply does not discard later commands in the poll batch', async () => {
  const client = new BridgeClient({ url: 'unused', token: 'token' }, { id: 'app' });
  client.instanceId = 'instance';
  client.handlers.set('health', () => 'ok');
  const replies = [];
  client.post = async (route, body) => {
    if (route === '/v1/poll') return { commands: ['expired', 'live'].map(request_id => ({ request_id, name: 'health' })) };
    if (body.request_id === 'expired') throw new Error('state request is not pending');
    replies.push(body);
    return { accepted: true };
  };
  await client.poll();
  assert.deepEqual(replies.map(reply => reply.request_id), ['live']);
});
