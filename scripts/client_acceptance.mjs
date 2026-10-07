import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import { createInterface } from 'node:readline';
import { connect, encodeFrame, unsupported } from '../mods/author/client.mjs';

const [mode, url, repo] = process.argv.slice(2);
const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
const timings = {};
const watched = [];
const say = value => console.log(JSON.stringify(value));
const ask = async need => {
  say({ need });
  const { value } = await lines.next();
  return JSON.parse(value);
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const time = async (name, run) => {
  const start = performance.now();
  const result = await run();
  (timings[name] ??= []).push(performance.now() - start);
  return result;
};

async function until(label, check, ms = 20000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) {
      const seen = watched.map(state => ({ name: state.name, roster: state.roster.map(entry => entry.name), revision: state.view()?.revision,
        components: components(state.view()).map(({ component: item }) => item.id), requests: state.requests.length, methods: [...new Set(state.notifications.map(item => item.method))], diagnostics: state.view()?.snapshot?.diagnostics }));
      throw new Error(`timed out waiting for ${label}: ${JSON.stringify(seen)}`);
    }
    await sleep(25);
  }
}

const rejects = async (promise, code) => {
  const error = await promise.then(() => null, caught => caught);
  assert.ok(error, `expected ${code}`);
  assert.ok(error.message.startsWith(code), `expected ${code}, got ${error.message}`);
  return error;
};

function components(view) {
  const found = [];
  const walk = (list, site) => {
    for (const component of list ?? []) {
      found.push({ site, component });
      walk(component.children, site);
    }
  };
  for (const [site, { components: list }] of Object.entries(view?.snapshot?.view.sites ?? {})) walk(list, site);
  return found;
}
const component = (view, id) => components(view).find(({ component: item }) => item.id === id)?.component;

function client(name, renderer, answer) {
  const state = { name, views: [], roster: [], mirrored: [], notifications: [], requests: [], reconnects: [] };
  watched.push(state);
  state.ready = connect({
    url, name, renderer,
    onView: view => state.views.push(view),
    onRoster: roster => (state.roster = roster),
    onMirrored: call => state.mirrored.push(call),
    onNotification: (method, params) => state.notifications.push({ method, params, at: performance.now() }),
    onServerRequest: (method, params) => {
      state.requests.push({ method, params, at: performance.now() });
      return answer(method, params, state);
    },
    onReconnect: change => state.reconnects.push(change),
  }).then(session => {
    if (!state.roster.length) state.roster = session.attachment.roster;
    return (state.session = session);
  });
  state.view = () => state.views.at(-1);
  state.seen = (method, test = () => true) => state.notifications.find(item => item.method === method && test(item.params));
  return state;
}

const TEXT = { kind: 'text', formats: ['text'], pointer: 'none', reducedMotion: true };
const GUI = { kind: 'gui', formats: ['svg', 'png', 'cells'], pointer: 'pixel', reducedMotion: false };
const TEXT_DRAWN = ['line', 'text', 'list', 'button', 'markdown', 'code'];
const GUI_DRAWN = [...TEXT_DRAWN, 'input', 'select', 'multiselect', 'image', 'raster'];

async function turn(owner, threadId, text, during) {
  const started = owner.notifications.length;
  const { turn: begun } = await owner.session.request('turn/start', { threadId, input: [{ type: 'text', text }] });
  if (during) await during(begun);
  return until(`turn ${text} completed`, () => owner.notifications.slice(started)
    .find(item => item.method === 'turn/completed' && item.params.turn.id === begun.id)?.params.turn, 60000);
}

