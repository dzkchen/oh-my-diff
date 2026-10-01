import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const runner = readFileSync(new URL('../runtime/omd/src/mods/runner.mjs', import.meta.url), 'utf8');
const mod = new URL('../mods/first-party/omd_editor/', import.meta.url);
const source = readFileSync(new URL('index.ts', mod), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('mod.json', mod), 'utf8'));
const surface = { events: { terminal: 'terminal', component_event: 'terminal', channel: 'events', timer: 'events', start: 'lifecycle', resume: 'lifecycle', turn_end: 'lifecycle', workspace_change: 'fs.read' },
  replacements: [], middleware: [], state: 'store', contracts: 'contracts' };
const sha = data => createHash('sha256').update(data).digest('hex');

function fixture() {
  const repository = realpathSync(mkdtempSync(join(tmpdir(), 'omd-editor-')));
  const git = (...argv) => spawnSync('git', argv, { cwd: repository, encoding: 'utf8' });
  git('init', '-q');
  mkdirSync(join(repository, 'src'));
  writeFileSync(join(repository, 'src/app.ts'), 'const a = 1;\r\nconst b = 2;\r\nconst c = 3;');
  writeFileSync(join(repository, 'image.bin'), Buffer.from([0xff, 0xfe, 0x00]));
  writeFileSync(join(repository, 'big.txt'), 'x'.repeat(120_000));
  git('add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base');
  writeFileSync(join(repository, 'notes.txt'), 'first\n');
  const calls = [];
  const host = { deny: null, confirm: true };
  const store = new Map();
  let revision = 0;
  const stat = path => {
    const full = join(repository, path);
    if (!existsSync(full)) return null;
    const info = lstatSync(full);
    return { kind: info.isDirectory() ? 'dir' : 'file', size: info.size, mtime_ms: 0, ...(info.isFile() ? { sha256: sha(readFileSync(full)) } : {}) };
  };
  const call = (operation, args) => {
    calls.push({ operation, args });
    switch (operation) {
      case 'exec.run': {
        const run = spawnSync(args.program, args.argv ?? [], { cwd: repository, encoding: 'utf8' });
        return { exit_code: run.status, stdout: run.stdout, stderr: run.stderr, stdout_sha256: sha(run.stdout), stdout_preview_truncated: false };
      }
      case 'workspace.stat': return { files: Object.fromEntries(args.paths.map(path => [path, stat(path)])) };
      case 'workspace.read': return { files: Object.fromEntries(args.paths.map(path => {
        const bytes = readFileSync(join(repository, path));
        try {
          return [path, { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), sha256: sha(bytes) }];
        } catch {
          throw new Error('workspace_text_not_utf8');
        }
      })) };
      case 'workspace.transaction': {
        if (host.deny) throw new Error(host.deny);
        for (const [path, expected] of Object.entries(args.expected)) if ((stat(path)?.sha256 ?? null) !== expected) throw new Error(`stale expected version for ${path}`);
        for (const [path, text] of Object.entries(args.writes)) writeFileSync(join(repository, path), text);
        return { files: Object.fromEntries(Object.keys(args.writes).map(path => [path, stat(path).sha256])), backup: null };
      }
      case 'workspace.watch': return { watch_id: 'w1' };
      case 'store.get': return store.get(`${args.scope}/${args.key}`) ?? null;
      case 'store.put': {
        if (args.value == null) throw new Error('store_value_required');
        const current = store.get(`${args.scope}/${args.key}`)?.revision ?? null;
        if (current !== args.expected_revision) throw new Error(`store_revision_conflict: current ${current ?? 'absent'}`);
        store.set(`${args.scope}/${args.key}`, { value: args.value, revision: ++revision });
        return { revision };
      }
      case 'terminal.prompt': return host.confirm ? { status: 'accepted' } : { status: 'declined' };
      case 'composer.write': return { text: args.insert, cursor: 0 };
      default: return { delivered: 1, dropped: 0, stopped: true };
    }
  };
  const invoke = (state, event, payload, name) => {
    const receipts = [];
    for (;;) {
      const request = { source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, state, settings: { git: true, lsp: true }, event, name, payload, receipts, surface, hook_budget_ms: 10000 };
      const output = JSON.parse(spawnSync(process.execPath, ['--no-warnings', '--experimental-vm-modules', '--input-type=module', '--eval', runner],
        { input: JSON.stringify(request), encoding: 'utf8', timeout: 20000 }).stdout);
      if (output.error) throw new Error(output.error);
      assert.ok(receipts.length <= 32, 'host call limit');
      assert.ok(Buffer.byteLength(JSON.stringify(receipts)) <= 131_072, 'host receipt limit');
      if (!output.host_call) return output;
      try {
        receipts.push({ call: output.host_call, value: call(output.host_call.operation, output.host_call.arguments) });
      } catch (error) {
        receipts.push({ call: output.host_call, error: error.message });
      }
    }
  };
  let state = null;
  const edit = text => {
    const output = invoke(state, 'command', text, 'edit');
    state = output.state;
    return output.value;
  };
  const keys = (...events) => {
    state = invoke(state, 'component_event', { component: 'omd_editor_doc', kind: 'input', events }).state;
  };
  const event = (name, payload) => {
    state = invoke(state, name, payload).state;
  };
  const sync = () => event('channel', { publisher: 'omd_editor', channel: 'omd_editor/hop', data: null, correlation: null, sequence: 1, dropped: 0 });
  const view = () => {
    const value = invoke(state, 'terminal', { event: 'redraw', ledger: { thread_id: 'thread-1', cwd: repository, cost: null } }).value;
    const components = [];
    const walk = items => items.forEach(item => {
      components.push(item);
      if (item.children) walk(item.children);
    });
    for (const site of Object.values(value?.sites ?? {})) walk(site.components);
    for (const component of components) {
      if (component.id) assert.match(component.id, /^[a-z0-9_]{1,48}$/);
      if (component.type !== 'document') continue;
      assert.ok(component.lines.length <= 2000);
      assert.ok(component.lines.flat().reduce((sum, span) => sum + span.text.length, 0) <= 49_152);
      for (const line of component.lines) {
        assert.ok(line.length <= 12, 'spans per line');
        for (const span of line) assert.ok(Buffer.byteLength(span.text) <= 1024 && !/[\u0000-\u001f\u007f-\u009f]/.test(span.text), JSON.stringify(span));
      }
    }
    return { value, find: id => components.find(component => component.id.endsWith(id)) };
  };
  const key = name => ({ key: name, text: null });
  const text = value => ({ key: null, text: value });
  const buffer = () => state.buffers[state.active];
  return { repository, git, calls, host, store, edit, keys, event, sync, view, key, text, buffer, get state() { return state; }, set state(value) { state = value; } };
}

