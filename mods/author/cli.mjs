#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, watch } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { stripTypeScriptTypes } from 'node:module';

const sdkRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiVersion = JSON.parse(readFileSync(join(sdkRoot, 'package.json'), 'utf8')).version;
const engine = process.env.OMD_MOD_BIN || 'omd-mod';
const node = process.env.OMD_MOD_NODE || process.execPath;

function fail(message) {
  throw new Error(message);
}

function command(program, args, options = {}) {
  const result = spawnSync(program, args, { cwd: options.cwd, encoding: 'utf8', stdio: options.capture ? 'pipe' : 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) fail((result.stderr || result.stdout || `${program} failed`).trim());
  return options.capture ? result.stdout.trim() : '';
}

function engineJson(args) {
  return JSON.parse(command(engine, args, { capture: true }));
}

function packageJson(name) {
  return {
    name: `omd-mod-${name}`,
    version: '0.1.0',
    private: true,
    type: 'module',
    scripts: {
      check: 'omd-mod-author check .',
      test: 'omd-mod-author test .',
      run: 'omd-mod-author run .',
      debug: 'omd-mod-author debug .',
      package: 'omd-mod-author package .',
      watch: 'omd-mod-author watch .',
    },
    devDependencies: {
      '@oh-my-diff/mod-api': process.env.OMD_MOD_SDK_SPEC || apiVersion,
      typescript: '5.9.3',
    },
  };
}

function tsconfig() {
  return {
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      noEmit: true,
      types: [],
    },
    include: ['index.ts', '.omd/*.d.ts'],
  };
}

function minimalSource() {
  return `import type { ModAPI } from '@oh-my-diff/mod-api';

export default function activate(api: ModAPI) {
  api.command('hello', input => {
    if (input === 'fail') throw new Error('INTENTIONAL_AUTHOR_FAILURE');
    return { display: \`Hello \${String(input || 'world')}\` };
  }, { description: 'Confirm the scaffold is running' });
}
`;
}

function scenarioFor(name) {
  const scenarios = {
    minimal: {
      schema: 1,
      virtual_time_ms: 1000,
      steps: [{ type: 'invoke', mod: name, event: 'command', name: 'hello', payload: 'author', expect: { display: 'Hello author' } }],
    },
    routing: {
      schema: 1,
      steps: [{ type: 'event', event: 'routing', payload: { routes: [{ name: 'sol', model: 'm1', provider: 'p', reasoning: 'high' }, { name: 'astra', model: 'm2', provider: 'p', reasoning: 'xhigh' }], model: null, provider: 'p', reasoning: null }, expect: [{ mod: 'routing', value: 'sol' }] }],
    },
    coordination: {
      schema: 1,
      host_operations: {
        'agents.spawn': [{ result: { handle: 'a', route: 'sol', permissions: 'read_only' } }, { result: { handle: 'b', route: 'astra', permissions: 'read_only' } }],
        'agents.wait': [{ result: { status: 'completed', text: 'one', consumed: true } }, { result: { status: 'completed', text: 'two', consumed: true } }],
      },
      steps: [{ type: 'invoke', mod: 'coordination', event: 'tool', name: 'compare', payload: { prompt: 'inspect' } }],
    },
    context: {
      schema: 1,
      steps: [{ type: 'event', event: 'context', payload: { thread_id: 't', turn_id: 'u', checkpoint: { remaining_work: ['test'] } } }],
    },
    recovery: {
      schema: 1,
      host_operations: { 'checkpoint.read': [{ result: { remaining_work: ['resume'] } }] },
      steps: [
        { type: 'event', event: 'compaction', payload: { token_limit: 32000, context_window: 64000 } },
        { type: 'event', event: 'context', payload: { thread_id: 't', turn_id: 'u', checkpoint: { remaining_work: ['resume'] } } },
        { type: 'invoke', mod: 'recovery', event: 'tool', name: 'checkpoint', payload: {} },
      ],
    },
    counter: {
      schema: 1,
      steps: [{ type: 'invoke', mod: 'counter', event: 'tool', name: 'count', payload: {}, expect: { count: 1 } }],
    },
    terminal: {
      schema: 1,
      packages: ['../counter'],
      steps: [
        { type: 'terminal_mount', mod: 'terminal', payload: { event: 'draw', checkpoint: null } },
        { type: 'terminal_interact', mod: 'terminal', key: 'Alt+x', payload: { event: 'draw', checkpoint: null }, expect: { action: { command: 'counter:reset', args: '' }, result: { display: 'Counter reset to 0' } } },
      ],
    },
    'service-consumer': {
      schema: 1,
      packages: ['../service-provider'],
      steps: [{ type: 'invoke', mod: 'service_consumer', event: 'command', name: 'format', payload: '  typed service  ', expect: 'typed service' }],
    },
    'service-provider': { schema: 1, steps: [{ type: 'status' }] },
  };
  return scenarios[name] || scenarios.minimal;
}

