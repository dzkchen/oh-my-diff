import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function discover(root) {
  const deleted = new Set(execFileSync('git', ['ls-files', '--deleted', '-z'], {
    cwd: root, encoding: 'utf8',
  }).split('\0'));
  const files = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root, encoding: 'utf8',
  }).split('\0').filter(path => path && !deleted.has(path)))].sort();
  const config = resolve(root, 'tests/suites.json');
  const optional = existsSync(config) ? JSON.parse(readFileSync(config, 'utf8')).optional : {};
  if (!optional || typeof optional !== 'object' || Array.isArray(optional)) throw new Error('Invalid optional test classifications');
  const candidates = files.filter(path => /(?:\.test|\.spec)\.[^/]+$|(?:^|\/)test_[^/]+\.py$|(?:[_/]tests\.rs$|\/tests\/[^/]+\.rs$)/.test(path));
  for (const [path, reason] of Object.entries(optional)) {
    if (!candidates.includes(path) || typeof reason !== 'string' || !reason.trim()) {
      throw new Error(`Invalid optional test classification: ${path}`);
    }
  }
  const tests = candidates.filter(path => !(path in optional) && /^(mods|tests|plugins)\/.*\.(test|spec)\.(mjs|cjs|js)$/.test(path));
  const suites = {
    python: candidates.filter(path => !(path in optional) && /^tests\/test_[^/]+\.py$/.test(path)),
    cargo: candidates.filter(path => !(path in optional) && /^runtime\/(omd|native)\/(src\/(?:.*_tests|(?:.*\/)?tests)\.rs|tests\/[^/]+\.rs)$/.test(path)),
    scenarios: candidates.filter(path => !(path in optional) && /^mods\/(examples|first-party)\/[^/]+\/mod\.test\.json$/.test(path)),
  };
  const classified = new Set([...tests, ...Object.values(suites).flat(), ...Object.keys(optional)]);
  const unclassified = candidates.filter(path => !classified.has(path));
  if (unclassified.length) throw new Error(`Unclassified tests: ${unclassified.join(', ')}`);
  if (!tests.length) throw new Error('No Node tests discovered');
  return { tests, suites, optional };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const inventory = discover(root);
    if (process.argv.includes('--list')) {
      process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`);
    } else {
      for (const [suite, paths] of Object.entries(inventory.suites)) {
        process.stderr.write(`Not executed by mods:test (${suite} suite): ${paths.length} test files\n`);
      }
      for (const [path, reason] of Object.entries(inventory.optional)) {
        process.stderr.write(`Not executed (optional/manual): ${path}: ${reason}\n`);
      }
      const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...inventory.tests], { cwd: root, stdio: 'inherit' });
      if (result.error) throw result.error;
      process.exitCode = result.status ?? 1;
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
