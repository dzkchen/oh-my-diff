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
const SCENE_IDS = ['ember', 'drift', 'lagoon', 'jelly', 'fireflies', 'moonlit'];

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

test('the scene goes under the whole screen and hides the welcome mark on a fresh session', () => {
  const start = started();
  assert.deepEqual(start.of('events.schedule'), [{ key: `f.${NOW}.-1.0.0.0.0`, delay_ms: 16 }]);
  const view = draw(start.state).value;
  assert.deepEqual(view.underlay, { raster: 'omd_theme_scene' });
  assert.deepEqual(view.sites.welcome.components, [{ type: 'box', id: 'omd_theme_hidden', label: 'Welcome hidden by the theme', min_width: 500, children: [{ type: 'slot' }] }]);
  const shown = draw(start.state).state;
  const blind = call({ event: 'terminal', state: shown, payload: { event: 'turn', ledger: null, presentation: { thread_id: 't1', phase: 'started', surface: 'fullscreen' }, client: null, clients: [] } });
  assert.deepEqual([blind.value.underlay, blind.state.view.columns], [{ raster: 'omd_theme_scene' }, 120]);
  const later = draw(start.state, { phase: 'started' }).value;
  assert.deepEqual([later.underlay, later.sites], [{ raster: 'omd_theme_scene' }, undefined]);
  for (const [name, extra] of [['NO_COLOR', { graphics: 'text' }], ['narrow', { columns: 59 }], ['inline', { surface: 'inline' }]]) {
    assert.equal(draw(start.state, extra).value.underlay, undefined, name);
  }
  assert.deepEqual(draw(started({ scene: 'off' }).state).value, {});
  const working = call({ event: 'turn_start', payload: { turn_id: 'a' }, state: start.state }).state;
  assert.equal(working.busy, true);
  assert.equal(call({ event: 'turn_end', payload: { turn_id: 'a', outcome: 'completed' }, state: working }).state.busy, false);
  assert.equal(call({ event: 'resume', payload: null, state: working }).state.busy, false);
});

test('the frame chain blits the screen in bands, then only changed cells, and pauses, shades or backs off when it should', () => {
  const state = ready();
  const first = tick(state, `f.${NOW}.-1.0.0.0.0`, NOW + 16);
  const full = first.of('terminal.blit');
  assert.equal(full.reduce((cells, blit) => cells + blit.rect.width * blit.rect.height, 0), 120 * 44);
  full.forEach(blit => assert.equal(decode(blit.packed).length, blit.rect.width * blit.rect.height * 12));
  const wide = tick(draw(state, { columns: 300, rows: 80 }).state, `f.${NOW}.-1.0.0.0.0`, NOW + 16).of('terminal.blit');
  assert.ok(wide.length > 1 && wide.every(blit => blit.rect.width * blit.rect.height <= 14_000));
  const docked = tick(draw(state, { chat: { x: 0, y: 0, columns: 90, rows: 44 } }).state, `f.${NOW}.-1.0.0.0.0`, NOW + 16);
  const cells = docked.of('terminal.blit').flatMap(blit => {
    const bytes = decode(blit.packed);
    return Array.from({ length: bytes.length / 12 }, (_, at) => ({ glyph: bytes.readUInt32LE(at * 12), x: blit.rect.x + at % blit.rect.width }));
  });
  assert.ok(cells.some(cell => cell.x < 90 && cell.glyph !== 32) && cells.every(cell => cell.x < 90 || cell.glyph === 32));
  assert.match(docked.of('events.schedule')[0].key, /\.0-0-0-90-44\.0$/);
  const [next] = first.of('events.schedule');
  assert.deepEqual(next, { key: `f.${NOW}.1.120.44.0-0-0-120-44.0`, delay_ms: 234 });
  const second = tick(state, next.key, NOW + 266);
  const [diff] = second.of('terminal.blit');
  assert.ok(diff.rect.x + diff.rect.width <= 120 && diff.rect.y + diff.rect.height <= 44);
  assert.deepEqual(second.of('events.schedule'), [{ key: `f.${NOW}.2.120.44.0-0-0-120-44.0`, delay_ms: 109 }]);
  assert.deepEqual(tick(state, `f.${NOW - 1}.2.120.44.0-0-0-120-44.0`, NOW + 300).calls, []);
  const restarted = tick(state, next.key, NOW + 266, { 'terminal.blit': () => ({ frame: 1, queued: 1, frame_ms: 16 }) });
  assert.deepEqual(restarted.of('events.schedule'), [{ key: `f.${NOW}.-1.120.44.0-0-0-120-44.0`, delay_ms: 109 }]);
  const hidden = tick(state, next.key, NOW + 266, { 'terminal.blit': () => ({ status: 'backpressure', retry_after_ms: 250 }) });
  assert.deepEqual(hidden.of('events.schedule'), [{ key: `f.${NOW}.-1.120.44.0-0-0-120-44.1`, delay_ms: 1000 }]);

  const behind = call({ event: 'turn_start', payload: { turn_id: 'a' }, state: draw(state, { phase: 'started' }).state }).state;
  const shaded = tick(behind, next.key, NOW + 5000);
  assert.equal(shaded.of('terminal.blit').reduce((cells, blit) => cells + blit.rect.width * blit.rect.height, 0), 120 * 44);
  assert.deepEqual(shaded.of('events.schedule'), [{ key: `f.${NOW}.1.120.44.1-0-0-120-44.0`, delay_ms: 400 }]);
  const held = tick(behind, `f.${NOW}.1.120.44.1-0-0-120-44.0`, NOW + 6500);
  assert.deepEqual([held.of('terminal.blit').map(blit => blit.rect), held.of('events.schedule')[0].key], [[{ x: 0, y: 0, width: 1, height: 1 }], `f.${NOW}.1.120.44.1-0-0-120-44.0`]);
  const lost = tick(behind, `f.${NOW}.1.120.44.1-0-0-120-44.0`, NOW + 6500, { 'terminal.blit': () => ({ frame: 1, queued: 1, frame_ms: 16 }) });
  assert.equal(lost.of('events.schedule')[0].key, `f.${NOW}.-1.120.44.1-0-0-120-44.0`);
  const restless = { ...behind, prefs: { ...behind.prefs, calm: false } };
  assert.equal(tick(restless, `f.${NOW}.1.120.44.1-0-0-120-44.0`, NOW + 6500).of('events.schedule')[0].key, `f.${NOW}.52.120.44.1-0-0-120-44.0`);

  const quiet = draw(state, { reduced_motion: true }).state;
  const still = tick(quiet, `f.${NOW}.-1.0.0.0.0`, NOW + 16);
  assert.ok(still.of('terminal.blit').length > 0);
  const poll = still.of('events.schedule')[0];
  assert.deepEqual(poll, { key: `f.${NOW}.0.120.44.0-0-0-120-44.0`, delay_ms: 1500 });
  assert.deepEqual(tick(quiet, poll.key, NOW + 1600).calls.map(item => item.operation), ['terminal.blit', 'events.schedule']);
});

