import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { callback } from '../../../tests/mod_runner.mjs';

const mod = new URL('./', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('mod.json', mod), 'utf8'));
const source = readFileSync(new URL('index.ts', mod), 'utf8');
const TOP = '/repo';
const STATUS = ['# branch.oid abc', '# branch.head main', '1 .M N... 100644 100644 100644 a a src/a.ts', '1 M. N... 100644 100644 100644 b b b.ts', '? new.txt', ''].join('\0');
const DIFF = 'diff --git a/src/a.ts b/src/a.ts\nindex 1..2 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n@@ -9,1 +9,1 @@\n-x\n+y\n';

function run(event, payload, { state = null, name, world = {} } = {}) {
  const calls = [];
  const host = ({ operation, arguments: args }) => {
    calls.push({ operation, arguments: args });
    if (operation === 'exec.run') {
      const argv = args.argv.slice(args.argv.indexOf('color.ui=false') + 1);
      if (args.argv[0] === 'rev-parse') return { exit_code: 0, stdout: `${TOP}\n`, stderr: '' };
      if (argv[1] === 'status') return { exit_code: 0, stdout: world.status ?? STATUS, stderr: '' };
      if (argv[1] === 'diff') return { exit_code: 0, stdout: argv.includes('--cached') ? '' : world.diff ?? DIFF, stderr: '' };
      if (argv[1] === 'log') return { exit_code: 0, stdout: argv.includes('--graph') ? '* abc main\n' : 'abc\0First\0Ann\x001700000000\ndef\0Second\0Ann\x001600000000\n', stderr: '' };
      if (argv.includes('push') && world.auth) return { exit_code: 128, stdout: '', stderr: "fatal: could not read Username for 'https://example.com': terminal prompts disabled" };
      if (argv[0] === 'rebase' || argv.includes('rebase')) return { exit_code: world.rebaseFails ? 1 : 0, stdout: '', stderr: world.rebaseFails ? 'conflict' : '' };
      return { exit_code: 0, stdout: '', stderr: '' };
    }
    if (operation === 'mods.service') return args.method === 'panels' ? { panels: [{ id: 'git' }] } : { registered: 'git' };
    if (operation === 'workspace.watch') return { watch_id: 'w1' };
    if (operation === 'session.info') return { thread_id: 't1', cwd: world.cwd ?? TOP, root: TOP };
    if (operation === 'terminal.prompt') return world.answer === undefined ? { status: 'declined' } : { status: 'accepted', value: world.answer };
    if (operation === 'terminal.pty') return args.action === 'start' ? { session: 'signin', running: true } : args.action === 'read' ? { text: world.exited ? 'Username: u\nfatal: Authentication failed\n' : '', running: !world.exited, exit_code: world.exited ? 128 : null } : { stopped: true };
    if (operation === 'composer.read') return { text: '', cursor: 0, selection: null, revision: 3, attachments: [], suggestion: null };
    if (operation === 'composer.write') return { text: args.edit.text, cursor: 0, revision: 4 };
    throw new Error(`unexpected host operation ${operation}`);
  };
  const request = { source, filename: fileURLToPath(new URL('index.ts', mod)), entrypoint: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, state, settings: {}, event, name, payload, hook_budget_ms: 10000 };
  const output = callback(request, host);
  if (output.error) throw new Error(output.error);
  return { value: output.value, state: output.state ?? state, calls };
}
const started = (world) => run('start', null, { world }).state;
const key = (state, name, world) => run('command', `key ${name}`, { state, name: 'git', world });
const draw = (state, columns = 260, rows = 40) => run('terminal', { event: 'redraw', ledger: { thread_id: 't1', cwd: TOP, cost: null }, client: { columns, rows } }, { state }).value;
const gits = calls => calls.filter(call => call.operation === 'exec.run').map(call => call.arguments.argv.slice(call.arguments.argv.indexOf('color.ui=false') + 1).join(' '));
const text = node => node.lines.map(line => line.map(span => span.text).join('')).join('\n');
const find = (view, id) => {
  const walk = nodes => nodes.reduce((found, node) => found ?? (node.id === id ? node : walk(node.children ?? [])), undefined);
  return walk(view.sites['omd_git/main'].components);
};
const notice = view => view.sites['omd_git/main'].components.at(-1).spans[0].text;

