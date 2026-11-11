import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Router } from '../mods/first-party/omd_cursor/transport.mjs';

for (const phase of ['agent', 'send']) {
  test(`Cursor supersession during ${phase} admission cancels stale ownership`, async () => {
    const data = await mkdtemp(join(tmpdir(), 'cursor-admission-'));
    const router = new Router({ data }, { name: 'fixture' }, 'fixture');
    router.ready = async () => {};
    let release, enter;
    const gate = new Promise(resolve => { release = resolve; });
    const entered = new Promise(resolve => { enter = resolve; });
    let agents = 0, sends = 0, cancellations = 0;
    router.agent = async () => {
      const id = ++agents;
      if (id === 1 && phase === 'agent') { enter(); await gate; }
      return { fresh: true, input: [], agent: { agentId: `agent-${id}`, send: async () => {
        sends++;
        if (id === 1 && phase === 'send') { enter(); await gate; }
        return { wait: () => new Promise(() => {}), cancel: async () => { cancellations++; } };
      } } };
    };
    try {
      const payload = { input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'work' }] }] };
      const first = router.start(payload, { id: 'm', slug: 'm' }, 'thread');
      const rejected = assert.rejects(first, /cursor_turn_superseded/);
      await entered;
      const second = await router.start(payload, { id: 'm', slug: 'm' }, 'thread');
      release();
      await rejected;
      assert.equal(router.turns.size, 1);
      assert.equal(router.turns.get(second.key), second.turn);
      assert.equal(sends, phase === 'agent' ? 1 : 2);
      assert.equal(cancellations, phase === 'agent' ? 0 : 1);
    } finally { release(); await rm(data, { recursive: true, force: true }); }
  });
}

test('concurrent cancellation during agent initialization uses distinct state files', async t => {
  const data = await mkdtemp(join(tmpdir(), 'cursor-cancel-'));
  const router = new Router({ data }, { name: 'fixture' }, 'fixture');
  router.ready = async () => {};
  t.mock.method(Date, 'now', () => 123456);
  let release, enter, count = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { enter = resolve; });
  router.agent = async () => {
    const id = ++count;
    if (count === 2) enter();
    await gate;
    return { fresh: true, input: [], agent: { agentId: `agent-${id}` } };
  };
  const payload = { input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'work' }] }] };
  const rejected = ['one', 'two'].map(thread => assert.rejects(
    router.start(payload, { id: 'm', slug: 'm' }, thread), /cursor_turn_superseded/));
  try {
    await entered;
    const results = await Promise.allSettled([...router.turns.keys()].map(key => router.cancel(key, 'cancelled')));
    assert.deepEqual(results.map(result => result.status), ['fulfilled', 'fulfilled']);
    assert.equal(router.turns.size, 0);
  } finally {
    release();
    await Promise.all(rejected);
    await rm(data, { recursive: true, force: true });
  }
});

test('late SDK tool callbacks reject after their admitting turn is superseded', async () => {
  const data = await mkdtemp(join(tmpdir(), 'cursor-late-tool-'));
  const router = new Router({ data }, { name: 'fixture' }, 'fixture');
  router.ready = async () => {};
  let release, enter, lateTools, oldTurn, count = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { enter = resolve; });
  router.agent = async () => {
    const id = ++count;
    return { fresh: true, input: [], agent: { agentId: `agent-${id}`, send: async (_prompt, options) => {
      if (id === 1) {
        lateTools = options.local.customTools;
        oldTurn = [...router.turns.values()][0];
        enter();
        await gate;
      }
      return { wait: () => new Promise(() => {}), cancel: async () => {} };
    } } };
  };
  const payload = { tools: [{ type: 'function', name: 'foo', parameters: { type: 'object' } }],
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'work' }] }] };
  const rejected = assert.rejects(router.start(payload, { id: 'm', slug: 'm' }, 'thread'), /cursor_turn_superseded/);
  try {
    await entered;
    await router.start(payload, { id: 'm', slug: 'm' }, 'thread');
    const result = lateTools.foo.execute({});
    result.catch(() => {});
    assert.equal(oldTurn.calls.size, 0);
    await assert.rejects(result, /cursor_run_ended/);
  } finally {
    release();
    await rejected;
    await rm(data, { recursive: true, force: true });
  }
});
