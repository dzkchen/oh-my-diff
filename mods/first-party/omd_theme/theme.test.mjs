import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const runner = readFileSync(new URL('../../../runtime/omd/src/mods/runner.mjs', import.meta.url), 'utf8');
const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const { capabilities } = JSON.parse(readFileSync(new URL('./mod.json', import.meta.url), 'utf8'));
const surface = { events: { terminal: 'terminal', app_notification: 'threads', start: 'lifecycle', resume: 'lifecycle', turn_end: 'lifecycle', timer: 'events', channel: 'events' }, replacements: ['terminal'], middleware: [], state: 'store', contracts: 'contracts' };
function run(event, name = '', payload = '', options = {}) {
  const result = spawnSync(process.execPath, ['--no-warnings', '--experimental-vm-modules', '--input-type=module', '--eval', runner], {
    input: JSON.stringify({ source, filename: 'index.ts', api: '0.2.0-experimental.5', surface, capabilities, settings: {}, state: null, event, name, payload, ...options }), encoding: 'utf8', timeout: 5000,
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
  assert.equal(defaults.background, 234);
  assert.notEqual(defaults.theme.user_message_background, '#17191d');
  assert.equal(defaults.foreground, 254);
  assert.deepEqual(defaults.theme.glyphs, {});
  assert.equal(defaults.backdrop, undefined);
  const unicode = run('terminal', '', '', { settings: { symbols: 'unicode' } }).value;
  assert.deepEqual(unicode.theme.glyphs, { '===': '≡  ', '->': '→ ', '<=': '≤ ' });
  for (const palette of ['night', 'midnight', 'paper', 'contrast', 'frost', 'graphite', 'amber']) {
    const value = run('terminal', '', '', { settings: { palette, composer_gloss: true } }).value;
    assert.match(value.theme.failure, /^#[\da-f]{6}$/);
    assert.equal(value.theme.syntax, palette === 'paper' ? 'catppuccin-latte' : 'catppuccin-mocha');
    assert.notEqual(value.surface_styles.composer.top, value.surface_styles.composer.bottom);
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
  assert.equal(paletteSelect(state).value, 'night');
  assert.equal(run('terminal', '', '', { state }).value.greeting, '');
  assert.equal(run('terminal', '', '', { state }).value.background, 234);
});

test('representative Ghostty, iTerm2 XML and Warp YAML imports retain RGB and ANSI intent', () => {
  const formats = {
    ghostty: 'background = #102030\nforeground = #ffffff\npalette = 1=#ff8888\npalette = 4=#aaccff\ncommand = ignored\n',
    iterm2: '<?xml version="1.0"?><plist><dict><key>Background Color</key><dict><key>Red Component</key><real>0.062745098</real><key>Green Component</key><real>0.125490196</real><key>Blue Component</key><real>0.188235294</real></dict><key>Foreground Color</key><dict><key>Red Component</key><real>1</real><key>Green Component</key><real>1</real><key>Blue Component</key><real>1</real></dict></dict></plist>',
    warp: "name: Sample\nbackground: '#102030'\nforeground: '#ffffff'\naccent: '#aaccff'\nbackground_image:\n  path: /never/opened.jpg\nterminal_colors:\n  normal:\n    red: '#ff8888'\n    green: '#88ff88'\n  bright:\n    black: '#aaaaaa'\n",
  };
  for (const [format, text] of Object.entries(formats)) {
    const path = `/tmp/${format} theme`;
    const output = run('command', 'load', `${format} ${path}`, { receipts: [importReceipt(path), textReceipt(text)] });
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
    const output = run('command', 'load', 'ghostty /tmp/denied', { state: prior, receipts: [receipt] });
    assert.equal(output.state.preview.palette, 'paper');
    assert.equal(output.calls.length, 1);
  }
  for (const [format, text] of [['ghostty', 'background = red\nforeground = #ffffff'], ['iterm2', 'bplist00'], ['warp', "foreground: '#ffffff'\nbackground: !!secret '/tmp/private'"]]) {
    const output = run('command', 'load', `${format} /tmp/bad`, { state: prior, receipts: [importReceipt('/tmp/bad'), textReceipt(text)] });
    assert.equal(output.state.preview.palette, 'paper');
    assert.deepEqual(output.state.imports, {});
  }
  for (const [command, value] of [['set', 'palette constructor'], ['set', 'palette __proto__'], ['style', '__proto__']]) assert.equal(run('command', command, value, { state: prior }).state.preview.palette, 'paper');
  assert.equal(run('terminal', '', '', { state: { preview: { palette: 'constructor' } } }).value.background, 234);
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
  const open = run('command', 'style').state;
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
  for (const page of ['palette', 'backdrop', 'position', 'glass', 'greeting', 'status']) {
    const state = run('command', 'page', page).state;
    const children = run('terminal', '', '', { state }).value.sites.dialog.components[0].children;
    assert.deepEqual(children.slice(0, 4).map(item => item.action.command), ['omd_theme:close', 'omd_theme:save', 'omd_theme:cancel', 'omd_theme:reset']);
  }
});

test('powerline presets show session, Git, context and OMD state; below adds one status segment; Alt+z stashes', () => {
  const thread = 'thread-123456789';
  const ledger = { thread_id: thread, cwd: '/Users/me/work/project', cost: { settled_task_charge_microusd: 1_250_000 } };
  const identity = { codex_version: '0.159.1', install_profile: 'full', mode: 'omd', mods: { installed: 9, enabled: 5, active: 5 } };
  const on = { statusline: 'default' };
  const notify = (state, method, params) => run('app_notification', '', { method, params: { threadId: thread, ...params }, thread_id: thread, coalesced: 0, dropped: 0 }, { state, settings: on }).state;
  assert.equal(run('app_notification', '', { method: 'thread/settings/updated', params: { threadId: thread }, thread_id: thread, coalesced: 0, dropped: 0 }).state, null);
  const exec = (argv, stdout) => ({ call: { operation: 'exec.run', arguments: { program: argv[0], ...(argv.length > 1 ? { argv: argv.slice(1) } : {}), timeout_ms: argv[0] === 'env' ? 2000 : 3000 } }, value: { exit_code: 0, stdout } });
  const start = stashed => run('start', '', null, { settings: on, receipts: [
    exec(['env'], 'TERM_PROGRAM=ghostty\nPATH=/bin\n'),
    { call: { operation: 'store.get', arguments: { key: 'stash', scope: 'repository' } }, value: stashed },
    { call: { operation: 'app.request', arguments: { method: 'config/read', params: {} } }, value: { config: { model: 'gpt-6.1-sol', model_reasoning_effort: 'medium' } } },
    exec(['git', 'status', '--porcelain=v2', '--branch'], '# branch.oid abc\n# branch.head main\n# branch.ab +2 -1\n1 M. N... 100644 100644 100644 a b src/a.ts\n1 .M N... 100644 100644 100644 a b src/b.ts\nu UU N... 1 2 3 4 a b c src/c.ts\n? new.ts\n'),
    { call: { operation: 'events.schedule', arguments: { key: 'git', delay_ms: 10000 } }, value: { key: 'git', delay_ms: 10000 } },
  ] }).state;
  assert.equal(start({ value: { active: 'kept', history: ['kept'] }, revision: 1, provenance: {} }).live.stashed, true);
  let state = start(null);
  assert.deepEqual(state.live.git, { branch: 'main', ahead: 2, behind: 1, staged: 1, unstaged: 2, untracked: 1 });
  assert.equal(state.live.nerd, true);
  state = notify(state, 'thread/settings/updated', { threadSettings: { model: 'gpt-6.1-sol', effort: 'high', modelProvider: 'openai' } });
  state = notify(state, 'thread/tokenUsage/updated', { tokenUsage: { total: { inputTokens: 12300, outputTokens: 4500 }, last: { totalTokens: 184000 }, modelContextWindow: 200000 } });
  const view = settings => run('terminal', '', { event: 'idle', ledger, identity }, { state, settings }).value;
  const spans = view({ statusline: 'nerd' }).sites.above_composer.components[1].spans;
  assert.equal(spans.map(span => span.text).join(''), ['  gpt-6.1-sol ', ' think:high ', '  …/work/project ', '  main ↑2 ↓1 +1 *2 ?1 ', '  ↑12k ↓4.5k ', '  $1.25 ', '  92%/200k ', '  thread-1 ', '  5 mods '].join('') + '');
  assert.ok(spans.filter(span => span.text.startsWith(' ')).every(span => span.bg));
  const ascii = view({ statusline: 'ascii' }).sites.above_composer.components[1].spans;
  assert.equal(ascii.map(span => span.text).join(''), 'gpt-6.1-sol | think:high | …/work/project | git:main ^2 v1 +1 *2 ?1 | in:12k out:4.5k | $1.25 | ctx:92%/200k');
  assert.ok(ascii.every(span => !span.bg));
  assert.deepEqual(view({ statusline: 'minimal', statusline_position: 'below' }).status, ['5 mods · $1.25 · ctx 92%!']);
  assert.equal(view({}).sites, undefined);
  assert.equal(view({}).status, undefined);

  let stash = null;
  const composer = { text: 'draft one' };
  const drive = (state, payload = '') => {
    const receipts = [];
    for (;;) {
      const output = run('command', 'stash', payload, { state, receipts, settings: on });
      if (!output.host_call) return output;
      const { operation, arguments: args } = output.host_call;
      const value = operation === 'store.get' ? stash && { value: stash, revision: 1, provenance: {} }
        : operation === 'store.put' ? (stash = args.value, { revision: 2 })
        : operation === 'composer.read' ? { text: composer.text, cursor: 0, attachments: [] }
        : (composer.text = args.text ?? composer.text + args.insert, { text: composer.text, cursor: 0 });
      receipts.push({ call: output.host_call, value });
    }
  };
  let output = drive(state);
  assert.deepEqual([output.value.display, composer.text, stash, output.state.live.stashed], ['Draft stashed; Alt+z restores it', '', { active: 'draft one', history: ['draft one'] }, true]);
  state = output.state;
  assert.match(view({ statusline: 'compact' }).sites.above_composer.components[1].spans.at(-2).text, /stash/);
  output = drive(output.state);
  assert.deepEqual([output.value.display, composer.text, stash.active, output.state.live.stashed], ['Stash restored', 'draft one', null, false]);
  assert.equal(drive(output.state, 'list').value.display, '1. draft one');
  composer.text = '';
  assert.equal(drive(output.state).value.display, 'Nothing to stash');
  assert.deepEqual(run('terminal').value.keybindings, { 'Alt+z': { command: 'omd_theme:stash' } });
});
