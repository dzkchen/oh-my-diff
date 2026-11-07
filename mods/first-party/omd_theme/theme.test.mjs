import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { callback } from '../../../tests/mod_runner.mjs';

const dir = new URL('./', import.meta.url);
const read = name => readFileSync(new URL(name, dir), 'utf8');
const manifest = JSON.parse(read('mod.json'));
const source = read('index.ts');
const assets = Object.fromEntries(manifest.assets.map(name => [name, { text: read(name), sha256: '0'.repeat(64) }]));
const NOW = 1_800_000_000_000;
const SCENE_IDS = ['ember', 'drift', 'lagoon', 'jelly', 'fireflies', 'moonlit', 'aurora'];

function call(input, overrides = {}) {
  const calls = [];
  const store = overrides.store ?? { value: null };
  const output = callback({ source, filename: fileURLToPath(new URL('index.ts', dir)), entrypoint: 'index.ts', assets, api: manifest.api,
    capabilities: manifest.capabilities, settings: {}, state: null, virtual_time_ms: NOW, hook_budget_ms: 10_000, ...input }, ({ operation, arguments: args }) => {
    calls.push({ operation, arguments: args });
    if (operation in overrides) return overrides[operation](args);
    if (operation === 'store.get') return store.value === null ? null : { value: store.value, revision: 1, provenance: {} };
    if (operation === 'store.put') { store.value = args.value; return { revision: 2 }; }
    if (operation === 'events.schedule') return { key: args.key, delay_ms: args.delay_ms };
    if (operation === 'events.publish') return { delivered: 1, dropped: 0 };
    if (operation === 'environment.read') return { values: { TERM_PROGRAM: { set: true, value: 'Orca' } } };
    if (operation === 'terminal.panel') return { shown: true };
    if (operation === 'terminal.blit') return { frame: 2, queued: 1, frame_ms: 16 };
    assert.fail(`unexpected host call ${operation}`);
  });
  assert.equal(output.error, undefined, output.error);
  return { ...output, calls, of: name => calls.filter(item => item.operation === name).map(item => item.arguments) };
}
const client = (extra = {}) => ({ kind: 'terminal', graphics: 'kitty', pointer: 'cell', reduced_motion: false, cell_px: null, columns: 120, rows: 44, ...extra });
const draw = (state, { phase = 'fresh', surface = 'fullscreen', ...extra } = {}) =>
  call({ event: 'terminal', state, payload: { event: 'startup', ledger: null, presentation: { thread_id: 't1', phase, surface }, client: client(extra), clients: [] } });
const started = (stored = null) => call({ event: 'start', payload: null }, { store: { value: stored } });
const ready = (prefs, extra) => {
  const start = started(prefs);
  return draw(start.state, extra).state;
};
const decode = packed => Buffer.from(packed, 'base64');
const tick = (state, key, ms, overrides) => call({ event: 'timer', payload: { key }, state, virtual_time_ms: ms }, overrides);

const KEY = `fxe5hx-0-0-0-120-44`;
const BEHIND_KEY = `fxe5hx-1-0-0-120-44`;

test('resizing wakes a still scene and retires its old timer without changing its raster', () => {
  const state = ready({ speed: 'off' });
  const first = tick(state, `f.${NOW}.-1.0.0.0.0`, NOW + 16);
  const old = first.of('events.schedule')[0].key;
  const resized = call({ event: 'terminal', state: first.state, virtual_time_ms: NOW + 32,
    payload: { event: 'idle', presentation: { phase: 'fresh', surface: 'fullscreen' }, client: client({ columns: 140 }), clients: [] } });
  assert.equal(resized.state.view.raster, state.view.raster);
  assert.deepEqual(resized.of('events.publish'), [{ channel: 'wake', data: NOW + 32 }]);
  assert.deepEqual(tick(resized.state, old, NOW + 40).calls, []);
  const wake = call({ event: 'channel', state: resized.state, payload: { channel: 'omd_theme/wake', data: NOW + 32 } });
  const frame = tick(wake.state, wake.of('events.schedule')[0].key, NOW + 48);
  assert.deepEqual(frame.of('terminal.blit')[0].rect, { x: 0, y: 0, width: 140, height: 44 });
  assert.deepEqual(draw(resized.state, { columns: 140 }).of('events.publish'), []);
});

