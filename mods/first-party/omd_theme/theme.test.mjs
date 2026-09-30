import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const runner = readFileSync(new URL('../../../runtime/omd/src/mods/runner.mjs', import.meta.url), 'utf8');
const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const surface = { events: { terminal: 'terminal' }, replacements: ['terminal'], middleware: [], state: 'store', contracts: 'contracts' };
function run(event, name = '', payload = '', options = {}) {
  const result = spawnSync(process.execPath, ['--no-warnings', '--experimental-vm-modules', '--input-type=module', '--eval', runner], {
    input: JSON.stringify({ source, filename: 'index.ts', api: '0.2.0-experimental.5', surface, capabilities: ['terminal', 'commands', 'store'], settings: {}, state: null, event, name, payload, ...options }), encoding: 'utf8', timeout: 5000,
  });
  assert.ifError(result.error);
  const output = JSON.parse(result.stdout);
  assert.equal(result.status, 0, `${result.stderr}\n${output.error ?? ''}`);
  return output;
}
const ref = { reference: 'a'.repeat(64), sha256: 'a'.repeat(64) };
const importReceipt = (path, limit = 65536, extra = {}, value = ref) => ({ call: { operation: 'terminal.import_file', arguments: { path, max_bytes: limit, ...extra } }, value });
const textReceipt = text => ({ call: { operation: 'evidence.read', arguments: { reference: ref, max_bytes: 16384 } }, value: { reference: ref, text, cursor: null, bytes: Buffer.byteLength(text) } });

