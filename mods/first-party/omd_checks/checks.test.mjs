import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const runner = readFileSync(new URL('../../../runtime/omd/src/mods/runner.mjs', import.meta.url), 'utf8');
const surface = { events: {}, replacements: [], middleware: [], state: 'store', contracts: 'contracts' };
const hash = character => character.repeat(64);

function run(payload, receipts = []) {
  const request = { source, filename: 'omd_checks.ts', api: '0.2.0-experimental.3', capabilities: ['tools', 'fs.read', 'exec'], environment: ['crypto'],
    state: null, settings: {}, event: 'tool', name: 'select', payload, receipts, surface, hook_budget_ms: 2000 };
  const result = spawnSync(process.execPath, ['--no-warnings', '--experimental-vm-modules', '--input-type=module', '--eval', runner], {
    input: JSON.stringify(request), encoding: 'utf8', timeout: 5000,
  });
  assert.ifError(result.error);
  return JSON.parse(result.stdout);
}

function replay(payload, entries, programs, stale = false, truncated = false) {
  const receipts = [];
  const calls = [];
  for (let index = 0; index < 40; index++) {
    const output = run(payload, receipts);
    if (!output.host_call) return { output, calls };
    const call = output.host_call;
    calls.push(call);
    let value;
    if (['workspace.snapshot', 'workspace.fingerprint'].includes(call.operation)) {
      if (call.arguments.expected && stale) receipts.push({ call, error: 'workspace_candidate_stale' });
      else receipts.push({ call, value: { snapshot: { reference: 'fixture', sha256: hash('a') }, candidate_sha256: hash('a') } });
      continue;
    }
    if (call.operation === 'workspace.list') {
      const prefix = call.arguments.path ? `${call.arguments.path}/` : '';
      value = { entries: Object.entries(entries).filter(([path]) => path.startsWith(prefix)).map(([path, item]) => ({ path, kind: 'file', size: item.size, mtime_ms: 1 })), truncated };
    }
    else if (call.operation === 'process.which') value = { found: programs.map(name => ({ name, path: `/bin/${name}`, sha256: hash('b') })) };
    else if (call.operation === 'workspace.stat') {
      assert.ok(call.arguments.paths.length <= 128);
      value = { files: Object.fromEntries(call.arguments.paths.map(path => [path, entries[path]
        ? { kind: 'file', size: entries[path].size, mtime_ms: 1, ...(call.arguments.hash ? { sha256: entries[path].sha256 } : {}) } : null])) };
    }
    else assert.fail(`unexpected operation ${call.operation}`);
    receipts.push({ call, value });
  }
  assert.fail('selection did not finish');
}

test('selects five languages and binds checks to relevant input digests and candidate', () => {
  const entries = {
    'pkg/Cargo.toml': { size: 10, sha256: hash('1') },
    'pkg/src/lib.rs': { size: 10, sha256: hash('2') },
    'web/tsconfig.json': { size: 10, sha256: hash('3') },
    'web/src/app.ts': { size: 10, sha256: hash('4') },
    'web/src/app.js': { size: 10, sha256: hash('5') },
    'py/main.py': { size: 10, sha256: hash('6') },
    'gradlew': { size: 10, sha256: hash('7') },
    'src/App.java': { size: 10, sha256: hash('8') },
    'notes.txt': { size: 10, sha256: hash('9') },
  };
  const paths = ['pkg/src/lib.rs', 'web/src/app.ts', 'web/src/app.js', 'py/main.py', 'src/App.java'];
  const first = replay({ paths }, entries, ['cargo', 'pnpm', 'ruff']);
  assert.equal(first.output.error, undefined, first.output.error);
  assert.deepEqual(first.output.value.checks.map(check => check.language), ['rust', 'typescript', 'javascript', 'python', 'java']);
  assert.equal(first.output.value.checks[0].working_directory, 'pkg');
  assert.deepEqual(first.output.value.checks[1].arguments, ['exec', 'tsc', '--noEmit', '--pretty', 'false', '-p', 'web/tsconfig.json']);
  assert.deepEqual(first.output.value.checks[3].arguments, ['check', 'py/main.py']);
  assert.equal(first.output.value.checks[4].program, './gradlew');
  assert.ok(first.output.value.checks.every(check => check.candidate_sha256 === hash('a') && /^[0-9a-f]{64}$/.test(check.input_sha256)));
  assert.equal(first.calls.at(-1).operation, 'workspace.fingerprint');
  const irrelevant = replay({ paths }, { ...entries, 'notes.txt': { size: 11, sha256: hash('c') } }, ['cargo', 'pnpm', 'ruff']);
  assert.deepEqual(irrelevant.output.value.checks.map(check => check.input_sha256), first.output.value.checks.map(check => check.input_sha256));
  const relevant = replay({ paths }, { ...entries, 'pkg/Cargo.toml': { size: 11, sha256: hash('c') } }, ['cargo', 'pnpm', 'ruff']);
  assert.notEqual(relevant.output.value.checks[0].input_sha256, first.output.value.checks[0].input_sha256);
  const wrapper = replay({ paths }, { ...entries, gradlew: { size: 11, sha256: hash('c') } }, ['cargo', 'pnpm', 'ruff']);
  assert.notEqual(wrapper.output.value.checks[4].input_sha256, first.output.value.checks[4].input_sha256);
});