test('rapid resizing preserves animation time and the frozen frame during a turn', () => {
  const state = ready();
  const first = tick(state, `f.${NOW}.-1.0.0.0.0`, NOW + 266);
  const busy = call({ event: 'turn_start', state: first.state, payload: null }).state;
  const frozen = tick(busy, `f.${NOW}.2.0.0.0.0`, NOW + 300).state;
  let resized = frozen;
  for (const columns of [140, 80, 160]) resized = draw(resized, { columns }).state;
  assert.equal(resized.run, NOW + 3);
  assert.equal(resized.origin, NOW);
  const frame = tick(resized, `f.${resized.run}.-1.0.0.0.0`, NOW + 10_000);
  assert.equal(frame.of('events.schedule')[0].key.split('.')[2], '2');
  const chosen = call({ event: 'command', name: 'scenes', payload: 'lagoon', state: resized });
  assert.equal(chosen.state.run, NOW + 4);
  assert.deepEqual(tick(chosen.state, `f.${resized.run}.-1.0.0.0.0`, NOW + 10_000).calls, []);
  const resumed = call({ event: 'resume', payload: null, state: resized });
  assert.equal(resumed.state.run, NOW + 4);
  assert.deepEqual(tick(resumed.state, `f.${resized.run}.-1.0.0.0.0`, NOW + 10_000).calls, []);
});

test('the scene goes under the whole screen and hides the welcome mark on a fresh session', () => {
  const start = started();
  assert.deepEqual(start.of('events.schedule'), [{ key: `f.${NOW}.-1.0.0.0.0`, delay_ms: 16 }]);
  const view = draw(start.state).value;
  assert.deepEqual(view.underlay, { raster: 'omd_theme_t1' });
  assert.deepEqual([view.welcome, view.sites], [{ show_while_composing: true, hidden: true }, undefined]);
  const shown = draw(start.state).state;
  const blind = call({ event: 'terminal', state: shown, payload: { event: 'turn', ledger: null, presentation: { thread_id: 't1', phase: 'started', surface: 'fullscreen' }, client: null, clients: [] } });
  assert.deepEqual([blind.value.underlay, blind.state.view.columns], [{ raster: 'omd_theme_t1' }, 120]);
  const later = draw(start.state, { phase: 'started' }).value;
  assert.deepEqual([later.underlay, later.welcome], [{ raster: 'omd_theme_t1' }, undefined]);
  for (const [name, extra] of [['NO_COLOR', { graphics: 'text' }], ['16 colours', { colors: '16' }], ['narrow', { columns: 59 }], ['inline', { surface: 'inline' }]]) {
    assert.deepEqual(draw(start.state, extra).value, {}, name);
  }
  assert.deepEqual(draw(started({ scene: 'off' }).state).value, {});
});

test('each thread draws its own raster, so a hidden thread never paints over the shown one', () => {
  const other = call({ event: 'terminal', state: started().state, payload: { event: 'startup', ledger: null,
    presentation: { thread_id: '0199A-B2', phase: 'fresh', surface: 'fullscreen' }, client: client(), clients: [] } });
  assert.deepEqual(other.value.underlay, { raster: 'omd_theme_0199ab2' });
  const blits = tick(other.state, `f.${NOW}.-1.0.0.0.0`, NOW + 16).of('terminal.blit');
  assert.ok(blits.length > 0 && blits.every(blit => blit.key === 'omd_theme_0199ab2'));
  const uuid = call({ event: 'terminal', state: started().state, payload: { event: 'startup', ledger: null,
    presentation: { thread_id: '019a3f2e-7c41-7d22-9b0e-5f6a8c1d2e3f', phase: 'fresh', surface: 'fullscreen' }, client: client({ columns: 300, rows: 120 }), clients: [] } });
  const first = tick(uuid.state, `f.${NOW}.-1.0.0.0.0`, NOW + 16);
  const later = tick(first.state, first.of('events.schedule')[0].key.replace(/^(f\.\d+)\.\d+/, '$1.999999'), NOW + 86_400_000);
  for (const { key } of [...first.of('events.schedule'), ...later.of('events.schedule')]) assert.ok(Buffer.byteLength(key) <= 64, key);
});

