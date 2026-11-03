import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from '../mods/node_modules/typescript/lib/typescript.js';
import { advance, calls, clock, emit, hostOperations, mount, runScenario, state, text } from '../mods/author/testing.mjs';

const manifest = {
  "schema": 1,
  "id": "answer_card",
  "version": "1.0.0",
  "api": "1.0.0",
  "state_version": 1,
  "state_scope": "thread",
  "capabilities": [
    "lifecycle",
    "events",
    "store",
    "terminal",
    "http"
  ],
  "http_access": {
    "origins": [
      "https://example.com"
    ]
  },
  "compatibility": {
    "required_features": [
      "timer_data_v1",
      "timers_16ms_v1",
      "reactive_state_v1",
      "state_scopes_v1",
      "structured_access_v1",
      "terminal_render_sites_v1",
      "ui_composition_v1"
    ]
  }
};
const source = `import type { ModAPI, TerminalPatch } from '@oh-my-diff/mod-api';

export default function activate(api: ModAPI) {
  const turn = api.atom('turn', '');
  const card = api.atom('card', '');
  const refresh = api.time.after<{ turn_id: string }>('card', 16, ({ data }) => {
    if (turn.get() !== data.turn_id) return;
    const response = api.host.tryCall('http.request', {
      url: 'https://example.com/cards/' + encodeURIComponent(data.turn_id),
      timeout_ms: 2000, max_bytes: 4096, redirects: 0,
    });
    card.set(response.ok && response.value.status >= 200 && response.value.status < 300
      ? response.value.body ?? '' : 'Card unavailable');
  });

  api.on('turn_start', event => {
    refresh.cancel();
    turn.set(event.turn_id);
    card.set('');
  });
  api.on('turn_end', event => {
    if (event.outcome !== 'completed') return;
    turn.set(event.turn_id);
    refresh.start({ turn_id: event.turn_id });
  });
  api.on('terminal', (): TerminalPatch => ({
    sites: { above_composer: { mode: 'wrap', components: [
      { type: 'slot' },
      { type: 'text', id: 'card', label: 'Answer card', text: card.get(), tone: 'muted' },
    ] } },
  }));
}`;
const first = '00000000-0000-4000-8000-000000000001';
const second = '00000000-0000-4000-8000-000000000002';
const turn = (threadId, turn_id) => [emit('turn_start', { turn_id }, { threadId }), emit('turn_end', { turn_id, outcome: 'completed' }, { threadId })];
const response = body => ({ result: { status: 200, url: 'https://example.com/cards/t1', headers: {}, redirects: [], truncated: false, bytes: body.length, body } });

function fixture(run) {
  const directory = mkdtempSync(join(tmpdir(), 'omd-background-work-'));
  try {
    writeFileSync(join(directory, 'mod.json'), JSON.stringify(manifest));
    writeFileSync(join(directory, 'index.ts'), source);
    return run(directory);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('payload timers require correctly typed arguments', () => fixture(directory => {
  const check = extra => {
    const file = join(directory, 'index.ts');
    writeFileSync(file, source + '\ndeclare const api: ModAPI;\n' + extra);
    return ts.getPreEmitDiagnostics(ts.createProgram([file], {
      strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext, types: [],
      paths: { '@oh-my-diff/mod-api': [new URL('../mods/api.d.ts', import.meta.url).pathname] },
    }));
  };
  assert.deepEqual(check(''), []);
  const reference = readFileSync(new URL('../mods/reference/events-and-lifecycle.md', import.meta.url), 'utf8');
  const example = reference.split('### `api.time` helpers')[1].match(/```ts\n([\s\S]*?)\n```/)[1];
  assert.deepEqual(check(example), []);
  const setup = "const task = api.time.after<{path: string}>('preview', 16, ({data}) => { data.path; });";
  assert.deepEqual(check(setup + "task.start({path: 'src/a.ts'});"), []);
  for (const invalid of ['task.start();', 'task.start({path: 1});', 'task.start(null);']) {
    assert.ok(check(setup + invalid).some(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error), invalid);
  }
  assert.deepEqual(check("api.time.after('old', 1000, ({key}) => { key; }).start(); api.time.every('tick', 1000, () => false).start();"), []);
}));

test('timer payloads carry the latest turn into state for repeated rendering', () => fixture(directory => {
  const result = runScenario(directory, clock(0), hostOperations({ 'http.request': [response('Hello')] }), { steps: [
    ...turn(first, 'old'), ...turn(first, 't1'),
    state('answer_card', { threadId: first, expect: { turn: 't1', card: '' } }),
    advance(16), mount('answer_card', { threadId: first }), mount('answer_card', { threadId: first }),
  ] });
  const requests = calls(result, 'http.request');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].at_ms, 16);
  assert.equal(requests[0].arguments.url, 'https://example.com/cards/t1');
  assert.match(text(result.steps.at(-1).value), /Hello/);
  assert.deepEqual(result.steps.at(-1).value, result.steps.at(-2).value);
}));

test('new turns cancel pending work and independent threads receive their own payloads', () => fixture(directory => {
  const result = runScenario(directory, clock(0), hostOperations({ 'http.request': [response('One'), response('Two')] }), { steps: [
    ...turn(first, 'cancelled'), emit('turn_start', { turn_id: 'next' }, { threadId: first }), advance(16),
    ...turn(first, 't1'), ...turn(second, 't2'), advance(16),
    state('answer_card', { threadId: first, expect: { turn: 't1', card: 'One' } }),
    state('answer_card', { threadId: second, expect: { turn: 't2', card: 'Two' } }),
  ] });
  assert.deepEqual(calls(result, 'http.request').map(call => call.arguments.url), ['https://example.com/cards/t1', 'https://example.com/cards/t2']);
}));

test('HTTP refusals become saved presentation state', () => fixture(directory => {
  runScenario(directory, clock(0), hostOperations({ 'http.request': [{ error: 'http_origin_denied' }] }), { steps: [
    ...turn(first, 't1'), advance(16),
    state('answer_card', { threadId: first, expect: { turn: 't1', card: 'Card unavailable' } }),
  ] });
}));