function debugScenario(name) {
  if (name === 'coordination') {
    return { schema: 1, steps: [{ type: 'invoke', mod: 'coordination', event: 'tool', name: 'compare', payload: null, expect_error: 'prompt required' }] };
  }
  if (name === 'minimal') {
    return { schema: 1, steps: [{ type: 'invoke', mod: name, event: 'command', name: 'hello', payload: 'fail', expect_error: 'INTENTIONAL_AUTHOR_FAILURE' }] };
  }
  return { schema: 1, steps: [{ type: 'invoke', mod: name.replaceAll('-', '_'), event: 'command', name: '__intentional_missing__', payload: null, expect_error: 'unsupported_or_unregistered_operation' }] };
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeProjectFiles(directory, name) {
  await writeJson(join(directory, 'package.json'), packageJson(name));
  await writeJson(join(directory, 'tsconfig.json'), tsconfig());
  await writeJson(join(directory, 'mod.test.json'), scenarioFor(name));
  await writeJson(join(directory, 'debug.test.json'), debugScenario(name));
}

async function createProject(directory, name) {
  if (!/^[a-z0-9_]{1,24}$/.test(name)) fail(`invalid_mod_id: ${name}`);
  if (existsSync(directory)) fail(`target_exists: ${directory}`);
  mkdirSync(directory, { recursive: true });
  await writeJson(join(directory, 'mod.json'), { schema: 1, id: name, version: '0.1.0', api: apiVersion, state_version: 1, capabilities: ['commands'] });
  await writeFile(join(directory, 'index.ts'), minimalSource());
  await writeProjectFiles(directory, name);
}

async function copyExample(directory, name) {
  const source = join(sdkRoot, 'examples', name);
  if (!statSync(source).isDirectory()) fail(`unknown_example: ${name}`);
  if (existsSync(directory)) fail(`target_exists: ${directory}`);
  cpSync(source, directory, { recursive: true });
  await writeProjectFiles(directory, name);
}

async function copyExamples(directory) {
  if (existsSync(directory)) fail(`target_exists: ${directory}`);
  mkdirSync(directory, { recursive: true });
  const names = ['routing', 'coordination', 'context', 'recovery', 'service-provider', 'service-consumer', 'counter', 'terminal'];
  for (const name of names) await copyExample(join(directory, name), name);
  await writeJson(join(directory, 'package.json'), { name: 'omd-mod-examples', private: true, scripts: { check: 'pnpm -r check', test: 'pnpm -r test', package: 'pnpm -r package' } });
  await writeFile(join(directory, 'pnpm-workspace.yaml'), "packages:\n  - '*'\n");
}

function checkProject(directory) {
  command('pnpm', ['exec', 'tsc', '-p', 'tsconfig.json'], { cwd: directory });
}

function trustPackage(store, directory) {
  const inspected = engineJson(['inspect', directory]);
  const capabilities = inspected.manifest.capabilities.join(',');
  engineJson(['trust', store, inspected.path, inspected.sha256, capabilities, 'user']);
  engineJson(['enable', store, inspected.path]);
}

function copyDeclarations(store, directory) {
  const declarations = engineJson(['declarations', store]);
  const target = join(directory, '.omd');
  mkdirSync(target, { recursive: true });
  cpSync(declarations.active_host, join(target, 'active-host.d.ts'));
  cpSync(declarations.installed_contracts, join(target, 'installed-contracts.d.ts'));
}

function runScenario(directory, file) {
  const scenarioPath = resolve(directory, file);
  const scenario = JSON.parse(readFileSync(scenarioPath, 'utf8'));
  const temporary = mkdtempSync(join(tmpdir(), 'omd-mod-author-'));
  const store = join(temporary, 'store');
  try {
    engineJson(['init', store, node]);
    const packages = [directory, ...(scenario.packages || []).map(path => resolve(directory, path))];
    for (const packagePath of packages) trustPackage(store, resolve(packagePath));
    const result = engineJson(['test', store, scenarioPath]);
    copyDeclarations(store, directory);
    checkProject(directory);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

async function packageProject(directory) {
  checkProject(directory);
  const inspected = engineJson(['inspect', directory]);
  const name = `${inspected.manifest.id}-${inspected.manifest.version}`;
  const target = join(directory, 'dist', name);
  if (existsSync(target)) fail(`package_target_exists: ${target}`);
  mkdirSync(target, { recursive: true });
  cpSync(join(directory, 'mod.json'), join(target, 'mod.json'));
  cpSync(join(directory, 'index.ts'), join(target, 'index.ts'));
  const transformed = stripTypeScriptTypes(readFileSync(join(directory, 'index.ts'), 'utf8'), { mode: 'transform', sourceMap: true, sourceUrl: 'index.ts' });
  const marker = '\n//# sourceMappingURL=data:application/json;base64,';
  const [javascript, encoded] = transformed.split(marker);
  await writeFile(join(target, 'index.js'), `${javascript}\n//# sourceMappingURL=index.js.map\n`);
  await writeFile(join(target, 'index.js.map'), Buffer.from(encoded.trim(), 'base64'));
  await writeJson(join(target, 'package-report.json'), { api: apiVersion, sha256: inspected.sha256, source_map: 'index.js.map', manifest: inspected.manifest });
  process.stdout.write(`${JSON.stringify({ package: target, sha256: inspected.sha256, source_map: join(target, 'index.js.map') }, null, 2)}\n`);
}

function watchProject(directory, store, once) {
  const reload = () => {
    const inspected = engineJson(['inspect', directory]);
    engineJson(['trust', store, inspected.path, inspected.sha256, inspected.manifest.capabilities.join(','), 'user']);
    engineJson(['enable', store, inspected.path]);
    const result = engineJson(['reload', store]);
    process.stdout.write(`${JSON.stringify({ reloaded: directory, sha256: inspected.sha256, result })}\n`);
  };
  reload();
  if (once) return;
  let pending;
  const watcher = watch(directory, { recursive: false }, (_event, filename) => {
    if (!['index.ts', 'mod.json'].includes(String(filename))) return;
    clearTimeout(pending);
    pending = setTimeout(reload, 100);
  });
  process.on('SIGINT', () => watcher.close());
}

async function main() {
  const [action, rawDirectory = '.', nameOrStore, extra] = process.argv.slice(2);
  const directory = resolve(rawDirectory);
  switch (action) {
    case 'create': return createProject(directory, nameOrStore || basename(directory));
    case 'example': return copyExample(directory, nameOrStore);
    case 'examples': return copyExamples(directory);
    case 'check': return checkProject(directory);
    case 'test': return runScenario(directory, 'mod.test.json');
    case 'run': return runScenario(directory, 'mod.test.json');
    case 'debug': return runScenario(directory, 'debug.test.json');
    case 'package': return packageProject(directory);
    case 'watch': return watchProject(directory, resolve(nameOrStore || fail('watch requires STORE')), extra === '--once');
    case 'report': process.stdout.write(`${JSON.stringify(engineJson(['report', directory]), null, 2)}\n`); return;
    case 'events': process.stdout.write(`${JSON.stringify(engineJson(['events', directory]), null, 2)}\n`); return;
    case 'diagnostics': process.stdout.write(`${JSON.stringify(engineJson(['diagnostics', directory, resolve(nameOrStore || 'omd-diagnostics.json')]), null, 2)}\n`); return;
    case 'explain': process.stdout.write(`${JSON.stringify(engineJson(['explain', rawDirectory]), null, 2)}\n`); return;
    default: fail('usage: omd-mod-author create DIR [ID] | example DIR NAME | examples DIR | check/test/run/debug/package DIR | watch DIR STORE [--once] | report/events STORE | diagnostics STORE [OUTPUT] | explain DENIAL');
  }
}

await main();