async function rawClient() {
  const key = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64');
  const socket = netConnect(url.slice('unix://'.length));
  await new Promise((resolve, reject) => socket.once('connect', resolve).once('error', reject));
  socket.write(`GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  await new Promise(resolve => socket.once('data', resolve));
  return socket;
}

async function headless() {
  const desk = client('approval desk gui', GUI, (method, params, self) => self.answer?.(method, params));
  const text = client('text console', TEXT, (method, params, self) => self.answer?.(method, params));
  await time('attach_ms', () => desk.ready);
  await time('attach_ms', () => text.ready);
  assert.equal(desk.session.attachment.protocol, 'omd-client/1');
  assert.ok(desk.session.attachment.features.includes('surface_call'), 'headless hosts delegate surface calls');
  await until('roster of two', () => desk.roster.length === 2 && text.roster.length === 2);
  assert.deepEqual(desk.roster.map(entry => entry.renderer.kind).sort(), ['gui', 'text']);
  say({ step: 'attach', clients: desk.roster.map(entry => entry.name) });

  const { thread } = await desk.session.request('thread/start', { cwd: repo, approvalPolicy: 'on-request', sandbox: 'workspace-write' });
  const joined = await text.session.request('thread/resume', { threadId: thread.id });
  assert.equal(joined.thread.id, thread.id, 'a second client joins the thread before its first turn');
  await until('both mods drew', () => component(desk.view(), 'desk_log') && component(desk.view(), 'external_clients')?.rows.length === 2);
  const owners = desk.view().snapshot.component_owners;
  assert.equal(owners.desk_log, 'approval_desk');
  assert.equal(owners.external_clients, 'external_client');
  say({ step: 'view', epoch: desk.view().epoch, revision: desk.view().revision, bytes: JSON.stringify(desk.view()).length });

  const badge = await until('badge', () => component(desk.view(), 'external_badge'));
  await until('text client view complete', () => ['desk_kinds', 'desk_note', 'external_badge', 'external_meter'].every(id => component(text.view(), id)));
  const textMissing = components(text.view()).map(({ component: item }) => unsupported(item, TEXT, TEXT_DRAWN)).filter(Boolean);
  const guiMissing = components(desk.view()).map(({ component: item }) => unsupported(item, GUI, GUI_DRAWN)).filter(Boolean);
  assert.deepEqual(textMissing.map(error => error.component).sort(), ['desk_kinds', 'desk_note', 'external_badge', 'external_meter']);
  assert.match(textMissing.find(error => error.component === 'external_meter').message, /^unsupported_element: raster 'external_meter': this renderer does not draw it; drawing its fallback "Eight-step color meter"$/);
  assert.deepEqual(guiMissing, []);
  assert.equal(unsupported(badge, TEXT, [...TEXT_DRAWN, 'image']).fallback, 'Badge reading "external"');
  say({ step: 'unsupported', text: textMissing.map(error => error.message) });

  const svg = await time('resource_ms', () => desk.session.resource(badge.image.reference));
  assert.equal(svg.mediaType, 'image/svg+xml');
  assert.equal(createHash('sha256').update(Buffer.from(svg.data, 'base64')).digest('hex'), svg.sha256);
  await rejects(desk.session.resource('evidence/not-in-view.svg'), 'resource_not_in_view');
  await until('blit mirrored to the cells client', () => desk.mirrored.find(call => call.operation === 'terminal.blit'));
  assert.equal(text.mirrored.filter(call => call.operation === 'terminal.blit').length, 0, 'blits go only to clients listing cells');
  say({ step: 'payloads', svgBytes: Buffer.from(svg.data, 'base64').length });

  const rows = component(text.view(), 'external_clients').rows;
  const self = rows.findIndex(row => row.value === text.session.attachment.clientId);
  const picked = await time('action_ms', () => text.session.action({ component: 'external_clients', row: self }));
  assert.equal(picked.outcome.display, `Picked ${text.session.attachment.clientId}`);
  const spent = text.session.actionToken;
  await text.session.request('omd/action', { actionToken: spent, component: 'external_clients', row: self }).catch(() => {});
  await rejects(text.session.request('omd/action', { actionToken: spent, component: 'external_clients', row: self }), 'action_replayed');
  await desk.session.read();
  await rejects(desk.session.request('omd/action', { actionToken: text.session.actionToken ?? 'foreign', component: 'external_clients', row: 0 }), 'action_unknown');
  const held = (await desk.session.read()).actionToken;
  await text.session.action({ component: 'desk_note', value: 'stale maker' });
  await until('desk note revision', () => component(desk.view(), 'desk_note')?.value === 'stale maker');
  await rejects(desk.session.request('omd/action', { actionToken: held, component: 'desk_log', row: 0 }), 'action_stale');
  say({ step: 'actions', stale: true, replayed: true, foreign: true });

  const noted = await time('action_ms', () => desk.session.action({ component: 'desk_note', value: 'reviewed by desk' }));
  assert.equal(noted.outcome.display, 'Note saved');
  await until('controlled input echoed', () => component(text.view(), 'desk_note')?.value === 'reviewed by desk');
  await desk.session.read();
  assert.deepEqual(await desk.session.event('desk_kinds', { kind: 'change', values: ['exec'] }), { delivered: true });
  await until('multiselect change applied', () => JSON.stringify(component(desk.view(), 'desk_kinds')?.value) === '["exec"]');
  await rejects(desk.session.request('omd/client/event', { epoch: 'other', component: 'desk_kinds', event: { kind: 'change', values: [] } }), 'view_stale');
  await rejects(desk.session.event('no_such_component', { kind: 'change', value: 'x' }), 'view_stale');
  await rejects(desk.session.event('desk_kinds', { kind: 'teleport' }), 'component_event_invalid');
  say({ step: 'inputs', note: 'reviewed by desk', kinds: ['exec'] });

  const hello = await time('turn_ms', () => turn(desk, thread.id, 'hello'));
  assert.equal(hello.status, 'completed');
  for (const watcher of [desk, text]) {
    const message = watcher.seen('item/completed', params => params.item.type === 'agentMessage' && params.turnId === hello.id);
    assert.equal(message?.params.item.text, 'FIXTURE_DONE', `${watcher.name} streamed the reply`);
    assert.ok(watcher.seen('turn/started', params => params.turn.id === hello.id));
  }
  say({ step: 'streaming', turn: hello.id });

  desk.answer = () => ({ decision: 'accept' });
  text.answer = async () => {
    await until('desk answered first', () => text.seen('serverRequest/resolved'));
    return { decision: 'decline' };
  };
  const approved = await turn(desk, thread.id, 'APPROVE_ME');
  assert.equal(approved.status, 'completed');
  assert.equal(desk.requests.length, 1);
  assert.equal(text.requests.length, 1, 'both subscribed clients got the approval');
  assert.equal(desk.requests[0].params.itemId, text.requests[0].params.itemId);
  const command = desk.seen('item/completed', params => params.item.type === 'commandExecution' && params.turnId === approved.id);
  assert.equal(command?.params.item.status, 'completed', 'the first answer (accept) decided');
  assert.ok(existsSync(`${repo}/approved.txt`));
  assert.ok(desk.seen('serverRequest/resolved'), 'the winner also sees the resolution');
  const streamed = desk.notifications.filter(item => item.method === 'item/commandExecution/outputDelta' && item.params.turnId === approved.id).map(item => item.params.delta).join('');
  assert.match(`${streamed}${command.params.item.aggregatedOutput ?? ''}`, /APPROVED_OUTPUT/, 'tool output reached the client');
  await until('desk shows the decision', () => component(text.view(), 'desk_log')?.rows.some(row => row.spans[0].text === 'approved'));
  say({ step: 'approval', decided: 'accept', lateAnswerIgnored: true });

  desk.answer = text.answer = () => ({ decision: 'cancel' });
  const cancelled = await turn(desk, thread.id, 'APPROVE_ME again');
  assert.equal(cancelled.status, 'interrupted', 'a cancel decision interrupts the turn');
  const interrupted = await turn(desk, thread.id, 'STALL_TURN', async begun => {
    await sleep(500);
    await desk.session.request('turn/interrupt', { threadId: thread.id, turnId: begun.id });
  });
  assert.equal(interrupted.status, 'interrupted');
  say({ step: 'cancellation', approvalCancel: cancelled.status, interrupt: interrupted.status });

  const history = await desk.session.request('thread/rewrite', { threadId: thread.id, edits: [], undo: false });
  const prompt = history.rows.find(row => row.kind === 'message.user' && row.access === 'edit');
  assert.ok(prompt, `an editable prompt row: ${JSON.stringify(history.rows.map(row => [row.kind, row.access]))}`);
  const redact = { op: 'replace', id: prompt.id, items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '[redacted]' }] }] };
  await rejects(desk.session.request('thread/rewrite', { threadId: thread.id, expectedRevision: 'stale:1', edits: [redact] }), 'history_revision_conflict');
  const rewritten = await desk.session.request('thread/rewrite', { threadId: thread.id, expectedRevision: history.revision, edits: [redact] });
  for (const watcher of [desk, text]) {
    await until(`${watcher.name} saw thread/rewritten`, () => watcher.seen('thread/rewritten', params => params.revision === rewritten.revision));
  }
  const compactedAt = desk.notifications.length;
  await desk.session.request('thread/compact/start', { threadId: thread.id });
  for (const watcher of [desk, text]) {
    await until(`${watcher.name} saw the compaction item`, () => watcher.seen('item/completed', params => params.item.type === 'contextCompaction'), 60000);
  }
  await until('compaction turn done', () => desk.notifications.slice(compactedAt).find(item => item.method === 'turn/completed'), 60000);
  say({ step: 'history', compacted: true, revision: rewritten.revision });

  desk.answer = text.answer = () => new Promise(() => {});
  const pending = desk.session.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'APPROVE_ME held' }] });
  await until('held approval', () => desk.requests.length === 3 && text.requests.length === 3);
  const { turn: heldTurn } = await pending;
  const reconnected = client('approval desk gui (reconnected)', GUI, () => ({ decision: 'accept' }));
  desk.session.close();
  await reconnected.ready;
  await reconnected.session.request('thread/resume', { threadId: thread.id });
  await until('replayed approval', () => reconnected.requests.length === 1);
  assert.equal(reconnected.requests[0].params.itemId, text.requests[2].params.itemId);
  const finished = await until('held turn finished', () => text.seen('turn/completed', params => params.turn.id === heldTurn.id), 60000);
  assert.equal(finished.params.turn.status, 'completed');
  await until('roster dropped the closed client', () => text.roster.length === 2 && !text.roster.some(entry => entry.name === 'approval desk gui'));
  say({ step: 'reconnect', replayedApprovals: reconnected.requests.length });

  const broken = await rawClient();
  broken.write(encodeFrame(1, Buffer.from('{not json'), true));
  broken.write(encodeFrame(1, Buffer.from(JSON.stringify({ id: 1, method: 'omd/client/event', params: {} })), true));
  broken.destroy();
  await reconnected.session.read();
  say({ step: 'broken_renderer', hostAlive: true });

  const recovery = await reconnected.session.recovery();
  const fixture = recovery.mods.find(entry => entry.id === 'broken_fixture');
  assert.ok(fixture?.failing, `the broken mod is failing: ${JSON.stringify(fixture)}`);
  assert.ok(component(reconnected.view(), 'desk_log') && component(reconnected.view(), 'external_clients'), 'other mods keep drawing');
  const heldToken = (await reconnected.session.read()).actionToken;
  await rejects(reconnected.session.recovery({ action: 'disable', target: 'approval_desk' }), 'client_surface_operation_unavailable');
  await ask('disable_desk');
  await reconnected.session.recovery({ action: 'reload', target: 'approval_desk' });
  await until('disabled mod left the view', () => !component(reconnected.view(), 'desk_log'), 15000);
  await rejects(reconnected.session.request('omd/action', { actionToken: heldToken, component: 'desk_log', row: 0 }), 'action_stale');
  await ask('enable_desk');
  await reconnected.session.recovery({ action: 'reload', target: 'approval_desk' });
  await until('re-enabled mod drew', () => component(reconnected.view(), 'desk_log'), 15000);
  await ask('change_source');
  await reconnected.session.recovery({ action: 'reload', target: 'approval_desk' });
  const untrusted = await reconnected.session.recovery();
  assert.match(untrusted.mods.find(entry => entry.id === 'approval_desk').error, /^source_changed: /);
  assert.match(untrusted.reload_error, /^untrusted_source: approval_desk changed after it was trusted/);
  assert.notEqual(component(reconnected.view(), 'desk_log')?.label, 'Approvals v2', 'an untrusted source change never runs');
  await ask('trust_source');
  await reconnected.session.recovery({ action: 'reload', target: 'approval_desk' });
  await until('trusted source reloaded', () => component(reconnected.view(), 'desk_log')?.label === 'Approvals v2', 15000);
  say({ step: 'recovery', broken: fixture.error, disabled: true, reloaded: true });

  const before = reconnected.view().epoch;
  await ask('restart_host');
  await until('reconnected after restart', () => reconnected.reconnects.length && text.reconnects.length, 30000);
  assert.notEqual(reconnected.reconnects[0].epoch, before, 'a restarted host has a new epoch');
  assert.equal(reconnected.reconnects[0].previousEpoch, before);
  await until('fresh view after restart', () => reconnected.view().epoch !== before && component(reconnected.view(), 'desk_log'), 30000);
  say({ step: 'host_restart', epoch: reconnected.reconnects[0].epoch });

  for (let index = 0; index < 20; index++) await time('read_ms', () => reconnected.session.read());
  for (let index = 0; index < 10; index++) {
    const start = performance.now();
    const seen = reconnected.views.length;
    await reconnected.session.action({ component: 'desk_note', value: `round ${index}` });
    await until('pushed view', () => reconnected.views.length > seen);
    (timings.action_to_view_ms ??= []).push(performance.now() - start);
  }
  reconnected.session.close();
  text.session.close();
}

async function bare() {
  const solo = client('bare', TEXT, () => ({ decision: 'decline' }));
  await solo.ready;
  assert.equal(solo.session.attachment.protocol, 'omd-client/1');
  const view = await solo.session.read();
  assert.equal(view.snapshot, null);
  const { thread } = await solo.session.request('thread/start', { cwd: repo });
  const done = await turn(solo, thread.id, 'hello');
  assert.equal(done.status, 'completed');
  const recovery = await solo.session.recovery();
  assert.deepEqual(recovery.mods, []);
  for (let index = 0; index < 20; index++) await time('read_ms', () => solo.session.read());
  solo.session.close();
}

async function coattach() {
  const desk = client('approval desk gui', GUI, (method, params, self) => self.answer?.(method, params));
  await time('attach_ms', () => desk.ready);
  let data = [];
  await until('the TUI thread is loaded', async () => {
    data = (await desk.session.request('thread/loaded/list', {}).catch(() => ({ data: [] }))).data;
    return data.length === 1;
  });
  await desk.session.request('thread/resume', { threadId: data[0] });
  await until('co-attached view', () => component(desk.view(), 'desk_log') && component(desk.view(), 'external_clients')?.rows.some(row => row.label === 'approval desk gui'));
  assert.ok(!desk.session.attachment.features.includes('surface_call'), 'a terminal is attached, so nothing is delegated');
  say({ step: 'coattach', thread: data[0] });

  desk.answer = () => ({ decision: 'accept' });
  await ask('tui_prompt_client_answers');
  await until('client answered the TUI approval', () => desk.requests.length === 1 && desk.seen('serverRequest/resolved'), 60000);
  await until('client sees the approved command', () => desk.seen('item/completed', params => params.item.type === 'commandExecution' && params.item.status === 'completed'), 60000);
  say({ step: 'tui_approval_by_client', command: desk.requests[0].params.command });

  desk.answer = () => new Promise(() => {});
  await ask('tui_prompt_terminal_answers');
  const count = (method, test = () => true) => desk.notifications.filter(item => item.method === method && test(item.params)).length;
  await until('terminal answered first', () => desk.requests.length === 2 && count('serverRequest/resolved') === 2
    && count('item/completed', params => params.item.type === 'commandExecution' && params.item.status === 'completed') === 2, 60000);
  say({ step: 'tui_approval_by_terminal' });

  await desk.session.update({ viewport: { width: 1200, height: 800, unit: 'px' }, focus: true });
  await ask('client_visible');
  const observer = client('text console', TEXT, () => ({ decision: 'decline' }));
  await observer.ready;
  await until('observer sees both', () => observer.roster.length === 2);
  desk.session.close();
  await until('roster dropped the vanished client', () => observer.roster.length === 1 && observer.roster[0].name === 'text console');
  await ask('client_gone');
  observer.session.close();
  say({ step: 'client_gone', terminalKeptWorking: true });
}

const run = { headless, bare, coattach }[mode];
try {
  await run();
  const summary = Object.fromEntries(Object.entries(timings).map(([name, values]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return [name, { n: sorted.length, p50: +sorted[Math.floor(sorted.length / 2)].toFixed(1), max: +sorted.at(-1).toFixed(1) }];
  }));
  say({ done: mode, timings: summary });
  process.exit(0);
} catch (error) {
  say({ failed: mode, error: error.stack ?? String(error) });
  process.exit(1);
}