test('editor buffers edit with undo, find, Git markers and composer quotes, then save CRLF text through a checked transaction', () => {
  const fx = fixture();
  const { repository, git, calls, edit, keys, event, sync, view, key, text, buffer } = fx;
  const original = sha(readFileSync(join(repository, 'src/app.ts')));
  assert.equal(edit('src/app.ts:2'), null);
  assert.doesNotMatch(view().find('_status').text, /Git/);
  sync();
  let { value, find } = view();
  assert.equal(value.sites.dialog.components[0].type, 'dialog');
  assert.match(find('_status').text, /^src\/app\.ts · 2:1 · CRLF · no final newline · Git \+0 ~0 -0$/);
  assert.deepEqual(calls.find(item => item.operation === 'workspace.watch').args, { paths: ['src/app.ts'], recursive: false, debounce_ms: 300 });

  keys(key('End'), text(' // two'), key('Enter'), text('const d = 4;'));
  assert.deepEqual(buffer().lines, ['const a = 1;', 'const b = 2; // two', 'const d = 4;', 'const c = 3;']);
  ({ value, find } = view());
  assert.match(find('_status').text, /^● src\/app\.ts · 3:13 .* Git \+1 ~1 -0$/);
  const document = value.sites.dialog.components[0].children.find(item => item.type === 'document');
  assert.deepEqual(document.lines.map(line => line[1].text), ['  ', '~ ', '+ ', '  ']);
  assert.deepEqual(document.lines[1].slice(2).map(span => span.tone ?? null).filter(Boolean).slice(0, 2), ['accent', 'attention']);
  assert.deepEqual(document.selected, { start: 2, end: 2 });

  keys(key('Ctrl+u'), key('Ctrl+u'), key('Ctrl+u'));
  assert.deepEqual(buffer().lines, ['const a = 1;', 'const b = 2;', 'const c = 3;']);
  assert.doesNotMatch(view().find('_status').text, /●/);
  keys(key('Ctrl+y'), key('Ctrl+y'), key('Ctrl+y'));
  assert.equal(buffer().lines[2], 'const d = 4;');

  keys(key('Ctrl+Home'), key('Ctrl+f'), text('CONST'), key('Enter'));
  assert.match(view().find('_find').text, /Find: CONST▏ · 0 matches/);
  keys(key('Backspace'), key('Backspace'), key('Backspace'), key('Backspace'), key('Backspace'), text('const'), key('Enter'), key('Esc'));
  assert.deepEqual([buffer().row, buffer().col], [1, 0]);
  assert.match(view().find('_find').text, /4 matches/);

  keys(key('Shift+Down'), key('Ctrl+e'));
  assert.deepEqual(calls.filter(item => item.operation === 'composer.write').at(-1).args, { insert: 'src/app.ts:2\n```\nconst b = 2; // two\n```\n' });
  const state = JSON.parse(JSON.stringify(fx.state));
  keys(key('Esc'), key('Ctrl+s'));
  assert.equal(readFileSync(join(repository, 'src/app.ts'), 'utf8'), 'const a = 1;\r\nconst b = 2;\r\nconst c = 3;');
  const committed = fx.state;
  fx.state = state;
  sync();
  assert.deepEqual(calls.filter(item => item.operation === 'events.schedule').at(-1).args, { key: 'hop', delay_ms: 1000 });
  fx.state = committed;
  event('timer', { key: 'hop' });
  assert.equal(readFileSync(join(repository, 'src/app.ts'), 'utf8'), 'const a = 1;\r\nconst b = 2; // two\r\nconst d = 4;\r\nconst c = 3;');
  assert.deepEqual(calls.filter(item => item.operation === 'workspace.transaction').at(-1).args.expected, { 'src/app.ts': original });
  ({ find } = view());
  assert.equal(find('_notice').text, 'Saved src/app.ts');
  assert.deepEqual(find('_git').options.map(option => option.value), ['stage src/app.ts', 'unstage src/app.ts']);
  assert.deepEqual(find('_lsp').options.slice(0, 4).map(option => option.value), ['definition src/app.ts:3:1', 'references src/app.ts:3:1', 'hover src/app.ts:3:1', 'actions src/app.ts:3']);
  assert.deepEqual(find('_lsp').action, { command: 'omd_lsp_view:lsp' });

  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'save');
  assert.match(view().find('_status').text, /Git \+1 ~1 -0$/);
  edit('refresh');
  sync();
  assert.match(view().find('_status').text, /Git \+0 ~0 -0$/);
  keys(key('Ctrl+Home'), key('Delete'), key('Delete'));
  assert.match(view().find('_status').text, /Git \+0 ~1 -0$/);
  keys(key('Shift+Down'), key('Shift+Down'), key('Backspace'));
  assert.deepEqual(buffer().lines, ['const d = 4;', 'const c = 3;']);
  assert.match(view().find('_status').text, /Git \+0 ~0 -1$/);

  ({ find } = view());
  assert.deepEqual(find('_lsp').options.map(option => option.value), ['definition src/app.ts:3:1', 'references src/app.ts:3:1', 'hover src/app.ts:3:1', 'symbols src/app.ts', 'diagnostics src/app.ts']);
  assert.equal(find('_lsp_hint').text, 'Answers use the saved file; save to format or apply code actions');
  keys(text('x'));
  ({ find } = view());
  assert.deepEqual(find('_lsp').options.map(option => option.value), ['symbols src/app.ts', 'diagnostics src/app.ts']);
  assert.equal(find('_lsp_hint').text, 'Answers use the saved file, where this line differs; save to format or apply code actions');
  keys(key('Ctrl+u'));
  edit('src/app.ts:4');
  assert.deepEqual([buffer().row, buffer().lines[buffer().row]], [1, 'const c = 3;']);
  edit('src/app.ts:2');
  assert.equal(buffer().row, 0);
  edit('pane');
  ({ value } = view());
  assert.deepEqual(Object.keys(value.sites), ['omd_editor/editor']);
  assert.equal(value.sites['omd_editor/editor'].components.find(item => item.type === 'document').height, undefined);
  edit('hide');
  assert.deepEqual(view().value, { status: ['edit: 1 unsaved'] });
});