test('opening an uninitialized thread loads its scene and wakes one chain for that thread', () => {
  const opened = call({ event: 'view', payload: { phase: 'opened', view: 'thread', view_id: 'child' } }, { store: { value: { scene: 'lagoon', speed: 'slow' } } });
  assert.deepEqual([opened.state.prefs.scene, opened.state.prefs.speed, opened.state.run], ['lagoon', 'slow', NOW]);
  assert.deepEqual(opened.of('events.publish'), [{ channel: 'wake', data: NOW }]);
  assert.deepEqual(opened.of('events.schedule'), []);
  const shown = call({ event: 'terminal', state: opened.state, payload: { event: 'idle', ledger: { thread_id: 'child', cwd: '/repo' },
    presentation: { thread_id: 'parent', phase: 'started', surface: 'fullscreen' }, client: client(), clients: [] } });
  assert.deepEqual(shown.value.underlay, { raster: 'omd_theme_child' });
  const wake = call({ event: 'channel', state: shown.state, payload: { channel: 'omd_theme/wake', data: NOW } });
  const [first] = wake.of('events.schedule');
  const blits = tick(wake.state, first.key, NOW + 16).of('terminal.blit');
  assert.ok(blits.length > 0 && blits.every(blit => blit.key === 'omd_theme_child'));
  const state = { ...shown.state, busy: true, switched: { from: 'ember', at: NOW - 100 } };
  const again = call({ event: 'view', state, virtual_time_ms: NOW + 1000, payload: { phase: 'opened', view: 'thread', view_id: 'child' } }, { store: { value: { scene: 'fireflies' } } });
  assert.deepEqual(again.state, state);
  assert.deepEqual(again.calls, []);
  const lead = started({ scene: 'moonlit' }).state;
  assert.deepEqual(call({ event: 'view', state: lead, payload: { phase: 'opened', view: 'thread', view_id: 'lead' } }).calls, []);
  for (const payload of [{ phase: 'closed', view: 'thread' }, { phase: 'opened', view: 'overlay' }]) {
    assert.deepEqual(call({ event: 'view', payload: { ...payload, view_id: null } }).calls, []);
  }
});