test('groups changed files by their enclosing project so every changed file is checked', () => {
  const entries = {
    'Cargo.toml': { size: 10, sha256: hash('1') },
    'crates/a/Cargo.toml': { size: 10, sha256: hash('2') },
    'crates/a/src/lib.rs': { size: 10, sha256: hash('3') },
    'crates/b/Cargo.toml': { size: 10, sha256: hash('4') },
    'crates/b/src/lib.rs': { size: 10, sha256: hash('5') },
    'packages/a/tsconfig.json': { size: 10, sha256: hash('6') },
    'packages/a/x.ts': { size: 10, sha256: hash('7') },
    'packages/b/tsconfig.json': { size: 10, sha256: hash('8') },
    'packages/b/y.ts': { size: 10, sha256: hash('9') },
  };
  const paths = ['crates/a/src/lib.rs', 'crates/b/src/lib.rs', 'packages/a/x.ts', 'packages/b/y.ts'];
  const { output, calls } = replay({ paths }, entries, ['cargo', 'pnpm']);
  assert.equal(output.error, undefined, output.error);
  assert.deepEqual(output.value.checks.map(check => [check.working_directory, check.arguments.at(-1), check.scope]), [
    ['crates/a', '--quiet', ['crates/a/src/lib.rs']],
    ['crates/b', '--quiet', ['crates/b/src/lib.rs']],
    ['', 'packages/a/tsconfig.json', ['packages/a/x.ts']],
    ['', 'packages/b/tsconfig.json', ['packages/b/y.ts']],
  ]);
  assert.ok(calls.filter(call => call.operation === 'workspace.list').every(call => call.arguments.path && call.arguments.max_entries === undefined));
});

test('reports unsupported checks without implying success', () => {
  const entries = { 'src/main.rs': { size: 10, sha256: hash('1') } };
  const { output } = replay({ paths: ['src/main.rs'] }, entries, []);
  assert.deepEqual(output.value.checks, []);
  assert.match(output.value.unsupported[0].reason, /Cargo.toml/);
  assert.match(output.value.unsupported[0].fallback, /unavailable evidence is not success/);
});

test('rejects traversal, missing paths, truncated lists, and changed candidates', () => {
  assert.match(run({ paths: ['../secret.rs'] }).error, /changed_paths_invalid/);
  assert.match(run({ paths: ['notes.txt'] }).error, /unsupported_source_path/);
  const entries = { 'main.py': { size: 10, sha256: hash('1') } };
  assert.match(replay({ paths: ['other.py'] }, entries, ['ruff']).output.error, /changed_source_missing/);
  assert.match(replay({ paths: ['main.py'] }, entries, ['ruff'], true).output.error, /workspace_candidate_stale/);
  const rust = { 'Cargo.toml': { size: 10, sha256: hash('1') }, 'src/main.rs': { size: 10, sha256: hash('2') } };
  assert.match(replay({ paths: ['src/main.rs'] }, rust, ['cargo'], false, true).output.error, /check_input_listing_truncated/);
});