test('editor refuses to overwrite intervening edits and recovers buffers after reloads, denials and restarts', () => {
  const fx = fixture();
  const { repository, calls, host, edit, keys, event, sync, view, key, text, buffer } = fx;
  const disk = () => readFileSync(join(repository, 'notes.txt'), 'utf8');
  const external = (content) => {
    writeFileSync(join(repository, 'notes.txt'), content);
    event('workspace_change', { repository, source: 'external', call_id: null, watch_id: 'w1', changes: [{ path: 'notes.txt', before: null, after: sha(content) }], status: 'observed' });
  };
  assert.match(edit('image.bin').display, /binary file/);
  assert.match(edit('big.txt').display, /118 KB; the editor opens files up to 100 KB/);
  writeFileSync(join(repository, 'long.ts'), `${Array.from({ length: 110 }, (_, index) => index === 99 ? `const s = "${'漢字'.repeat(150)}" + ${'1 + '.repeat(20)}2;` : `let v${index} = "${'x'.repeat(398)}";`).join('\n')}\n`);
  assert.equal(edit('long.ts:100'), null);
  const long = view().value.sites.dialog.components[0].children.find(item => item.type === 'document');
  assert.ok(long.lines[long.selected.start].some(span => span.bg === 7));
  edit('close');
  writeFileSync(join(repository, 'block.ts'), 'let a = 1; /* open\nstill comment\nend */ const b = `x\n${a} y`;\n"""not python"""\n');
  assert.equal(edit('block.ts'), null);
  const painted = view().value.sites.dialog.components[0].children.find(item => item.type === 'document').lines.slice(1).map(line => line.slice(2).map(span => [span.text, span.tone ?? null]));
  assert.deepEqual(painted, [[['still comment', 'muted']], [['end */', 'muted'], [' ', null], ['const', 'accent'], [' b = ', null], ['`x', 'success']],
    [['${a} y`', 'success'], [';', null]], [['"""not python"""', 'success']]]);
  edit('close');
  assert.equal(edit('notes.txt'), null);
  sync();
  assert.match(view().find('_status').text, /Git \+1 ~0 -0$/);
  assert.deepEqual(calls.filter(item => item.operation === 'workspace.watch').at(-1).args, { paths: ['notes.txt'], recursive: false, debounce_ms: 300 });

  external('first\nfrom agent\n');
  assert.deepEqual(buffer().lines, ['first', 'from agent']);
  assert.equal(view().find('_notice').text, 'Reloaded notes.txt: it changed on disk');

  keys(key('Ctrl+End'), text(' mine'));
  external('first\nfrom agent\nexternal\n');
  assert.equal(buffer().conflict, 'notes.txt changed on disk after you opened it');
  assert.deepEqual(view().find('_conflict').options.map(option => option.value), ['review', 'reload', 'keep']);
  keys(key('Ctrl+s'));
  assert.equal(disk(), 'first\nfrom agent\nexternal\n');
  edit('keep');
  edit('save');
  assert.equal(disk(), 'first\nfrom agent\nexternal\n');
  assert.equal(buffer().conflict, 'notes.txt changed on disk; your save was refused');

  edit('review');
  assert.match(view().find('_review').unified, /-from agent\n-external\n\+from agent mine/);
  writeFileSync(join(repository, 'notes.txt'), 'raced\n');
  edit('overwrite');
  assert.equal(disk(), 'raced\n');
  edit('review');
  host.confirm = false;
  edit('overwrite');
  assert.equal(disk(), 'raced\n');
  host.confirm = true;
  edit('overwrite');
  assert.equal(disk(), 'first\nfrom agent mine\n');
  assert.equal(buffer().conflict, null);

  keys(text('!'));
  host.deny = 'workspace_write_denied: notes.txt';
  edit('save');
  assert.equal(view().find('_notice').text, 'Not saved: workspace_write_denied: notes.txt');
  assert.equal(buffer().conflict, null);
  host.deny = null;

  edit('src/app.ts');
  assert.deepEqual(view().find('_buffers').options.map(option => option.label), ['● notes.txt', 'src/app.ts']);
  assert.deepEqual([fx.state.buffers[0].lines, fx.state.buffers[0].parked.chunks], [[], 1]);
  assert.deepEqual(fx.store.get('thread/0:notes.txt').value, 'first\nfrom agent mine!');
  writeFileSync(join(repository, 'notes.txt'), 'changed while closed\n');
  const saved = fx.state;
  fx.state = JSON.parse(JSON.stringify(saved));
  event('start', null);
  assert.equal(fx.state.notice, 'Recovered unsaved buffers: notes.txt');
  assert.equal(fx.state.buffers[0].conflict, 'notes.txt changed on disk after you opened it');
  assert.equal(fx.state.buffers[1].base, undefined);
  sync();
  assert.equal(typeof fx.state.buffers[1].base, 'string');

  edit('buffer 0');
  assert.deepEqual(buffer().lines, ['first', 'from agent mine!']);
  assert.deepEqual(fx.state.buffers[1].lines, []);
  edit('close');
  assert.deepEqual(view().find('_close').options.map(option => option.value), ['save', 'discard', 'cancel']);
  edit('close discard');
  assert.equal(disk(), 'changed while closed\n');
  assert.deepEqual(fx.state.buffers.map(item => item.path), ['src/app.ts']);
  assert.equal(buffer().lines.length, 3);

  writeFileSync(join(repository, 'a.txt'), `${'a'.repeat(99)}\n`.repeat(600));
  writeFileSync(join(repository, 'b.txt'), `${'b'.repeat(99)}\n`.repeat(600));
  edit('a.txt');
  keys(text('!'));
  edit('b.txt:7');
  assert.deepEqual(fx.state.buffers.map(item => [item.path, item.lines.length, item.parked?.chunks ?? null]), [['src/app.ts', 0, 0], ['a.txt', 0, 2], ['b.txt', 0, 0]]);
  assert.equal(view().find('_empty').text, 'Opening b.txt…');
  sync();
  assert.deepEqual([buffer().lines.length, buffer().row], [600, 6]);
  edit('buffer 1');
  assert.deepEqual([buffer().lines[0], buffer().lines.length, view().find('_status').text.startsWith('● a.txt')], [`!${'a'.repeat(99)}`, 600, true]);
});
