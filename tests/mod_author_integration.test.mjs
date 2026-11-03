import {afterEach, beforeEach, test} from 'node:test';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {advance, calls, clock, coreValue, emit, hostOperations, intercept, invoke, mount, reload, runScenario, state} from '../mods/author/testing.mjs';

const manifest = {
  "schema": 1,
  "id": "answer_connections",
  "version": "0.1.0",
  "api": "1.0.0",
  "state_version": 1,
  "state_scope": "thread",
  "license": "MIT",
  "capabilities": [
    "commands",
    "credentials",
    "events",
    "store",
    "lifecycle",
    "http",
    "terminal"
  ],
  "http_access": {
    "origins": [
      "https://example.com"
    ],
    "credentials": [
      "owned"
    ]
  },
  "compatibility": {
    "required_features": [
      "session_activation_v1",
      "background_jobs_v1",
      "assistant_message_identity_v1",
      "secrets_v1",
      "render_hooks_v1",
      "reactive_state_v1",
      "state_scopes_v1", "terminal_render_sites_v1", "ui_composition_v1"
    ]
  }
};
const source = `import type { Json, ModAPI, RenderEvent, TerminalPatch } from '@oh-my-diff/mod-api';

type Message = { message_id: string };

export default function activate(api: ModAPI) {
  const connection = api.atom('connection', '');
  const latest = api.atom<Message>('latest', { message_id: '' });
  const cards = api.atom<Record<string, string>>('cards', {});
  let requests = 0;
  const refresh = api.background<Message, Json>('refresh', input => {
    const credential = connection.get();
    if (!credential) throw new Error('Connect an account first');
    const response = api.host.call('http.request', {
      url: 'https://example.com/cards/' + encodeURIComponent(input.message_id),
      credential, max_bytes: 4096, timeout_ms: 2000, redirects: 0,
    });
    if (response.status < 200 || response.status >= 300) throw new Error('Card request failed: ' + response.status);
    if (response.truncated) throw new Error('Card response exceeded the size limit');
    const saved = { ...cards.get(), [input.message_id]: response.body ?? '' };
    for (const key of Object.keys(saved).slice(0, Math.max(0, Object.keys(saved).length - 32))) delete saved[key];
    cards.set(saved);
    return { message_id: input.message_id, requests: ++requests };
  });

  api.command('connect', () => {
    const result = api.host.call('credentials.request', {
      action: 'enroll', kind: 'secret', label: 'Answer cards', origin: 'https://example.com',
    });
    if (result.status === 'completed' && result.profile) connection.set(result.profile.id);
    return { display: result.status === 'completed' ? 'Connected' : 'Connection declined' };
  });
  api.command('disconnect', () => {
    refresh.cancel();
    const profile = connection.get();
    if (profile) {
      const result = api.host.call('credentials.request', { action: 'remove', profile });
      if (result.status !== 'completed') return { display: 'Disconnect declined' };
    }
    connection.set('');
    cards.set({});
    return { display: 'Disconnected' };
  });
  api.command('retry', () => {
    const message = latest.get();
    if (!message.message_id) return { display: 'No message to attach a card to' };
    refresh.start(message);
    return { display: 'Card request queued' };
  });
  api.command('cancel', () => { refresh.cancel(); return { display: 'Pending card request cancelled' }; });
  api.command('status', () => ({ display: JSON.stringify(refresh.get()) }));
  api.on('assistant_message', message => {
    latest.set({ message_id: message.message_id });
    if (connection.get()) refresh.start({ message_id: message.message_id });
  });
  api.on('terminal', (event): TerminalPatch | null => {
    if (event.presentation?.surface !== 'inline') return null;
    const card = cards.get()[latest.get().message_id];
    return card ? { sites: { above_composer: { mode: 'wrap', components: [
      { type: 'slot' }, { type: 'text', id: 'latest_card', label: 'Connected account', text: card, tone: 'muted' },
    ] } } } : null;
  });
  api.intercept('render', { match: { component: 'assistant_message', lifecycle: 'final', props: { first: true } } }, async (event, next) => {
    const inner = await next(event);
    const message = event as RenderEvent<'assistant_message'>;
    const id = message.props.message_id;
    const card = id ? cards.get()[id] : undefined;
    return card ? { tree: [...inner.tree, { type: 'text', id: 'answer_card', label: 'Connected account', text: card, tone: 'muted' }] } : inner;
  });
}
`;
let directory;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'omd-author-integration-'));
  writeFileSync(join(directory, 'mod.json'), JSON.stringify(manifest));
  writeFileSync(join(directory, 'index.ts'), source);
});
afterEach(() => rmSync(directory, {recursive: true, force: true}));
const threadId = '00000000-0000-4000-8000-000000000001';
const id = 'answer_connections';
const profile = {id: 'synthetic-profile', label: 'Fixture', kind: 'secret', provider: null, origin: 'https://example.com', status: 'ready', default: false};
const credential = {result: {status: 'completed', profile}};
const response = body => ({result: {status: 200, url: 'https://example.com/cards/m1', headers: {}, redirects: [], truncated: false, bytes: body.length, body}});
const command = name => invoke(id, 'command', name, null, {threadId});
const message = message_id => emit('assistant_message', {thread_id: threadId, turn_id: 'turn-one', message_id, text: 'Identical answer', truncated: false}, {threadId});
const inspect = () => state(id, {threadId});
const draw = message_id => intercept('render', {component: 'assistant_message', id: message_id, lifecycle: 'final', surface: 'fullscreen', owner: null, props: {text: 'Identical answer', first: true, truncated: false, message_id}}, {threadId, core: [coreValue({tree: [{type: 'native'}]})]});