test('start registers the panel, watches the repository and draws files with the selected diff', () => {
  const { state, calls } = run('start', null);
  assert.deepEqual(calls.find(call => call.operation === 'mods.service').arguments, { name: 'omd.workspace', method: 'register', input: { id: 'git', title: 'Git', site: 'omd_git/main', order: 10 } });
  assert.deepEqual(calls.find(call => call.operation === 'workspace.watch').arguments, { paths: ['.'], key: 'omd_git', debounce_ms: 300, git: true });
  assert.ok(calls.filter(call => call.operation === 'exec.run').every(call => call.arguments.sandbox === 'none'));
  const view = draw(state);
  const [list, main] = [find(view, 'omd_git_list'), find(view, 'omd_git_main')];
  assert.deepEqual([0, 1, 2, 3, 4].map(panel => find(view, `omd_git_side${panel}_box`).title), ['[1] Status', '[2] Files', '[3] Local branches', '[4] Commits', '[5] Stash']);
  assert.deepEqual([find(view, 'omd_git_side1_box').style.border, find(view, 'omd_git_side3_box').style.border], ['thick', 'rounded']);
  assert.match(text(find(view, 'omd_git_side3')), /^ {2}abc First {2}Ann, \d+ years? ago\n {2}def Second {2}Ann, \d+ years? ago$/);
  assert.equal(find(view, 'omd_git_layout').style.direction, 'row');
  assert.equal(find(draw(state, 109), 'omd_git_layout').style, undefined);
  assert.ok([260, 109].every(columns => find(draw(state, columns, 90), 'omd_git_main').height <= 40));
  assert.match(notice(view), /^Stage: Space \| All: a/);
  assert.equal(text(list), '▶  M src/a.ts\n  M  b.ts\n  ?? new.txt');
  assert.match(text(main), /^diff --git a\/src\/a.ts/);
  assert.equal(main.lines.find(line => line[0].text === '+new')[0].tone, 'success');
  const keys = view.key_contexts[0];
  assert.deepEqual(keys.when, { focus: 'omd_git/main' });
  assert.ok(['j', 'k', '1', '5', 'Space', 'Enter', 'c', 'P', 'p', '@'].every(name => keys.keys[name]));
  assert.ok(Object.keys(keys.keys).length <= 32);
  assert.equal(run('terminal', { event: 'redraw', ledger: null }, { state: { ...state, placed: false } }).value, null);
});

test('moving loads that file, Space stages it and discarding needs a confirmation', () => {
  let state = started();
  const moved = key(state, 'j');
  state = moved.state;
  assert.ok(gits(moved.calls).includes('--no-optional-locks diff --no-ext-diff --no-textconv --src-prefix=a/ --dst-prefix=b/ HEAD -- b.ts'));
  const staged = key(state, 'Space');
  assert.ok(gits(staged.calls).includes('reset -q -- b.ts'));
  assert.ok(gits(staged.calls).some(argv => argv.includes('status')));
  const declined = key(state, 'd');
  assert.equal(declined.calls.find(call => call.operation === 'terminal.prompt').arguments.kind, 'confirm');
  assert.ok(!gits(declined.calls).some(argv => argv.startsWith('checkout')));
  const discarded = key(state, 'd', { answer: '' });
  assert.ok(gits(discarded.calls).includes('checkout HEAD -- b.ts'));
});

test('Enter lists the hunks, Space stages one through git apply and @ adds it to the prompt', () => {
  const opened = key(started(), 'Enter');
  const list = find(draw(opened.state), 'omd_git_list');
  assert.equal(text(list), '▶ unstaged @@ -1,2 +1,2 @@\n  unstaged @@ -9,1 +9,1 @@');
  const second = key(opened.state, 'j').state;
  const applied = key(second, 'Space');
  const apply = applied.calls.find(call => call.operation === 'exec.run' && call.arguments.argv.includes('apply'));
  assert.deepEqual(apply.arguments.argv.slice(-2), ['--cached', '-']);
  assert.equal(apply.arguments.stdin, 'diff --git a/src/a.ts b/src/a.ts\nindex 1..2 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -9,1 +9,1 @@\n-x\n+y\n');
  const attached = key(second, '@');
  assert.match(attached.calls.find(call => call.operation === 'composer.write').arguments.edit.text, /^\n```diff\n.*@@ -9,1 \+9,1 @@\n-x\n\+y\n```\n$/s);
  assert.equal(find(draw(key(second, 'Enter').state), 'omd_git_side1_box').title, '[2] Files');
});

test('@ on a file inserts a mention relative to the working directory', () => {
  const world = { cwd: `${TOP}/src` };
  const attached = key(started(world), '@', world);
  assert.equal(attached.calls.find(call => call.operation === 'composer.write').arguments.edit.text, '@a.ts ');
});

