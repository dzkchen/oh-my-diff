import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { callback } from '../../../tests/mod_runner.mjs';
import { cut, mention, parseStatus, summary } from './git.ts';

const mod = new URL('./', import.meta.url);
const read = name => readFileSync(new URL(name, mod), 'utf8');
const manifest = JSON.parse(read('mod.json'));
const source = read('index.ts');
const assets = Object.fromEntries(manifest.assets.map(name => [name, { text: read(name), sha256: '0'.repeat(64) }]));
const TOP = '/repo';
const SITE = 'omd_git/main';
const STATUS = ['# branch.oid abc', '# branch.head main', '1 .M N... 100644 100644 100644 a a src/a.ts', '1 M. N... 100644 100644 100644 b b b.ts', '? new.txt', ''].join('\0');
const DIFF = 'diff --git a/src/a.ts b/src/a.ts\nindex 1..2 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n@@ -9,1 +9,1 @@\n-x\n+y\n';
const REJECTED = ' ! [rejected]        main -> main (non-fast-forward)\nerror: failed to push some refs\nhint: Updates were rejected because the tip of your current branch is behind';

function run(event, payload, { state = null, name, world = {} } = {}) {
  const calls = [];
  const host = ({ operation, arguments: args }) => {
    calls.push({ operation, arguments: args });
    if (operation === 'exec.run') {
      if (world.noGit) throw new Error('exec_program_unavailable: git');
      if (args.argv[0] === 'rev-parse') return world.missing ? { exit_code: 128, stdout: '', stderr: 'fatal: not a git repository' } : { exit_code: 0, stdout: `${TOP}\n${TOP}/.git\n`, stderr: '' };
      const argv = args.argv.slice(args.argv.indexOf('color.ui=false') + 1);
      const ok = (stdout = '') => ({ exit_code: 0, stdout, stderr: '' });
      const failed = stderr => ({ exit_code: 1, stdout: '', stderr });
      if (argv.includes('grep')) return world.rebasing ? ok('rebase-merge/head-name\n') : world.op ? ok(`${world.op}\n`) : failed('');
      if (argv[1] === 'status') return ok(world.status ?? STATUS);
      if (argv[1] === 'diff') return ok(argv.includes('--cached') ? '' : world.diff ?? DIFF);
      if (argv[1] === 'log') return ok(argv.includes('--graph') ? '* abc main\n' : 'abc\0First\0Ann\x001700000000\ndef\0Second\0Ann\x001600000000\n');
      if (argv[1] === 'rev-parse' && argv[2] === 'HEAD') return ok(world.moves && world.rebased ? 'other\n' : 'fix\n');
      if (argv.includes('push') && world.auth) return { exit_code: 128, stdout: '', stderr: "fatal: could not read Username for 'https://example.com': terminal prompts disabled" };
      if (argv.includes('push') && world.rejected && !argv.includes('--force-with-lease')) return failed(REJECTED);
      if (argv.includes('rebase') && argv.includes('--abort')) world.rebasing = false;
      else if (argv.includes('rebase') && world.rebaseFails) {
        world.rebasing = world.rebased = true;
        return failed('conflict');
      }
      return ok();
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
  const request = { source, filename: fileURLToPath(new URL('index.ts', mod)), entrypoint: 'index.ts', assets, api: manifest.api, capabilities: manifest.capabilities, state, settings: {}, event, name, payload, hook_budget_ms: 10000 };
  const output = callback(request, host);
  if (output.error) throw new Error(output.error);
  return { value: output.value, state: output.state ?? state, calls };
}
const started = (world) => run('start', null, { world }).state;
const key = (state, name, world) => run('command', `key ${name}`, { state, name: 'git', world });
const draw = (state, site = { columns: 90, rows: 40 }, client = { columns: 260, rows: 40 }) =>
  run('terminal', { event: 'redraw', ledger: { thread_id: 't1', cwd: TOP, cost: null }, client: { ...client, ...(site ? { sites: { [SITE]: site } } : {}) } }, { state }).value;
const gits = calls => calls.filter(call => call.operation === 'exec.run').map(call => call.arguments.argv.slice(call.arguments.argv.indexOf('color.ui=false') + 1).join(' '));
const prompts = calls => calls.filter(call => call.operation === 'terminal.prompt').map(call => call.arguments);
const text = node => node.lines.map(line => line.map(span => span.text).join('')).join('\n');
const find = (view, id) => {
  const walk = nodes => nodes.reduce((found, node) => found ?? (node.id === id ? node : walk(node.children ?? [])), undefined);
  return walk(view.sites[SITE].components);
};
const notice = view => view.sites[SITE].components.at(-1).spans[0].text;
const height = (view, id) => {
  const walk = node => (node.type === 'document' || node.type === 'terminal' ? node.height : 0) + (node.title ? 2 : 0) + (node.children ?? []).reduce((total, child) => total + walk(child), 0);
  return walk(find(view, id));
};

test('porcelain v2 renames and unmerged records keep paths with spaces and unicode, and the old path of a rename', () => {
  const out = ['# branch.head (detached)', '2 R. N... 100644 100644 100644 a b R100 new näme.ts', 'old name.ts', 'u UU N... 100644 100644 100644 100644 a b c conflict – ü.ts', '1 .M N... 100644 100644 100644 a a plain.ts', ''].join('\0');
  const { head, files } = parseStatus(out);
  assert.equal(head.branch, '');
  assert.deepEqual(files, [
    { path: 'new näme.ts', orig: 'old name.ts', kind: '2', x: 'R', y: ' ' },
    { path: 'conflict – ü.ts', kind: 'u', x: 'U', y: 'U' },
    { path: 'plain.ts', kind: '1', x: ' ', y: 'M' },
  ]);
  assert.equal(cut('line\r\n', 100), 'line?');
  assert.equal(cut('crlf\r', 100), 'crlf');
  assert.equal(summary('hint: try again\nerror: failed\nfatal: gone'), 'error: failed fatal: gone hint: try again');
  assert.deepEqual([mention('src/a b.ts'), mention('src/a.ts')], ['@"src/a b.ts" ', '@src/a.ts ']);
});

test('start draws files with the selected diff, side by side once the site has 85 columns', () => {
  const { state, calls } = run('start', null);
  assert.ok(calls.some(call => call.operation === 'mods.service' && call.arguments.method === 'register'));
  assert.ok(calls.filter(call => call.operation === 'exec.run').every(call => call.arguments.sandbox === 'none'));
  assert.ok(gits(calls).filter(argv => /^(--no-optional-locks )?(diff|log|show|stash show)/.test(argv)).every(argv => argv.includes('--no-color')));
  const view = draw(state);
  const [list, main] = [find(view, 'omd_git_list'), find(view, 'omd_git_main')];
  assert.deepEqual([0, 1, 2, 3, 4].map(panel => find(view, `omd_git_side${panel}_box`).title), ['[1] Status', '[2] Files', '[3] Local branches', '[4] Commits', '[5] Stash']);
  assert.deepEqual([find(view, 'omd_git_side1_box').style.border, find(view, 'omd_git_side3_box').style.border], ['thick', 'rounded']);
  assert.match(text(find(view, 'omd_git_side3')), /^ {2}abc First {2}Ann, \d+ years? ago\n {2}def Second {2}Ann, \d+ years? ago$/);
  assert.equal(find(view, 'omd_git_layout').style.direction, 'row');
  assert.equal(find(draw(state, { columns: 84, rows: 40 }), 'omd_git_layout').style, undefined);
  assert.equal(find(draw(state, null), 'omd_git_layout').style.direction, 'row');
  assert.equal(find(draw(state, null, { columns: 109, rows: 40 }), 'omd_git_layout').style, undefined);
  assert.ok(height(draw(state, { columns: 90, rows: 50 }), 'omd_git_sides') + 1 <= 50);
  assert.ok(height(draw(state, { columns: 60, rows: 50 }), 'omd_git_layout') + 1 <= 50);
  assert.match(notice(view), /^Stage: Space \| All: a/);
  assert.equal(text(list), '▶  M src/a.ts\n  M  b.ts\n  ?? new.txt');
  assert.match(text(main), /^diff --git a\/src\/a.ts/);
  assert.equal(main.lines.find(line => line[0].text === '+new')[0].tone, 'success');
  const keys = view.key_contexts[0];
  assert.deepEqual(keys.when, { focus: SITE });
  assert.ok(['j', 'k', '1', '5', 'Space', 'Enter', 'c', 'P', 'p', '@', 'R'].every(name => keys.keys[name]));
  assert.ok(Object.keys(keys.keys).length <= 32);
  assert.equal(run('terminal', { event: 'redraw', ledger: null }, { state: { ...state, placed: false } }).value, null);
});

test('outside a repository or without git the panel says so, keeps R, and R detects a repository made since', () => {
  const missing = started({ missing: true });
  const view = draw(missing);
  assert.equal(view.sites[SITE].components[0].spans[0].text, 'Not a Git repository');
  assert.deepEqual(Object.keys(view.key_contexts[0].keys), ['R']);
  assert.equal(run('command', '', { state: missing, name: 'git', world: { missing: true } }).value.display, 'Not a Git repository');
  const found = key(missing, 'R');
  assert.equal(text(find(draw(found.state), 'omd_git_list')), '▶  M src/a.ts\n  M  b.ts\n  ?? new.txt');
  assert.equal(draw(started({ noGit: true })).sites[SITE].components[0].spans[0].text, 'git not found on PATH');
  const display = run('command', '', { state: null, name: 'git' }).value.display;
  assert.match(display, /^Git panel: main in \/repo, 3 changed/);
});

test('moving loads that file, Space stages it, discarding needs a confirmation and a clean tree has nothing to stage', () => {
  let state = started();
  const moved = key(state, 'j');
  state = moved.state;
  assert.ok(gits(moved.calls).includes('--no-optional-locks diff --no-color --no-ext-diff --no-textconv --src-prefix=a/ --dst-prefix=b/ HEAD -- b.ts'));
  assert.ok(!gits(moved.calls).some(argv => argv.includes('status')));
  const staged = key(state, 'Space');
  assert.ok(gits(staged.calls).includes('reset -q -- b.ts'));
  assert.ok(gits(staged.calls).some(argv => argv.includes('status')));
  const declined = key(state, 'd');
  assert.equal(prompts(declined.calls)[0].kind, 'confirm');
  assert.ok(!gits(declined.calls).some(argv => argv.includes('status')));
  const discarded = key(state, 'd', { answer: '' });
  assert.ok(gits(discarded.calls).includes('checkout HEAD -- b.ts'));
  const untracked = key(key(state, 'j').state, 'd');
  assert.equal(prompts(untracked.calls)[0].message, 'Delete untracked new.txt?');
  const clean = started({ status: '# branch.head main\0' });
  assert.equal(notice(draw(key(clean, 'a', { status: '# branch.head main\0' }).state)), 'Nothing to stage');
});

test('discarding a staged rename restores the old path and removes the new one', () => {
  const world = { status: ['# branch.head main', '2 R. N... 100644 100644 100644 a b R100 new name.ts', 'old name.ts', ''].join('\0'), answer: '' };
  const discarded = key(started(world), 'd', world);
  assert.ok(gits(discarded.calls).includes('restore --staged --worktree --source=HEAD -- old name.ts new name.ts'));
});

test('Enter lists the hunks, Space stages one through git apply, @ adds it to the prompt and Esc goes back', () => {
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
  const escaped = run('component_event', { component: 'omd_git_list', thread_id: 't1', kind: 'input', events: [{ key: 'Esc', text: null }] }, { state: second });
  assert.equal(find(draw(escaped.state), 'omd_git_side1_box').title, '[2] Files');
  assert.match(text(find(draw(escaped.state), 'omd_git_main')), /^diff --git/);
});

test('Enter on a binary file says Space stages it whole', () => {
  const world = { diff: 'diff --git a/src/a.ts b/src/a.ts\nindex 1..2 100644\nBinary files a/src/a.ts and b/src/a.ts differ\n' };
  const entered = key(started(world), 'Enter', world);
  assert.equal(notice(draw(entered.state)), 'A binary file has no text hunks: Space stages it whole');
  assert.equal(find(draw(entered.state), 'omd_git_side1_box').title, '[2] Files');
});

test('@ on a file inserts a mention relative to the working directory, quoted when it has a space', () => {
  const world = { cwd: `${TOP}/src` };
  const attached = key(started(world), '@', world);
  assert.equal(attached.calls.find(call => call.operation === 'composer.write').arguments.edit.text, '@a.ts ');
  const spaced = { status: '# branch.head main\x001 .M N... 100644 100644 100644 a a my file.ts\0' };
  assert.equal(key(started(spaced), '@', spaced).calls.find(call => call.operation === 'composer.write').arguments.edit.text, '@"my file.ts" ');
});

test('rewording an older commit rebases onto its parent, aborts only its own rebase and refuses during another', () => {
  const commits = key(started(), '4').state;
  const older = key(commits, 'j').state;
  const reworded = key(older, 'r', { answer: "It's new" });
  const rebase = gits(reworded.calls).find(argv => argv.includes('rebase -i'));
  assert.match(rebase, /rebase\.abbreviateCommands=false .* rebase -i --autostash --no-autosquash def\^$/);
  assert.ok(!gits(reworded.calls).includes('rebase --abort'));
  const failed = key(older, 'r', { answer: 'x', rebaseFails: true });
  assert.ok(gits(failed.calls).includes('rebase --abort'));
  const busy = key(older, 'r', { answer: 'x', op: 'MERGE_HEAD' });
  assert.ok(!gits(busy.calls).some(argv => argv.includes('rebase -i')));
  assert.equal(notice(draw(busy.state)), 'A merge is in progress: finish it first (m)');
  const head = key(commits, 'r', { answer: 'Top' });
  assert.ok(gits(head.calls).includes('commit --amend --only -m Top'));
});

test('amending an older commit undoes its fixup commit only while HEAD is still that commit', () => {
  const older = key(key(started(), '4').state, 'j').state;
  const failed = key(older, 'A', { answer: '', rebaseFails: true });
  assert.ok(gits(failed.calls).some(argv => argv.includes('--autosquash')));
  assert.ok(gits(failed.calls).includes('reset -q --soft HEAD~1'));
  const moved = key(older, 'A', { answer: '', rebaseFails: true, moves: true });
  assert.ok(!gits(moved.calls).includes('reset -q --soft HEAD~1'));
  const busy = key(older, 'A', { answer: '', rebasing: true });
  assert.ok(!gits(busy.calls).some(argv => argv.startsWith('commit')));
});

test('a rebase in progress shows in Status, m continues or aborts it, and Space marks a conflict resolved', () => {
  const world = { rebasing: true, status: '# branch.head (detached)\0u UU N... 100644 100644 100644 100644 a b c both.ts\0' };
  const state = started(world);
  const view = draw(state);
  assert.match(text(find(view, 'omd_git_side0')), /HEAD \(detached\) \(Rebasing\)$/);
  assert.match(notice(view), /^Rebasing: continue or abort with m/);
  const continued = key(state, 'm', { ...world, answer: 'continue' });
  assert.equal(prompts(continued.calls)[0].kind, 'choice');
  assert.ok(gits(continued.calls).includes('-c core.editor=true rebase --continue'));
  assert.ok(gits(key(state, 'm', { ...world, answer: 'abort' }).calls).includes('-c core.editor=true rebase --abort'));
  const resolved = key(state, 'Space', { ...world, answer: '' });
  assert.equal(prompts(resolved.calls)[0].message, 'Mark both.ts as resolved?');
  assert.ok(gits(resolved.calls).includes('add -- both.ts'));
  assert.equal(notice(draw(key(state, 'P', world).state)), 'HEAD is detached: check out a branch to push it');
});

test('push asks first, tracks origin without an upstream and offers a force push with lease once rejected', () => {
  const state = started();
  assert.ok(!gits(key(state, 'P').calls).some(argv => argv.startsWith('push')));
  const pushed = key(state, 'P', { answer: '' });
  const call = pushed.calls.find(item => item.operation === 'exec.run' && item.arguments.argv.includes('push'));
  assert.deepEqual(call.arguments.argv.slice(-4), ['push', '-u', 'origin', 'main']);
  assert.equal(call.arguments.timeout_ms, 120_000);
  const forced = key(state, 'P', { answer: '', rejected: true });
  assert.equal(prompts(forced.calls)[1].title, 'Force push');
  assert.ok(gits(forced.calls).includes('push --force-with-lease -u origin main'));
  assert.equal(notice(draw(forced.state)), 'Force pushed');
});

test('a push that needs a password reruns in a terminal pane after asking, and R returns once git exits', () => {
  const state = started();
  const world = { answer: '', auth: true };
  const pushed = key(state, 'P', world);
  const start = pushed.calls.find(call => call.operation === 'terminal.pty' && call.arguments.action === 'start').arguments;
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

test('a watch event right after the panel’s own write is skipped once, and nothing refreshes while unplaced', () => {
  const staged = key(started(), 'Space').state;
  const echo = run('workspace_change', { repository: TOP, source: 'external', call_id: null, changes: [], status: 'observed' }, { state: staged });
  assert.deepEqual(gits(echo.calls), []);
  const next = run('workspace_change', { repository: TOP, source: 'external', call_id: null, changes: [], status: 'observed' }, { state: echo.state });
  assert.ok(gits(next.calls).some(argv => argv.includes('status')));
  const unplaced = run('workspace_change', { repository: TOP, source: 'tool', call_id: 'c', changes: [], status: 'observed' }, { state: { ...staged, placed: false } });
  assert.deepEqual(unplaced.calls, []);
});

test('a large status and diff stay inside the 64 KiB view patch and the saved state stays small', () => {
  const world = {
    status: ['# branch.head main', ...Array.from({ length: 400 }, (_, index) => `1 .M N... 100644 100644 100644 a a src/${'deep/'.repeat(8)}file-${index}.ts`), ''].join('\0'),
    diff: `diff --git a/x b/x\n@@ -1 +1 @@\n${Array.from({ length: 3000 }, (_, index) => `+${'"\\'.repeat(60)}${index}`).join('\n')}\n`,
  };
  const state = started(world);
  const view = draw(state);
  const [list, main] = [find(view, 'omd_git_list'), find(view, 'omd_git_main')];
  assert.equal(list.lines.length, 80);
  assert.ok(main.lines.length > 20);
  assert.ok(new TextEncoder().encode(JSON.stringify(view)).length <= 65_536);
  assert.ok(new TextEncoder().encode(JSON.stringify(state)).length <= 65_536);
});

test('pathspecs are literal, a stash may have no message and an untracked file has no hunk mode', () => {
  const state = started();
  const discarded = key(state, 'd', { answer: '' });
  assert.ok(discarded.calls.filter(call => call.operation === 'exec.run' && call.arguments.argv[0] === '--no-pager').every(call => call.arguments.argv[1] === '--literal-pathspecs'));
  assert.ok(gits(key(state, 's', { answer: '' }).calls).includes('stash push --include-untracked -- .'));
  const third = key(key(state, 'j').state, 'j').state;
  const entered = key(third, 'Enter');
  assert.ok(!gits(entered.calls).some(argv => argv.startsWith('add')));
  assert.match(notice(draw(entered.state)), /untracked file has no hunks/);
});