test('the frame chain blits the screen in bands, then only the changed rows, merged into bands', () => {
  const state = ready();
  const first = tick(state, `f.${NOW}.-1.0.0.0.0`, NOW + 16);
  const full = first.of('terminal.blit');
  assert.equal(full.reduce((cells, blit) => cells + blit.rect.width * blit.rect.height, 0), 120 * 44);
  full.forEach(blit => assert.equal(decode(blit.packed).length, blit.rect.width * blit.rect.height * 12));
  const wideState = draw(state, { columns: 300, rows: 80 }).state;
  const wide = tick(wideState, `f.${wideState.run}.-1.0.0.0.0`, NOW + 16).of('terminal.blit');
  assert.ok(wide.length > 1 && wide.every(blit => blit.rect.width * blit.rect.height <= 14_000));
  const dockedState = draw(state, { chat: { x: 0, y: 0, columns: 90, rows: 44 } }).state;
  const docked = tick(dockedState, `f.${dockedState.run}.-1.0.0.0.0`, NOW + 16);
  const cells = docked.of('terminal.blit').flatMap(blit => {
    const bytes = decode(blit.packed);
    return Array.from({ length: bytes.length / 12 }, (_, at) => ({ glyph: bytes.readUInt32LE(at * 12), x: blit.rect.x + at % blit.rect.width }));
  });
  assert.ok(cells.some(cell => cell.x < 90 && cell.glyph !== 32) && cells.every(cell => cell.x < 90 || cell.glyph === 32));
  assert.match(docked.of('events.schedule')[0].key, /\.fxe5hx-0-0-0-90-44\.0$/);
  const [next] = first.of('events.schedule');
  assert.equal(next.key, `f.${NOW}.1.120.44.${KEY}.0`);
  assert.ok(next.delay_ms > 0 && next.delay_ms <= 250);
  const second = tick(state, next.key, NOW + 266);
  const diffs = second.of('terminal.blit');
  assert.ok(diffs.length > 0 && diffs.length < 44 && diffs.every(blit => blit.rect.x + blit.rect.width <= 120 && blit.rect.width * blit.rect.height <= 14_000));
  diffs.forEach(blit => assert.equal(decode(blit.packed).length, blit.rect.width * blit.rect.height * 12));
  const [after] = second.of('events.schedule');
  assert.equal(after.key, `f.${NOW}.2.120.44.${KEY}.0`);
  assert.ok(after.delay_ms > 0 && after.delay_ms <= 125);
  assert.deepEqual(tick(state, `f.${NOW - 1}.2.120.44.${KEY}.0`, NOW + 300).calls, []);
  const restarted = tick(state, next.key, NOW + 266, { 'terminal.blit': () => ({ frame: 1, queued: 1, frame_ms: 16 }) });
  assert.equal(restarted.of('events.schedule')[0].key, `f.${NOW}.-1.120.44.${KEY}.0`);
  const hidden = tick(state, next.key, NOW + 266, { 'terminal.blit': () => ({ status: 'backpressure', retry_after_ms: 250 }) });
  assert.deepEqual(hidden.of('events.schedule'), [{ key: `f.${NOW}.-1.120.44.${KEY}.1`, delay_ms: 1000 }]);
});

test('a turn darkens and pauses the scene, a still scene draws once, and both only probe for a restart', () => {
  const state = ready();
  const behind = call({ event: 'turn_start', payload: { turn_id: 'a' }, state: draw(state, { phase: 'started' }).state }).state;
  const shaded = tick(behind, `f.${NOW}.1.120.44.${KEY}.0`, NOW + 5000);
  assert.equal(shaded.of('terminal.blit').reduce((cells, blit) => cells + blit.rect.width * blit.rect.height, 0), 120 * 44);
  assert.deepEqual(shaded.of('events.schedule'), [{ key: `f.${NOW}.1.120.44.${BEHIND_KEY}.0`, delay_ms: 400 }]);
  const held = tick(behind, `f.${NOW}.1.120.44.${BEHIND_KEY}.0`, NOW + 6500, { 'terminal.blit': () => ({ frame: 1, queued: 0, frame_ms: 16 }) });
  assert.deepEqual([held.of('terminal.blit').map(blit => blit.rect), held.of('events.schedule')[0].key], [[{ x: 0, y: 0, width: 1, height: 1 }], `f.${NOW}.1.120.44.${BEHIND_KEY}.0`]);
  const lost = tick(behind, `f.${NOW}.1.120.44.${BEHIND_KEY}.0`, NOW + 6500, { 'terminal.blit': () => ({ frame: 1, queued: 1, frame_ms: 16 }) });
  assert.equal(lost.of('events.schedule')[0].key, `f.${NOW}.-1.120.44.${BEHIND_KEY}.0`);
  const restless = { ...behind, prefs: { ...behind.prefs, calm: false } };
  assert.equal(tick(restless, `f.${NOW}.1.120.44.${BEHIND_KEY}.0`, NOW + 6500).of('events.schedule')[0].key, `f.${NOW}.52.120.44.${BEHIND_KEY}.0`);

  const quiet = draw(state, { reduced_motion: true }).state;
  const still = tick(quiet, `f.${NOW}.-1.0.0.0.0`, NOW + 16);
  assert.ok(still.of('terminal.blit').length > 0);
  const poll = still.of('events.schedule')[0];
  assert.deepEqual(poll, { key: `f.${NOW}.0.120.44.${KEY}.0`, delay_ms: 1500 });
  const kept = tick(still.state, poll.key, NOW + 1600);
  assert.deepEqual(kept.calls.map(item => item.operation), ['terminal.blit', 'events.schedule']);
  const corner = decode(still.of('terminal.blit')[0].packed).subarray(0, 12);
  for (const probe of [kept, tick(kept.state, poll.key, NOW + 3200)]) assert.deepEqual(decode(probe.of('terminal.blit')[0].packed), corner);
});

