import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { activate, assertFailure, assertShortCircuit, assertWrapped, attach, clock, component, coreValue, detach, environment, find, intercept, invoke, mount, packages, pointer, runScenario, state, storeMock, text, tiers, waitUntil } from '../mods/author/testing.mjs';

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

test('author example refuses an unknown or listed-but-missing example cleanly', () => {
  const root = mkdtempSync(join(tmpdir(), 'omd-author-example-'));
  try {
    mkdirSync(join(root, 'sdk/author'), { recursive: true });
    copyFileSync(new URL('../mods/author/cli.mjs', import.meta.url), join(root, 'sdk/author/cli.mjs'));
    writeFileSync(join(root, 'sdk/package.json'), JSON.stringify({ version: '1', files: ['examples/ghost'] }));
    for (const name of ['ghost', 'nope']) {
      const result = spawnSync(process.execPath, [join(root, 'sdk/author/cli.mjs'), 'example', join(root, name), name], { encoding: 'utf8' });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, new RegExp(`unknown_example: ${name}`));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('component steps keep an explicit zero size', () => {
  assert.deepEqual(component('m', 'grid', { columns: 0, rows: 0 }), { type: 'component', mod: 'm', module: 'grid', columns: 0, rows: 0 });
});

test('author test fails when a project has no tests', () => {
  const root = mkdtempSync(join(tmpdir(), 'omd-author-test-'));
  try {
    writeFileSync(join(root, 'mod.tests.ts'), '');
    const result = spawnSync(process.execPath, [new URL('../mods/author/cli.mjs', import.meta.url).pathname, 'test', root], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /no_tests/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the test kit seeds and reads persisted mod state through the engine', { skip: !process.env.OMD_MOD_BIN && 'needs the omd-mod engine in OMD_MOD_BIN' }, () => {
  const counter = new URL('../mods/examples/counter', import.meta.url).pathname;
  const trace = runScenario(counter, { steps: [
    state('counter', { value: 41 }),
    invoke('counter', 'tool', 'count', {}, { expect: { count: 42 } }),
    state('counter', { expect: 42 }),
    invoke('counter', 'command', 'reset'),
    state('counter', { expect: 0 }),
  ] });
  assert.deepEqual(trace.steps.map(step => step.value), [41, { count: 42 }, 42, { display: 'Counter reset to 0' }, 0]);
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
    engine('init', store, process.execPath);
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
    engine('init', store, process.execPath);
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

const guardSource = (field) => `import type { ModAPI } from '@oh-my-diff/mod-api';

export default function activate(api: ModAPI) {
  api.intercept('tool', async (input, next) => {
    if (input.tool !== 'exec_command') return next(input);
    const cmd = input.arguments.${field};
    if (typeof cmd !== 'string') throw new Error('cmd_required');
    if (cmd.includes('rm -rf')) return { deny: 'destructive command' };
    return next(cmd.startsWith('git push') ? { ...input, arguments: { ...input.arguments, cmd: 'echo guarded' } } : input);
  });
  api.on('component_event', event => api.state.set({ kind: event.kind, component: event.component, client: event.client ?? null, action: event.pointer?.action ?? null }));
  api.on('terminal', input => ({ sites: { dialog: { components: [
    { type: 'text', id: 'title', label: 'title', text: \`clients:\${input.clients?.length ?? 0}\` },
    { type: 'box', id: 'canvas', label: 'canvas', pointer: true },
    { type: 'button', id: 'allow', label: 'allow', text: 'Allow', action: { command: 'proof:allow' } },
  ] } } }));
  api.command('allow', () => 'allowed');
  api.command('last', () => api.state.get());
  api.command('clock', () => Date.now());
  api.command('policy', () => {
    const mode = api.host.call('environment.read', { names: ['MODE'] }).values.MODE?.value ?? null;
    return { mode, allow: api.host.call('store.get', { key: 'allow' })?.value ?? null };
  });
}
`;

const inventory = (parameters) => ({ thread_id: 'fixture', tools: [
  { name: 'exec_command', kind: 'builtin', server: null, original: { description: 'Run a command', parameters, freeform: false }, effective: { description: 'Run a command', parameters, deferred: false } },
  { name: 'apply_patch', kind: 'builtin', server: null, original: { description: 'Patch files', parameters: null, freeform: true }, effective: null },
  { name: 'mcp__docs__search', kind: 'mcp', server: 'docs', original: { description: 'Search docs', parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } }, required: ['query'] }, freeform: false }, effective: { description: 'Search docs', parameters: null, deferred: true } },
] });

test('fixture-rendered scaffold, typed tool, UI, guard and policy tier work offline from a fixture inventory, not supported-client proof', { skip: !process.env.OMD_MOD_BIN && 'needs the omd-mod engine in OMD_MOD_BIN' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'omd-author-workflow-'));
  const mods = new URL('../mods/', import.meta.url).pathname;
  const cli = join(mods, 'author/cli.mjs');
  const author = (...args) => spawnSync(process.execPath, ['--no-warnings', cli, ...args], { encoding: 'utf8' });
  try {
    const project = join(root, 'proof');
    assert.equal(author('create', project, 'proof').status, 0);
    rmSync(join(project, 'node_modules/@oh-my-diff'), { recursive: true, force: true });
    mkdirSync(join(project, 'node_modules/.bin'), { recursive: true });
    mkdirSync(join(project, 'node_modules/@oh-my-diff'));
    symlinkSync(mods, join(project, 'node_modules/@oh-my-diff/mod-api'));
    symlinkSync(join(mods, 'node_modules/typescript'), join(project, 'node_modules/typescript'));
    symlinkSync(join(mods, 'node_modules/typescript/bin/tsc'), join(project, 'node_modules/.bin/tsc'));
    const manifest = JSON.parse(readFileSync(join(project, 'mod.json'), 'utf8'));
    writeFileSync(join(project, 'mod.json'), JSON.stringify({ ...manifest, capabilities: ['commands', 'interception', 'terminal', 'store', 'exec'], exec_environment: ['MODE'] }));
    const policy = join(root, 'policy');
    mkdirSync(policy);
    writeFileSync(join(policy, 'mod.json'), JSON.stringify({ schema: 1, id: 'policy', version: '0.1.0', api: manifest.api, state_version: 1, capabilities: ['interception'] }));
    writeFileSync(join(policy, 'index.ts'), "export default function activate(api) { api.intercept('tool', async (input, next) => JSON.stringify(input.arguments).includes('sudo') ? { deny: 'no sudo' } : next(input)); }\n");

    const store = join(root, 'store');
    const engine = (...args) => spawnSync(process.env.OMD_MOD_BIN, args, { encoding: 'utf8' });
    assert.equal(engine('init', store, process.execPath).status, 0);
    const parameters = { type: 'object', properties: { cmd: { type: 'string', description: 'Shell command' }, workdir: { type: 'string' } }, required: ['cmd'], additionalProperties: false };
    writeFileSync(join(store, 'tool-inventory.json'), JSON.stringify(inventory(parameters)));
    writeFileSync(join(project, 'index.ts'), guardSource('cmd'));
    assert.equal(author('watch', project, '--', store, '--once').status, 0);
    const types = readFileSync(join(project, '.omd/tool-types.d.ts'), 'utf8');
    assert.match(types, /"exec_command": \{ \/\*\* Shell command \*\/ "cmd": string; "workdir"\?: string; \};/);
    assert.match(types, /"apply_patch": string;/);
    assert.match(types, /"mcp__docs__search": \{[^}]*"query": string;[^}]*"limit"\?: number;|"mcp__docs__search": \{[^}]*"limit"\?: number;[^}]*"query": string;/);
    assert.equal(author('check', project).status, 0);
    writeFileSync(join(project, 'index.ts'), guardSource('command'));
    const rejected = author('check', project);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stdout, /Property 'command' does not exist/);
    writeFileSync(join(project, 'index.ts'), guardSource('cmd'));

    const call = (tool, args) => ({ tool, arguments: args, call_id: 'call-1', thread_id: 'fixture', agent_id: null, schema: null, raw_arguments: JSON.stringify(args), batch: null });
    const effective = { output: 'ok', success: true };
    const trace = runScenario(project, clock(1000), environment({ MODE: 'ci' }), storeMock({ get: [['git']] }), packages(policy), tiers({ append: ['policy'] }), { steps: [
      invoke('proof', 'command', 'policy', null, { expect: { mode: 'ci', allow: ['git'] } }),
      waitUntil(invoke('proof', 'command', 'clock'), 3000, { everyMs: 1000, maxMs: 5000, expect: { waited_ms: 2000, value: 3000 } }),
      intercept('tool', call('exec_command', { cmd: 'ls' }), { core: [coreValue(effective)] }),
      intercept('tool', call('exec_command', { cmd: 'git push origin main' }), { core: [coreValue(effective)] }),
      intercept('tool', call('exec_command', { cmd: 'rm -rf build' })),
      intercept('tool', call('exec_command', { cmd: 'sudo ls' })),
      intercept('tool', call('exec_command', {}), { core: [coreValue(effective)] }),
      mount('proof'),
      activate('proof', 'allow', { expect: { action: { command: 'proof:allow', args: '' }, result: 'allowed' } }),
      attach('web', { renderer: { kind: 'gui', pointer: 'pixel' } }),
      mount('proof'),
      pointer('proof', 'canvas', { column: 1, row: 0, action: 'down', button: 'left' }, { client: 'client-1' }),
      invoke('proof', 'command', 'last', null, { expect: { kind: 'pointer', component: 'canvas', client: 'client-1', action: 'down' } }),
      detach('client-1'),
    ] });
    const chain = index => trace.steps[index].value;
    assert.deepEqual(chain(2).trace.map(entry => entry.mod), ['engine', 'policy', 'proof']);
    assertWrapped(chain(3), 'proof');
    assert.equal(chain(3).core_calls[0].arguments.cmd, 'echo guarded');
    assertShortCircuit(chain(4), 'proof');
    assertShortCircuit(chain(5), 'policy');
    assertFailure(chain(6), 'proof', /cmd_required/);
    assert.equal(find(chain(7), 'canvas').pointer, true);
    assert.match(text(chain(7)), /clients:0\nAllow/);
    assert.match(text(chain(10)), /clients:1/);
    assert.equal(trace.paid_requests, 0);
    assert.deepEqual(trace.unused_mock_replies, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