test('default greeting is hidden; palettes retain semantic colors and width-preserving symbols', () => {
  const defaults = run('terminal').value;
  assert.equal(defaults.greeting, '');
  assert.equal(defaults.background, 235);
  assert.equal(defaults.foreground, 255);
  assert.deepEqual(defaults.theme.glyphs, {});
  assert.equal(defaults.backdrop, undefined);
  const unicode = run('terminal', '', '', { settings: { symbols: 'unicode' } }).value;
  assert.deepEqual(unicode.theme.glyphs, { '===': '≡  ', '->': '→ ', '<=': '≤ ' });
  for (const palette of ['midnight', 'paper', 'contrast', 'frost', 'graphite', 'amber']) {
    const value = run('terminal', '', '', { settings: { palette, composer_gloss: true } }).value;
    assert.match(value.theme.failure, /^#[\da-f]{6}$/);
    assert.equal(value.theme.syntax, palette === 'paper' ? 'catppuccin-latte' : 'catppuccin-mocha');
    assert.notEqual(value.surface_styles.composer.top, value.surface_styles.composer.bottom);
    assert.equal(value.message_template, undefined);
    assert.equal(value.completed_tools, undefined);
  }
});

test('preview, save, reload, discard and reset keep user-selected greeting and palette state', () => {
  let state = run('command', 'set', 'palette paper').state;
  assert.equal(run('terminal', '', '', { state }).value.background, 231);
  state = run('command', 'save', '', { state }).state;
  assert.equal(state.preview, null);
  assert.equal(run('terminal', '', '', { state }).value.background, 231);
  state = run('command', 'set', 'palette amber', { state }).state;
  state = run('command', 'cancel', '', { state }).state;
  assert.equal(run('terminal', '', '', { state }).value.background, 231);
  state = run('command', 'set', 'greeting_text Build something useful', { state }).state;
  state = run('command', 'set', 'greeting_enabled true', { state }).state;
  assert.equal(run('terminal', '', '', { state }).value.greeting, 'Build something useful');
  const paletteSelect = state => run('terminal', '', '', { state: { ...state, open: true } }).value.sites.dialog.components[0].children.find(item => item.label === 'Palette library');
  const shown = paletteSelect(state);
  state = run('command', 'reset', '', { state }).state;
  assert.notEqual(paletteSelect(state).id, shown.id);
  assert.equal(paletteSelect(state).value, 'midnight');
  assert.equal(run('terminal', '', '', { state }).value.greeting, '');
  assert.equal(run('terminal', '', '', { state }).value.background, 235);
});

test('representative Ghostty, iTerm2 XML and Warp YAML imports retain RGB and ANSI intent', () => {
  const formats = {
    ghostty: 'background = #102030\nforeground = #ffffff\npalette = 1=#ff8888\npalette = 4=#aaccff\ncommand = ignored\n',
    iterm2: '<?xml version="1.0"?><plist><dict><key>Background Color</key><dict><key>Red Component</key><real>0.062745098</real><key>Green Component</key><real>0.125490196</real><key>Blue Component</key><real>0.188235294</real></dict><key>Foreground Color</key><dict><key>Red Component</key><real>1</real><key>Green Component</key><real>1</real><key>Blue Component</key><real>1</real></dict></dict></plist>',
    warp: "name: Sample\nbackground: '#102030'\nforeground: '#ffffff'\naccent: '#aaccff'\nbackground_image:\n  path: /never/opened.jpg\nterminal_colors:\n  normal:\n    red: '#ff8888'\n    green: '#88ff88'\n  bright:\n    black: '#aaaaaa'\n",
  };
  for (const [format, text] of Object.entries(formats)) {
    const path = `/tmp/${format} theme`;
    const output = run('command', 'import', `${format} ${path}`, { receipts: [importReceipt(path), textReceipt(text)] });
    assert.equal(output.state.imports.import_1.background, '#102030');
    assert.equal(output.state.imports.import_1.foreground, '#ffffff');
    assert.equal(output.calls.length, 2);
    assert.equal(output.state.preview.palette, 'import_1');
    const saved = run('command', 'save', '', { state: output.state }).state;
    assert.equal(run('terminal', '', '', { state: saved }).value.theme.accent, output.state.imports.import_1.theme.accent);
  }
});

test('denied, declined, malformed and unsupported imports preserve the selected appearance', () => {
  const prior = run('command', 'set', 'palette paper').state;
  for (const receipt of [importReceipt('/tmp/denied', 65536, {}, { status: 'declined' }), { call: importReceipt('/tmp/denied').call, error: 'permission_denied' }]) {
    const output = run('command', 'import', 'ghostty /tmp/denied', { state: prior, receipts: [receipt] });
    assert.equal(output.state.preview.palette, 'paper');
    assert.equal(output.calls.length, 1);
  }
  for (const [format, text] of [['ghostty', 'background = red\nforeground = #ffffff'], ['iterm2', 'bplist00'], ['warp', "foreground: '#ffffff'\nbackground: !!secret '/tmp/private'"]]) {
    const output = run('command', 'import', `${format} /tmp/bad`, { state: prior, receipts: [importReceipt('/tmp/bad'), textReceipt(text)] });
    assert.equal(output.state.preview.palette, 'paper');
    assert.deepEqual(output.state.imports, {});
  }
  for (const [command, value] of [['set', 'palette constructor'], ['set', 'palette __proto__'], ['theme', '__proto__']]) assert.equal(run('command', command, value, { state: prior }).state.preview.palette, 'paper');
  assert.equal(run('terminal', '', '', { state: { preview: { palette: 'constructor' } } }).value.background, 235);
  const invalid = run('command', 'set', 'scale 99', { state: prior });
  assert.equal(invalid.state.preview.palette, 'paper');
  assert.match(invalid.value.display, /0.1/);
});

test('image import uses package lifetime and a bounded native sample; discard restores the prior asset', () => {
  const rgba = Array.from({ length: 80 * 24 * 4 }, (_, index) => index % 4 === 3 ? 255 : 100);
  const receipts = [importReceipt('/tmp/image.png', 8 * 1024 * 1024, { lifetime: 'package' }), { call: { operation: 'terminal.image_sample', arguments: { resource: ref, columns: 80, rows: 24 } }, value: { width: 80, height: 24, rgba } }];
  const output = run('command', 'image', '/tmp/image.png', { receipts });
  assert.equal(output.state.preview_asset.ascii.split('\n').length, 24);
  const view = run('terminal', '', '', { state: output.state }).value;
  assert.deepEqual(view.backdrop.image.resource, ref);
  assert.equal(view.backdrop.fallback.ascii.text, output.state.preview_asset.ascii);
  assert.equal(view.backdrop.image.scale, 1);
  const saved = run('command', 'save', '', { state: output.state }).state;
  assert.deepEqual(saved.asset.resource, ref);
  assert.equal(saved.preview_asset, null);
  const rejected = run('command', 'image', '/tmp/image.png', { state: saved, receipts: [receipts[0], { call: receipts[1].call, error: 'backdrop_image_invalid_or_too_large' }] });
  assert.deepEqual(rejected.state.asset.resource, ref);
  assert.equal(rejected.state.preview_asset, null);
});

test('ASCII import rejects control sequences; settings pages expose keyboard actions with bounded components', () => {
  const output = run('command', 'ascii', '/tmp/art.txt', { receipts: [importReceipt('/tmp/art.txt', 8192), textReceipt(' /\\ \n/  \\')] });
  assert.equal(output.state.preview.backdrop_mode, 'ascii');
  const rejected = run('command', 'ascii', '/tmp/art.txt', { state: output.state, receipts: [importReceipt('/tmp/art.txt', 8192), textReceipt('\u001b[2J')] });
  assert.equal(rejected.state.preview.ascii_text, output.state.preview.ascii_text);
  const open = run('command', 'theme').state;
  const components = run('terminal', '', '', { state: open }).value.sites.dialog.components[0].children;
  assert.ok(components.every(item => item.id.startsWith('omd_theme_')));
  assert.ok(components.some(item => item.action?.command === 'omd_theme:save'));
  assert.ok(components.some(item => item.action?.command === 'omd_theme:reset'));
});


test('greeting byte bounds and short-dialog recovery actions remain usable after resize', () => {
  const state = run('command', 'set', 'greeting_text Hello').state;
  const rejected = run('command', 'set', `greeting_text ${'界'.repeat(100)}`, { state });
  assert.equal(rejected.state.preview.greeting_text, 'Hello');
  assert.match(rejected.value.display, /UTF-8 bytes/);
  for (const page of ['palette', 'backdrop', 'position', 'glass', 'greeting']) {
    const state = run('command', 'page', page).state;
    const children = run('terminal', '', '', { state }).value.sites.dialog.components[0].children;
    assert.deepEqual(children.slice(0, 4).map(item => item.action.command), ['omd_theme:close', 'omd_theme:save', 'omd_theme:cancel', 'omd_theme:reset']);
  }
});