test('a wake that beats its state write waits, a narrow fresh session keeps polling, and stale stored choices fall back', () => {
  const state = ready();
  assert.deepEqual(tick(state, `f.${NOW + 5}.-1.0.0.0.0`, NOW + 20).of('events.schedule'), [{ key: `f.${NOW + 5}.-1.0.0.0.1`, delay_ms: 250 }]);
  const narrow = draw(state, { columns: 50 }).state;
  assert.deepEqual(tick(narrow, `f.${NOW}.-1.0.0.0.0`, NOW + 5000).of('events.schedule'), [{ key: `f.${NOW}.-1.0.0.0.0`, delay_ms: 1000 }]);
  assert.deepEqual(tick(draw(state, { surface: 'inline' }).state, `f.${NOW}.-1.0.0.0.0`, NOW + 5000).calls, []);
  const prefs = started({ scene: 'gone', speed: 'warp', density: 7, image: { label: 'x', width: 2, height: 2, rgb: 'ff' } }).state.prefs;
  assert.deepEqual([prefs.scene, prefs.speed, prefs.density, prefs.image], ['ember', 'normal', 'normal', null]);
});

test('every scene animates in single-width glyphs at narrow and wide sizes within the frame budget', async () => {
  const scenes = await import(new URL('scenes.ts', dir));
  for (const id of SCENE_IDS) {
    for (const [width, height] of [[56, 6], [200, 30]]) {
      const a = scenes.compose(id, null, 1, width, height, 1.8, null, 30);
      const b = scenes.compose(id, null, 1, width, height, 1.8, null, 30.5);
      assert.ok(scenes.changed(a, b), `${id} ${width}x${height} moves`);
      for (const code of a.glyph) assert.ok(code >= 32 && code !== 127 && String.fromCodePoint(code).length === 1, `${id} glyph ${code}`);
    }
    const started = performance.now();
    for (let k = 0; k < 10; k++) scenes.compose(id, 'ember', 0.5, 200, 60, 1, null, k * 0.1);
    assert.ok((performance.now() - started) / 10 < 25, `${id} renders a revealing 200x60 frame in under 25 ms`);
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
  assert.deepEqual(chosen.of('events.publish'), [{ channel: 'wake', data: NOW }]);
  assert.match(chosen.of('terminal.panel')[0].subtitle, /Showing: Lagoon/);
  assert.equal(run('panel calm false').state.prefs.calm, false);
  let invoked;
  run('panel syntax', { 'commands.invoke': args => { invoked = args; return { command: 'theme', result: { invoked: true } }; } });
  assert.deepEqual(invoked, { command: 'theme' });
  const shader = call({ event: 'command', name: 'scenes', payload: 'panel steps:Ghostty:shader', state }, { store }).of('terminal.panel')[0];
  assert.match(shader.subtitle, /custom-shader-animation = true/);
  let copied;
  call({ event: 'command', name: 'scenes', payload: 'steps Ghostty shader copy', state }, { store, 'terminal.copy': args => { copied = args.text; return { status: 'confirmed' }; } });
  assert.match(copied, /void mainImage/);
  const typed = call({ event: 'command', name: 'scenes', payload: 'font Iosevka Term', state }, { store });
  assert.match(typed.value.display, /Font family: Iosevka Term/);
  let imported;
  const image = call({ event: 'command', name: 'scenes', payload: 'image /tmp/sky  one.png', state }, { store, 'terminal.import_file': args => { imported = args.path; return { status: 'declined' }; } });
  assert.deepEqual([imported, image.value.display], ['/tmp/sky  one.png','Image import declined; the scene is unchanged']);
});