test('a wake that beats its state write waits, a narrow fresh session keeps polling, and stale stored choices fall back', () => {
  const state = ready();
  assert.deepEqual(tick(state, `f.${NOW + 5}.-1.0.0.0.0`, NOW + 20).of('events.schedule'), [{ key: `f.${NOW + 5}.-1.0.0.0.1`, delay_ms: 50 }]);
  const narrow = draw(state, { columns: 50 }).state;
  assert.deepEqual(tick(narrow, `f.${NOW}.-1.0.0.0.0`, NOW + 5000).of('events.schedule'), [{ key: `f.${NOW}.-1.0.0.0.0`, delay_ms: 1000 }]);
  assert.deepEqual(tick(draw(state, { surface: 'inline' }).state, `f.${NOW}.-1.0.0.0.0`, NOW + 5000).calls, []);
  assert.deepEqual(tick(draw(state, { colors: '16' }).state, `f.${NOW}.-1.0.0.0.0`, NOW + 5000).calls, []);
  const prefs = started({ scene: 'gone', speed: 'warp', density: 7, image: { label: 'x', width: 2, height: 2, rgb: 'ff' } }).state.prefs;
  assert.deepEqual([prefs.scene, prefs.speed, prefs.density, prefs.image], ['ember', 'normal', 'normal', null]);
});

test('no scene starts no frame chain, stops pending ticks, and choosing a scene wakes it', () => {
  const store = { value: { scene: 'off' } };
  const start = started(store.value);
  assert.deepEqual(start.of('events.schedule'), []);
  const state = draw(start.state).state;
  assert.deepEqual(tick(state, `f.${NOW}.-1.0.0.0.0`, NOW + 16).calls, []);
  const staleWake = call({ event: 'channel', payload: { channel: 'omd_theme/wake', data: NOW }, state });
  assert.deepEqual(staleWake.of('events.schedule'), []);
  const chosen = call({ event: 'command', name: 'scenes', payload: 'lagoon', state, virtual_time_ms: NOW + 100 }, { store });
  const wake = chosen.of('events.publish')[0];
  const woken = call({ event: 'channel', payload: { channel: `omd_theme/${wake.channel}`, data: wake.data }, state: chosen.state });
  const [first] = woken.of('events.schedule');
  assert.equal(first.key, `f.${NOW + 100}.-1.0.0.0.0`);
  assert.ok(tick(woken.state, first.key, NOW + 116).of('terminal.blit').length > 0);
});

test('every scene animates in single-width glyphs at narrow and wide sizes', async () => {
  const scenes = await import(new URL('scenes.ts', dir));
  for (const id of SCENE_IDS) {
    for (const [width, height] of [[56, 6], [200, 30]]) {
      const a = scenes.compose(id, null, 1, width, height, 1.8, null, 30);
      const b = scenes.compose(id, null, 1, width, height, 1.8, null, 30.5);
      assert.ok(scenes.changed(a, b).length > 0, `${id} ${width}x${height} moves`);
      for (const code of a.glyph) assert.ok(code >= 32 && code !== 127 && String.fromCodePoint(code).length === 1, `${id} glyph ${code}`);
    }
  }
});

