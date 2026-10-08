import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { callback } from './mod_runner.mjs';

const source = readFileSync(new URL('../mods/first-party/omd_minefield/index.ts', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../mods/first-party/omd_minefield/mod.json', import.meta.url)));
const surface = { events: { terminal: 'terminal', component_event: 'terminal', view: 'terminal', focus: 'terminal', timer: 'events', channel: 'events', start: 'lifecycle', resume: 'lifecycle', stop: 'lifecycle' }, state: 'store', replacements: [], middleware: [] };
const clone = value => structuredClone(value);
function run(event, payload, state = null, name = '', host = call => call.arguments, now = 1000) {
  const calls = [];
  const result = callback({ source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, surface, state, settings: {}, event, name, payload, package: { id: manifest.id }, hook_budget_ms: 1000, virtual_time_ms: now }, call => { calls.push(call); return host(call); }, []);
  assert.equal(result.error, undefined, result.error);
  return { ...result, calls };
}
function session(state = null) {
  let sequence = state?.last ?? 0;
  let now = 1000;
  let generation = 1;
  const calls = [];
  const host = call => {
    assert.ok(['events.schedule', 'events.cancel', 'events.publish', 'packages.list'].includes(call.operation), call.operation);
    if (call.operation === 'events.publish') {
      assert.match(call.arguments.channel, /^[a-z0-9_.-]{1,64}$/);
      assert.ok(manifest.subscriptions.channels.includes(`${manifest.id}/${call.arguments.channel}`));
    }
    calls.push(call);
    return call.operation === 'events.publish' ? { delivered: 1, dropped: 0 } : call.operation === 'events.cancel' ? { cancelled: true } : call.operation === 'packages.list' ? { generation, packages: [], reload_error: null } : call.arguments;
  };
  const step = (event, payload, name = '') => {
    const reply = run(event, payload, state, name, host, now);
    state = reply.state;
    for (const call of reply.calls.filter(call => call.operation === 'events.publish')) play(call.arguments.data);
    return reply;
  };
  const play = (data, seq = ++sequence) => {
    const reply = run('channel', { publisher: manifest.id, channel: 'omd_minefield/play', data, sequence: seq }, state, '', host, now);
    state = reply.state;
    return reply;
  };
  return { get state() { return state; }, calls, step, play, reload: () => { generation++; }, advance: ms => { now += ms; }, command: args => step('command', args, 'minefield'), key: (...keys) => step('component_event', { component: 'minefield_board', kind: 'input', events: keys.map(key => ({ key, text: key.length === 1 ? key : null })) }), tick: () => { now += 1000; return step('timer', { key: state.clock }); } };
}
const adjacent = cell => Array.from({ length: 81 }, (_, other) => other).filter(other => other !== cell && Math.abs(other % 9 - cell % 9) <= 1 && Math.abs(Math.floor(other / 9) - Math.floor(cell / 9)) <= 1);
const currentToken = state => `${state.board.id}_${state.revision}`;

test('opening commits the board even when the startup publication has no recipient', () => {
  const first = run('command', 'new 42', null, 'minefield', call => {
    assert.equal(call.operation, 'events.publish');
    assert.deepEqual(call.arguments, { channel: 'play', data: { action: 'ready' } });
    return { delivered: 0, dropped: 0 };
  });
  assert.equal(first.state.open, true);
  assert.equal(first.state.board.seed, 42);
  assert.equal(first.state.clock, null);
  assert.equal(first.state.last, null);
  const view = run('terminal', { event: 'idle', client: { columns: 110, rows: 55 } }, first.state).value;
  assert.equal(view.keybindings.F6.focus, 'minefield_board');
  assert.equal(view.sites.dialog.components[0].children[1].children[0].lines.length, 27);
  const reopened = run('command', '', { ...first.state, open: false }, 'minefield', () => ({ delivered: 0, dropped: 0 }));
  assert.equal(reopened.state.open, true);
  assert.deepEqual(reopened.state.board, first.state.board);
});

test('seeded generation is deterministic at every opening and excludes its neighbours', () => {
  for (let cell = 0; cell < 81; cell++) {
    const a = session(), b = session();
    a.command('new 4294967295'); b.command('new 4294967295');
    a.play({ action: 'reveal', cell }); b.play({ action: 'reveal', cell });
    assert.deepEqual(a.state.board, b.state.board);
    const board = a.state.board;
    assert.equal(new Set(board.mines).size, 10);
    assert.ok([cell, ...adjacent(cell)].every(cell => !board.mines.includes(cell)));
    assert.ok(board.revealed.length > 1);
    assert.equal(board.first, cell);
  }
});

test('flood skips flags, repeated flag/reveal is idempotent, limits flags and settles a win once', () => {
  const game = session(); game.command('new 11');
  for (let cell = 0; cell < 12; cell++) game.play({ action: 'flag', cell });
  assert.equal(game.state.board.flags.length, 10);
  game.play({ action: 'flag', cell: 0 });
  game.play({ action: 'reveal', cell: 0 });
  assert.equal(game.state.board.first, null);
  for (let cell = 0; cell < 10; cell++) game.play({ action: 'unflag', cell });
  game.play({ action: 'flag', cell: 1 }); game.play({ action: 'reveal', cell: 0 });
  assert.ok(!game.state.board.revealed.includes(1));
  game.play({ action: 'unflag', cell: 1 });
  game.tick(); game.tick();
  for (let cell = 0; cell < 81; cell++) if (!game.state.board.mines.includes(cell)) game.play({ action: 'reveal', cell });
  assert.equal(game.state.board.result, 'won');
  assert.equal(game.state.board.revealed.length, 71);
  assert.equal(game.state.wins, 1);
  assert.equal(game.state.best, 2000);
  assert.equal(game.state.clock, null);
  game.play({ action: 'reveal', cell: 80 });
  assert.equal(game.state.wins, 1);
});

test('chord requires exact flags, reveals safe neighbours and wrong flags lose without a record', () => {
  const original = session(); original.command('new 19'); original.play({ action: 'reveal', cell: 40 });
  const base = original.state;
  const cell = base.board.revealed.find(cell => adjacent(cell).some(other => base.board.mines.includes(other)) && adjacent(cell).some(other => !base.board.mines.includes(other) && !base.board.revealed.includes(other)));
  assert.notEqual(cell, undefined);
  const game = session(clone(base));
  game.play({ action: 'chord', cell });
  assert.deepEqual(game.state.board.revealed, base.board.revealed);
  for (const other of adjacent(cell).filter(other => base.board.mines.includes(other))) game.play({ action: 'flag', cell: other });
  game.play({ action: 'chord', cell });
  assert.notEqual(game.state.board.result, 'lost');
  assert.ok(game.state.board.revealed.length > base.board.revealed.length);
  const wrong = session(clone(base));
  const mines = adjacent(cell).filter(other => base.board.mines.includes(other));
  const safe = adjacent(cell).find(other => !base.board.mines.includes(other) && !base.board.revealed.includes(other));
  for (const other of [safe, ...mines.slice(1)]) wrong.play({ action: 'flag', cell: other });
  wrong.play({ action: 'chord', cell });
  assert.equal(wrong.state.board.result, 'lost');
  assert.equal(wrong.state.best, null);
  assert.equal(wrong.state.wins, 0);
  assert.equal(wrong.state.clock, null);
});

test('stale board tokens, concurrent CAS replay, duplicate channel and timer input preserve saves', () => {
  const game = session(); game.command('new 0');
  const snapshot = clone(game.state), intent = { action: 'flag', cell: 0, token: currentToken(snapshot) };
  const event = { publisher: manifest.id, channel: 'omd_minefield/play', data: intent, sequence: 2 };
  const a = run('channel', event, snapshot), b = run('channel', { ...event, sequence: 3, data: { ...intent, cell: 1 } }, snapshot);
  assert.deepEqual(a.state.board.flags, [0]); assert.deepEqual(b.state.board.flags, [1]);
  const replay = run('channel', { ...event, sequence: 3, data: { ...intent, cell: 1 } }, a.state);
  assert.deepEqual(replay.state, a.state);
  assert.deepEqual(run('channel', event, a.state).state, a.state);
  game.play({ action: 'reveal', cell: 40 });
  const timer = game.state.clock; game.tick();
  assert.equal(game.state.board.elapsed_ms, 1000);
  game.step('timer', { key: timer });
  assert.equal(game.state.board.elapsed_ms, 1000);
  game.command('new 42'); game.play(intent);
  assert.deepEqual(game.state.board.flags, []);
});

test('keyboard batches keep cursor order, pointer maps window cells once and Escape releases game focus', () => {
  const game = session(); game.command('new 10');
  game.key('Right', 'Right', 'Down', 'f', 'f');
  assert.equal(game.state.cursor, 51);
  assert.deepEqual(game.state.board.flags, [51]);
  game.key('u', 'Enter');
  assert.equal(game.state.board.first, 51);
  const view = game.step('terminal', { event: 'idle', client: { columns: 20, rows: 24 } }).value;
  const box = view.sites.header.components[0];
  assert.equal(box.children[0].id, 'minefield_board');
  assert.equal(box.children[0].lines.length, 4);
  const parts = box.id.split('_'), firstRow = Number(parts[4]), firstCol = Number(parts[5]);
  const event = { component: box.id, kind: 'pointer', pointer: { action: 'down', button: 'right', column: 5, row: 0 } };
  game.step('component_event', event);
  game.step('component_event', event);
  const cell = firstRow * 9 + firstCol;
  assert.ok(game.state.board.revealed.includes(cell) || game.state.board.flags.includes(cell));
  const prior = clone(game.state);
  for (const pointer of [{ ...event.pointer, column: -1 }, { ...event.pointer, row: 99 }, { ...event.pointer, action: 'up' }]) game.step('component_event', { ...event, component: box.id, pointer });
  assert.deepEqual(game.state, prior);
  game.key('Esc');
  assert.equal(game.state.open, false);
  assert.equal(game.state.clock, null);
  assert.equal(game.step('terminal', {}).value, null);
});

test('pause, blur, native panes, restart and close stop timers and resume without offline time', () => {
  const game = session(); game.command('new 5'); game.key('Enter'); game.tick();
  const saved = clone(game.state);
  for (const [event, payload] of [['start', null], ['resume', null], ['stop', null], ['focus', { focused: false }], ['view', { phase: 'opened', view: 'bottom_pane' }], ['component_event', { component: 'minefield_board', kind: 'blur' }]]) {
    const restored = session(clone(saved)); restored.step(event, payload);
    assert.equal(restored.state.clock, null);
    assert.equal(restored.state.paused, true);
    assert.equal(restored.state.board.elapsed_ms, 1000);
    restored.step('timer', { key: saved.clock });
    assert.equal(restored.state.board.elapsed_ms, 1000);
    restored.command('resume'); restored.tick();
    assert.equal(restored.state.board.elapsed_ms, 2000);
  }
  game.command('pause'); assert.equal(game.state.clock, null);
  game.command('close'); assert.equal(game.state.clock, null);
  game.command('open'); assert.equal(game.state.paused, true);
  assert.deepEqual(game.state.board, saved.board);
});

test('inactive callbacks have zero host calls and views stay bounded and readable on resized inline clients', () => {
  for (const event of ['terminal', 'start', 'resume', 'stop', 'timer', 'focus', 'view', 'component_event']) {
    const reply = run(event, event === 'timer' ? { key: 'old' } : {});
    assert.equal(reply.calls.length, 0);
    assert.equal(reply.state, null);
  }
  const game = session(); game.command('');
  for (const [columns, rows] of [[100, 40], [80, 30], [80, 24], [48, 20], [48, 16], [20, 16], [8, 16], [40, 12], [7, 10], [1, 1]]) {
    const view = game.step('terminal', { event: 'idle', presentation: { surface: 'inline' }, client: { columns, rows } }).value;
    const popup = columns >= 48 && rows >= 20;
    const text = popup ? view.sites.dialog.components[0].children[0].text : view.sites.above_composer.components[0].text;
    assert.ok(Buffer.byteLength(text) <= 4096);
    assert.ok(text.split('\n').every(line => line.length <= columns));
    assert.match(text.replaceAll('\n', ''), /R5 C5: covered/);
    assert.equal(Boolean(view.sites.header), !popup && rows >= 16 && columns >= 8);
    assert.equal(view.layout, undefined);
    assert.equal(Boolean(view.sites.dialog), popup);
    const board = popup ? view.sites.dialog.components[0].children[1].children[0] : view.sites.header?.components[0].children[0];
    if (board) {
      assert.ok(board.lines.every(line => line.length <= 12));
      assert.ok(board.lines.some(line => line.some(span => span.bg)));
      assert.ok(board.lines.every(line => line.map(span => span.text).join('').length <= columns));
      if (popup) assert.equal(board.lines.length, rows >= 40 ? 27 : rows >= 30 ? 18 : 9);
    }
  }
  assert.equal(manifest.capabilities.some(cap => ['model', 'http', 'exec', 'autonomous', 'fs.write'].includes(cap)), false);
  for (const args of ['new -1', 'new 4294967296', 'new potato', 'reveal 0 1', 'flag 1 10', 'close extra']) assert.equal(run('command', args, game.state, 'minefield').calls.length, 0);
});

test('graphical tiles cover the whole board, map pointer tile geometry, and dismiss without losing the save', () => {
  const game = session(); game.command('new 42');
  let view = game.step('terminal', { client: { columns: 110, rows: 55, graphics: 'cells' } }).value;
  const box = view.sites.dialog.components[0].children[1];
  const doc = box.children[0];
  assert.equal(doc.lines.length, 27);
  assert.ok(doc.lines[0].some(span => span.text === '▛▀▀▀▀▜' && span.bg));
  assert.ok(!doc.lines.flat().some(span => span.text.includes('#')));
  game.step('component_event', { component: box.id, kind: 'pointer', pointer: { action: 'down', button: 'right', column: 5 + 8 * 6, row: 8 * 3 + 1 } });
  assert.deepEqual(game.state.board.flags, [80]);
  view = game.step('terminal', { client: { columns: 110, rows: 55, graphics: 'cells' } }).value;
  assert.ok(view.sites.dialog.components[0].children[1].children[0].lines.flat().some(span => span.text.includes('⚑')));
  const saved = clone(game.state.board);
  const text = game.step('terminal', { client: { columns: 110, rows: 55, graphics: 'text' } }).value;
  assert.ok(text.sites.dialog.components[0].children[1].children[0].lines.flat().some(span => span.text.includes('F')));
  game.step('component_event', { component: 'minefield_dialog', kind: 'close' });
  assert.equal(game.state.open, false);
  assert.deepEqual(game.state.board, saved);
});

test('wall-time checkpoints include delayed ticks, pause excludes time, and rollback cannot count twice', () => {
  const game = session(); game.command('new 7'); game.key('Enter');
  game.advance(3500); game.tick();
  assert.equal(game.state.board.elapsed_ms, 4500);
  game.advance(250); game.command('pause');
  assert.equal(game.state.board.elapsed_ms, 4750);
  const before = clone(game.state.board);
  game.key('Enter', 'f', 'c');
  assert.deepEqual(game.state.board, before);
  game.advance(20000); game.command('resume'); game.tick();
  assert.equal(game.state.board.elapsed_ms, 5750);
  game.advance(-500); game.step('timer', { key: game.state.clock });
  assert.equal(game.state.board.elapsed_ms, 5750);
  game.advance(1000); game.step('timer', { key: game.state.clock });
  assert.equal(game.state.board.elapsed_ms, 6250);
});

test('same-source package reload pauses without charging its hidden interval', () => {
  const game = session(); game.command('new 7'); game.key('Enter'); game.tick();
  const result = run('timer', { key: game.state.clock }, game.state, '', call => {
    assert.equal(call.operation, 'packages.list');
    return { generation: 2, packages: [], reload_error: null };
  }, 100000);
  assert.equal(result.state.board.elapsed_ms, 1000);
  assert.equal(result.state.paused, true);
  assert.equal(result.state.clock, null);
  assert.equal(result.state.at, null);
  assert.equal(result.calls.length, 1);
  game.reload(); game.advance(100000); game.command('resume'); game.tick();
  assert.equal(game.state.board.elapsed_ms, 2000);
  assert.equal(game.state.paused, false);
  assert.notEqual(game.state.clock, null);
});