test('connect, attach separate cards to identical messages, reload and disconnect', () => {
  const trace = runScenario(directory, clock(0), hostOperations({
    'credentials.request': [credential, {result: {status: 'completed', profile: null}}],
    'http.request': [response('First card'), response('Second card')],
  }), {steps: [command('connect'), message('m1'), advance(16), message('m2'), advance(16), inspect(), draw('m1'), draw('m2'), mount(id, {threadId, payload: {event: 'draw', ledger: null, presentation: {thread_id: threadId, phase: 'started', surface: 'inline'}}}), reload(), inspect(), draw('m1'), command('disconnect'), inspect()]});
  const snapshots = trace.steps.filter(step => step.type === 'state').map(step => step.value);
  assert.deepEqual(snapshots[0].cards, {m1: 'First card', m2: 'Second card'});
  assert.deepEqual(snapshots[1].cards, snapshots[0].cards);
  const rendered = trace.steps.filter(step => step.type === 'intercept').map(step => JSON.stringify(step.value));
  assert.match(rendered[0], /First card/); assert.doesNotMatch(rendered[0], /Second card/);
  assert.match(rendered[1], /Second card/); assert.doesNotMatch(rendered[1], /First card/);
  assert.match(rendered[2], /First card/);
  const inline = JSON.stringify(trace.steps.find(step => step.type === 'terminal_mount').value);
  assert.match(inline, /Second card/); assert.doesNotMatch(inline, /First card/);
  assert.equal(snapshots[2].connection, '');
  assert.deepEqual(snapshots[2].cards, {});
  assert.deepEqual(calls(trace, 'http.request').map(call => call.arguments.credential), [profile.id, profile.id]);
});

test('declined enrollment makes no HTTP request', () => {
  const trace = runScenario(directory, clock(0), hostOperations({'credentials.request': [{result: {status: 'declined', profile: null}}]}), {steps: [command('connect'), message('m1'), advance(16)]});
  assert.equal(calls(trace, 'http.request').length, 0);
});

test('pending cancellation and reload drop requests; retry is explicit', () => {
  const trace = runScenario(directory, clock(0), hostOperations({'credentials.request': [credential], 'http.request': [response('Retried')]}), {steps: [
    command('connect'), message('m1'), command('cancel'), advance(16),
    message('m2'), reload(), advance(16), command('retry'), advance(16), inspect(),
  ]});
  assert.equal(calls(trace, 'http.request').length, 1);
  assert.deepEqual(trace.steps.at(-1).value.cards, {m2: 'Retried'});
});

test('expired credential is a failed job without a card', () => {
  const trace = runScenario(directory, clock(0), hostOperations({'credentials.request': [credential], 'http.request': [{error: 'credential_expired'}]}), {steps: [command('connect'), message('m1'), advance(16), command('status'), inspect()]});
  assert.match(JSON.stringify(trace.steps.at(-2).value), /failed/);
  assert.match(JSON.stringify(trace.steps.at(-2).value), /credential_expired/);
  assert.equal(trace.steps.at(-1).value.cards?.m1, undefined);
});

test('the same background API runs independent repository checks without channel wiring', () => {
  const manifest = {schema: 1, id: 'repository_checks', version: '1.0.0', api: '1.0.0', state_version: 1, state_scope: 'thread', capabilities: ['commands', 'events', 'store', 'exec'], compatibility: {required_features: ['session_activation_v1', 'background_jobs_v1']}};
  const source = `import type { ModAPI } from '@oh-my-diff/mod-api';
    export default function activate(api: ModAPI) {
      const check = api.background<null, string>('git', () => {
        const result = api.host.call('exec.run', {program: 'git', argv: ['status', '--short'], timeout_ms: 1000, max_output_bytes: 4096});
        if (result.exit_code !== 0) throw new Error('Git check failed');
        return result.stdout;
      });
      api.command('refresh', () => { check.start(null); return null; });
      api.command('status', () => ({display: JSON.stringify(check.get())}));
    }`;
  writeFileSync(join(directory, 'mod.json'), JSON.stringify(manifest));
  writeFileSync(join(directory, 'index.ts'), source);
  const result = {exit_code: 0, signal: null, stdout: ' M README.md\n', stdout_sha256: '0'.repeat(64), stdout_bytes: 13, output_artifact: null, stderr: '', stdout_truncated: false, stdout_preview_truncated: false, stderr_truncated: false, stderr_preview_truncated: false, timed_out: false, duration_ms: 1, program: {path: '/usr/bin/git', sha256: '0'.repeat(64)}, guards_verified: 0};
  const trace = runScenario(directory, clock(0), hostOperations({'exec.run': [{result}]}), {steps: [
    invoke('repository_checks', 'command', 'refresh', null, {threadId}), advance(16),
    invoke('repository_checks', 'command', 'status', null, {threadId}),
  ]});
  assert.match(JSON.stringify(trace.steps.at(-1).value), /completed/);
  assert.match(JSON.stringify(trace.steps.at(-1).value), /README.md/);
  assert.equal(calls(trace, 'exec.run').length, 1);
  assert.equal(calls(trace, 'events.publish').length, 0);
});