test('the panel applies choices at once and keeps Codex\'s picker and the terminal steps one item away', () => {
  const store = { value: null };
  let state = ready();
  const run = (args, overrides = {}) => call({ event: 'command', name: 'scenes', payload: args, state }, { store, ...overrides });
  const opened = run('');
  const panel = opened.of('terminal.panel')[0];
  assert.equal(opened.of('events.publish').length, 0);
  state = opened.state;
  assert.deepEqual(panel.tabs.map(tab => tab.id), ['scenes', 'motion', 'terminal']);
  assert.equal(panel.items[0].id, 'syntax');
  assert.ok(panel.items.find(item => item.id === 'steps:Orca:background').group.includes('this terminal'));
  const chosen = run('panel scene:lagoon');
  assert.equal(store.value.scene, 'lagoon');
  assert.deepEqual([chosen.state.prefs.scene, chosen.state.switched.from], ['lagoon', 'ember']);
  assert.deepEqual(chosen.of('events.publish'), [{ channel: 'wake', data: NOW + 1 }]);
  assert.match(chosen.of('terminal.panel')[0].subtitle, /Showing: Lagoon/);
  assert.equal(run('panel calm false').state.prefs.calm, false);
  assert.equal(run('panel speed warp').state.prefs.speed, 'normal');
  let invoked;
  run('panel syntax', { 'commands.invoke': args => { invoked = args; return { command: 'theme', result: { invoked: true } }; } });
  assert.deepEqual(invoked, { command: 'theme' });
  const shader = call({ event: 'command', name: 'scenes', payload: 'panel steps:Ghostty:shader', state }, { store }).of('terminal.panel')[0];
  assert.match(shader.subtitle, /custom-shader-animation = true/);
  let copied;
  call({ event: 'command', name: 'scenes', payload: 'steps Ghostty shader copy', state }, { store, 'terminal.copy': args => { copied = args.text; return { status: 'confirmed' }; } });
  assert.match(copied, /void mainImage/);
  call({ event: 'command', name: 'scenes', payload: 'terminal ghostty', state }, { store });
  assert.equal(store.value.family, '');
  const typed = call({ event: 'command', name: 'scenes', payload: 'font Iosevka Term', state }, { store });
  assert.match(typed.value.display, /Font family: Iosevka Term/);
  let imported;
  const image = call({ event: 'command', name: 'scenes', payload: 'image /tmp/sky  one.png', state }, { store, 'terminal.import_file': args => { imported = args.path; return { status: 'declined' }; } });
  assert.deepEqual([imported, image.value.display], ['/tmp/sky  one.png','Image import declined; the scene is unchanged']);
});

 test('typing on a fresh thread does not change the scene brightness', () => {
  const state = ready(null, { welcome: null });
  const result = tick(state, `f.${NOW}.1.120.44.${KEY}.0`, NOW + 125);
  assert.match(result.of('events.schedule')[0].key, new RegExp(KEY));
});

 test('the first prompt keeps the populated canvas when the thread receives its id', () => {
  const fresh = call({ event: 'terminal', state: started().state, payload: { event: 'startup', ledger: null,
    presentation: { thread_id: null, phase: 'fresh', surface: 'fullscreen' }, client: client(), clients: [] } });
  const frame = tick(fresh.state, `f.${NOW}.-1.0.0.0.0`, NOW + 16);
  const sent = draw(frame.state, { phase: 'started' });
  assert.deepEqual(sent.value.underlay, fresh.value.underlay);
  const next = tick(sent.state, frame.of('events.schedule')[0].key, NOW + 141);
  assert.ok(next.of('terminal.blit').length > 0);
  assert.ok(next.of('terminal.blit').every(blit => blit.key === fresh.value.underlay.raster));
});

