import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callback } from './mod_runner.mjs';

const redactor = `export default function (api) {
  api.command('redact', (args) => {
    const [threadId, word] = String(args).split(' ');
    const items = api.host.call('app.request', { method: 'thread/items/list', params: { threadId } }).data;
    const { revision, rows } = api.host.call('app.request', { method: 'thread/rewrite', params: { threadId } });
    const edits = items
      .filter(item => item.type === 'userMessage' && item.text.includes(word))
      .filter(item => rows.some(row => row.id === item.id && row.access === 'edit'))
      .map(item => ({ op: 'replace', id: item.id, items: [{ type: 'message', role: 'user',
        content: [{ type: 'input_text', text: item.text.split(word).join('[redacted]') }] }] }));
    if (!edits.length) return { display: 'nothing to redact' };
    const result = api.host.call('app.request', { method: 'thread/rewrite', params: { threadId, expectedRevision: revision, edits } });
    return { display: 'redacted ' + edits.length + ' at ' + result.revision };
  });
}`;

const pruner = `export default function (api) {
  api.command('prune', (threadId) => {
    const { revision, rows } = api.host.call('app.request', { method: 'thread/rewrite', params: { threadId } });
    const edits = rows.filter(row => row.kind === 'function_call' && row.access === 'edit').map(row => ({ op: 'delete', id: row.id }));
    const result = api.host.call('app.request', { method: 'thread/rewrite', params: { threadId, expectedRevision: revision, edits } });
    return { display: 'pruned ' + edits.length + ', undo with revision ' + result.revision };
  });
  api.command('restore', (threadId) => {
    const { revision } = api.host.call('app.request', { method: 'thread/rewrite', params: { threadId } });
    api.host.call('app.request', { method: 'thread/rewrite', params: { threadId, expectedRevision: revision, undo: true } });
    return { display: 'restored' };
  });
}`;

function thread() {
  let generation = 1;
  let rows = [
    { id: 'u1', turnId: 't1', kind: 'message.user', access: 'edit', text: 'deploy with SECRET' },
    { id: 'c1', turnId: 't1', kind: 'function_call', access: 'edit' },
    { id: 'a1', turnId: 't1', kind: 'message.assistant', access: 'edit', text: 'done' },
  ];
  const history = [];
  const view = () => ({ revision: `r:${generation}`, rows: rows.map(({ text, ...row }) => row) });
  return {
    rows: () => rows,
    request(method, params) {
      if (method === 'thread/items/list') {
        return { data: rows.filter(row => row.text).map(row => ({ id: row.id, type: row.kind === 'message.user' ? 'userMessage' : 'agentMessage', text: row.text })) };
      }
      assert.equal(method, 'thread/rewrite');
      if (params.expectedRevision === undefined) return { ...view(), previousRevision: null };
      if (params.expectedRevision !== view().revision) throw new Error('history_revision_conflict');
      const previous = view().revision;
      if (params.undo) {
        rows = history.pop();
      } else {
        history.push(rows);
        for (const edit of params.edits) {
          if (edit.op === 'delete') rows = rows.filter(row => row.id !== edit.id);
          if (edit.op === 'replace') rows = rows.map(row => row.id === edit.id ? { ...row, text: edit.items[0].content[0].text } : row);
        }
      }
      generation += 1;
      return { ...view(), previousRevision: previous };
    },
  };
}

function run(source, name, payload, target) {
  const request = { source, filename: 'index.ts', api: '0.2.0-experimental.5', capabilities: ['commands', 'sessions', 'history_write'],
    state: null, settings: {}, event: 'command', name, payload, hook_budget_ms: 10000 };
  const output = callback(request, call => {
    assert.equal(call.operation, 'app.request');
    return target.request(call.arguments.method, call.arguments.params ?? {});
  });
  if (output.error) throw new Error(output.error);
  return output.value.display;
}

test('two unrelated mods rewrite a transcript through revision-checked thread/rewrite', () => {
  const target = thread();
  assert.equal(run(redactor, 'redact', 'thread-1 SECRET', target), 'redacted 1 at r:2');
  assert.equal(target.rows()[0].text, 'deploy with [redacted]');
  assert.equal(run(pruner, 'prune', 'thread-1', target), 'pruned 1, undo with revision r:3');
  assert.deepEqual(target.rows().map(row => row.id), ['u1', 'a1']);
  assert.equal(run(pruner, 'restore', 'thread-1', target), 'restored');
  assert.deepEqual(target.rows().map(row => row.id), ['u1', 'c1', 'a1']);
  assert.equal(run(redactor, 'redact', 'thread-1 SECRET', target), 'nothing to redact');
});