test('rewording an older commit rebases with a scripted editor and aborts on failure', () => {
  const commits = key(started(), '4').state;
  const older = key(commits, 'j').state;
  const reworded = key(older, 'r', { answer: "It's new" });
  const rebase = gits(reworded.calls).find(argv => argv.includes('rebase'));
  assert.match(rebase, /sequence\.editor=sh -c 'sed "1s\/\^pick \/reword \/" "\$1" > "\$1\.omd" && mv "\$1\.omd" "\$1"' sh/);
  assert.match(rebase, /core\.editor=sh -c 'printf "%s\\n" "\$0" > "\$1"' 'It'\\''s new' rebase -i --autostash --autosquash def\^$/);
  const failed = key(older, 'r', { answer: 'x', rebaseFails: true });
  assert.ok(gits(failed.calls).includes('rebase --abort'));
  const head = key(commits, 'r', { answer: 'Top' });
  assert.ok(gits(head.calls).includes('commit --amend --only -m Top'));
});

test('push asks first and tracks origin when the branch has no upstream', () => {
  const state = started();
  assert.ok(!gits(key(state, 'P').calls).some(argv => argv.startsWith('push')));
  const pushed = key(state, 'P', { answer: '' });
  const call = pushed.calls.find(item => item.operation === 'exec.run' && item.arguments.argv.includes('push'));
  assert.deepEqual(call.arguments.argv.slice(-4), ['push', '-u', 'origin', 'main']);
  assert.equal(call.arguments.timeout_ms, 120_000);
});

test('a push that needs a password reruns in a terminal pane after asking, and R returns once git exits', () => {
  const state = started();
  const world = { answer: '', auth: true };
  const pushed = key(state, 'P', world);
  const start =pushed.calls.find(call => call.operation === 'terminal.pty' && call.arguments.action === 'start').arguments;
  assert.deepEqual(start, { action: 'start', session: 'signin', program: 'git', argv: ['-C', TOP, 'push', '-u', 'origin', 'main'], sandbox: 'none' });
  assert.match(notice(draw(pushed.state)), /^Answer git in the terminal below/);
  assert.deepEqual(find(draw(pushed.state), 'omd_git_signin'), { type: 'terminal', id: 'omd_git_signin', label: 'Sign in', session: 'signin', height: 10 });
  assert.deepEqual(draw(pushed.state).key_contexts[0].keys.i.action, { focus: 'omd_git_signin' });
  const done = key(pushed.state, 'R', { exited: true });
  assert.equal(notice(draw(done.state)), 'git exited with 128: fatal: Authentication failed');
  assert.ok(done.calls.some(call => call.operation === 'terminal.pty' && call.arguments.action === 'stop'));
  assert.ok(find(draw(done.state), 'omd_git_main'));
  assert.ok(!key(state, 'P', { answer: '' }).calls.some(call => call.operation === 'terminal.pty'));
});

test('a large status and diff stay inside the 64 KiB view patch', () => {
  const world = {
    status: ['# branch.head main', ...Array.from({ length: 400 }, (_, index) => `1 .M N... 100644 100644 100644 a a src/${'deep/'.repeat(8)}file-${index}.ts`), ''].join('\0'),
    diff: `diff --git a/x b/x\n@@ -1 +1 @@\n${Array.from({ length: 3000 }, (_, index) => `+${'"\\'.repeat(60)}${index}`).join('\n')}\n`,
  };
  const view = draw(started(world));
  const [list, main] = [find(view, 'omd_git_list'), find(view, 'omd_git_main')];
  assert.equal(list.lines.length, 80);
  assert.ok(main.lines.length > 20);
  assert.ok(new TextEncoder().encode(JSON.stringify(view)).length <= 65_536);
});

test('pathspecs are literal and an untracked file has no hunk mode', () => {
  const state = started();
  const discarded = key(state, 'd', { answer: '' });
  assert.ok(discarded.calls.filter(call => call.operation === 'exec.run' && call.arguments.argv[0] === '--no-pager').every(call => call.arguments.argv[1] === '--literal-pathspecs'));
  assert.ok(gits(key(state, 's', { answer: 'wip' }).calls).includes('stash push --include-untracked -m wip -- .'));
  const third = key(key(state, 'j').state, 'j').state;
  const entered = key(third, 'Enter');
  assert.ok(!gits(entered.calls).some(argv => argv.startsWith('add')));
  assert.match(notice(draw(entered.state)), /untracked file has no hunks/);
});
