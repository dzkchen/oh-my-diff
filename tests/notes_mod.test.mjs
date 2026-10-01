import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const runner = readFileSync(new URL('../runtime/omd/src/mods/runner.mjs', import.meta.url), 'utf8');
const mod = new URL('../mods/first-party/omd_notes/', import.meta.url);
const source = readFileSync(new URL('index.ts', mod), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('mod.json', mod), 'utf8'));
const surface = { events: { terminal: 'terminal', channel: 'events', timer: 'events', resume: 'lifecycle', completion: 'composer' }, replacements: ['completion'], middleware: [], state: 'store', contracts: 'contracts' };
const sha = data => createHash('sha256').update(data).digest('hex');

test('notes vaults link, search, track tasks and write only through checked, confirmed changes', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'omd-notes-')));
  const repository = join(root, 'repo');
  const personal = join(root, 'personal');
  mkdirSync(join(repository, 'src'), { recursive: true });
  mkdirSync(personal);
  writeFileSync(join(repository, 'src/app.ts'), 'one\ntwo\nthree\n');
  const vault = join(repository, '.omd/notes');
  const answers = [];
  const calls = [];
  const confirms = [];
  const walk = dir => readdirSync(join(repository, dir), { withFileTypes: true }).flatMap(entry => {
    const path = `${dir}/${entry.name}`;
    return [{ path, kind: entry.isDirectory() ? 'dir' : 'file', size: 0, mtime_ms: 0 }, ...(entry.isDirectory() ? walk(path) : [])];
  });
  const run = (program, argv, stdin) => spawnSync(program, argv, { cwd: repository, input: stdin, encoding: 'utf8' });
  const host = (operation, args) => {
    calls.push({ operation, args });
    switch (operation) {
      case 'exec.run': {
        for (const guard of args.guards ?? []) if (sha(run(guard.program, guard.argv).stdout) !== guard.stdout_sha256) throw new Error('exec_guard_changed');
        const result = run(args.program, args.argv, args.stdin);
        return { exit_code: result.status, stdout: result.stdout, stderr: result.stderr, stdout_sha256: sha(result.stdout) };
      }
      case 'workspace.list':
        if (!existsSync(join(repository, args.path))) throw new Error('workspace_path_missing');
        return { entries: walk(args.path), truncated: false };
      case 'workspace.transaction':
        for (const [path, expected] of Object.entries(args.expected)) {
          const current = existsSync(join(repository, path)) ? sha(readFileSync(join(repository, path))) : null;
          if (current !== expected) throw new Error('workspace_transaction_stale');
        }
        for (const { old, new: next } of args.renames ?? []) renameSync(join(repository, old), join(repository, next));
        for (const [path, text] of Object.entries(args.writes ?? {})) writeFileSync(join(repository, path), text);
        return { files: {}, backup: null };
      case 'terminal.prompt':
        confirms.push(args);
        return args.kind === 'text' ? { status: 'accepted', value: answers.shift() } : { status: 'accepted' };
      case 'store.get': return calls.some(call => call.operation === 'store.put') ? { value: null, revision: 1, provenance: { thread_id: 'thread-1' } } : null;
      case 'store.put': return { revision: 1 };
      case 'app.request': return { data: [{ items: [{ type: 'agentMessage', text: 'The fix is in **app.ts**.' }] }] };
      default: return { delivered: 1, dropped: 0 };
    }
  };
  const invoke = (state, event, payload, name, settings = { personal }) => {
    const receipts = [];
    for (;;) {
      const request = { source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, state, settings, event, name, payload, receipts, surface, hook_budget_ms: 10000 };
      const output = JSON.parse(spawnSync(process.execPath, ['--no-warnings', '--experimental-vm-modules', '--input-type=module', '--eval', runner],
        { input: JSON.stringify(request), encoding: 'utf8', timeout: 20000 }).stdout);
      if (output.error) throw new Error(output.error);
      if (!output.host_call) return output;
      try {
        receipts.push({ call: output.host_call, value: host(output.host_call.operation, output.host_call.arguments) });
      } catch (error) {
        receipts.push({ call: output.host_call, error: error.message });
      }
    }
  };
  let state = null;
  const note = text => {
    const output = invoke(state, 'command', text, 'note');
    state = output.state;
    return output.value;
  };
  const items = () => state.list.items.map(item => item.label);
  try {
    note('new Alpha');
    assert.equal(readFileSync(join(vault, 'Alpha.md'), 'utf8'), '# Alpha\n\n');
    writeFileSync(join(vault, 'Beta.md'), '# Beta\n\nSee [[Alpha|the first]] and [[Gamma]]. #idea\n- [ ] ship it\n- [x] plan it\n');
    note('open Alpha');
    assert.deepEqual(state.note.backlinks, [{ label: '← Beta:3 See [[Alpha|the first]] and [[Gamma]]. #idea', value: 'open project:Beta.md:3' }]);
    note('open Beta');
    assert.deepEqual(state.note.links, [{ label: '→ Alpha', value: 'open project:Alpha.md' }, { label: '→ Gamma (missing; Enter creates it)', value: 'new Gamma' }]);
    assert.deepEqual(state.note.tags, ['idea']);
    note('tasks');
    assert.deepEqual(items(), ['☐ Beta: ship it', '☑ Beta: plan it']);
    note('task project:Beta.md:4');
    assert.match(readFileSync(join(vault, 'Beta.md'), 'utf8'), /- \[x\] ship it/);
    note('tags');
    assert.deepEqual(items(), ['#idea (1)']);
    note('search first');
    assert.deepEqual(items(), ['Beta:3 See [[Alpha|the first]] and [[Gamma]]. #idea']);

    note('open Beta');
    writeFileSync(join(vault, 'Beta.md'), `${readFileSync(join(vault, 'Beta.md'), 'utf8')}external line\n`);
    const polled = invoke(state, 'timer', { key: 'poll' });
    state = polled.state;
    assert.match(state.note.text, /external line/);
    assert.deepEqual(calls.at(-1).args, { key: 'poll', delay_ms: 2000 });
    writeFileSync(join(vault, 'Beta.md'), `${readFileSync(join(vault, 'Beta.md'), 'utf8')}second external\n`);
    assert.equal(note('append mine').display, 'the note changed outside this view; it was reloaded, retry the edit');
    note('append mine');
    assert.match(readFileSync(join(vault, 'Beta.md'), 'utf8'), /external line\nsecond external\nmine\n$/);

    note('open Alpha');
    note('rename Omega');
    assert.equal(existsSync(join(vault, 'Omega.md')), true);
    assert.match(readFileSync(join(vault, 'Beta.md'), 'utf8'), /\[\[Omega\|the first\]\]/);
    assert.match(confirms.at(-1).message, /Alpha → Omega\nUpdates links in 1 notes/);

    answers.push('Snippet');
    note('from src/app.ts:2-3');
    assert.equal(readFileSync(join(vault, 'Snippet.md'), 'utf8'), '# Snippet\n\nSource: `src/app.ts:2-3`\n\n```\ntwo\nthree\n```\n');
    answers.push('Answer');
    note('response');
    assert.equal(readFileSync(join(vault, 'Answer.md'), 'utf8'), '# Answer\n\nThe fix is in **app.ts**.\n');

    note('new --personal Private');
    assert.equal(readFileSync(join(personal, 'Private.md'), 'utf8'), '# Private\n\n');
    note('');
    assert.deepEqual(items(), ['◇ Answer', '◇ Beta', '◇ Omega', '◆ Private', '◇ Snippet']);

    const completion = invoke(state, 'completion', { kind: 'argument', command: 'note', query: 'om', line: 'open om' }).value;
    assert.deepEqual(completion, { items: [{ insert: 'Omega' }] });
    const view = invoke(state, 'terminal', { event: 'redraw', ledger: null }).value;
    assert.equal(view.keybindings['Alt+n'].command, 'omd_notes:note');
    assert.deepEqual(view.sites['omd_notes/notes'].components[2].rows.map(row => row.value).slice(0, 2), ['open project:Answer.md', 'open project:Beta.md']);

    const agent = invoke(state, 'tool', { title: 'Beta', content: 'from the agent', mode: 'append' }, 'write', { personal, agent: true });
    assert.equal(agent.value, 'Saved Beta');
    assert.match(confirms.at(-1).title, /Agent wants to append note Beta/);
    assert.match(readFileSync(join(vault, 'Beta.md'), 'utf8'), /from the agent\n$/);
    assert.equal(statSync(join(vault, 'Beta.md')).isFile(), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
