import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { discover } from '../scripts/mod_test_suite.mjs';

test('suite discovers colocated tests and rejects unclassified tests before executing', () => {
  const root = mkdtempSync(join(tmpdir(), 'omd-test-discovery-'));
  const put = (path, source = '') => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), source);
  };
  try {
    execFileSync('git', ['init', '-q', root]);
    put('mods/new-package/new.test.mjs');
    put('mods/removed.test.mjs');
    put('plugins/bundled/example/mod.test.mjs');
    execFileSync('git', ['-C', root, 'add', '.']);
    rmSync(join(root, 'mods/removed.test.mjs'));
    put('tests/new.test.mjs');
    put('tests/test_new.py');
    put('runtime/omd/tests/new.rs');
    put('runtime/native/src/new_tests.rs');
    put('runtime/native/src/nested/tests.rs');
    put('mods/examples/new/mod.test.json');
    put('.gitignore', 'ignored/\n');
    put('ignored/example.test.mjs');
    assert.deepEqual(discover(root).tests, [
      'mods/new-package/new.test.mjs', 'plugins/bundled/example/mod.test.mjs', 'tests/new.test.mjs',
    ]);
    assert.deepEqual(discover(root).suites, {
      python: ['tests/test_new.py'],
      cargo: ['runtime/native/src/nested/tests.rs', 'runtime/native/src/new_tests.rs', 'runtime/omd/tests/new.rs'],
      scenarios: ['mods/examples/new/mod.test.json'],
    });
    put('tests/nested/test_undiscovered.py');
    assert.throws(() => discover(root), /Unclassified tests: tests\/nested\/test_undiscovered.py/);
    rmSync(join(root, 'tests/nested/test_undiscovered.py'));
    put('tools/manual.test.mjs');
    assert.throws(() => discover(root), /Unclassified tests: tools\/manual.test.mjs/);
    put('tests/suites.json', JSON.stringify({ optional: { 'tools/manual.test.mjs': 'Run manually with a terminal' } }));
    assert.deepEqual(discover(root).optional, { 'tools/manual.test.mjs': 'Run manually with a terminal' });
    put('tests/unsupported.test.ts');
    assert.throws(() => discover(root), /Unclassified tests: tests\/unsupported.test.ts/);
    put('tests/suites.json', JSON.stringify({ optional: { 'missing.test.mjs': 'Manual' } }));
    assert.throws(() => discover(root), /missing.test.mjs/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
