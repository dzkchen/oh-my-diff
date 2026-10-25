import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { invoke, state } from '../mods/author/testing.mjs';

test('author packaging preserves custom entrypoints, assets and lifecycle scripts and inspects the output', () => {
  const root = mkdtempSync(join(tmpdir(), 'omd-author-package-'));
  try {
    const api = JSON.parse(readFileSync(new URL('../mods/package.json', import.meta.url))).version;
    const manifest = { schema: 1, id: 'fixture', version: '1.0.0', api, state_version: 1, capabilities: [], entrypoint: 'src/main.ts', assets: ['assets/data.json'], lifecycle: { install: 'scripts/install.ts' } };
    for (const directory of ['src', 'assets', 'scripts']) mkdirSync(join(root, directory));
    writeFileSync(join(root, 'mod.json'), JSON.stringify(manifest));
    writeFileSync(join(root, 'src/main.ts'), 'export default () => {};');
    writeFileSync(join(root, 'assets/data.json'), '{"value":1}');
    writeFileSync(join(root, 'scripts/install.ts'), 'export default () => {};');
    const engine = join(root, 'inspect.mjs');
    writeFileSync(engine, `#!${process.execPath}\nimport { readFileSync, appendFileSync } from 'node:fs';\nimport { join } from 'node:path';\nimport { createHash } from 'node:crypto';\nconst directory = process.argv[3];\nconst manifest = JSON.parse(readFileSync(join(directory, 'mod.json')));\nconst hash = createHash('sha256');\nfor (const path of ['mod.json', manifest.entrypoint, ...manifest.assets, ...Object.values(manifest.lifecycle)]) hash.update(readFileSync(join(directory, path)));\nappendFileSync(${JSON.stringify(join(root, 'inspections'))}, directory + '\\n');\nconsole.log(JSON.stringify({ manifest, sha256: hash.digest('hex') }));\n`);
    chmodSync(engine, 0o700);
    const result = spawnSync(process.execPath, [new URL('../mods/author/cli.mjs', import.meta.url).pathname, 'package', root], { encoding: 'utf8', env: { ...process.env, OMD_MOD_BIN: process.env.OMD_MOD_BIN ?? engine } });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    for (const path of [manifest.entrypoint, ...manifest.assets, ...Object.values(manifest.lifecycle)]) assert.equal(readFileSync(join(report.package, path), 'utf8'), readFileSync(join(root, path), 'utf8'));
    if (!process.env.OMD_MOD_BIN) assert.ok(readFileSync(join(root, 'inspections'), 'utf8').trim().split('\n').includes(report.package));
    assert.equal(JSON.parse(readFileSync(join(report.package, 'package-report.json'))).sha256, report.sha256);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('author example and diagnostic commands preserve their public arguments', () => {
  const root = mkdtempSync(join(tmpdir(), 'omd-author-commands-'));
  try {
    const engine = join(root, 'engine.mjs');
    writeFileSync(engine, `#!${process.execPath}\nconsole.log(JSON.stringify({ args: process.argv.slice(2) }));\n`);
    chmodSync(engine, 0o700);
    const author = (...args) => {
      const result = spawnSync(process.execPath, [new URL('../mods/author/cli.mjs', import.meta.url).pathname, ...args], { encoding: 'utf8', env: { ...process.env, OMD_MOD_BIN: engine } });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    };
    const store = join(root, 'store');
    for (const command of ['report', 'events']) assert.deepEqual(JSON.parse(author(command, store)).args, [command, store]);
    const output = join(root, 'diagnostics.json');
    assert.deepEqual(JSON.parse(author('diagnostics', store, output)).args, ['diagnostics', store, output]);
    assert.deepEqual(JSON.parse(author('explain', 'capability_denied')).args, ['explain', 'capability_denied']);
    const single = join(root, 'single');
    author('example', single, 'terminal');
    assert.equal(JSON.parse(readFileSync(join(single, 'mod.json'))).id, 'terminal');
    const all = join(root, 'all');
    author('examples', all);
    assert.equal(JSON.parse(readFileSync(join(all, 'routing', 'mod.json'))).id, 'routing');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('scaffold commands and mapped failures work for custom and example-named IDs', { skip: !process.env.OMD_MOD_BIN && 'needs the omd-mod engine in OMD_MOD_BIN' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'omd-author-scaffold-'));
  const author = (...args) => spawnSync(process.execPath, ['--no-warnings', new URL('../mods/author/cli.mjs', import.meta.url).pathname, ...args], { encoding: 'utf8' });
  try {
    for (const id of ['my_mod', 'routing']) {
      const project = join(root, id);
      const created = author('create', project, id);
      assert.equal(created.status, 0, created.stderr);
      const tested = author('test', project);
      assert.equal(tested.status, 0, tested.stderr);
      assert.match(tested.stdout, /Hello author/);
      const checked = author('check', project);
      assert.equal(checked.status, 0, checked.stderr);
      assert.match(checked.stderr, /check: ok/);
      const scenario = author('run', project);
      assert.equal(scenario.status, 0, scenario.stderr);
      assert.match(scenario.stdout, /Hello author/);
      const debugged = author('debug', project);
      assert.equal(debugged.status, 0, debugged.stderr);
      assert.match(debugged.stdout, /INTENTIONAL_AUTHOR_FAILURE/);
      assert.match(debugged.stdout, /index\.ts:\d+:\d+/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('watch updates an installed local package without changing its grants, scope or disabled choice', { skip: !process.env.OMD_MOD_BIN && 'needs the omd-mod engine in OMD_MOD_BIN' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'omd-author-watch-'));
  const project = join(root, 'project');
  const store = join(root, 'store');
  const author = (...args) => spawnSync(process.execPath, ['--no-warnings', new URL('../mods/author/cli.mjs', import.meta.url).pathname, ...args], { encoding: 'utf8', cwd: args[0] === 'create' ? root : project });
  const engine = (...args) => {
    const result = spawnSync(process.env.OMD_MOD_BIN, args, { encoding: 'utf8', cwd: project });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  try {
    assert.equal(author('create', project, 'fixture').status, 0);
    const manifest = JSON.parse(readFileSync(join(project, 'mod.json'), 'utf8'));
    manifest.settings_schema = { type: 'object', properties: { label: { type: 'string', default: 'Initial' } } };
    manifest.capabilities = ['commands', 'fs.read', 'fs.external'];
    manifest.fs_access = { roots: [{ path: project }] };
    engine('init', store);
    const dependency = join(root, 'dependency');
    mkdirSync(dependency);
    writeFileSync(join(dependency, 'mod.json'), JSON.stringify({ ...manifest, id: 'dependency', capabilities: [], fs_access: undefined }));
    writeFileSync(join(dependency, 'index.ts'), 'export default () => {};');
    const inspected = engine('inspect', dependency);
    const index = join(root, 'index.json');
    writeFileSync(index, JSON.stringify({ schema: 1, packages: { dependency: [{ version: '0.1.0', source: { kind: 'local', path: dependency }, integrity: inspected.sha256 }] } }));
    manifest.dependencies = [{ id: 'dependency', version: '^0.1.0' }];
    writeFileSync(join(project, 'mod.json'), JSON.stringify(manifest));
    const request = JSON.stringify({ source: { kind: 'local', path: project }, scope: 'project', index, trust: { packages: { fixture: { capabilities: manifest.capabilities, dependencies: true }, dependency: { capabilities: [] } } }, settings: { fixture: { label: 'Kept' } } });
    const preview = engine('package-plan', store, request);
    engine('package-apply', store, request, preview.confirmation);
    engine('package-enable', store, 'dependency');
    engine('package-enable', store, 'fixture');
    const originalPackages = engine('package-lock', store).packages;
    const original = originalPackages.fixture;
    assert.equal(original.scope, 'project');
    const source = readFileSync(join(project, 'index.ts'), 'utf8');
    writeFileSync(join(project, 'index.ts'), source.replace('Hello ', 'Edited '));
    const watched = author('watch', project, '--', store, '--once');
    assert.equal(watched.status, 0, watched.stderr);
    const updated = engine('package-lock', store).packages.fixture;
    assert.notEqual(updated.integrity, original.integrity);
    assert.equal(updated.scope, original.scope);
    assert.deepEqual(updated.trust, original.trust);
    assert.deepEqual(updated.settings, { label: 'Kept' });
    assert.equal(updated.enabled, true);
    assert.deepEqual(engine('package-lock', store).packages.dependency, originalPackages.dependency);
    assert.deepEqual(engine('command', store, 'fixture', 'hello', '"author"'), { display: 'Edited author' });
    writeFileSync(join(project, 'index.ts'), source + '?');
    const broken = author('watch', project, store, '--once');
    assert.notEqual(broken.status, 0);
    assert.match(broken.stderr, /ERR_INVALID_TYPESCRIPT_SYNTAX/);
    assert.equal(engine('package-lock', store).packages.fixture.integrity, updated.integrity);
    writeFileSync(join(project, 'index.ts'), source.replace('Hello ', 'Edited '));
    engine('package-disable', store, 'fixture');
    assert.equal(author('watch', project, store, '--once').status, 0);
    assert.equal(engine('package-lock', store).packages.fixture.enabled, false);
    writeFileSync(join(project, 'mod.json'), JSON.stringify({ ...manifest, capabilities: [...manifest.capabilities, 'exec'] }));
    const denied = author('watch', project, store, '--once');
    assert.notEqual(denied.status, 0);
    assert.match(denied.stderr, /explicit_exact_capability_grant_required/);
    assert.deepEqual(engine('package-lock', store).packages.fixture.trust, original.trust);
    writeFileSync(join(project, 'mod.json'), JSON.stringify({ ...manifest, fs_access: { roots: [{ path: root }] } }));
    const authority = author('watch', project, store, '--once');
    assert.notEqual(authority.status, 0);
    assert.match(authority.stderr, /watch_approval_required/);
    assert.deepEqual(engine('package-lock', store).packages.fixture.authority, original.authority);
    writeFileSync(join(project, 'mod.json'), JSON.stringify({ ...manifest, state_version: 2 }));
    const migration = author('watch', project, store, '--once');
    assert.notEqual(migration.status, 0);
    assert.match(migration.stderr, /watch_approval_required/);
    assert.equal(engine('package-lock', store).packages.fixture.state_version, 1);
    const other = join(root, 'other');
    mkdirSync(other);
    writeFileSync(join(other, 'mod.json'), JSON.stringify(manifest));
    writeFileSync(join(other, 'index.ts'), source);
    const replaced = author('watch', other, store, '--once');
    assert.notEqual(replaced.status, 0);
    assert.match(replaced.stderr, /watch_source_mismatch/);
    assert.equal(engine('package-lock', store).packages.fixture.integrity, updated.integrity);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('watch refuses to move a shared dependency from project to user scope', { skip: !process.env.OMD_MOD_BIN && 'needs the omd-mod engine in OMD_MOD_BIN' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'omd-author-watch-scope-'));
  const project = join(root, 'project');
  const store = join(root, 'store');
  const author = (...args) => spawnSync(process.execPath, ['--no-warnings', new URL('../mods/author/cli.mjs', import.meta.url).pathname, ...args], { encoding: 'utf8', cwd: root });
  const engine = (...args) => {
    const result = spawnSync(process.env.OMD_MOD_BIN, args, { encoding: 'utf8', cwd: project });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const install = request => {
    const serialized = JSON.stringify(request);
    const preview = engine('package-plan', store, serialized);
    engine('package-apply', store, serialized, preview.confirmation);
  };
  try {
    assert.equal(author('create', project, 'fixture').status, 0);
    const manifest = JSON.parse(readFileSync(join(project, 'mod.json'), 'utf8'));
    const dependency = join(root, 'dependency');
    mkdirSync(dependency);
    writeFileSync(join(dependency, 'mod.json'), JSON.stringify({ ...manifest, id: 'dependency', capabilities: [] }));
    writeFileSync(join(dependency, 'index.ts'), 'export default () => {};');
    const inspected = engine('inspect', dependency);
    const index = join(root, 'index.json');
    writeFileSync(index, JSON.stringify({ schema: 1, packages: { dependency: [{ version: '0.1.0', source: { kind: 'local', path: dependency }, integrity: inspected.sha256 }] } }));
    writeFileSync(join(project, 'mod.json'), JSON.stringify({ ...manifest, dependencies: [{ id: 'dependency', version: '^0.1.0' }] }));
    engine('init', store);
    const trust = { packages: { fixture: { capabilities: manifest.capabilities, dependencies: true }, dependency: { capabilities: [] } } };
    install({ source: { kind: 'local', path: project }, scope: 'user', index, trust });
    // Seed inconsistent dependency scopes directly: installing a second scope fails before watch runs.
    const mixedScopes = engine('package-lock', store);
    mixedScopes.packages.dependency.scope = 'project';
    writeFileSync(join(store, 'packages.lock.json'), JSON.stringify(mixedScopes));
    const config = JSON.parse(readFileSync(join(store, 'mods.json'), 'utf8'));
    config.mods.find(selection => selection.path === mixedScopes.packages.dependency.path).scope = 'project';
    writeFileSync(join(store, 'mods.json'), JSON.stringify(config));
    engine('package-enable', store, 'dependency');
    const before = engine('package-lock', store);
    assert.equal(before.packages.fixture.scope, 'user');
    assert.equal(before.packages.dependency.scope, 'project');
    const selections = readFileSync(join(store, 'mods.json'), 'utf8');
    const source = readFileSync(join(project, 'index.ts'), 'utf8');
    writeFileSync(join(project, 'index.ts'), source.replace('Hello ', 'Edited '));
    const watched = author('watch', project, store, '--once');
    assert.notEqual(watched.status, 0, watched.stdout);
    assert.match(watched.stderr, /package_scope_conflict: dependency is installed in project scope/);
    assert.deepEqual(engine('package-lock', store), before);
    assert.equal(readFileSync(join(store, 'mods.json'), 'utf8'), selections);
    engine('package-disable', store, 'dependency');
    assert.equal(engine('package-lock', store).packages.dependency.enabled, false);
    engine('package-enable', store, 'dependency');
    assert.equal(engine('package-lock', store).packages.dependency.enabled, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('author help and errors print without a stack', () => {
  const cli = new URL('../mods/author/cli.mjs', import.meta.url).pathname;
  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^usage: omd-mod-author /);
  const unknown = spawnSync(process.execPath, [cli, 'nonsense'], { encoding: 'utf8' });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /^usage: omd-mod-author /);
  const root = mkdtempSync(join(tmpdir(), 'omd-author-fail-'));
  try {
    const failed = spawnSync(process.execPath, [cli, 'create', join(root, 'bad'), 'BAD-ID!'], { encoding: 'utf8' });
    assert.equal(failed.status, 1);
    assert.equal(failed.stderr, 'invalid_mod_id: BAD-ID!\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('thread ids map on every step helper', () => {
  assert.equal(state('m', { threadId: 't' }).thread_id, 't');
  assert.equal(invoke('m', 'command', 'c', null, { threadId: 't' }).thread_id, 't');
});

test('a managed release install scaffolds the SDK from its release asset and a dev install links its files', () => {
  const root = mkdtempSync(join(tmpdir(), 'omd-author-sdk-spec-'));
  try {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'pnpm'), '#!/bin/sh\n');
    chmodSync(join(bin, 'pnpm'), 0o700);
    const scaffold = (prefix, record) => {
      const sdk = join(prefix, 'author/package');
      mkdirSync(sdk, { recursive: true });
      cpSync(new URL('../mods/author', import.meta.url).pathname, join(sdk, 'author'), { recursive: true });
      cpSync(new URL('../mods/package.json', import.meta.url).pathname, join(sdk, 'package.json'));
      if (record) writeFileSync(join(prefix, 'install.json'), JSON.stringify(record));
      const project = join(prefix, 'project');
      const { OMD_MOD_SDK_SPEC, ...env } = process.env;
      const result = spawnSync(process.execPath, [join(sdk, 'author/cli.mjs'), 'create', project, 'demo'], { encoding: 'utf8', env: { ...env, PATH: `${bin}:${process.env.PATH}` } });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(readFileSync(join(project, 'package.json'))).devDependencies['@oh-my-diff/mod-api'];
    };
    assert.equal(scaffold(join(root, 'managed'), { version: '1.2.3', update: {} }), 'https://github.com/dzkchen/oh-my-diff/releases/download/v1.2.3/mod-api.tgz');
    assert.match(scaffold(join(root, 'dev'), { version: '1.2.3' }), /^file:/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