test('enabling a scene from no scene never draws the Ember fallback', async () => {
  const { compose } = await import(new URL('scenes.ts', dir));
  for (const id of SCENE_IDS) {
    const expected = compose(id, null, 1, 120, 44, 1, null, 1);
    for (const progress of [0, 0.1, 0.5]) {
      assert.deepEqual(compose(id, 'off', progress, 120, 44, 1, null, 1), expected);
    }
  }
});

test('Aurora flares when a turn ends and stirs while one runs with calm off, in place; other scenes ignore turns', async () => {
  const scenes = await import(new URL('scenes.ts', dir));
  const glow = canvas => canvas.bg.reduce((sum, color) => sum + (color >> 8 & 255), 0);
  const at = energy => scenes.compose('aurora', null, 1, 120, 34, 1, null, 30, energy);
  assert.ok(glow(at(1)) > glow(at(0.5)) && glow(at(0.5)) > glow(at(0)));
  const lit = canvas => [...canvas.bg].map(color => (color >> 8 & 255) > 60);
  const overlap = lit(at(0)).filter((on, index) => on && lit(at(0.1))[index]).length;
  assert.ok(overlap > 0.95 * lit(at(0)).filter(Boolean).length, 'a fading flare moves the curtains only a little per step');
  for (const id of SCENE_IDS.filter(id => id !== 'aurora')) {
    assert.deepEqual(scenes.compose(id, null, 1, 80, 20, 1, null, 30, 1).bg, scenes.compose(id, null, 1, 80, 20, 1, null, 30).bg, id);
  }

  const state = ready({ scene: 'aurora' });
  const ended = call({ event: 'turn_end', payload: { turn_id: 'a', outcome: 'completed' }, state, virtual_time_ms: NOW + 1000 }).state;
  assert.deepEqual([ended.busy, ended.ended], [false, NOW + 1000]);
  const frame = s => tick(s, `f.${NOW}.-1.0.0.0.0`, NOW + 1125).of('terminal.blit').map(blit => blit.packed).join();
  assert.notEqual(frame(ended), frame({ ...ended, ended: undefined }));
  const working = { ...state, busy: true, prefs: { ...state.prefs, calm: false } };
  assert.notEqual(frame(working), frame(state));
  const ember = ready();
  assert.equal(frame({ ...ember, ended: NOW + 1000 }), frame(ember));
});

test('background and idle scenes stop timers and resume without resetting active work', () => {
  for (const payload of [{ focused: false }, { focused: true, idle: true }]) {
    const state = call({ event: 'turn_start', state: ready(), payload: null }).state;
    const hidden = call({ event: 'focus', state, payload });
    assert.equal(hidden.state.busy, true);
    assert.deepEqual(tick(hidden.state, `f.${NOW}.-1.0.0.0.0`, NOW + 1000).calls, []);
    const resumed = call({ event: 'focus', state: hidden.state, payload: { focused: true, idle: false }, virtual_time_ms: NOW + 2000 });
    assert.equal(resumed.state.busy, true);
    assert.equal(resumed.state.origin, state.origin);
    assert.equal(resumed.of('events.publish').length, 1);
    const wake = call({ event: 'channel', state: resumed.state, payload: { channel: 'omd_theme/wake', data: resumed.state.run } });
    assert.equal(wake.of('events.schedule').length, 1);
  }
});

test('a newly displayed thread recovers a previous inactive state from its terminal snapshot', () => {
  const state = ready();
  const hidden = call({ event: 'focus', state, payload: { focused: false } }).state;
  const shown = draw(hidden, { active: true });
  assert.equal(shown.state.inactive, false);
  assert.equal(shown.of('events.publish').length, 1);
  const background = draw(shown.state, { active: false });
  assert.equal(background.state.inactive, true);
  assert.deepEqual(tick(background.state, `f.${background.state.run}.-1.0.0.0.0`, NOW + 1000).calls, []);
});
