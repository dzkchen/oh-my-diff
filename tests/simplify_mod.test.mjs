import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const runner = readFileSync(new URL('../runtime/omd/src/mods/runner.mjs', import.meta.url), 'utf8');
const component = new URL('../plugins/bundled/oh-my-diff/plugins/omd-review-policy/mod/', import.meta.url);
const source = readFileSync(new URL('index.ts', component), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('mod.json', component), 'utf8'));
const surface = { events: {}, replacements: [], middleware: [], state: 'store', contracts: 'contracts' };

function simplify(repository, text) {
  const receipts = [];
  for (;;) {
    const request = { source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, state: null, settings: {},
      event: 'command', name: 'simplify', payload: text, receipts, surface, hook_budget_ms: 5000 };
    const output = JSON.parse(spawnSync(process.execPath, ['--no-warnings', '--experimental-vm-modules', '--input-type=module', '--eval', runner],
      { input: JSON.stringify(request), encoding: 'utf8', timeout: 10000 }).stdout);
    if (output.error) throw new Error(output.error);
    if (!output.host_call) return output.value;
    const { program, argv } = output.host_call.arguments;
    const run = spawnSync(program, argv, { cwd: repository, encoding: 'utf8' });
    receipts.push({ call: output.host_call, value: { exit_code: run.status, stdout: run.stdout, stderr: run.stderr, stdout_preview_truncated: false } });
  }
}

test('simplify scopes changed lines for uncommitted, staged, branch and named-file selections', () => {
  const repository = mkdtempSync(join(tmpdir(), 'omd-simplify-'));
  const git = (...args) => assert.equal(spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@localhost', ...args], { cwd: repository }).status, 0);
  const lines = prefix => Array.from({ length: 10 }, (_, index) => `${prefix}${index + 1}`).join('\n') + '\n';
  try {
    git('init', '-q', '-b', 'main');
    for (const name of ['keep', 'edit', 'gone', 'move']) writeFileSync(join(repository, `${name}.txt`), lines(name));
    git('add', '.');
    git('commit', '-qm', 'base');
    git('checkout', '-qb', 'feature');
    writeFileSync(join(repository, 'keep.txt'), lines('keep').replace('keep4', 'branch4'));
    git('commit', '-qam', 'branch');
    writeFileSync(join(repository, 'edit.txt'), lines('edit').replace('edit2\nedit3', 'x\ny').replace('edit8', 'z'));
    git('rm', '-q', 'gone.txt');
    git('mv', 'move.txt', 'moved.txt');
    writeFileSync(join(repository, 'moved.txt'), lines('move').replace('move5', 'five'));
    writeFileSync(join(repository, 'staged.txt'), 'staged\n');
    git('add', 'staged.txt');
    writeFileSync(join(repository, 'new.txt'), 'new\n');

    const all = simplify(repository, '').submit;
    assert.equal(all, '$omd-review-policy:omd-simplify\n\nChanged lines in scope (uncommitted changes):\n'
      + '- edit.txt: lines 2-3, 8\n- moved.txt: renamed; lines 5\n- staged.txt: new file (all lines)\n- new.txt: new file (all lines)');
    assert.equal(simplify(repository, '--staged').submit.split('\n').slice(3).join('\n'), '- staged.txt: new file (all lines)');
    assert.match(simplify(repository, '--ref=main').submit, /\(changes since the merge base with main\):\n- edit\.txt: lines 2-3, 8\n- keep\.txt: lines 4\n/);
    assert.match(simplify(repository, 'edit.txt new.txt').submit, /in the named files\):\n- edit\.txt: lines 2-3, 8\n- new\.txt: new file \(all lines\)$/);
    assert.deepEqual(simplify(repository, 'keep.txt'), { display: 'No changed lines to simplify in uncommitted changes in the named files.' });
    assert.match(simplify(repository, '--ref=missing').display, /^git failed: /);
    assert.match(simplify(repository, '--staged --ref=main').display, /^Use either/);
    assert.match(simplify(repository, '--ref=-x').display, /^Usage:/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});
