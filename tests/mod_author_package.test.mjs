import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { activate, assertFailure, assertShortCircuit, assertWrapped, attach, clock, coreValue, detach, environment, find, intercept, invoke, mount, packages, pointer, runScenario, storeMock, text, tiers, waitUntil } from '../mods/author/testing.mjs';

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
    symlinkSync(join(mods, 'node_modules/.bin/tsc'), join(project, 'node_modules/.bin/tsc'));
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
    assert.equal(author('watch', project, store, '--once').status, 0);
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
